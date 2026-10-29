import { makeFunctionReference } from 'convex/server'
import { v, type ObjectType } from 'convex/values'
import { Effect } from 'effect'

import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import {
  action,
  internalMutation,
  mutation,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import {
  detectFileSignature,
  inspectCsvFile,
  inspectOfficeFile,
  inspectZipSafety,
  matchesDeclaredMimeType,
  type FileSignature,
} from './_documents/fileInspection'
import { requiresConfiguredScanner, scanFileWithConfiguredGateway } from './_documents/scanner'
import {
  directUploadLimitBytesForMimeType,
  DIRECT_UPLOAD_ALLOWED_MIME_TYPES,
  MAX_DIRECT_UPLOAD_BYTES,
} from './_documents/uploadLimits'
import { requireAuthAdmin } from './_helpers/auth'
import { requireAuthEffect } from './_helpers/auth.identity'
import { convexPromise, convexSync, runConvex } from './_helpers/effect'
import { logAdminAction } from './_helpers/auditLog'
import { resolveCurrentCompanyAuthorization } from './_helpers/companyAuthorization'
import { invalidState, unauthorized, validationFailed, type AppError } from './_helpers/errors'
import { enforceRateLimit } from './_helpers/rateLimit'
import { normalizeSha256Hex } from './_helpers/sha256'
import {
  prepareOrReconcileIntakeClaim,
  reconcileIntakeClaimByDigest,
  resetPendingClaimForDeletion,
  verifyIntakeClaimProof,
  type IntakeClaimResult,
} from './_intake/claim'
import { createOpaqueIntakeToken, hashIntakeSessionToken, sha256Hex } from './_intake/crypto'
import {
  INTAKE_ABSOLUTE_ACCESS_TTL_MS,
  INTAKE_ACCESS_TTL_MS,
  INTAKE_DELETION_PROOF_TTL_MS,
  INTAKE_MAX_ASSESSMENTS_PER_SESSION,
  INTAKE_MAX_ROTATIONS,
  INTAKE_UPLOAD_INSPECTION_GRACE_MS,
  INTAKE_UPLOAD_INTENT_TTL_MS,
  normalizeIntakeFileName,
  normalizeIntakeIdentityName,
  intakeAssessmentFindingValidator,
  intakeAssessmentSourceValidator,
  intakeAssessmentStatusInputValidator,
  intakeInspectionAllowsClaim,
  isIntakeDocumentClaimable,
  normalizeIntakeAssessmentFindings,
  normalizeIntakeAssessmentStatus,
  projectIntakeAssessment,
  projectIntakeDocument,
  type IntakeDocumentProjection,
  type IntakeInspectionStatus,
} from './_intake/model'
import { consumeIntakeServerProof, type IntakeServerProofInput } from './_intake/serverProof'
import {
  requireActiveIntakeSession,
  requireIntakeDeletionAuthority,
  resolveActiveIntakeSession,
} from './_intake/sessions'
import { deleteIntakeSessionData } from './_intake/storage'
import {
  intakeSupportScope,
  normalizeSupportMessage,
  projectSupportMessage,
  supportScopeKey,
} from './_support/model'

const proofArgs = {
  serverIssuedAt: v.number(),
  proofNonce: v.string(),
  serverProof: v.string(),
}

/** La forma que comparten los handlers que sólo prueban el token de la sala. */
const sessionProofArgs = { sessionToken: v.string(), ...proofArgs }

const signatureValidator = v.union(
  v.literal('PDF'),
  v.literal('ZIP'),
  v.literal('OLE'),
  v.literal('TEXT'),
  v.literal('UNKNOWN')
)

const inspectionStatusValidator = v.union(
  v.literal('CLEAN'),
  v.literal('NOT_CONFIGURED'),
  v.literal('UNINSPECTED'),
  v.literal('SUSPICIOUS')
)

const MAX_ACTIVE_SESSIONS_PER_ANONYMOUS_KEY = 3
const MAX_RECONCILIATION_BATCH = 200
const MAX_INTAKE_SUPPORT_MESSAGES = 30
const INTAKE_SUPPORT_MESSAGE_LIMIT = 12
const ADMIN_INTAKE_WORKSPACE_READ_LIMIT = 120
const ADMIN_INTAKE_WORKSPACE_READ_WINDOW_MS = 5 * 60 * 1000
type IntakeReadCtx = MutationCtx | QueryCtx

function proofFrom(args: IntakeServerProofInput): IntakeServerProofInput {
  return {
    serverIssuedAt: args.serverIssuedAt,
    proofNonce: args.proofNonce,
    serverProof: args.serverProof,
  }
}

function validAnonymousKey(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value)
}

function uploadBindingParts(args: {
  sessionToken: string
  fileName: string
  declaredMimeType: string
  declaredByteSize: number
  declaredSha256: string
}): string[] {
  return [
    args.sessionToken,
    args.fileName,
    args.declaredMimeType,
    `${args.declaredByteSize}`,
    args.declaredSha256,
  ]
}

function registerBindingParts(args: {
  sessionToken: string
  intentId: Id<'intakeUploadIntents'>
  storageId: Id<'_storage'>
}): string[] {
  return [args.sessionToken, `${args.intentId}`, `${args.storageId}`]
}

async function listSessionDocuments(
  ctx: IntakeReadCtx,
  intakeSessionId: Id<'intakeSessions'>
): Promise<IntakeDocumentProjection[]> {
  const rows = await ctx.db
    .query('intakeDocuments')
    .withIndex('by_session_createdAt', (q) => q.eq('intakeSessionId', intakeSessionId))
    .collect()
  return rows.map(projectIntakeDocument)
}

async function latestSessionAssessment(ctx: IntakeReadCtx, intakeSessionId: Id<'intakeSessions'>) {
  const rows = await ctx.db
    .query('intakeAssessments')
    .withIndex('by_session', (q) => q.eq('intakeSessionId', intakeSessionId))
    .take(INTAKE_MAX_ASSESSMENTS_PER_SESSION + 1)
  if (rows.length > INTAKE_MAX_ASSESSMENTS_PER_SESSION) {
    throw invalidState(
      'La sala temporal excede el límite de evaluaciones.',
      'INTAKE_ASSESSMENT_LIMIT'
    )
  }

  return rows.reduce<(typeof rows)[number] | null>((latest, candidate) => {
    if (!latest) return candidate
    if (candidate.updatedAt !== latest.updatedAt) {
      return candidate.updatedAt > latest.updatedAt ? candidate : latest
    }
    if (candidate.createdAt !== latest.createdAt) {
      return candidate.createdAt > latest.createdAt ? candidate : latest
    }
    return candidate._creationTime > latest._creationTime ? candidate : latest
  }, null)
}

async function projectSessionAssessment(
  ctx: IntakeReadCtx,
  assessment: Doc<'intakeAssessments'>,
  intakeSessionId: Id<'intakeSessions'>
) {
  for (const finding of assessment.findings) {
    for (const evidenceDocumentId of finding.evidenceDocumentIds) {
      const document = await ctx.db.get(evidenceDocumentId)
      if (!document || document.intakeSessionId !== intakeSessionId) {
        throw invalidState(
          'La evaluación contiene evidencia fuera de su sesión.',
          'INTAKE_ASSESSMENT_EVIDENCE_SCOPE'
        )
      }
    }
  }
  return projectIntakeAssessment(assessment)
}

async function workspaceProjection(ctx: IntakeReadCtx, session: Doc<'intakeSessions'>) {
  const assessment = await latestSessionAssessment(ctx, session._id)
  return {
    authorized: true as const,
    accessExpiresAt: session.accessExpiresAt,
    identityName: session.identityEvidence?.name,
    documents: await listSessionDocuments(ctx, session._id),
    assessment: assessment ? await projectSessionAssessment(ctx, assessment, session._id) : null,
  }
}

const createSessionArgs = {
  anonymousKey: v.string(),
  identityName: v.optional(v.string()),
  ...proofArgs,
}

const createSessionProgram = Effect.fn('Intake.createSession')(function* (
  ctx: MutationCtx,
  args: ObjectType<typeof createSessionArgs>
) {
  yield* convexPromise(() =>
    consumeIntakeServerProof({
      ctx,
      operation: 'CREATE_SESSION',
      bindingParts: [args.anonymousKey, args.identityName ?? '-'],
      proof: proofFrom(args),
    })
  )
  if (!validAnonymousKey(args.anonymousKey)) {
    return yield* Effect.fail(
      validationFailed('La solicitud temporal no es válida.', 'anonymousKey')
    )
  }

  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `intakeSession:${args.anonymousKey}`,
      limit: 10,
      windowMs: 24 * 60 * 60 * 1000,
    })
  )
  const now = Date.now()
  const active = yield* convexPromise(() =>
    ctx.db
      .query('intakeSessions')
      .withIndex('by_anonymousKey_status', (q) =>
        q.eq('anonymousKeyHash', args.anonymousKey).eq('status', 'ACTIVE')
      )
      .filter((q) =>
        q.and(q.gt(q.field('accessExpiresAt'), now), q.gt(q.field('absoluteExpiresAt'), now))
      )
      .take(MAX_ACTIVE_SESSIONS_PER_ANONYMOUS_KEY + 1)
  )
  if (active.length >= MAX_ACTIVE_SESSIONS_PER_ANONYMOUS_KEY) {
    return yield* Effect.fail(
      invalidState('No se puede abrir otra sala temporal en este momento.', 'INTAKE_SESSION_LIMIT')
    )
  }

  const identityName = normalizeIntakeIdentityName(args.identityName)
  const sessionToken = createOpaqueIntakeToken()
  const accessExpiresAt = now + INTAKE_ACCESS_TTL_MS
  const absoluteExpiresAt = now + INTAKE_ABSOLUTE_ACCESS_TTL_MS
  const deletionProofExpiresAt = now + INTAKE_DELETION_PROOF_TTL_MS
  const sessionTokenHash = yield* convexPromise(() => hashIntakeSessionToken(sessionToken))
  const intakeSessionId = yield* convexPromise(() =>
    ctx.db.insert('intakeSessions', {
      sessionTokenHash,
      anonymousKeyHash: args.anonymousKey,
      audience: process.env.INTAKE_SERVER_AUDIENCE!,
      status: 'ACTIVE',
      identityEvidence: identityName
        ? { kind: 'NAME' as const, name: identityName, capturedAt: now }
        : undefined,
      claimStatus: 'UNCLAIMED',
      createdAt: now,
      accessExpiresAt,
      absoluteExpiresAt,
      deletionProofExpiresAt,
      rotationCount: 0,
      documentCount: 0,
      totalStagedBytes: 0,
    })
  )
  yield* convexPromise(() =>
    ctx.db.insert('intakeEvents', {
      intakeSessionId,
      type: 'SESSION_CREATED',
      createdAt: now,
    })
  )

  return {
    sessionToken,
    accessExpiresAt,
    deletionProofExpiresAt,
    workspace: {
      authorized: true as const,
      accessExpiresAt,
      identityName,
      documents: [] as IntakeDocumentProjection[],
      assessment: null,
    },
  }
})

export const createSession = mutation({
  args: createSessionArgs,
  handler: (ctx, args) => runConvex(createSessionProgram(ctx, args)),
})

const resolveSessionProgram = Effect.fn('Intake.resolveSession')(function* (
  ctx: MutationCtx,
  args: ObjectType<typeof sessionProofArgs>
) {
  yield* convexPromise(() =>
    consumeIntakeServerProof({
      ctx,
      operation: 'RESOLVE_SESSION',
      bindingParts: [args.sessionToken],
      proof: proofFrom(args),
    })
  )
  const session = yield* convexPromise(() => resolveActiveIntakeSession(ctx, args.sessionToken))
  if (!session) return { authenticated: false as const }
  return {
    authenticated: true as const,
    accessExpiresAt: session.accessExpiresAt,
    deletionProofExpiresAt: session.deletionProofExpiresAt,
  }
})

export const resolveSession = mutation({
  args: sessionProofArgs,
  handler: (ctx, args) => runConvex(resolveSessionProgram(ctx, args)),
})

const projectWorkspaceProgram = Effect.fn('Intake.projectWorkspace')(function* (
  ctx: MutationCtx,
  args: ObjectType<typeof sessionProofArgs>
) {
  yield* convexPromise(() =>
    consumeIntakeServerProof({
      ctx,
      operation: 'PROJECT_WORKSPACE',
      bindingParts: [args.sessionToken],
      proof: proofFrom(args),
    })
  )
  const session = yield* convexPromise(() => resolveActiveIntakeSession(ctx, args.sessionToken))
  if (!session) return { authenticated: false as const }
  return {
    authenticated: true as const,
    ...(yield* convexPromise(() => workspaceProjection(ctx, session))),
  }
})

export const projectWorkspace = mutation({
  args: sessionProofArgs,
  handler: (ctx, args) => runConvex(projectWorkspaceProgram(ctx, args)),
})

/**
 * Store one bounded, source-backed intake assessment. Only an authenticated
 * team profile may write this projection. External producers are intentionally
 * restricted to pending findings; a team member must explicitly confirm or
 * reject each finding before an assessment can become ready.
 */
const recordIntakeAssessmentArgs = {
  intakeSessionId: v.id('intakeSessions'),
  source: intakeAssessmentSourceValidator,
  findings: v.array(intakeAssessmentFindingValidator),
  status: intakeAssessmentStatusInputValidator,
}

const recordIntakeAssessmentProgram = Effect.fn('Intake.recordIntakeAssessment')(function* (
  ctx: MutationCtx,
  args: ObjectType<typeof recordIntakeAssessmentArgs>
) {
  const auth = yield* convexPromise(() => requireAuthAdmin(ctx))
  const session = yield* convexPromise(() => ctx.db.get(args.intakeSessionId))
  if (!session) {
    return yield* Effect.fail(
      invalidState('La sesión temporal no existe.', 'INTAKE_SESSION_NOT_FOUND')
    )
  }

  const existingAssessments = yield* convexPromise(() =>
    ctx.db
      .query('intakeAssessments')
      .withIndex('by_session', (q) => q.eq('intakeSessionId', session._id))
      .take(INTAKE_MAX_ASSESSMENTS_PER_SESSION + 1)
  )
  if (existingAssessments.length >= INTAKE_MAX_ASSESSMENTS_PER_SESSION) {
    return yield* Effect.fail(
      invalidState('La sala temporal excede el límite de evaluaciones.', 'INTAKE_ASSESSMENT_LIMIT')
    )
  }

  const findings = normalizeIntakeAssessmentFindings(args.findings, args.source)
  for (const finding of findings) {
    for (const evidenceDocumentId of finding.evidenceDocumentIds) {
      const document = yield* convexPromise(() =>
        ctx.db.get(evidenceDocumentId as Id<'intakeDocuments'>)
      )
      if (!document || document.intakeSessionId !== session._id) {
        return yield* Effect.fail(unauthorized('La evidencia no pertenece a esta sesión temporal.'))
      }
    }
  }

  const status = normalizeIntakeAssessmentStatus(args.status, args.source, findings)
  const now = Date.now()
  const assessmentId = yield* convexPromise(() =>
    ctx.db.insert('intakeAssessments', {
      intakeSessionId: session._id,
      status,
      source: args.source,
      findings: findings.map((finding) => ({
        category: finding.category,
        evidenceDocumentIds: finding.evidenceDocumentIds as Id<'intakeDocuments'>[],
        confidence: finding.confidence,
        reviewState: finding.reviewState,
      })),
      createdAt: now,
      updatedAt: now,
    })
  )

  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: auth.profile._id,
      adminEmail: auth.user.email,
      action: 'SYSTEM_CONFIG_CHANGE',
      targetType: 'SYSTEM',
      targetId: `${assessmentId}`,
      newValue: {
        kind: 'INTAKE_ASSESSMENT',
        intakeSessionId: `${session._id}`,
        source: args.source,
        status,
        findingCount: findings.length,
      },
      notes: 'INTAKE_ASSESSMENT_RECORDED',
    })
  )

  const assessment = yield* convexPromise(() => ctx.db.get(assessmentId))
  if (!assessment) {
    return yield* Effect.fail(
      invalidState('No se pudo confirmar la evaluación.', 'INTAKE_ASSESSMENT_MISSING')
    )
  }
  return projectIntakeAssessment(assessment)
})

export const recordIntakeAssessment = mutation({
  args: recordIntakeAssessmentArgs,
  handler: (ctx, args) => runConvex(recordIntakeAssessmentProgram(ctx, args)),
})

/**
 * Bounded admin read model for the temporary-room review surface. The caller
 * may optionally bind the session to the company currently being operated;
 * this prevents a valid intake id from being combined with another company
 * page while keeping the support queue able to review unclaimed rooms.
 *
 * The projection deliberately reuses the same document/assessment whitelists
 * as the temporary workspace. Storage ids, tokens, and raw session rows never
 * cross this boundary.
 *
 * This is intentionally a mutation: every admin read is rate-limited and
 * records the bounded metadata that was returned in the audit log.
 */
const getAdminIntakeWorkspaceProgram = Effect.fn('Intake.getAdminIntakeWorkspace')(function* (
  ctx: MutationCtx,
  args: { intakeSessionId: Id<'intakeSessions'>; companyId?: Id<'companies'> }
) {
  const auth = yield* convexPromise(() => requireAuthAdmin(ctx))
  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `adminIntakeWorkspaceRead:${auth.profile._id}`,
      limit: ADMIN_INTAKE_WORKSPACE_READ_LIMIT,
      windowMs: ADMIN_INTAKE_WORKSPACE_READ_WINDOW_MS,
    })
  )

  const session = yield* convexPromise(() => ctx.db.get(args.intakeSessionId))
  if (!session) {
    return yield* Effect.fail(
      invalidState('La sesión temporal no existe.', 'INTAKE_SESSION_NOT_FOUND')
    )
  }
  if (args.companyId !== undefined && session.claimedCompanyId !== args.companyId) {
    return yield* Effect.fail(unauthorized('La sesión temporal no pertenece a esta empresa.'))
  }

  const assessment = yield* convexPromise(() => latestSessionAssessment(ctx, session._id))
  const workspace = {
    intakeSessionId: session._id,
    status: session.status,
    claimedCompanyId: session.claimedCompanyId ?? null,
    identityName: session.identityEvidence?.name ?? null,
    documents: yield* convexPromise(() => listSessionDocuments(ctx, session._id)),
    assessment: assessment
      ? yield* convexPromise(() => projectSessionAssessment(ctx, assessment, session._id))
      : null,
  }

  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: auth.profile._id,
      adminEmail: auth.user.email,
      action: 'SYSTEM_CONFIG_CHANGE',
      targetType: 'SYSTEM',
      targetId: `${session._id}`,
      notes: 'INTAKE_WORKSPACE_READ',
      newValue: {
        operation: 'INTAKE_WORKSPACE_READ',
        intakeSessionId: `${session._id}`,
        companyId: args.companyId !== undefined ? `${args.companyId}` : null,
        claimedCompanyId: session.claimedCompanyId ? `${session.claimedCompanyId}` : null,
        sessionStatus: session.status,
        documentCount: workspace.documents.length,
        assessmentId: workspace.assessment?.id ?? null,
        assessmentStatus: workspace.assessment?.status ?? null,
      },
    })
  )

  return workspace
})

export const getAdminIntakeWorkspace = mutation({
  args: {
    intakeSessionId: v.id('intakeSessions'),
    companyId: v.optional(v.id('companies')),
  },
  handler: (ctx, args) => runConvex(getAdminIntakeWorkspaceProgram(ctx, args)),
})

const rotateSessionArgs = {
  sessionToken: v.string(),
  identityName: v.optional(v.string()),
  ...proofArgs,
}

const rotateSessionProgram = Effect.fn('Intake.rotateSession')(function* (
  ctx: MutationCtx,
  args: ObjectType<typeof rotateSessionArgs>
) {
  const boundIdentityName = args.identityName
  yield* convexPromise(() =>
    consumeIntakeServerProof({
      ctx,
      operation: 'ROTATE_SESSION',
      bindingParts:
        boundIdentityName === undefined
          ? [args.sessionToken]
          : [args.sessionToken, boundIdentityName],
      proof: proofFrom(args),
    })
  )
  const session = yield* convexPromise(() => resolveActiveIntakeSession(ctx, args.sessionToken))
  if (!session) return { rotated: false as const }
  if (session.rotationCount >= INTAKE_MAX_ROTATIONS) {
    return yield* Effect.fail(
      invalidState('La sesión temporal alcanzó su límite de rotaciones.', 'INTAKE_ROTATION_LIMIT')
    )
  }

  const now = Date.now()
  const sessionToken = createOpaqueIntakeToken()
  const accessExpiresAt = Math.min(session.absoluteExpiresAt, now + INTAKE_ACCESS_TTL_MS)
  if (accessExpiresAt <= now) return { rotated: false as const }
  const identityName = normalizeIntakeIdentityName(args.identityName)
  const updatedIdentityEvidence =
    args.identityName === undefined
      ? session.identityEvidence
      : identityName
        ? { kind: 'NAME' as const, name: identityName, capturedAt: now }
        : undefined
  const identityPatch =
    args.identityName === undefined ? {} : { identityEvidence: updatedIdentityEvidence }
  const sessionTokenHash = yield* convexPromise(() => hashIntakeSessionToken(sessionToken))
  yield* convexPromise(() =>
    ctx.db.patch(session._id, {
      sessionTokenHash,
      accessExpiresAt,
      rotatedAt: now,
      rotationCount: session.rotationCount + 1,
      ...identityPatch,
    })
  )
  yield* convexPromise(() =>
    ctx.db.insert('intakeEvents', {
      intakeSessionId: session._id,
      type: 'SESSION_ROTATED',
      createdAt: now,
    })
  )
  const updated = {
    ...session,
    accessExpiresAt,
    ...(args.identityName === undefined ? {} : { identityEvidence: updatedIdentityEvidence }),
  }
  return {
    rotated: true as const,
    sessionToken,
    accessExpiresAt,
    deletionProofExpiresAt: session.deletionProofExpiresAt,
    workspace: yield* convexPromise(() => workspaceProjection(ctx, updated)),
  }
})

export const rotateSession = mutation({
  args: rotateSessionArgs,
  handler: (ctx, args) => runConvex(rotateSessionProgram(ctx, args)),
})

const revokeSessionProgram = Effect.fn('Intake.revokeSession')(function* (
  ctx: MutationCtx,
  args: ObjectType<typeof sessionProofArgs>
) {
  yield* convexPromise(() =>
    consumeIntakeServerProof({
      ctx,
      operation: 'REVOKE_SESSION',
      bindingParts: [args.sessionToken],
      proof: proofFrom(args),
    })
  )
  const session = yield* convexPromise(() => requireActiveIntakeSession(ctx, args.sessionToken))
  const now = Date.now()
  yield* convexPromise(() =>
    ctx.db.patch(session._id, {
      status: 'REVOKED',
      revokedAt: now,
      revokedReason: 'VISITOR_ENDED_ACCESS',
    })
  )
  yield* convexPromise(() =>
    ctx.db.insert('intakeEvents', {
      intakeSessionId: session._id,
      type: 'SESSION_REVOKED',
      createdAt: now,
    })
  )
  return { revoked: true as const }
})

export const revokeSession = mutation({
  args: sessionProofArgs,
  handler: (ctx, args) => runConvex(revokeSessionProgram(ctx, args)),
})

const claimToAuthenticatedCompanyProgram = Effect.fn('Intake.claimToAuthenticatedCompany')(
  function* (
    ctx: MutationCtx,
    args: {
      sessionToken: string
      workosSubject: string
      claimNonce: string
      claimProof: string
    }
  ) {
    const auth = yield* requireAuthEffect(ctx)
    if (
      auth.identity.authProvider !== 'workos' ||
      auth.identity.subject !== args.workosSubject ||
      auth.user.workosUserId !== auth.identity.subject ||
      auth.profile.role !== 'COMPANY'
    ) {
      return yield* Effect.fail(unauthorized('Solicitud de claim no autorizada.'))
    }
    const claimDigest = yield* convexPromise(() => verifyIntakeClaimProof(args))
    const authorization = yield* convexPromise(() => resolveCurrentCompanyAuthorization(ctx, auth))
    if (
      !authorization ||
      authorization.access !== 'MANAGE' ||
      authorization.company.ownerId !== auth.profile._id
    ) {
      return yield* Effect.fail(unauthorized('Solicitud de claim no autorizada.'))
    }
    return yield* convexPromise(() =>
      prepareOrReconcileIntakeClaim({
        ctx,
        sessionToken: args.sessionToken,
        claimDigest,
        profileId: auth.profile._id,
        companyId: authorization.company._id,
      })
    )
  }
)

export const claimToAuthenticatedCompany = mutation({
  args: {
    sessionToken: v.string(),
    workosSubject: v.string(),
    claimNonce: v.string(),
    claimProof: v.string(),
  },
  handler: (ctx, args): Promise<IntakeClaimResult> =>
    runConvex(claimToAuthenticatedCompanyProgram(ctx, args)),
})

const reconcileClaimProgram = Effect.fn('Intake.reconcileClaim')(function* (
  ctx: MutationCtx,
  args: { claimDigest: string }
) {
  return yield* convexPromise(() => reconcileIntakeClaimByDigest(ctx, args.claimDigest))
})

export const _reconcileClaim = internalMutation({
  args: { claimDigest: v.string() },
  handler: (ctx, args): Promise<IntakeClaimResult> => runConvex(reconcileClaimProgram(ctx, args)),
})

async function loadIntakeSupportThread(ctx: MutationCtx, intakeSessionId: Id<'intakeSessions'>) {
  const scope = intakeSupportScope(intakeSessionId)
  const scopeKey = supportScopeKey(scope)
  const rows = await ctx.db
    .query('supportThreads')
    .withIndex('by_scopeKey', (q) => q.eq('scopeKey', scopeKey))
    .take(2)
  if (rows.length > 1) {
    throw invalidState(
      'La sala tiene más de una conversación de soporte.',
      'SUPPORT_SCOPE_DUPLICATE'
    )
  }
  const thread = rows[0] ?? null
  if (
    thread &&
    (thread.scopeKey !== scopeKey ||
      thread.scope.kind !== 'INTAKE' ||
      thread.scope.intakeSessionId !== intakeSessionId)
  ) {
    throw invalidState('La conversación no tiene un alcance válido.', 'SUPPORT_SCOPE_INVALID')
  }
  return { scope, scopeKey, thread }
}

const getIntakeSupportProgram = Effect.fn('Intake.getIntakeSupport')(function* (
  ctx: MutationCtx,
  args: ObjectType<typeof sessionProofArgs>
) {
  yield* convexPromise(() =>
    consumeIntakeServerProof({
      ctx,
      operation: 'SUPPORT_READ',
      bindingParts: [args.sessionToken],
      proof: proofFrom(args),
    })
  )
  const session = yield* convexPromise(() => requireActiveIntakeSession(ctx, args.sessionToken))
  const { thread } = yield* convexPromise(() => loadIntakeSupportThread(ctx, session._id))
  if (!thread) return { threadId: null, messages: [], truncated: false }

  const rows = yield* convexPromise(() =>
    ctx.db
      .query('supportMessages')
      .withIndex('by_thread_sequence', (q) => q.eq('threadId', thread._id))
      .order('desc')
      .take(MAX_INTAKE_SUPPORT_MESSAGES + 1)
  )
  const truncated = rows.length > MAX_INTAKE_SUPPORT_MESSAGES
  const messages = rows.slice(0, MAX_INTAKE_SUPPORT_MESSAGES).reverse().map(projectSupportMessage)
  if (thread.clientUnreadCount > 0 || thread.clientUnread) {
    yield* convexPromise(() =>
      ctx.db.patch(thread._id, {
        clientReadThroughSequence: thread.lastSequence,
        clientUnreadCount: 0,
        clientUnread: false,
      })
    )
  }
  return { threadId: thread._id, messages, truncated }
})

export const getIntakeSupport = mutation({
  args: sessionProofArgs,
  handler: (ctx, args) => runConvex(getIntakeSupportProgram(ctx, args)),
})

const sendIntakeSupportMessageArgs = {
  sessionToken: v.string(),
  body: v.string(),
  ...proofArgs,
}

const sendIntakeSupportMessageProgram = Effect.fn('Intake.sendIntakeSupportMessage')(function* (
  ctx: MutationCtx,
  args: ObjectType<typeof sendIntakeSupportMessageArgs>
) {
  const body = normalizeSupportMessage(args.body)
  const bodyDigest = yield* convexPromise(() => sha256Hex(body))
  yield* convexPromise(() =>
    consumeIntakeServerProof({
      ctx,
      operation: 'SUPPORT_SEND',
      bindingParts: [args.sessionToken, bodyDigest],
      proof: proofFrom(args),
    })
  )
  const session = yield* convexPromise(() => requireActiveIntakeSession(ctx, args.sessionToken))
  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `intakeSupport:${session._id}`,
      limit: INTAKE_SUPPORT_MESSAGE_LIMIT,
      windowMs: 5 * 60 * 1000,
    })
  )
  const { scope, scopeKey, thread } = yield* convexPromise(() =>
    loadIntakeSupportThread(ctx, session._id)
  )
  const now = Date.now()
  const previousSequence = thread?.lastSequence ?? 0
  const sequence = previousSequence + 1
  if (!Number.isSafeInteger(sequence)) {
    return yield* Effect.fail(
      invalidState('La conversación alcanzó su límite.', 'SUPPORT_SEQUENCE_LIMIT')
    )
  }
  const threadId = thread
    ? thread._id
    : yield* convexPromise(() =>
        ctx.db.insert('supportThreads', {
          scope,
          scopeKey,
          lastSequence: 0,
          adminReadThroughSequence: 0,
          clientReadThroughSequence: 0,
          adminUnreadCount: 0,
          clientUnreadCount: 0,
          adminUnread: false,
          clientUnread: false,
          createdAt: now,
          updatedAt: now,
          lastMessageAt: now,
        })
      )
  const messageId = yield* convexPromise(() =>
    ctx.db.insert('supportMessages', {
      threadId,
      sequence,
      author: { kind: 'INTAKE' as const },
      body,
      createdAt: now,
    })
  )
  yield* convexPromise(() =>
    ctx.db.patch(threadId, {
      lastSequence: sequence,
      adminUnreadCount: (thread?.adminUnreadCount ?? 0) + 1,
      adminUnread: true,
      updatedAt: now,
      lastMessageAt: now,
    })
  )
  const message = yield* convexPromise(() => ctx.db.get(messageId))
  if (!message) {
    return yield* Effect.fail(
      invalidState('No se pudo confirmar el mensaje.', 'SUPPORT_MESSAGE_MISSING')
    )
  }
  return { threadId, message: projectSupportMessage(message) }
})

export const sendIntakeSupportMessage = mutation({
  args: sendIntakeSupportMessageArgs,
  handler: (ctx, args) => runConvex(sendIntakeSupportMessageProgram(ctx, args)),
})

const deleteDataProgram = Effect.fn('Intake.deleteData')(function* (
  ctx: MutationCtx,
  args: ObjectType<typeof sessionProofArgs>
) {
  const session = yield* convexPromise(() => requireIntakeDeletionAuthority(ctx, args.sessionToken))
  if (session.claimStatus === 'PROCESSING') {
    return yield* Effect.fail(
      invalidState('El claim todavía está en proceso.', 'INTAKE_CLAIM_PROCESSING')
    )
  }
  yield* convexPromise(() =>
    consumeIntakeServerProof({
      ctx,
      operation: 'DELETE_DATA',
      bindingParts: [args.sessionToken],
      proof: proofFrom(args),
      intakeSessionId: session._id,
    })
  )
  if (session.claimStatus === 'FAILED') {
    yield* convexPromise(() => resetPendingClaimForDeletion(ctx, session._id))
  }
  yield* convexPromise(() => deleteIntakeSessionData(ctx, session._id))
  return { deleted: true as const }
})

export const deleteData = mutation({
  args: sessionProofArgs,
  handler: (ctx, args) => runConvex(deleteDataProgram(ctx, args)),
})

function validateDeclaredUpload(args: {
  fileName: string
  declaredMimeType: string
  declaredByteSize: number
  declaredSha256: string
}):
  | {
      fileName: string
      declaredMimeType: string
      declaredByteSize: number
      declaredSha256: string
    }
  | { registered: false; code: 'FILE_TOO_LARGE' } {
  const fileName = normalizeIntakeFileName(args.fileName)
  const declaredMimeType = args.declaredMimeType.trim().toLowerCase()
  if (!(DIRECT_UPLOAD_ALLOWED_MIME_TYPES as readonly string[]).includes(declaredMimeType)) {
    throw validationFailed('El tipo de archivo no está permitido.', 'declaredMimeType')
  }
  if (!Number.isSafeInteger(args.declaredByteSize) || args.declaredByteSize <= 0) {
    throw validationFailed('El tamaño del archivo no está permitido.', 'declaredByteSize')
  }
  if (args.declaredByteSize > directUploadLimitBytesForMimeType(declaredMimeType)) {
    return { registered: false, code: 'FILE_TOO_LARGE' }
  }
  const declaredSha256 = args.declaredSha256.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(declaredSha256)) {
    throw validationFailed('La huella del archivo no es válida.', 'declaredSha256')
  }
  return { fileName, declaredMimeType, declaredByteSize: args.declaredByteSize, declaredSha256 }
}

const issueUploadIntentArgs = {
  sessionToken: v.string(),
  fileName: v.string(),
  declaredMimeType: v.string(),
  declaredByteSize: v.number(),
  declaredSha256: v.string(),
  /** El cliente reintenta un archivo que ya tuvo un intento terminal no recibido. */
  supersedePending: v.optional(v.boolean()),
  ...proofArgs,
}

const issueUploadIntentProgram = Effect.fn('Intake.issueUploadIntent')(function* (
  ctx: MutationCtx,
  args: ObjectType<typeof issueUploadIntentArgs>
) {
  yield* convexPromise(() =>
    consumeIntakeServerProof({
      ctx,
      operation: 'ISSUE_UPLOAD',
      bindingParts: uploadBindingParts(args),
      proof: proofFrom(args),
    })
  )
  const session = yield* convexPromise(() => requireActiveIntakeSession(ctx, args.sessionToken))
  const file = yield* convexSync(() => validateDeclaredUpload(args))
  if ('registered' in file) return file
  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `intakeUploadIntent:${session._id}`,
      limit: 40,
      windowMs: 60 * 60 * 1000,
    })
  )

  const existingDocuments = yield* convexPromise(() =>
    ctx.db
      .query('intakeDocuments')
      .withIndex('by_session_createdAt', (q) => q.eq('intakeSessionId', session._id))
      .collect()
  )
  const existingDocument = existingDocuments.find(
    (document) => document.sha256.toLowerCase() === file.declaredSha256
  )
  if (existingDocument) {
    return {
      alreadyRegistered: true as const,
      document: projectIntakeDocument(existingDocument),
    }
  }

  const duplicateWithStatus = (status: 'ISSUED' | 'INSPECTING') =>
    ctx.db
      .query('intakeUploadIntents')
      .withIndex('by_session_sha_status', (q) =>
        q
          .eq('intakeSessionId', session._id)
          .eq('declaredSha256', file.declaredSha256)
          .eq('status', status)
      )
      .collect()

  // Un intent INSPECTING ya tiene los bytes en storage: la inspección va a
  // decidir y una segunda carga solo duplicaría el blob.
  const inspecting = yield* convexPromise(() => duplicateWithStatus('INSPECTING'))
  if (inspecting.length > 0) {
    return yield* Effect.fail(
      invalidState('Este archivo ya tiene una carga pendiente.', 'INTAKE_UPLOAD_PENDING')
    )
  }

  const now = Date.now()
  // Un intent ISSUED de la misma huella puede ser una carga que este cliente
  // canceló o dejó a medias (sin bytes registrados ni documento) o una que
  // otra pestaña tiene a mitad de XHR. Solo el cliente sabe cuál: con
  // `supersedePending` — que manda únicamente tras un intento terminal no
  // recibido del mismo archivo — se supersede con el mismo estado terminal
  // que usa la barrida de expiración y se emite uno nuevo con URL nueva,
  // para que «puedes seguir cuando quieras» no espere los diez minutos del
  // TTL. Sin el flag, un ISSUED vigente sigue siendo una carga pendiente.
  const issued = yield* convexPromise(() => duplicateWithStatus('ISSUED'))
  if (issued.length > 0) {
    if (args.supersedePending !== true) {
      return yield* Effect.fail(
        invalidState('Este archivo ya tiene una carga pendiente.', 'INTAKE_UPLOAD_PENDING')
      )
    }
    for (const stale of issued) {
      yield* convexPromise(() => ctx.db.patch(stale._id, { status: 'EXPIRED', expiredAt: now }))
    }
  }

  const expiresAt = now + INTAKE_UPLOAD_INTENT_TTL_MS
  const intentId = yield* convexPromise(() =>
    ctx.db.insert('intakeUploadIntents', {
      intakeSessionId: session._id,
      status: 'ISSUED',
      ...file,
      createdAt: now,
      expiresAt,
    })
  )
  const uploadUrl = yield* convexPromise(() => ctx.storage.generateUploadUrl())
  yield* convexPromise(() =>
    ctx.db.insert('intakeEvents', {
      intakeSessionId: session._id,
      type: 'UPLOAD_INTENT_ISSUED',
      uploadIntentId: intentId,
      createdAt: now,
    })
  )
  return { alreadyRegistered: false as const, intentId, uploadUrl, expiresAt }
})

export const issueUploadIntent = mutation({
  args: issueUploadIntentArgs,
  handler: (ctx, args) => runConvex(issueUploadIntentProgram(ctx, args)),
})

type PreparedUpload =
  | {
      status: 'READY'
      intakeSessionId: Id<'intakeSessions'>
      intent: Doc<'intakeUploadIntents'>
      size: number
      sha256: string
      contentType: string
    }
  | { status: 'ALREADY_REGISTERED'; document: IntakeDocumentProjection; clean: boolean }
  | { status: 'REJECTED'; code: string }

async function hasConflictingStorageReference(
  ctx: MutationCtx,
  storageId: Id<'_storage'>
): Promise<boolean> {
  const [intakeDocument, document, version, intakeIntent, vdrIntent, assetIntent] =
    await Promise.all([
      ctx.db
        .query('intakeDocuments')
        .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
        .first(),
      ctx.db
        .query('documents')
        .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
        .first(),
      ctx.db
        .query('documentVersions')
        .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
        .first(),
      ctx.db
        .query('intakeUploadIntents')
        .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
        .first(),
      ctx.db
        .query('vdrUploadIntents')
        .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
        .first(),
      ctx.db
        .query('assetUploadIntents')
        .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
        .first(),
    ])
  return Boolean(
    intakeDocument || document || version || intakeIntent || vdrIntent || assetIntent
  )
}

const prepareUploadArgs = {
  sessionToken: v.string(),
  intentId: v.id('intakeUploadIntents'),
  storageId: v.id('_storage'),
  ...proofArgs,
}

const prepareUploadProgram = Effect.fn('Intake.prepareUpload')(function* (
  ctx: MutationCtx,
  args: ObjectType<typeof prepareUploadArgs>
): Effect.fn.Return<PreparedUpload, AppError> {
  yield* convexPromise(() =>
    consumeIntakeServerProof({
      ctx,
      operation: 'REGISTER_UPLOAD',
      bindingParts: registerBindingParts(args),
      proof: proofFrom(args),
    })
  )
  const session = yield* convexPromise(() => requireActiveIntakeSession(ctx, args.sessionToken))
  const intent = yield* convexPromise(() => ctx.db.get(args.intentId))
  if (!intent || intent.intakeSessionId !== session._id) {
    return yield* Effect.fail(unauthorized('La carga no pertenece a esta sesión temporal.'))
  }
  if (intent.status === 'CONSUMED' || intent.status === 'REJECTED') {
    const registeredDocumentId = intent.storageId === args.storageId ? intent.documentId : undefined
    if (registeredDocumentId) {
      const document = yield* convexPromise(() => ctx.db.get(registeredDocumentId))
      if (document && document.intakeSessionId === session._id) {
        return {
          status: 'ALREADY_REGISTERED',
          document: projectIntakeDocument(document),
          clean: isIntakeDocumentClaimable(document),
        }
      }
    }
    return { status: 'REJECTED', code: 'UPLOAD_INTENT_TERMINAL' }
  }
  if (intent.status !== 'ISSUED') {
    return yield* Effect.fail(
      invalidState('La carga requiere reconciliación.', 'INTAKE_UPLOAD_UNCERTAIN')
    )
  }

  const now = Date.now()
  if (intent.expiresAt <= now) {
    yield* convexPromise(() => ctx.db.patch(intent._id, { status: 'EXPIRED', expiredAt: now }))
    return { status: 'REJECTED', code: 'UPLOAD_INTENT_EXPIRED' }
  }
  const conflicting = yield* convexPromise(() =>
    hasConflictingStorageReference(ctx, args.storageId)
  )
  if (conflicting) {
    return yield* Effect.fail(
      unauthorized('El archivo no está autorizado para esta sesión temporal.')
    )
  }
  const blob = yield* convexPromise(() => ctx.db.system.get(args.storageId))
  if (!blob) {
    yield* convexPromise(() =>
      ctx.db.patch(intent._id, {
        status: 'REJECTED',
        storageId: args.storageId,
        rejectionReason: 'STORAGE_NOT_FOUND',
        rejectedAt: now,
      })
    )
    return { status: 'REJECTED', code: 'UPLOAD_INTENT_REJECTED' }
  }
  const contentType = (blob.contentType ?? '').trim().toLowerCase()
  if (
    blob.size !== intent.declaredByteSize ||
    normalizeSha256Hex(blob.sha256) !== intent.declaredSha256 ||
    contentType !== intent.declaredMimeType ||
    blob.size > MAX_DIRECT_UPLOAD_BYTES
  ) {
    yield* convexPromise(() =>
      ctx.db.patch(intent._id, {
        status: 'REJECTED',
        storageId: args.storageId,
        rejectionReason: 'UPLOAD_INTENT_MISMATCH',
        rejectedAt: now,
      })
    )
    return { status: 'REJECTED', code: 'UPLOAD_INTENT_MISMATCH' }
  }

  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `intakeInspection:${session._id}`,
      limit: 40,
      windowMs: 60 * 60 * 1000,
    })
  )
  yield* convexPromise(() =>
    ctx.db.patch(intent._id, {
      status: 'INSPECTING',
      storageId: args.storageId,
      preparedAt: now,
      expiresAt: now + INTAKE_UPLOAD_INSPECTION_GRACE_MS,
    })
  )
  return {
    status: 'READY',
    intakeSessionId: session._id,
    intent: { ...intent, status: 'INSPECTING', storageId: args.storageId },
    size: blob.size,
    sha256: intent.declaredSha256,
    contentType,
  }
})

export const _prepareUpload = internalMutation({
  args: prepareUploadArgs,
  handler: (ctx, args): Promise<PreparedUpload> => runConvex(prepareUploadProgram(ctx, args)),
})

type FinalizeArgs = {
  sessionToken: string
  intentId: Id<'intakeUploadIntents'>
  storageId: Id<'_storage'>
  inspectedSize: number
  inspectedSha256: string
  signature: FileSignature
  inspectionStatus: IntakeInspectionStatus
  quarantineReason?: string
  scannerEngine?: string
  scannerScanId?: string
  scannerDefinitionVersion?: string
  scannedAt?: number
}

type FinalizedUpload = {
  registered: boolean
  code?: string
  document: IntakeDocumentProjection
}

// El tipo de retorno va anotado porque el programa agenda por `internal.*`: sin
// la anotación, `_generated/api` necesitaría el tipo de este módulo para
// tiparse a sí mismo y `tsc` corta el ciclo devolviendo `any`.
const finalizeUploadProgram = Effect.fn('Intake.finalizeUpload')(function* (
  ctx: MutationCtx,
  args: FinalizeArgs
): Effect.fn.Return<FinalizedUpload, AppError> {
  const session = yield* convexPromise(() => requireActiveIntakeSession(ctx, args.sessionToken))
  const intent = yield* convexPromise(() => ctx.db.get(args.intentId))
  if (
    !intent ||
    intent.intakeSessionId !== session._id ||
    intent.status !== 'INSPECTING' ||
    intent.storageId !== args.storageId
  ) {
    return yield* Effect.fail(unauthorized('La carga no pertenece a esta sesión temporal.'))
  }
  const blob = yield* convexPromise(() => ctx.db.system.get(args.storageId))
  const contentType = (blob?.contentType ?? '').trim().toLowerCase()
  if (
    !blob ||
    blob.size !== args.inspectedSize ||
    normalizeSha256Hex(args.inspectedSha256) !== intent.declaredSha256 ||
    blob.size !== intent.declaredByteSize ||
    normalizeSha256Hex(blob.sha256) !== intent.declaredSha256 ||
    contentType !== intent.declaredMimeType ||
    !matchesDeclaredMimeType(contentType, args.signature)
  ) {
    return yield* Effect.fail(
      validationFailed('La inspección no coincide con el archivo.', 'storageId')
    )
  }

  const now = Date.now()
  const claimable = intakeInspectionAllowsClaim(args.inspectionStatus)
  const documentId = yield* convexPromise(() =>
    ctx.db.insert('intakeDocuments', {
      intakeSessionId: session._id,
      uploadIntentId: intent._id,
      displayName: intent.fileName,
      declaredMimeType: intent.declaredMimeType,
      detectedMimeType: contentType,
      byteSize: blob.size,
      sha256: intent.declaredSha256,
      storageId: args.storageId,
      storageState: 'STAGED_INTAKE',
      inspectionStatus: args.inspectionStatus,
      claimable,
      signatureKind: args.signature,
      scannerEngine: args.scannerEngine,
      scannerScanId: args.scannerScanId,
      scannerDefinitionVersion: args.scannerDefinitionVersion,
      scannedAt: args.scannedAt,
      quarantineReason: args.quarantineReason,
      createdAt: now,
    })
  )
  yield* convexPromise(() =>
    ctx.db.patch(intent._id, {
      status: claimable ? 'CONSUMED' : 'REJECTED',
      documentId,
      consumedAt: claimable ? now : undefined,
      rejectedAt: claimable ? undefined : now,
      rejectionReason: claimable ? undefined : args.quarantineReason,
    })
  )
  yield* convexPromise(() =>
    ctx.db.patch(session._id, {
      documentCount: session.documentCount + 1,
      totalStagedBytes: session.totalStagedBytes + blob.size,
    })
  )
  yield* convexPromise(() =>
    ctx.db.insert('intakeEvents', {
      intakeSessionId: session._id,
      type: claimable ? 'DOCUMENT_STAGED' : 'DOCUMENT_QUARANTINED',
      documentId,
      uploadIntentId: intent._id,
      outcomeCode: args.quarantineReason,
      createdAt: now,
    })
  )
  const document = yield* convexPromise(() => ctx.db.get(documentId))
  if (!document) {
    return yield* Effect.fail(
      invalidState('No se pudo confirmar el documento temporal.', 'INTAKE_DOCUMENT_UNCERTAIN')
    )
  }
  // Un archivo en cuarentena no es una entrega: el equipo se entera de lo que
  // el cliente logró dejar, no de lo que el escáner rechazó.
  if (claimable) {
    yield* convexPromise(() =>
      ctx.scheduler.runAfter(0, internal.notifications._recordIntakeUpload, {
        intakeSessionId: session._id,
        fileName: intent.fileName,
      })
    )
  }
  return {
    registered: claimable,
    ...(claimable ? {} : { code: args.quarantineReason ?? 'UPLOAD_QUARANTINED' }),
    document: projectIntakeDocument(document),
  }
})

export const _finalizeUpload = internalMutation({
  args: {
    sessionToken: v.string(),
    intentId: v.id('intakeUploadIntents'),
    storageId: v.id('_storage'),
    inspectedSize: v.number(),
    inspectedSha256: v.string(),
    signature: signatureValidator,
    inspectionStatus: inspectionStatusValidator,
    quarantineReason: v.optional(v.string()),
    scannerEngine: v.optional(v.string()),
    scannerScanId: v.optional(v.string()),
    scannerDefinitionVersion: v.optional(v.string()),
    scannedAt: v.optional(v.number()),
  },
  handler: (ctx, args): Promise<FinalizedUpload> => runConvex(finalizeUploadProgram(ctx, args)),
})

const prepareUploadRef = makeFunctionReference<
  'mutation',
  {
    sessionToken: string
    intentId: Id<'intakeUploadIntents'>
    storageId: Id<'_storage'>
    serverIssuedAt: number
    proofNonce: string
    serverProof: string
  },
  PreparedUpload
>('intake:_prepareUpload')

const finalizeUploadRef = makeFunctionReference<
  'mutation',
  FinalizeArgs,
  {
    registered: boolean
    code?: string
    document: IntakeDocumentProjection
  }
>('intake:_finalizeUpload')

async function quarantineUpload(
  ctx: { runMutation: (ref: typeof finalizeUploadRef, args: FinalizeArgs) => Promise<unknown> },
  args: Omit<FinalizeArgs, 'inspectionStatus'>,
  inspectionStatus: 'UNINSPECTED' | 'SUSPICIOUS'
) {
  return await ctx.runMutation(finalizeUploadRef, { ...args, inspectionStatus })
}

const inspectAndRegisterUploadProgram = Effect.fn('Intake.inspectAndRegisterUpload')(function* (
  ctx: ActionCtx,
  args: ObjectType<typeof prepareUploadArgs>
) {
  const prepared = yield* convexPromise(() => ctx.runMutation(prepareUploadRef, args))
  if (prepared.status === 'ALREADY_REGISTERED') {
    return {
      registered: prepared.clean,
      ...(prepared.clean ? {} : { code: 'UPLOAD_QUARANTINED' }),
      document: prepared.document,
    }
  }
  if (prepared.status === 'REJECTED') {
    return { registered: false as const, code: prepared.code }
  }

  const blob = yield* convexPromise(() => ctx.storage.get(args.storageId))
  const base: Omit<FinalizeArgs, 'inspectionStatus'> = {
    sessionToken: args.sessionToken,
    intentId: args.intentId,
    storageId: args.storageId,
    inspectedSize: prepared.size,
    inspectedSha256: prepared.sha256,
    signature: 'UNKNOWN',
  }
  if (!blob || blob.size !== prepared.size) {
    return yield* convexPromise(() =>
      quarantineUpload(ctx, { ...base, quarantineReason: 'SCAN_UNAVAILABLE' }, 'UNINSPECTED')
    )
  }

  const header = new Uint8Array(yield* convexPromise(() => blob.slice(0, 16).arrayBuffer()))
  const signature = detectFileSignature(header)
  base.signature = signature
  if (!matchesDeclaredMimeType(prepared.contentType, signature)) {
    return yield* convexPromise(() =>
      quarantineUpload(ctx, { ...base, quarantineReason: 'INVALID_FILE_SIGNATURE' }, 'SUSPICIOUS')
    )
  }
  if (signature === 'ZIP') {
    const zipSafety = yield* convexPromise(() => inspectZipSafety(blob))
    if (!zipSafety.safe) {
      const quarantineReason = zipSafety.code
      return yield* convexPromise(() =>
        quarantineUpload(ctx, { ...base, quarantineReason }, 'SUSPICIOUS')
      )
    }
  }
  if (prepared.contentType === 'text/csv') {
    const csv = yield* convexPromise(() => inspectCsvFile(blob))
    if (!csv.safe) {
      return yield* convexPromise(() =>
        quarantineUpload(ctx, { ...base, quarantineReason: 'INVALID_FILE_SIGNATURE' }, 'SUSPICIOUS')
      )
    }
  } else if (prepared.contentType !== 'application/pdf') {
    const officeOk = yield* convexPromise(() => inspectOfficeFile(blob, prepared.contentType))
    if (!officeOk) {
      return yield* convexPromise(() =>
        quarantineUpload(ctx, { ...base, quarantineReason: 'INVALID_FILE_SIGNATURE' }, 'SUSPICIOUS')
      )
    }
  }

  const scan = yield* convexPromise(() => scanFileWithConfiguredGateway(blob, prepared.sha256))
  if (scan.status === 'INFECTED') {
    return yield* convexPromise(() =>
      quarantineUpload(ctx, { ...base, quarantineReason: 'MALWARE_DETECTED' }, 'SUSPICIOUS')
    )
  }
  if (
    scan.status === 'ERROR' ||
    (scan.status === 'NOT_CONFIGURED' && requiresConfiguredScanner(process.env))
  ) {
    return yield* convexPromise(() =>
      quarantineUpload(ctx, { ...base, quarantineReason: 'SCAN_UNAVAILABLE' }, 'UNINSPECTED')
    )
  }
  if (scan.status === 'NOT_CONFIGURED') {
    return yield* convexPromise(() =>
      ctx.runMutation(finalizeUploadRef, {
        ...base,
        inspectionStatus: 'NOT_CONFIGURED',
      })
    )
  }

  return yield* convexPromise(() =>
    ctx.runMutation(finalizeUploadRef, {
      ...base,
      inspectionStatus: 'CLEAN',
      scannerEngine: scan.engine,
      scannerScanId: scan.scanId,
      scannerDefinitionVersion: scan.definitionVersion,
      scannedAt: scan.scannedAt,
    })
  )
})

export const inspectAndRegisterUpload = action({
  args: prepareUploadArgs,
  handler: (ctx, args) => runConvex(inspectAndRegisterUploadProgram(ctx, args)),
})

const reconcileArtifactsProgram = Effect.fn('Intake.reconcileArtifacts')(function* (
  ctx: MutationCtx
) {
  const now = Date.now()
  const [proofs, issued, inspecting, sessions] = yield* convexPromise(() =>
    Promise.all([
      ctx.db
        .query('intakeProofNonces')
        .withIndex('by_expiresAt', (q) => q.lte('expiresAt', now))
        .take(MAX_RECONCILIATION_BATCH),
      ctx.db
        .query('intakeUploadIntents')
        .withIndex('by_status_expiresAt', (q) => q.eq('status', 'ISSUED').lte('expiresAt', now))
        .take(MAX_RECONCILIATION_BATCH),
      ctx.db
        .query('intakeUploadIntents')
        .withIndex('by_status_expiresAt', (q) => q.eq('status', 'INSPECTING').lte('expiresAt', now))
        .take(MAX_RECONCILIATION_BATCH),
      ctx.db
        .query('intakeSessions')
        .withIndex('by_status_accessExpiresAt', (q) =>
          q.eq('status', 'ACTIVE').lte('accessExpiresAt', now)
        )
        .take(MAX_RECONCILIATION_BATCH),
    ])
  )

  for (const row of proofs) yield* convexPromise(() => ctx.db.delete(row._id))
  for (const row of issued) {
    yield* convexPromise(() => ctx.db.patch(row._id, { status: 'EXPIRED', expiredAt: now }))
  }
  for (const row of inspecting) {
    yield* convexPromise(() => ctx.db.patch(row._id, { status: 'UNCERTAIN', uncertainAt: now }))
  }
  for (const session of sessions) {
    yield* convexPromise(() => ctx.db.patch(session._id, { status: 'EXPIRED', expiredAt: now }))
    yield* convexPromise(() =>
      ctx.db.insert('intakeEvents', {
        intakeSessionId: session._id,
        type: 'SESSION_EXPIRED',
        createdAt: now,
      })
    )
  }

  return {
    deletedProofs: proofs.length,
    expiredIntents: issued.length,
    uncertainIntents: inspecting.length,
    expiredSessions: sessions.length,
  }
})

export const _reconcileArtifacts = internalMutation({
  args: {},
  handler: (ctx) => runConvex(reconcileArtifactsProgram(ctx)),
})
