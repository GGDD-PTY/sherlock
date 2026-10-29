import { Cause, Effect, Result, Schema } from 'effect'
import { NextRequest } from 'next/server'

import {
  respond,
  routePromise,
  runRouteEffect,
  type RouteOperationError,
} from '@/lib/api/effect-route'
import { getUnauthenticatedConvex } from '@/lib/convex-auth'
import {
  intakeInvalidRequest,
  intakeJson,
  intakeModeUnavailable,
  intakeRequestId,
  intakeTemporarilyUnavailable,
  intakeUnauthorized,
  rejectIntakeMutation,
  rejectIntakeRateLimit,
  rejectIntakeReadOrigin,
} from '@/lib/intake/api'
import { isIntakeDemoModeEnabled } from '@/lib/intake/demo-mode'
import {
  createIntakeCsrfToken,
  INTAKE_CSRF_BOOTSTRAP_BINDING,
  setIntakeCsrfCookie,
  clearIntakeCsrfCookie,
} from '@/lib/intake/csrf'
import { createIntakeAnonymousKey, createIntakeServerProof } from '@/lib/intake/proof'
import { intakeSessionSchema, parseIntakeJson } from '@/lib/intake/request'
import {
  clearIntakeSessionCookie,
  createIntakeSessionRef,
  projectIntakeWorkspaceRef,
  readIntakeSessionToken,
  revokeIntakeSessionRef,
  rotateIntakeSessionRef,
  setIntakeSessionCookie,
  type IntakeDocumentView,
  type IntakeAssessmentFindingView,
  type IntakeAssessmentView,
  type IntakeWorkspaceView,
} from '@/lib/intake/session'

import { getClientIp } from '@/lib/utils/rate-limit'

const ROUTE = '/api/intake/session'

const isSessionQuotaError = Schema.is(
  Schema.Struct({
    data: Schema.Union([
      Schema.Literal('Rate limit exceeded'),
      Schema.Struct({
        code: Schema.Literal('BUSINESS_INVALID_STATE'),
        details: Schema.Struct({ currentState: Schema.Literal('INTAKE_SESSION_LIMIT') }),
      }),
    ]),
  })
)

const sessionCreationFailure = Effect.fn('IntakeSession.creationFailure')(function* (
  cause: Cause.Cause<RouteOperationError>,
  requestId: string
) {
  const typed = Cause.findError(cause)
  if (Result.isSuccess(typed) && isSessionQuotaError(typed.success.cause)) {
    yield* Effect.logWarning('Intake session quota reached', { code: 'INTAKE_SESSION_LIMIT' })
    return intakeJson(
      {
        code: 'INTAKE_SESSION_LIMIT',
        error:
          'Se alcanzó el límite de salas temporales. Continúa con tu cuenta para subir los documentos.',
      },
      requestId,
      { status: 429 }
    )
  }
  yield* Effect.logError('Intake session creation failed', {
    operation: Result.isSuccess(typed) ? typed.success.operation : 'intake.session.defect',
  })
  return intakeTemporarilyUnavailable(requestId, ROUTE)
})

const MAX_ASSESSMENT_EVIDENCE = 20
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_ACCESS_TTL_MS = 24 * 60 * 60 * 1000 + 5_000
const MAX_DELETION_TTL_MS = 7 * 24 * 60 * 60 * 1000 + 5_000
const INTAKE_ASSESSMENT_CATEGORIES = new Set<IntakeAssessmentFindingView['category']>([
  'financialStatements',
  'notes',
  'businessExplanation',
  'language',
  'businessModel',
  'pitch',
  'teaserCim',
  'loanPaymentTape',
  'financialModel',
  'portfolioDetail',
  'legalDetail',
  'country',
])

function projectDocument(value: unknown): IntakeDocumentView | null {
  if (!value || typeof value !== 'object') return null
  const document = value as Record<string, unknown>
  if (
    typeof document.id !== 'string' ||
    document.id.length === 0 ||
    document.id.length > 256 ||
    typeof document.displayName !== 'string' ||
    document.displayName.length === 0 ||
    document.displayName.length > 255 ||
    typeof document.declaredMimeType !== 'string' ||
    document.declaredMimeType.length === 0 ||
    document.declaredMimeType.length > 200 ||
    typeof document.byteSize !== 'number' ||
    !Number.isSafeInteger(document.byteSize) ||
    document.byteSize <= 0 ||
    document.byteSize > MAX_FILE_BYTES ||
    !['CLEAN', 'NOT_CONFIGURED', 'UNINSPECTED', 'SUSPICIOUS'].includes(
      String(document.inspectionStatus)
    ) ||
    typeof document.claimable !== 'boolean' ||
    typeof document.createdAt !== 'number' ||
    !Number.isSafeInteger(document.createdAt)
  ) {
    return null
  }
  return {
    id: document.id,
    displayName: document.displayName,
    declaredMimeType: document.declaredMimeType,
    byteSize: document.byteSize,
    inspectionStatus: document.inspectionStatus as IntakeDocumentView['inspectionStatus'],
    claimable: document.claimable,
    createdAt: document.createdAt,
  }
}

function projectAssessment(value: unknown): IntakeAssessmentView | null {
  if (!value || typeof value !== 'object') return null
  const assessment = value as Record<string, unknown>
  if (
    typeof assessment.id !== 'string' ||
    typeof assessment.intakeSessionId !== 'string' ||
    !['PENDING', 'NEEDS_REVIEW', 'READY'].includes(String(assessment.status)) ||
    !['TEAM', 'EXTERNAL'].includes(String(assessment.source)) ||
    !Array.isArray(assessment.findings) ||
    assessment.findings.length > 24 ||
    typeof assessment.createdAt !== 'number' ||
    !Number.isSafeInteger(assessment.createdAt) ||
    typeof assessment.updatedAt !== 'number' ||
    !Number.isSafeInteger(assessment.updatedAt)
  ) {
    return null
  }

  const findings: IntakeAssessmentFindingView[] = []
  for (const rawFinding of assessment.findings) {
    if (!rawFinding || typeof rawFinding !== 'object') return null
    const finding = rawFinding as Record<string, unknown>
    if (
      !INTAKE_ASSESSMENT_CATEGORIES.has(
        finding.category as IntakeAssessmentFindingView['category']
      ) ||
      !Array.isArray(finding.evidenceDocumentIds) ||
      finding.evidenceDocumentIds.length > MAX_ASSESSMENT_EVIDENCE ||
      finding.evidenceDocumentIds.some((id) => typeof id !== 'string') ||
      typeof finding.confidence !== 'number' ||
      !Number.isFinite(finding.confidence) ||
      finding.confidence < 0 ||
      finding.confidence > 1 ||
      !['PENDING', 'CONFIRMED', 'REJECTED'].includes(String(finding.reviewState))
    ) {
      return null
    }
    findings.push({
      category: finding.category as IntakeAssessmentFindingView['category'],
      evidenceDocumentIds: finding.evidenceDocumentIds as string[],
      confidence: finding.confidence,
      reviewState: finding.reviewState as IntakeAssessmentFindingView['reviewState'],
    })
  }

  return {
    id: assessment.id,
    intakeSessionId: assessment.intakeSessionId,
    status: assessment.status as IntakeAssessmentView['status'],
    source: assessment.source as IntakeAssessmentView['source'],
    findings,
    createdAt: assessment.createdAt,
    updatedAt: assessment.updatedAt,
  }
}

function projectWorkspace(value: unknown): IntakeWorkspaceView | null {
  if (!value || typeof value !== 'object') return null
  const workspace = value as Record<string, unknown>
  if (workspace.authorized !== true || !Array.isArray(workspace.documents)) return null
  const documents = workspace.documents.map(projectDocument)
  if (documents.some((document) => document === null)) return null
  const assessment = projectAssessment(workspace.assessment)
  if (workspace.assessment !== undefined && workspace.assessment !== null && !assessment)
    return null
  if (
    workspace.identityName !== undefined &&
    (typeof workspace.identityName !== 'string' || workspace.identityName.length > 120)
  ) {
    return null
  }
  return {
    authorized: true,
    ...(typeof workspace.accessExpiresAt === 'number'
      ? { accessExpiresAt: workspace.accessExpiresAt }
      : {}),
    ...(typeof workspace.identityName === 'string' ? { identityName: workspace.identityName } : {}),
    documents: documents as IntakeDocumentView[],
    assessment,
  }
}

function validIssuedAuthority(value: {
  sessionToken: string
  accessExpiresAt: number
  deletionProofExpiresAt: number
}): boolean {
  const now = Date.now()
  return (
    /^[A-Za-z0-9_-]{43}$/.test(value.sessionToken) &&
    Number.isSafeInteger(value.accessExpiresAt) &&
    value.accessExpiresAt > now &&
    value.accessExpiresAt <= now + MAX_ACCESS_TTL_MS &&
    Number.isSafeInteger(value.deletionProofExpiresAt) &&
    value.deletionProofExpiresAt > value.accessExpiresAt &&
    value.deletionProofExpiresAt <= now + MAX_DELETION_TTL_MS
  )
}

type IntakeClient = NonNullable<ReturnType<typeof getUnauthenticatedConvex>>

const readIntakeWorkspace = Effect.fn('IntakeSession.readWorkspace')(function* (
  client: IntakeClient,
  sessionToken: string,
  requestId: string
) {
  const result = yield* routePromise('intake.session.projectWorkspace', () =>
    client.mutation(projectIntakeWorkspaceRef, {
      sessionToken,
      ...createIntakeServerProof({
        operation: 'PROJECT_WORKSPACE',
        bindingParts: [sessionToken],
      }),
    })
  )
  const csrfToken = createIntakeCsrfToken({ binding: sessionToken })
  if (!result.authenticated) {
    const response = intakeJson({ authorized: false, retainedOnly: true, csrfToken }, requestId)
    setIntakeCsrfCookie(response, csrfToken)
    return response
  }
  const workspace = projectWorkspace(result)
  if (!workspace) return intakeTemporarilyUnavailable(requestId, ROUTE)
  const response = intakeJson({ ...workspace, csrfToken }, requestId)
  setIntakeCsrfCookie(response, csrfToken)
  return response
})

const createOrRotateIntakeSession = Effect.fn('IntakeSession.createOrRotate')(function* (
  request: NextRequest,
  client: IntakeClient,
  sessionToken: string | null,
  identityName: string | undefined,
  requestId: string
) {
  if (sessionToken) {
    const result = yield* routePromise('intake.session.rotate', () =>
      client.mutation(rotateIntakeSessionRef, {
        sessionToken,
        ...(identityName ? { identityName } : {}),
        ...createIntakeServerProof({
          operation: 'ROTATE_SESSION',
          bindingParts: identityName ? [sessionToken, identityName] : [sessionToken],
        }),
      })
    )
    // Una sesión que rota y devuelve una autoridad que el servidor no puede
    // avalar sí es una falla: se cierra y se limpian las cookies.
    if (result.rotated) {
      if (!validIssuedAuthority(result)) {
        const response = intakeJson({ error: 'Solicitud no autorizada' }, requestId, {
          status: 403,
        })
        clearIntakeSessionCookie(response)
        clearIntakeCsrfCookie(response)
        return response
      }
      const workspace = projectWorkspace(result.workspace)
      if (!workspace) return intakeTemporarilyUnavailable(requestId, ROUTE)
      const nextCsrfToken = createIntakeCsrfToken({ binding: result.sessionToken })
      const response = intakeJson({ ...workspace, csrfToken: nextCsrfToken }, requestId)
      setIntakeSessionCookie(response, result.sessionToken, result.deletionProofExpiresAt)
      setIntakeCsrfCookie(response, nextCsrfToken, result.deletionProofExpiresAt)
      return response
    }
    // Que no rote no es una falla: la cookie nombra una sesión reclamada,
    // vencida o revocada — un recuerdo, no una autoridad viva. La tanda que
    // el cliente acaba de soltar abre sesión nueva en vez de quedarse sin
    // camino temporal y caer al sobre de IndexedDB (prod 2026-09-03 03:25).
  }

  const anonymousKey = createIntakeAnonymousKey(getClientIp(request))
  const result = yield* routePromise('intake.session.create', () =>
    client.mutation(createIntakeSessionRef, {
      anonymousKey,
      identityName,
      ...createIntakeServerProof({
        operation: 'CREATE_SESSION',
        bindingParts: [anonymousKey, identityName ?? '-'],
      }),
    })
  )
  if (!validIssuedAuthority(result)) return intakeTemporarilyUnavailable(requestId, ROUTE)
  const workspace = projectWorkspace(result.workspace)
  if (!workspace) return intakeTemporarilyUnavailable(requestId, ROUTE)
  const nextCsrfToken = createIntakeCsrfToken({ binding: result.sessionToken })
  const response = intakeJson({ ...workspace, csrfToken: nextCsrfToken }, requestId, {
    status: 201,
  })
  setIntakeSessionCookie(response, result.sessionToken, result.deletionProofExpiresAt)
  setIntakeCsrfCookie(response, nextCsrfToken, result.deletionProofExpiresAt)
  return response
})

const revokeIntakeSession = Effect.fn('IntakeSession.revoke')(function* (
  client: IntakeClient,
  sessionToken: string,
  requestId: string
) {
  yield* routePromise('intake.session.revoke', () =>
    client.mutation(revokeIntakeSessionRef, {
      sessionToken,
      ...createIntakeServerProof({
        operation: 'REVOKE_SESSION',
        bindingParts: [sessionToken],
      }),
    })
  )
  return intakeJson({ revoked: true }, requestId)
})

const getIntakeSession = Effect.fn('IntakeSession.GET')(function* (
  request: NextRequest,
  requestId: string
) {
  if (!isIntakeDemoModeEnabled()) return yield* respond(intakeModeUnavailable(requestId))
  const origin = rejectIntakeReadOrigin(request, requestId)
  if (origin) return yield* respond(origin)
  const limited = yield* routePromise('intake.session.readRateLimit', () =>
    rejectIntakeRateLimit(request, requestId, 'read')
  )
  if (limited) return yield* respond(limited)

  const sessionToken = readIntakeSessionToken(request)
  if (!sessionToken) {
    const csrfToken = createIntakeCsrfToken({ binding: INTAKE_CSRF_BOOTSTRAP_BINDING })
    const response = intakeJson({ authorized: false, csrfToken }, requestId)
    setIntakeCsrfCookie(response, csrfToken)
    return response
  }

  const client = getUnauthenticatedConvex()
  if (!client) return yield* respond(intakeTemporarilyUnavailable(requestId, ROUTE))
  return yield* Effect.catchCause(readIntakeWorkspace(client, sessionToken, requestId), () =>
    Effect.succeed(intakeTemporarilyUnavailable(requestId, ROUTE))
  )
})

const postIntakeSession = Effect.fn('IntakeSession.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  if (!isIntakeDemoModeEnabled()) return yield* respond(intakeModeUnavailable(requestId))
  const sessionToken = readIntakeSessionToken(request)
  const csrf = rejectIntakeMutation(
    request,
    requestId,
    sessionToken ?? INTAKE_CSRF_BOOTSTRAP_BINDING
  )
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('intake.session.writeRateLimit', () =>
    rejectIntakeRateLimit(request, requestId, 'session')
  )
  if (limited) return yield* respond(limited)
  const parsed = yield* routePromise('intake.session.parse', () =>
    parseIntakeJson(request, intakeSessionSchema)
  )
  if (!parsed.ok) {
    return yield* respond(intakeInvalidRequest(requestId, parsed.status, parsed.code))
  }

  const client = getUnauthenticatedConvex()
  if (!client) return yield* respond(intakeTemporarilyUnavailable(requestId, ROUTE))
  const identityName = parsed.data.name?.trim() || undefined
  return yield* Effect.catchCause(
    createOrRotateIntakeSession(request, client, sessionToken, identityName, requestId),
    (cause) => sessionCreationFailure(cause, requestId)
  )
})

const deleteIntakeSession = Effect.fn('IntakeSession.DELETE')(function* (
  request: NextRequest,
  requestId: string
) {
  if (!isIntakeDemoModeEnabled()) return yield* respond(intakeModeUnavailable(requestId))
  const sessionToken = readIntakeSessionToken(request)
  if (!sessionToken) return yield* respond(intakeUnauthorized(requestId))
  const csrf = rejectIntakeMutation(request, requestId, sessionToken)
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('intake.session.deleteRateLimit', () =>
    rejectIntakeRateLimit(request, requestId, 'mutation')
  )
  if (limited) return yield* respond(limited)

  const client = getUnauthenticatedConvex()
  if (!client) return yield* respond(intakeTemporarilyUnavailable(requestId, ROUTE))
  return yield* Effect.catchCause(revokeIntakeSession(client, sessionToken, requestId), () =>
    Effect.succeed(intakeTemporarilyUnavailable(requestId, ROUTE))
  )
})

export function GET(request: NextRequest): Promise<Response> {
  const requestId = intakeRequestId(request)
  return runRouteEffect(request, ROUTE, getIntakeSession(request, requestId), { requestId })
}

export function POST(request: NextRequest): Promise<Response> {
  const requestId = intakeRequestId(request)
  return runRouteEffect(request, ROUTE, postIntakeSession(request, requestId), { requestId })
}

export function DELETE(request: NextRequest): Promise<Response> {
  const requestId = intakeRequestId(request)
  return runRouteEffect(request, ROUTE, deleteIntakeSession(request, requestId), { requestId })
}
