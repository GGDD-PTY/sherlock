import { makeFunctionReference } from 'convex/server'
import { Effect, Option, Schema } from 'effect'

import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { confirmCompanyName } from '../companyChecklist'
import type { AuthResult } from '../_helpers/auth.types'
import { COMPANY_NAME_MAX_LENGTH, normalizeCompanyName } from '../_helpers/companyName'
import { evaluateCompanyManagementAuthorization } from '../_helpers/companyAuthorization'
import { convexPromise, convexSync, runConvex } from '../_helpers/effect'
import { invalidState, unauthorized } from '../_helpers/errors'
import { normalizeSha256Hex } from '../_helpers/sha256'
import { createOpaqueIntakeToken, hashIntakeSessionToken, sha256Hex } from './crypto'
import {
  buildIntakeClaimNoncePayload,
  buildIntakeClaimProofPayload,
  isValidIntakeClaimSubject,
} from './claimProof'
import { intakeInspectionAllowsClaim, isIntakeDocumentClaimable } from './model'
import { isIntakeDemoModeEnabled, resolveIntakeServerBoundaryConfig } from './proofFormat'
import { requireActiveIntakeSessionEffect } from './sessions'
import { inferVdrFolderFromName } from '../../src/lib/vdr/document-taxonomy'

const encoder = new TextEncoder()
const Base64UrlSignature = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)))
const isBase64UrlSignature = Schema.is(Base64UrlSignature)
const CLAIM_RECONCILIATION_CODE = 'CLAIM_RECONCILIATION_REQUIRED' as const

type ClaimProofArgs = {
  sessionToken: string
  workosSubject: string
  claimNonce: string
  claimProof: string
}

export type IntakeClaimResult =
  | {
      status: 'PROCESSING'
      claimDigest: string
      companyId: string
    }
  | {
      status: 'FAILED'
      claimDigest: string
      companyId: string
      code: typeof CLAIM_RECONCILIATION_CODE
      completedAt: number
    }
  | {
      status: 'SUCCEEDED'
      claimDigest: string
      companyId: string
      documentIds: string[]
      claimedDocumentCount: number
      skippedDocumentCount: number
      completedAt: number
      // El nombre que la persona escribió en la landing. Viaja aunque la sala
      // no se haya renombrado: es lo único que le dice al equipo con qué
      // empresa creyó estar entrando quien soltó los documentos.
      declaredName?: string
    }

function decodeBase64Url(value: string): ArrayBuffer | null {
  if (!isBase64UrlSignature(value)) return null
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes.buffer
  } catch {
    return null
  }
}

const verifyHmac = Effect.fn('IntakeClaim.verifyHmac')(function* (
  secret: string,
  payload: string,
  value: string
) {
  const signature = decodeBase64Url(value)
  if (!signature) return false
  const key = yield* convexPromise(() =>
    crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )
  )
  return yield* convexPromise(() =>
    crypto.subtle.verify('HMAC', key, signature, encoder.encode(payload))
  )
})

/**
 * El nonce y el proof se verifican en ese orden y contra el MISMO secreto: el
 * proof solo vale si su nonce ya estaba firmado por nosotros. Todo rechazo dice
 * lo mismo hacia afuera y lleva su motivo en la traza.
 */
const verifyIntakeClaimProofEffect = Effect.fn('IntakeClaim.verifyProof')(function* (
  args: ClaimProofArgs
) {
  if (!isIntakeDemoModeEnabled()) {
    return yield* Effect.fail(
      invalidState('El acceso temporal no está disponible.', 'INTAKE_MODE_DISABLED')
    )
  }
  const config = resolveIntakeServerBoundaryConfig({
    secret: process.env.INTAKE_SERVER_SECRET,
    audience: process.env.INTAKE_SERVER_AUDIENCE,
  })
  const noncePayload = buildIntakeClaimNoncePayload({
    audience: config?.audience ?? '',
    sessionToken: args.sessionToken,
    workosSubject: args.workosSubject,
  })
  const proofPayload = buildIntakeClaimProofPayload({
    audience: config?.audience ?? '',
    sessionToken: args.sessionToken,
    workosSubject: args.workosSubject,
    claimNonce: args.claimNonce,
  })
  const denied = () => unauthorized('Solicitud de claim no autorizada.')

  if (!config) {
    yield* Effect.annotateCurrentSpan('denied', 'BOUNDARY_NOT_CONFIGURED')
    return yield* Effect.fail(denied())
  }
  if (!noncePayload || !proofPayload || !isValidIntakeClaimSubject(args.workosSubject)) {
    yield* Effect.annotateCurrentSpan('denied', 'PAYLOAD_MALFORMED')
    return yield* Effect.fail(denied())
  }
  if (!(yield* verifyHmac(config.secret, noncePayload, args.claimNonce))) {
    yield* Effect.annotateCurrentSpan('denied', 'NONCE_MISMATCH')
    return yield* Effect.fail(denied())
  }
  if (!(yield* verifyHmac(config.secret, proofPayload, args.claimProof))) {
    yield* Effect.annotateCurrentSpan('denied', 'SIGNATURE_MISMATCH')
    return yield* Effect.fail(denied())
  }
  return yield* convexPromise(() =>
    sha256Hex(`${config.audience}:${args.claimNonce}:${args.claimProof}`)
  )
})

export function verifyIntakeClaimProof(args: ClaimProofArgs): Promise<string> {
  return runConvex(verifyIntakeClaimProofEffect(args))
}

function provenanceMarker(
  session: Doc<'intakeSessions'>,
  document: Doc<'intakeDocuments'>,
  claimDigest: string
): string {
  return `intake-origin:v1:${session._id}:${document._id}:${claimDigest}`
}

const SafeCount = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
)

/**
 * El resultado del claim se persiste como JSON dentro de `claimResult.code` y
 * se vuelve a leer en cada reintento. Antes su forma vivía en un tipo y sus
 * invariantes en una condición de trece ramas donde un `??` daba defaults por
 * posición; ahora las dos cosas son una sola definición, y cada invariante
 * cruzado comprueba que el conteo coincida con la lista de documentos.
 */
const RecordedClaimResultSchema = Schema.Struct({
  version: Schema.Literal(1),
  documentIds: Schema.Array(Schema.String.pipe(Schema.check(Schema.isLengthBetween(1, 256)))),
  claimedDocumentCount: SafeCount,
  skippedDocumentCount: SafeCount,
  declaredName: Schema.optionalKey(
    Schema.String.pipe(Schema.check(Schema.isLengthBetween(1, COMPANY_NAME_MAX_LENGTH)))
  ),
}).pipe(
  Schema.check(
    Schema.makeFilter((result) => {
      const issues: Array<Schema.FilterIssue> = []
      if (result.claimedDocumentCount !== result.documentIds.length) {
        issues.push({
          path: ['claimedDocumentCount'],
          issue: 'claimedDocumentCount no coincide con documentIds',
        })
      }
      return issues
    })
  )
)

type RecordedClaimResult = typeof RecordedClaimResultSchema.Type

const decodeRecordedClaimResultOption = Schema.decodeUnknownOption(RecordedClaimResultSchema)

function encodeRecordedClaimResult(result: Omit<RecordedClaimResult, 'version'>): string {
  return JSON.stringify({ version: 1, ...result } satisfies RecordedClaimResult)
}

function decodeRecordedClaimResult(value: string | undefined): RecordedClaimResult | null {
  if (!value) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  return Option.getOrNull(decodeRecordedClaimResultOption(parsed))
}

const loadSessionDocuments = Effect.fn('IntakeClaim.loadSessionDocuments')(function* (
  ctx: MutationCtx,
  intakeSessionId: Id<'intakeSessions'>
) {
  const documents = yield* convexPromise(() =>
    ctx.db
      .query('intakeDocuments')
      .withIndex('by_session_createdAt', (q) => q.eq('intakeSessionId', intakeSessionId))
      .collect()
  )
  return documents
})

const uniqueDocumentByStorageId = Effect.fn('IntakeClaim.uniqueDocumentByStorageId')(function* (
  ctx: MutationCtx,
  storageId: Id<'_storage'>
) {
  const rows = yield* convexPromise(() =>
    ctx.db
      .query('documents')
      .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
      .take(2)
  )
  if (rows.length > 1) {
    return yield* Effect.fail(
      invalidState('La custodia del archivo requiere reconciliación.', 'CLAIM_STORAGE_CONFLICT')
    )
  }
  // La anotación no es adorno: sin ella el `?? null` se evapora del tipo —el
  // índice de un arreglo no se declara opcional— y el `null` que este helper
  // sí devuelve dejaría de existir para quien lo llama.
  const found: Doc<'documents'> | null = rows[0] ?? null
  return found
})

const uniqueVersionByStorageId = Effect.fn('IntakeClaim.uniqueVersionByStorageId')(function* (
  ctx: MutationCtx,
  storageId: Id<'_storage'>
) {
  const rows = yield* convexPromise(() =>
    ctx.db
      .query('documentVersions')
      .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
      .take(2)
  )
  if (rows.length > 1) {
    return yield* Effect.fail(
      invalidState('La custodia del archivo requiere reconciliación.', 'CLAIM_STORAGE_CONFLICT')
    )
  }
  const found: Doc<'documentVersions'> | null = rows[0] ?? null
  return found
})

const requireMatchingBlob = Effect.fn('IntakeClaim.requireMatchingBlob')(function* (
  ctx: MutationCtx,
  document: Doc<'intakeDocuments'>
) {
  const blob = yield* convexPromise(() => ctx.db.system.get(document.storageId))
  if (
    !blob ||
    blob.size !== document.byteSize ||
    normalizeSha256Hex(blob.sha256) !== normalizeSha256Hex(document.sha256) ||
    (blob.contentType ?? '').trim().toLowerCase() !== document.detectedMimeType
  ) {
    return yield* Effect.fail(
      invalidState('La evidencia del archivo requiere reconciliación.', 'CLAIM_BLOB_MISMATCH')
    )
  }
})

const insertInitialVersion = Effect.fn('IntakeClaim.insertInitialVersion')(function* (args: {
  ctx: MutationCtx
  intakeDocument: Doc<'intakeDocuments'>
  documentId: Id<'documents'>
  companyId: Id<'companies'>
  profileId: Id<'profiles'>
  now: number
}) {
  const { ctx, intakeDocument, documentId, companyId, profileId, now } = args
  return yield* convexPromise(() =>
    ctx.db.insert('documentVersions', {
      documentId,
      companyId,
      versionNumber: 1,
      storageId: intakeDocument.storageId,
      displayName: intakeDocument.displayName,
      declaredMimeType: intakeDocument.declaredMimeType,
      detectedMimeType: intakeDocument.detectedMimeType,
      byteSize: intakeDocument.byteSize,
      sha256: intakeDocument.sha256,
      signatureKind: intakeDocument.signatureKind,
      verificationStatus: 'SIGNATURE_VERIFIED',
      malwareScanStatus: intakeDocument.inspectionStatus === 'CLEAN' ? 'CLEAN' : 'NOT_CONFIGURED',
      scannerEngine: intakeDocument.scannerEngine,
      scannerScanId: intakeDocument.scannerScanId,
      scannerDefinitionVersion: intakeDocument.scannerDefinitionVersion,
      scannedAt: intakeDocument.scannedAt,
      publicationStatus: 'PUBLISHED',
      replacesVersionId: undefined,
      createdAt: now,
      createdByProfileId: profileId,
      publishedAt: now,
    })
  )
})

const reconcileCanonicalDocument = Effect.fn('IntakeClaim.reconcileCanonicalDocument')(
  function* (args: {
    ctx: MutationCtx
    session: Doc<'intakeSessions'>
    intakeDocument: Doc<'intakeDocuments'>
    claimDigest: string
    profileId: Id<'profiles'>
    companyId: Id<'companies'>
    now: number
  }) {
    const { ctx, session, intakeDocument, claimDigest, profileId, companyId, now } = args
    const marker = provenanceMarker(session, intakeDocument, claimDigest)
    const byStorageDocument = yield* uniqueDocumentByStorageId(ctx, intakeDocument.storageId)
    const byStorageVersion = yield* uniqueVersionByStorageId(ctx, intakeDocument.storageId)

    let canonicalDocument: Doc<'documents'> | null = byStorageDocument
    if (!canonicalDocument && byStorageVersion) {
      const documentId = byStorageVersion.documentId
      canonicalDocument = yield* convexPromise(() => ctx.db.get(documentId))
    }

    if (canonicalDocument) {
      const canonical = canonicalDocument
      if (
        canonical.companyId !== companyId ||
        canonical.provenanceNotes !== marker ||
        (byStorageVersion &&
          (byStorageVersion.documentId !== canonical._id ||
            byStorageVersion.companyId !== companyId ||
            byStorageVersion.versionNumber !== 1))
      ) {
        return yield* Effect.fail(
          invalidState('La custodia del archivo requiere reconciliación.', 'CLAIM_STORAGE_CONFLICT')
        )
      }

      let initialVersion: Doc<'documentVersions'> | null = byStorageVersion
      if (!initialVersion) {
        yield* requireMatchingBlob(ctx, intakeDocument)
        const versionId = yield* insertInitialVersion({
          ctx,
          intakeDocument,
          documentId: canonical._id,
          companyId,
          profileId,
          now,
        })
        initialVersion = yield* convexPromise(() => ctx.db.get(versionId))
      }
      const version = initialVersion
      if (!version) {
        return yield* Effect.fail(
          invalidState('La versión inicial requiere reconciliación.', 'CLAIM_VERSION_MISSING')
        )
      }
      if (!canonical.currentVersionId) {
        yield* convexPromise(() =>
          ctx.db.patch(canonical._id, {
            currentVersionNumber: 1,
            currentVersionId: version._id,
            publishedVersionId: version._id,
            updatedAt: now,
          })
        )
      }
      yield* convexPromise(() =>
        ctx.db.patch(intakeDocument._id, {
          storageState: 'OWNED_BY_COMPANY',
          claimable: false,
        })
      )
      return canonical._id
    }

    if (byStorageVersion) {
      return yield* Effect.fail(
        invalidState('La versión inicial requiere reconciliación.', 'CLAIM_VERSION_MISSING')
      )
    }

    yield* requireMatchingBlob(ctx, intakeDocument)
    const documentId = yield* convexPromise(() =>
      ctx.db.insert('documents', {
        companyId,
        name: intakeDocument.displayName,
        fileType: intakeDocument.detectedMimeType,
        fileSize: intakeDocument.byteSize,
        storageId: intakeDocument.storageId,
        lifecycleStatus: 'ACTIVE',
        currentVersionNumber: 1,
        accessLevel: 'PRIVATE',
        classification: 'RESTRICTED',
        protectionPolicyVersion: 'trust-os-v2',
        updatedAt: now,
        folder: inferVdrFolderFromName(intakeDocument.displayName),
        sourceType: 'USER_UPLOAD',
        sourceName: 'SHERLOCK_INTAKE',
        provenanceNotes: marker,
        isExpired: false,
      })
    )
    const versionId = yield* insertInitialVersion({
      ctx,
      intakeDocument,
      documentId,
      companyId,
      profileId,
      now,
    })
    yield* convexPromise(() =>
      ctx.db.patch(documentId, {
        currentVersionId: versionId,
        publishedVersionId: versionId,
      })
    )
    yield* convexPromise(() =>
      ctx.db.patch(intakeDocument._id, {
        storageState: 'OWNED_BY_COMPANY',
        claimable: false,
      })
    )
    return documentId
  }
)

const projectSucceededClaim = Effect.fn('IntakeClaim.projectSucceeded')(function* (
  session: Doc<'intakeSessions'>
) {
  if (
    !session.claimDigest ||
    !session.claimedCompanyId ||
    !session.claimResult ||
    session.claimResult.status !== 'SUCCEEDED'
  ) {
    return yield* Effect.fail(
      invalidState('El resultado del claim requiere reconciliación.', 'CLAIM_RESULT_MISSING')
    )
  }
  const recorded = decodeRecordedClaimResult(session.claimResult.code)
  if (!recorded) {
    return yield* Effect.fail(
      invalidState('El resultado del claim requiere reconciliación.', 'CLAIM_RESULT_MISSING')
    )
  }
  return {
    status: 'SUCCEEDED',
    claimDigest: session.claimDigest,
    companyId: `${session.claimedCompanyId}`,
    documentIds: [...recorded.documentIds],
    claimedDocumentCount: recorded.claimedDocumentCount,
    skippedDocumentCount: recorded.skippedDocumentCount,
    completedAt: session.claimResult.completedAt,
    ...(recorded.declaredName === undefined ? {} : { declaredName: recorded.declaredName }),
  } satisfies IntakeClaimResult
})

const reconcileClaimRef = makeFunctionReference<
  'mutation',
  { claimDigest: string },
  IntakeClaimResult
>('intake:_reconcileClaim')

// El aviso al equipo de esta sesión nació anónimo (sin `companyId`, con link al
// listado de empresas). Se calendariza como los otros tres disparadores: la
// fila de `teamAlerts` la comparte toda la tanda y su conflicto no puede caerle
// al claim del cliente.
const attachCompanyToIntakeAlertRef = makeFunctionReference<
  'mutation',
  { intakeSessionId: Id<'intakeSessions'>; companyId: Id<'companies'> }
>('notifications:_attachCompanyToIntakeAlert')

const loadClaimByDigest = Effect.fn('IntakeClaim.loadByDigest')(function* (
  ctx: MutationCtx,
  claimDigest: string
) {
  const sessions = yield* convexPromise(() =>
    ctx.db
      .query('intakeSessions')
      .withIndex('by_claimDigest', (q) => q.eq('claimDigest', claimDigest))
      .take(2)
  )
  if (sessions.length > 1) {
    return yield* Effect.fail(
      invalidState('El claim requiere reconciliación.', 'CLAIM_DIGEST_CONFLICT')
    )
  }
  const found: Doc<'intakeSessions'> | null = sessions[0] ?? null
  return found
})

function requireSameClaimAuthority(args: {
  session: Doc<'intakeSessions'>
  profileId: Id<'profiles'>
  companyId: Id<'companies'>
}): void {
  if (
    args.session.claimedProfileId !== args.profileId ||
    args.session.claimedCompanyId !== args.companyId
  ) {
    throw unauthorized('Solicitud de claim no autorizada.')
  }
}

const failInactiveClaim = Effect.fn('IntakeClaim.failInactive')(function* (
  ctx: MutationCtx,
  session: Doc<'intakeSessions'>
) {
  if (!session.claimDigest || !session.claimedCompanyId) {
    return yield* Effect.fail(unauthorized('Solicitud de claim no autorizada.'))
  }

  const completedAt =
    session.claimResult?.status === 'FAILED' ? session.claimResult.completedAt : Date.now()
  if (session.claimStatus !== 'FAILED' || session.claimResult?.status !== 'FAILED') {
    yield* convexPromise(() =>
      ctx.db.patch(session._id, {
        claimStatus: 'FAILED',
        claimResult: {
          status: 'FAILED',
          completedAt,
          code: CLAIM_RECONCILIATION_CODE,
        },
      })
    )
  }
  return {
    status: 'FAILED',
    claimDigest: session.claimDigest,
    companyId: `${session.claimedCompanyId}`,
    code: CLAIM_RECONCILIATION_CODE,
    completedAt,
  } satisfies IntakeClaimResult
})

const prepareOrReconcileIntakeClaimEffect = Effect.fn('IntakeClaim.prepareOrReconcile')(
  function* (args: {
    ctx: MutationCtx
    sessionToken: string
    claimDigest: string
    profileId: Id<'profiles'>
    companyId: Id<'companies'>
  }) {
    const existing = yield* loadClaimByDigest(args.ctx, args.claimDigest)
    if (existing) {
      yield* convexSync(() =>
        requireSameClaimAuthority({
          session: existing,
          profileId: args.profileId,
          companyId: args.companyId,
        })
      )
      if (existing.status === 'CLAIMED' && existing.claimStatus === 'CLAIMED') {
        return yield* projectSucceededClaim(existing)
      }
      if (existing.status !== 'ACTIVE') {
        return yield* failInactiveClaim(args.ctx, existing)
      }
      return yield* reconcileIntakeClaimEffect(args.ctx, existing)
    }

    const session = yield* requireActiveIntakeSessionEffect(args.ctx, args.sessionToken, Date.now())
    if (session.claimDigest || session.claimStatus !== 'UNCLAIMED') {
      return yield* Effect.fail(unauthorized('Solicitud de claim no autorizada.'))
    }
    const documents = yield* loadSessionDocuments(args.ctx, session._id)
    for (const document of documents) {
      if (!isIntakeDocumentClaimable(document)) continue
      yield* convexPromise(() =>
        args.ctx.db.patch(document._id, {
          storageState: 'CLAIM_PENDING',
          claimable: false,
        })
      )
    }
    yield* convexPromise(() =>
      args.ctx.db.patch(session._id, {
        claimDigest: args.claimDigest,
        claimStatus: 'PROCESSING',
        claimResult: undefined,
        claimedProfileId: args.profileId,
        claimedCompanyId: args.companyId,
      })
    )
    yield* convexPromise(() =>
      args.ctx.scheduler.runAfter(0, reconcileClaimRef, { claimDigest: args.claimDigest })
    )
    yield* convexPromise(() =>
      args.ctx.scheduler.runAfter(0, attachCompanyToIntakeAlertRef, {
        intakeSessionId: session._id,
        companyId: args.companyId,
      })
    )
    return {
      status: 'PROCESSING',
      claimDigest: args.claimDigest,
      companyId: `${args.companyId}`,
    } satisfies IntakeClaimResult
  }
)

export function prepareOrReconcileIntakeClaim(args: {
  ctx: MutationCtx
  sessionToken: string
  claimDigest: string
  profileId: Id<'profiles'>
  companyId: Id<'companies'>
}): Promise<IntakeClaimResult> {
  return runConvex(prepareOrReconcileIntakeClaimEffect(args))
}

// ============================================================================
// EL NOMBRE DE LA LANDING SOLO BAUTIZA UN ALTA NUEVA
// ============================================================================
// Espejo de `companyBornFromHandoff` (src/lib/mycroft/handoff-claim.ts). Un
// cliente que ya tiene sala conserva su nombre al adjuntar más documentos.
// El claim solo nombra una empresa creada por esta misma sesión y todavía
// no confirmada por su dueño. En los demás casos solo incorpora documentos.
//
// Los dos relojes de acá son del servidor Convex — el `_creationTime` de la
// empresa y el de la sesión —, así que no hace falta el margen de desfase que
// el handoff sí necesita contra el reloj del navegador.
const intakeOwnsCompanyName = Effect.fn('IntakeClaim.ownsCompanyName')(function* (
  ctx: MutationCtx,
  company: Doc<'companies'>,
  session: Doc<'intakeSessions'>
) {
  if (company._creationTime < session._creationTime) return false
  const checklist = yield* convexPromise(() =>
    ctx.db
      .query('companyChecklist')
      .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
      .first()
  )
  return typeof checklist?.nameConfirmedAt !== 'number'
})

function workosAuthForStoredProfile(
  user: Doc<'users'> | null,
  profile: Doc<'profiles'>
): AuthResult | null {
  if (!user || profile.userId !== user._id || !user.workosUserId) return null
  return {
    identity: {
      subject: user.workosUserId,
      authProvider: 'workos',
      issuer: 'https://api.workos.com/',
    },
    user,
    profile,
  }
}

const reconcileIntakeClaimEffect = Effect.fn('IntakeClaim.reconcile')(function* (
  ctx: MutationCtx,
  session: Doc<'intakeSessions'>
) {
  if (session.status === 'CLAIMED' && session.claimStatus === 'CLAIMED') {
    return yield* projectSucceededClaim(session)
  }
  if (session.status !== 'ACTIVE') {
    return yield* failInactiveClaim(ctx, session)
  }
  const claimDigest = session.claimDigest
  const claimedProfileId = session.claimedProfileId
  const claimedCompanyId = session.claimedCompanyId
  if (
    !claimDigest ||
    !claimedProfileId ||
    !claimedCompanyId ||
    (session.claimStatus !== 'PROCESSING' && session.claimStatus !== 'FAILED')
  ) {
    return yield* Effect.fail(unauthorized('Solicitud de claim no autorizada.'))
  }

  const now = Date.now()
  yield* convexPromise(() =>
    ctx.db.patch(session._id, { claimStatus: 'PROCESSING', claimResult: undefined })
  )

  // Todo lo de adentro se recupera como un FAILED registrado —defecto incluido,
  // igual que el `catch` de antes—: dejar la sesión en PROCESSING le cerraría al
  // visitante su camino de borrado.
  return yield* Effect.gen(function* () {
    // Authority can change between prepare and reconcile (profile deactivated,
    // company ownership moved). Inside the recovery so the outcome is a recorded
    // FAILED, which keeps the visitor's deletion path open, instead of a throw
    // that would strand the session in PROCESSING.
    const [profile, company] = yield* convexPromise(() =>
      Promise.all([ctx.db.get(claimedProfileId), ctx.db.get(claimedCompanyId)])
    )
    if (
      !profile ||
      profile.role !== 'COMPANY' ||
      profile.isActive === false ||
      !company ||
      company.ownerId !== profile._id
    ) {
      return yield* Effect.fail(unauthorized('Solicitud de claim no autorizada.'))
    }

    // El prepare ya pasó por el evaluador, pero el reconcile corre después, sin
    // JWT. Otra membresía puede dejar el perfil activo: hay que volver a
    // evaluar la gestión con la identidad guardada.
    const user = yield* convexPromise(() => ctx.db.get(profile.userId))
    const auth = workosAuthForStoredProfile(user, profile)
    if (!auth) {
      return yield* Effect.fail(unauthorized('Solicitud de claim no autorizada.'))
    }
    const decision = yield* convexPromise(() =>
      evaluateCompanyManagementAuthorization(ctx, auth, company)
    )
    if (!decision.authorized) {
      return yield* Effect.fail(unauthorized('Solicitud de claim no autorizada.'))
    }

    // Un nombre declarado inservible se ignora: es cosmético y no debe costarle
    // al cliente los documentos que sí vinieron con el claim.
    const declaredName = normalizeCompanyName(session.identityEvidence?.name)
    if (declaredName && (yield* intakeOwnsCompanyName(ctx, company, session))) {
      if (declaredName !== company.name) {
        yield* convexPromise(() => ctx.db.patch(company._id, { name: declaredName }))
      }
      yield* convexPromise(() => confirmCompanyName(ctx, company._id, 'INTAKE_CLAIM'))
    }

    const documents = yield* loadSessionDocuments(ctx, session._id)
    const documentIds: string[] = []
    for (const intakeDocument of documents) {
      if (
        intakeDocument.storageState !== 'CLAIM_PENDING' &&
        intakeDocument.storageState !== 'OWNED_BY_COMPANY'
      ) {
        continue
      }
      if (
        !intakeInspectionAllowsClaim(intakeDocument.inspectionStatus) ||
        (intakeDocument.storageState !== 'OWNED_BY_COMPANY' && intakeDocument.claimable)
      ) {
        return yield* Effect.fail(
          invalidState('El documento no se puede reclamar.', 'CLAIM_DOCUMENT_NOT_CLEAN')
        )
      }
      const documentId = yield* reconcileCanonicalDocument({
        ctx,
        session,
        intakeDocument,
        claimDigest,
        profileId: claimedProfileId,
        companyId: claimedCompanyId,
        now,
      })
      documentIds.push(`${documentId}`)
    }

    const completedAt = Date.now()
    const rotatedSessionTokenHash = yield* convexPromise(() =>
      hashIntakeSessionToken(createOpaqueIntakeToken())
    )
    yield* convexPromise(() =>
      ctx.db.patch(session._id, {
        sessionTokenHash: rotatedSessionTokenHash,
        status: 'CLAIMED',
        claimStatus: 'CLAIMED',
        claimResult: {
          status: 'SUCCEEDED',
          completedAt,
          code: encodeRecordedClaimResult({
            documentIds,
            claimedDocumentCount: documentIds.length,
            skippedDocumentCount: documents.length - documentIds.length,
            declaredName,
          }),
        },
        claimedAt: completedAt,
        rotatedAt: completedAt,
        rotationCount: session.rotationCount + 1,
        revokedAt: completedAt,
        revokedReason: 'CLAIM_SUCCEEDED',
      })
    )
    const claimed = yield* convexPromise(() => ctx.db.get(session._id))
    if (!claimed) {
      return yield* Effect.fail(
        invalidState('El resultado del claim requiere reconciliación.', 'CLAIM_RESULT_MISSING')
      )
    }
    return yield* projectSucceededClaim(claimed)
  }).pipe(
    Effect.catchCause(() =>
      Effect.gen(function* () {
        const completedAt = Date.now()
        yield* convexPromise(() =>
          ctx.db.patch(session._id, {
            claimStatus: 'FAILED',
            claimResult: {
              status: 'FAILED',
              completedAt,
              code: CLAIM_RECONCILIATION_CODE,
            },
          })
        )
        return {
          status: 'FAILED',
          claimDigest,
          companyId: `${claimedCompanyId}`,
          code: CLAIM_RECONCILIATION_CODE,
          completedAt,
        } satisfies IntakeClaimResult
      })
    )
  )
})

const reconcileIntakeClaimByDigestEffect = Effect.fn('IntakeClaim.reconcileByDigest')(function* (
  ctx: MutationCtx,
  claimDigest: string
) {
  const session = yield* loadClaimByDigest(ctx, claimDigest)
  if (!session) return yield* Effect.fail(unauthorized('Solicitud de claim no autorizada.'))
  return yield* reconcileIntakeClaimEffect(ctx, session)
})

export function reconcileIntakeClaimByDigest(
  ctx: MutationCtx,
  claimDigest: string
): Promise<IntakeClaimResult> {
  return runConvex(reconcileIntakeClaimByDigestEffect(ctx, claimDigest))
}

const resetPendingClaimForDeletionEffect = Effect.fn('IntakeClaim.resetPendingForDeletion')(
  function* (ctx: MutationCtx, intakeSessionId: Id<'intakeSessions'>) {
    const documents = yield* loadSessionDocuments(ctx, intakeSessionId)
    for (const document of documents) {
      if (document.storageState !== 'CLAIM_PENDING') continue
      yield* convexPromise(() =>
        ctx.db.patch(document._id, {
          storageState: 'STAGED_INTAKE',
          claimable: intakeInspectionAllowsClaim(document.inspectionStatus),
        })
      )
    }
  }
)

export async function resetPendingClaimForDeletion(
  ctx: MutationCtx,
  intakeSessionId: Id<'intakeSessions'>
): Promise<void> {
  await runConvex(resetPendingClaimForDeletionEffect(ctx, intakeSessionId))
}
