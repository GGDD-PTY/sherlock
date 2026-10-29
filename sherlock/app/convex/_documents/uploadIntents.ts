// ============================================================================
// LA MÁQUINA DE ESTADOS DE LOS INTENTOS DE SUBIDA DEL VDR
// ============================================================================
// Un intento pasa por ACTIVE/ISSUED → INSPECTING → CONSUMED, y cae a EXPIRED,
// REJECTED, ABORTED o UNCERTAIN. Los estados viven en un `Schema.Literals`
// derivado del schema de la tabla, así que la lista y el tipo son el mismo
// objeto y una transición a un estado que la tabla no conoce no compila.
//
// Todo esto corre en mutations: sin timers, sin `Effect.retry` con schedule,
// sin `fetch`. La ventana de 10 minutos y la gracia de 30 se comparan contra
// `Date.now()`, que el aislado congela durante toda la ejecución.
// ============================================================================

import { v } from 'convex/values'
import { Effect, Schema } from 'effect'

import type { Doc, Id } from '../_generated/dataModel'
import { internalMutation, mutation, type MutationCtx } from '../_generated/server'
import type { AuthResult } from '../_helpers/auth'
import { requireAuthEffect } from '../_helpers/auth.identity'
import { convexPromise, convexSync, runConvex } from '../_helpers/effect'
import type { AppError } from '../_helpers/errors'
import { invalidState, unauthorized, validationFailed } from '../_helpers/errors'
import { enforceRateLimit } from '../_helpers/rateLimit'
import { normalizeSha256Hex } from '../_helpers/sha256'
import {
  findDocumentByStorageIdEffect,
  loadCompanyOrThrowEffect,
  requireCompanyOwnerOrAdminEffect,
} from './shared'
import {
  directUploadLimitBytesForMimeType,
  isDirectUploadMimeType,
  MAX_DIRECT_UPLOAD_BYTES,
} from './uploadLimits'
import {
  adminVdrCapabilityValidator,
  requireAdminVdrCapability,
  withoutAdminVdrCapability,
} from '../_adminVdr/capability'
import { adminVdrTarget } from '../_adminVdr/capabilityFormat'

const VDR_UPLOAD_INTENT_TTL_MS = 10 * 60 * 1000
const VDR_UPLOAD_PREPARED_GRACE_MS = 30 * 60 * 1000
const MAX_ACTIVE_UPLOAD_INTENTS_PER_PROFILE = 20
const MAX_RECONCILIATION_MATCHES = MAX_ACTIVE_UPLOAD_INTENTS_PER_PROFILE + 1
const MAX_EXPIRY_BATCH = 100
const UNCERTAIN_QUARANTINE_MS = 24 * 60 * 60 * 1000
const MAX_FILE_NAME_LENGTH = 255
const MAX_DOCUMENT_NAME_LENGTH = 180
const MAX_DESCRIPTION_LENGTH = 2_000
const MAX_FOLDER_LENGTH = 120

export const findVdrUploadIntentByStorageIdEffect = Effect.fn('VdrUploadIntent.findByStorageId')(
  function* (ctx: Pick<MutationCtx, 'db'>, storageId: Id<'_storage'>) {
    return yield* convexPromise(() =>
      ctx.db
        .query('vdrUploadIntents')
        .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
        .first()
    )
  }
)

export function findVdrUploadIntentByStorageId(
  ctx: Pick<MutationCtx, 'db'>,
  storageId: Id<'_storage'>
): Promise<Doc<'vdrUploadIntents'> | null> {
  return runConvex(findVdrUploadIntentByStorageIdEffect(ctx, storageId))
}

type AccessLevel = NonNullable<Doc<'documents'>['accessLevel']>
type Classification = NonNullable<Doc<'documents'>['classification']>

const accessLevelValidator = v.optional(
  v.union(v.literal('PUBLIC'), v.literal('NDA_REQUIRED'), v.literal('PRIVATE'))
)
const classificationValidator = v.optional(
  v.union(
    v.literal('PUBLIC_TEASER'),
    v.literal('CONFIDENTIAL'),
    v.literal('RESTRICTED'),
    v.literal('LEGAL'),
    v.literal('KYC_SENSITIVE')
  )
)

const issueUploadIntentArgs = {
  adminCapability: adminVdrCapabilityValidator,
  companyId: v.id('companies'),
  replaceDocumentId: v.optional(v.id('documents')),
  fileName: v.string(),
  declaredMimeType: v.string(),
  declaredByteSize: v.number(),
  declaredSha256: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  accessLevel: accessLevelValidator,
  classification: classificationValidator,
  folder: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
}

export type UploadIntentMetadata = {
  companyId: Id<'companies'>
  replaceDocumentId?: Id<'documents'>
  fileName: string
  declaredMimeType: string
  declaredByteSize: number
  declaredSha256: string
  name: string
  description?: string
  accessLevel?: AccessLevel
  classification?: Classification
  folder?: string
  expiresAt?: number
}

export type BoundUploadIntent = UploadIntentMetadata & {
  intentId: Id<'vdrUploadIntents'>
  requestedByProfileId: Id<'profiles'>
}

// Los códigos con los que la emisión rechaza sin lanzar. Uno solo, declarado
// una vez: el guard sale del mismo objeto en vez de repetir la lista en una
// escalera de comparaciones que podía quedarse corta.
const UPLOAD_INTENT_REJECTION_CODES = [
  'UPLOAD_INTENT_ACTIVE',
  'UPLOAD_INTENT_UNCERTAIN',
  'UPLOAD_INTENT_EXPIRED',
  'UPLOAD_INTENT_REJECTED',
  'UPLOAD_INTENT_MISMATCH',
  'FILE_TOO_LARGE',
  'INVALID_FILE_TYPE',
] as const

const UploadIntentRejectionSchema = Schema.Struct({
  registered: Schema.Literal(false),
  code: Schema.Literals(UPLOAD_INTENT_REJECTION_CODES),
})

export type UploadIntentRejection = typeof UploadIntentRejectionSchema.Type

const isUploadIntentRejection = Schema.is(UploadIntentRejectionSchema)

// Los estados los declara la tabla; esta lista es la que el código recorre.
const RECONCILIATION_STATUSES = [
  'ACTIVE',
  'ISSUED',
  'INSPECTING',
  'UNCERTAIN',
  'CONSUMED',
  'REJECTED',
  'EXPIRED',
  'ABORTED',
] as const

const ReconciliationStatusSchema = Schema.Literals(RECONCILIATION_STATUSES)

type ReconciliationStatus = typeof ReconciliationStatusSchema.Type

// Los dos barridos de reconciliación recorren subconjuntos de esa lista, y
// estaban escritos a mano en el sitio del `for`. Renombrar un estado en la
// tabla los dejaba sin coincidir, en silencio y sin que el typecheck dijera
// nada. `pick` los deriva del mismo catálogo, así que un nombre que ya no
// existe rompe la compilación.
const SUPERSEDABLE_STATUSES = ReconciliationStatusSchema.pick(['ACTIVE', 'ISSUED'])
const RECONCILABLE_STATUSES = ReconciliationStatusSchema.pick([
  'ACTIVE',
  'INSPECTING',
  'UNCERTAIN',
  'ISSUED',
])

const findExactIntentsByStatus = Effect.fn('VdrUploadIntent.findExactByStatus')(function* (
  ctx: Pick<MutationCtx, 'db'>,
  key: Pick<
    Doc<'vdrUploadIntents'>,
    'requestedByProfileId' | 'companyId' | 'replaceDocumentId' | 'declaredSha256'
  >,
  status: ReconciliationStatus,
  limit = MAX_RECONCILIATION_MATCHES
) {
  return yield* convexPromise(() =>
    ctx.db
      .query('vdrUploadIntents')
      .withIndex('by_reconciliation_key_status', (q) =>
        q
          .eq('requestedByProfileId', key.requestedByProfileId)
          .eq('companyId', key.companyId)
          .eq('replaceDocumentId', key.replaceDocumentId)
          .eq('declaredSha256', key.declaredSha256)
          .eq('status', status)
      )
      .take(limit)
  )
})

const reconcileConsumedIntent = Effect.fn('VdrUploadIntent.reconcileConsumed')(function* (
  ctx: Pick<MutationCtx, 'db'>,
  intent: Doc<'vdrUploadIntents'>
): Effect.fn.Return<Id<'documents'> | null, AppError> {
  const intentStorageId = intent.storageId
  const intentDocumentId = intent.documentId
  const intentVersionId = intent.documentVersionId
  if (!intentDocumentId || !intentStorageId) return null

  const version = intentVersionId
    ? yield* convexPromise(() => ctx.db.get(intentVersionId))
    : yield* convexPromise(() =>
        ctx.db
          .query('documentVersions')
          .withIndex('by_storageId', (q) => q.eq('storageId', intentStorageId))
          .first()
      )
  const document = yield* convexPromise(() => ctx.db.get(intentDocumentId))

  if (
    !version ||
    !document ||
    document.companyId !== intent.companyId ||
    version.documentId !== intent.documentId ||
    version.companyId !== intent.companyId ||
    version.storageId !== intent.storageId ||
    version.sha256 !== intent.declaredSha256 ||
    version.declaredMimeType !== intent.declaredMimeType ||
    version.byteSize !== intent.declaredByteSize ||
    version.createdByProfileId !== intent.requestedByProfileId ||
    (intent.replaceDocumentId !== undefined && intent.documentId !== intent.replaceDocumentId)
  ) {
    return null
  }

  return intentDocumentId
})

type PriorIntentOutcome =
  | { registered: true; documentId: Id<'documents'> }
  | {
      registered: false
      code: 'UPLOAD_INTENT_ACTIVE' | 'UPLOAD_INTENT_UNCERTAIN' | 'UPLOAD_INTENT_REJECTED'
    }
  | null

const reconcileExactPriorIntent = Effect.fn('VdrUploadIntent.reconcilePrior')(function* (
  ctx: MutationCtx,
  key: Pick<
    Doc<'vdrUploadIntents'>,
    'requestedByProfileId' | 'companyId' | 'replaceDocumentId' | 'declaredSha256'
  >,
  now: number
): Effect.fn.Return<PriorIntentOutcome, AppError> {
  const consumed = yield* findExactIntentsByStatus(ctx, key, 'CONSUMED')
  if (consumed.length > 0) {
    if (consumed.length >= MAX_RECONCILIATION_MATCHES) {
      return { registered: false, code: 'UPLOAD_INTENT_UNCERTAIN' }
    }
    const reconciled = yield* Effect.forEach(
      consumed,
      (intent) => reconcileConsumedIntent(ctx, intent),
      { concurrency: 'unbounded' }
    )
    const documentId = reconciled[0]
    if (!documentId || reconciled.some((candidate) => candidate !== documentId)) {
      return { registered: false, code: 'UPLOAD_INTENT_UNCERTAIN' }
    }
    return { registered: true, documentId }
  }

  if ((yield* findExactIntentsByStatus(ctx, key, 'UNCERTAIN', 1)).length > 0) {
    return { registered: false, code: 'UPLOAD_INTENT_UNCERTAIN' }
  }
  const inspecting = yield* findExactIntentsByStatus(ctx, key, 'INSPECTING')
  for (const intent of inspecting) {
    if (intent.expiresAt <= now || !intent.storageId || !intent.preparedAt) {
      yield* convexPromise(() =>
        ctx.db.patch(intent._id, { status: 'UNCERTAIN', uncertainAt: now })
      )
    }
    return { registered: false, code: 'UPLOAD_INTENT_UNCERTAIN' }
  }
  if ((yield* findExactIntentsByStatus(ctx, key, 'REJECTED', 1)).length > 0) {
    return { registered: false, code: 'UPLOAD_INTENT_REJECTED' }
  }

  for (const status of SUPERSEDABLE_STATUSES.literals) {
    const active = yield* findExactIntentsByStatus(ctx, key, status)
    for (const intent of active) {
      if (intent.storageId || intent.preparedAt) {
        yield* convexPromise(() =>
          ctx.db.patch(
            intent._id,
            intent.expiresAt <= now
              ? { status: 'UNCERTAIN', uncertainAt: now }
              : { status: 'INSPECTING' }
          )
        )
        return { registered: false, code: 'UPLOAD_INTENT_UNCERTAIN' }
      }
      if (intent.expiresAt > now) {
        return { registered: false, code: 'UPLOAD_INTENT_ACTIVE' }
      }
      yield* convexPromise(() =>
        ctx.db.patch(intent._id, { status: 'EXPIRED', expiredAt: now })
      )
    }
    if (active.length >= MAX_RECONCILIATION_MATCHES) {
      return { registered: false, code: 'UPLOAD_INTENT_UNCERTAIN' }
    }
  }

  const expired = yield* findExactIntentsByStatus(ctx, key, 'EXPIRED')
  for (const intent of expired) {
    if (intent.storageId || intent.preparedAt) {
      yield* convexPromise(() =>
        ctx.db.patch(intent._id, { status: 'UNCERTAIN', uncertainAt: now })
      )
      return { registered: false, code: 'UPLOAD_INTENT_UNCERTAIN' }
    }
  }
  if (expired.length >= MAX_RECONCILIATION_MATCHES) {
    return { registered: false, code: 'UPLOAD_INTENT_UNCERTAIN' }
  }

  return null
})

const countActiveUploadIntents = Effect.fn('VdrUploadIntent.countActive')(function* (
  ctx: MutationCtx,
  requestedByProfileId: Id<'profiles'>,
  now: number
) {
  let activeCount = 0
  for (const status of RECONCILABLE_STATUSES.literals) {
    const intents = yield* convexPromise(() =>
      ctx.db
        .query('vdrUploadIntents')
        .withIndex('by_requester_status', (q) =>
          q.eq('requestedByProfileId', requestedByProfileId).eq('status', status)
        )
        .take(MAX_ACTIVE_UPLOAD_INTENTS_PER_PROFILE + 1)
    )
    for (const intent of intents) {
      if (status === 'UNCERTAIN') {
        activeCount += 1
      } else if (status === 'INSPECTING') {
        if (intent.expiresAt <= now) {
          yield* convexPromise(() =>
            ctx.db.patch(intent._id, { status: 'UNCERTAIN', uncertainAt: now })
          )
        }
        activeCount += 1
      } else if (intent.storageId || intent.preparedAt) {
        yield* convexPromise(() =>
          ctx.db.patch(
            intent._id,
            intent.expiresAt <= now
              ? { status: 'UNCERTAIN', uncertainAt: now }
              : { status: 'INSPECTING' }
          )
        )
        activeCount += 1
      } else if (intent.expiresAt <= now) {
        yield* convexPromise(() =>
          ctx.db.patch(intent._id, { status: 'EXPIRED', expiredAt: now })
        )
      } else {
        activeCount += 1
      }
    }
  }
  return activeCount
})

function normalizeText(value: string, maximum: number, field: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw validationFailed(`El campo ${field} no es válido.`, field)
  }
  return normalized
}

function normalizeOptionalText(
  value: string | undefined,
  maximum: number,
  field: string
): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (normalized.length === 0) return undefined
  if (normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw validationFailed(`El campo ${field} no es válido.`, field)
  }
  return normalized
}

const authorizeRoomScope = Effect.fn('VdrUploadIntent.authorizeRoomScope')(function* (
  ctx: MutationCtx,
  auth: AuthResult,
  args: Pick<UploadIntentMetadata, 'companyId' | 'replaceDocumentId'>
): Effect.fn.Return<void, AppError> {
  const { profile } = auth
  if (profile.role !== 'ADMIN' && profile.role !== 'COMPANY') {
    return yield* Effect.fail(
      unauthorized('Solo empresas o administradores pueden emitir intentos de subida VDR.')
    )
  }

  const company = yield* loadCompanyOrThrowEffect(ctx, args.companyId)
  yield* requireCompanyOwnerOrAdminEffect(
    ctx,
    auth,
    company,
    'Solo el dueño puede subir a esta sala.'
  )

  if (args.replaceDocumentId) {
    const replaceDocumentId = args.replaceDocumentId
    const document = yield* convexPromise(() => ctx.db.get(replaceDocumentId))
    if (!document || document.companyId !== args.companyId) {
      return yield* Effect.fail(
        unauthorized('La versión solo puede reemplazar un documento de esta sala exacta.')
      )
    }
    if (document.lifecycleStatus === 'ARCHIVED') {
      return yield* Effect.fail(
        invalidState('Un documento archivado no admite versiones nuevas.', 'DOCUMENT_ARCHIVED')
      )
    }
  }
})

function validateDeclaredFile(args: UploadIntentMetadata):
  | {
      fileName: string
      declaredMimeType: string
      declaredByteSize: number
      declaredSha256: string
    }
  | UploadIntentRejection {
  const fileName = normalizeText(args.fileName, MAX_FILE_NAME_LENGTH, 'fileName')
  const declaredMimeType = args.declaredMimeType.trim().toLowerCase()
  if (!isDirectUploadMimeType(declaredMimeType)) {
    throw validationFailed('El tipo de archivo no está permitido.', 'declaredMimeType')
  }
  if (!Number.isSafeInteger(args.declaredByteSize) || args.declaredByteSize <= 0) {
    throw validationFailed('El tamaño declarado del archivo no está permitido.', 'declaredByteSize')
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

type IssueUploadIntentArgs = UploadIntentMetadata & { adminCapability?: string }

type IssuedUploadIntent =
  | { intentId: Id<'vdrUploadIntents'>; uploadUrl: string; expiresAt: number }
  | UploadIntentRejection
  | { registered: true; documentId: Id<'documents'> }

const issueDirectUploadIntentProgram = Effect.fn('VdrUploadIntent.issue')(function* (
  ctx: MutationCtx,
  args: IssueUploadIntentArgs
): Effect.fn.Return<IssuedUploadIntent, AppError> {
  const auth = yield* requireAuthEffect(ctx)
  const { profile } = auth
  yield* authorizeRoomScope(ctx, auth, args)
  const company = yield* loadCompanyOrThrowEffect(ctx, args.companyId)
  yield* convexPromise(() =>
    requireAdminVdrCapability({
      ctx,
      auth,
      capability: args.adminCapability,
      company,
      action: 'DOCUMENT_UPLOAD_INTENT',
      target: args.replaceDocumentId
        ? adminVdrTarget('DOCUMENT', `${args.replaceDocumentId}`)
        : adminVdrTarget('COMPANY', `${args.companyId}`),
      input: withoutAdminVdrCapability(args),
    })
  )

  const file = yield* convexSync(() => validateDeclaredFile(args))
  if (isUploadIntentRejection(file)) return file
  const name = yield* convexSync(() => normalizeText(args.name, MAX_DOCUMENT_NAME_LENGTH, 'name'))
  const description = yield* convexSync(() =>
    normalizeOptionalText(args.description, MAX_DESCRIPTION_LENGTH, 'description')
  )
  const folder =
    (yield* convexSync(() => normalizeOptionalText(args.folder, MAX_FOLDER_LENGTH, 'folder'))) ??
    'General'
  const now = Date.now()

  if (
    args.expiresAt !== undefined &&
    (!Number.isSafeInteger(args.expiresAt) || args.expiresAt <= now)
  ) {
    return yield* Effect.fail(
      validationFailed('La expiración del documento no es válida.', 'expiresAt')
    )
  }

  const prior = yield* reconcileExactPriorIntent(
    ctx,
    {
      requestedByProfileId: profile._id,
      companyId: args.companyId,
      replaceDocumentId: args.replaceDocumentId,
      declaredSha256: file.declaredSha256,
    },
    now
  )
  if (prior) return prior

  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `vdrUploadIntent:${profile._id}`,
      limit: 60,
      windowMs: 60 * 60 * 1000,
    })
  )

  const activeCount = yield* countActiveUploadIntents(ctx, profile._id, now)
  if (activeCount >= MAX_ACTIVE_UPLOAD_INTENTS_PER_PROFILE) {
    return yield* Effect.fail(
      invalidState(
        'Tienes demasiadas subidas pendientes. Espera a que finalicen o expiren.',
        'UPLOAD_INTENT_LIMIT'
      )
    )
  }

  const intentId = yield* convexPromise(() =>
    ctx.db.insert('vdrUploadIntents', {
      companyId: args.companyId,
      requestedByProfileId: profile._id,
      status: 'ACTIVE',
      ...file,
      replaceDocumentId: args.replaceDocumentId,
      name,
      description,
      accessLevel: args.accessLevel ?? 'NDA_REQUIRED',
      classification: args.classification,
      folder,
      documentExpiresAt: args.expiresAt,
      createdAt: now,
      expiresAt: now + VDR_UPLOAD_INTENT_TTL_MS,
    })
  )
  const uploadUrl = yield* convexPromise(() => ctx.storage.generateUploadUrl())

  return { intentId, uploadUrl, expiresAt: now + VDR_UPLOAD_INTENT_TTL_MS }
})

export const issueDirectUploadIntent = mutation({
  args: issueUploadIntentArgs,
  handler: (ctx, args) => runConvex(issueDirectUploadIntentProgram(ctx, args)),
})

type PreparedUploadIntent =
  | {
      status: 'READY'
      bound: BoundUploadIntent
      size: number
      contentType: string
      sha256: string
      expectedCurrentVersionNumber: number
    }
  | { status: 'ALREADY_REGISTERED'; documentId: Id<'documents'> }
  | {
      status: 'BLOCKED'
      registered: false
      code: 'UPLOAD_INTENT_UNCERTAIN'
    }
  | ({ status: 'REJECTED' } & UploadIntentRejection)

export const requireBoundUploadIntentEffect = Effect.fn('VdrUploadIntent.requireBound')(function* (
  ctx: MutationCtx,
  input: BoundUploadIntent & { storageId: Id<'_storage'> },
  auth: AuthResult
): Effect.fn.Return<Doc<'vdrUploadIntents'>, AppError> {
  const { profile } = auth
  const intent = yield* convexPromise(() => ctx.db.get(input.intentId))
  if (!intent || intent.requestedByProfileId !== profile._id) {
    return yield* Effect.fail(unauthorized('El intento de subida no es válido para esta sesión.'))
  }
  const isLegacyPreparedIntent =
    intent.status === 'ISSUED' &&
    intent.storageId === input.storageId &&
    intent.preparedAt !== undefined
  if (intent.status !== 'INSPECTING' && !isLegacyPreparedIntent) {
    return yield* Effect.fail(
      invalidState('El intento de subida ya no está activo.', 'UPLOAD_INTENT_TERMINAL')
    )
  }
  if (
    intent.storageId !== input.storageId ||
    intent.companyId !== input.companyId ||
    intent.replaceDocumentId !== input.replaceDocumentId ||
    intent.fileName !== input.fileName ||
    intent.declaredMimeType !== input.declaredMimeType ||
    intent.declaredByteSize !== input.declaredByteSize ||
    intent.declaredSha256 !== input.declaredSha256 ||
    intent.name !== input.name ||
    intent.description !== input.description ||
    intent.accessLevel !== (input.accessLevel ?? 'NDA_REQUIRED') ||
    intent.classification !== input.classification ||
    intent.folder !== (input.folder ?? 'General') ||
    intent.documentExpiresAt !== input.expiresAt
  ) {
    return yield* Effect.fail(unauthorized('La subida no coincide con el intento emitido.'))
  }
  if (intent.expiresAt <= Date.now()) {
    return yield* Effect.fail(invalidState('El intento de subida expiró.', 'UPLOAD_INTENT_EXPIRED'))
  }
  yield* authorizeRoomScope(ctx, auth, intent)
  return intent
})

export const rejectBoundUploadIntentEffect = Effect.fn('VdrUploadIntent.reject')(function* (
  ctx: MutationCtx,
  input: BoundUploadIntent & { storageId: Id<'_storage'> },
  auth: AuthResult,
  reason: string
): Effect.fn.Return<void, AppError> {
  const intent = yield* requireBoundUploadIntentEffect(ctx, input, auth)
  const now = Date.now()
  yield* convexPromise(() =>
    ctx.db.patch(intent._id, {
      status: 'REJECTED',
      rejectedAt: now,
      rejectionReason: reason,
    })
  )
})

export const consumeBoundUploadIntentEffect = Effect.fn('VdrUploadIntent.consume')(function* (
  ctx: MutationCtx,
  input: BoundUploadIntent & { storageId: Id<'_storage'> },
  auth: AuthResult,
  documentId: Id<'documents'>,
  documentVersionId: Id<'documentVersions'>
): Effect.fn.Return<void, AppError> {
  const intent = yield* requireBoundUploadIntentEffect(ctx, input, auth)
  yield* convexPromise(() =>
    ctx.db.patch(intent._id, {
      status: 'CONSUMED',
      documentId,
      documentVersionId,
      consumedAt: Date.now(),
    })
  )
})

const prepareDirectUploadIntentProgram = Effect.fn('VdrUploadIntent.prepare')(function* (
  ctx: MutationCtx,
  args: { intentId: Id<'vdrUploadIntents'>; storageId: Id<'_storage'> }
): Effect.fn.Return<PreparedUploadIntent, AppError> {
  const auth = yield* requireAuthEffect(ctx)
  const { profile } = auth
  const intent = yield* convexPromise(() => ctx.db.get(args.intentId))
  if (!intent || intent.requestedByProfileId !== profile._id) {
    return yield* Effect.fail(unauthorized('El intento de subida no es válido para esta sesión.'))
  }
  yield* authorizeRoomScope(ctx, auth, intent)

  if (intent.status === 'CONSUMED') {
    if (intent.storageId === args.storageId && intent.documentId) {
      return { status: 'ALREADY_REGISTERED', documentId: intent.documentId }
    }
    return yield* Effect.fail(
      invalidState('El intento de subida ya fue consumido.', 'UPLOAD_INTENT_REPLAY')
    )
  }
  const now = Date.now()
  if (intent.status === 'INSPECTING') {
    if (intent.storageId !== args.storageId) {
      return yield* Effect.fail(
        invalidState('El intento ya está ligado a otro archivo.', 'UPLOAD_INTENT_STORAGE_MISMATCH')
      )
    }
    if (intent.expiresAt <= now) {
      yield* convexPromise(() =>
        ctx.db.patch(intent._id, { status: 'UNCERTAIN', uncertainAt: now })
      )
      return {
        status: 'BLOCKED',
        registered: false,
        code: 'UPLOAD_INTENT_UNCERTAIN',
      }
    }
    return yield* Effect.fail(
      invalidState(
        'El intento de subida ya está en inspección.',
        'UPLOAD_INTENT_INSPECTION_IN_PROGRESS'
      )
    )
  }
  if (intent.status === 'UNCERTAIN') {
    return yield* Effect.fail(
      invalidState(
        'El intento de subida requiere reconciliación controlada.',
        'UPLOAD_INTENT_UNCERTAIN'
      )
    )
  }
  const isLegacyPreparedIntent =
    (intent.status === 'ACTIVE' || intent.status === 'ISSUED') &&
    (intent.storageId !== undefined || intent.preparedAt !== undefined)
  if (isLegacyPreparedIntent) {
    if (intent.storageId !== args.storageId) {
      return yield* Effect.fail(
        invalidState('El intento ya está ligado a otro archivo.', 'UPLOAD_INTENT_STORAGE_MISMATCH')
      )
    }
    yield* convexPromise(() =>
      ctx.db.patch(
        intent._id,
        intent.expiresAt <= now
          ? { status: 'UNCERTAIN', uncertainAt: now }
          : { status: 'INSPECTING' }
      )
    )
    return {
      status: 'BLOCKED',
      registered: false,
      code: 'UPLOAD_INTENT_UNCERTAIN',
    }
  }
  if (intent.status !== 'ACTIVE' && intent.status !== 'ISSUED') {
    return yield* Effect.fail(
      invalidState('El intento de subida ya no está activo.', 'UPLOAD_INTENT_TERMINAL')
    )
  }

  if (intent.expiresAt <= now) {
    yield* convexPromise(() =>
      ctx.db.patch(intent._id, { status: 'EXPIRED', expiredAt: now })
    )
    return {
      status: 'REJECTED',
      registered: false,
      code: 'UPLOAD_INTENT_EXPIRED',
    }
  }

  if (intent.storageId && intent.storageId !== args.storageId) {
    return yield* Effect.fail(
      invalidState('El intento ya está ligado a otro archivo.', 'UPLOAD_INTENT_STORAGE_MISMATCH')
    )
  }

  // This mutation is the atomic inspection lease. Charge the bounded scan
  // budget before any blob metadata/bytes can reach the external scanner.
  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `inspectedDocumentIngest:${profile._id}`,
      limit: 120,
      windowMs: 60 * 60 * 1000,
    })
  )

  // Public asset and VDR authority are mutually exclusive. Once a storageId
  // is attributed to any asset intent (including rejected/expired evidence),
  // it can never be rebound as a confidential room document.
  const assetIntent = yield* convexPromise(() =>
    ctx.db
      .query('assetUploadIntents')
      .withIndex('by_storageId', (q) => q.eq('storageId', args.storageId))
      .first()
  )
  if (assetIntent) {
    return yield* Effect.fail(unauthorized('El archivo no está autorizado para esta sala.'))
  }

  const existingDocument = yield* findDocumentByStorageIdEffect(ctx, args.storageId)
  if (existingDocument) {
    return yield* Effect.fail(
      validationFailed('Este archivo ya está registrado como documento.', 'storageId')
    )
  }
  const blob = yield* convexPromise(() => ctx.db.system.get(args.storageId))
  if (!blob) {
    yield* convexPromise(() =>
      ctx.db.patch(intent._id, {
        status: 'REJECTED',
        storageId: args.storageId,
        rejectedAt: now,
        rejectionReason: 'STORAGE_NOT_FOUND',
      })
    )
    return { status: 'REJECTED', registered: false, code: 'UPLOAD_INTENT_REJECTED' }
  }

  const contentType = (blob.contentType ?? '').trim().toLowerCase()
  const sizeMismatch = blob.size !== intent.declaredByteSize
  const mimeMismatch = contentType !== intent.declaredMimeType
  const hashMismatch = normalizeSha256Hex(blob.sha256) !== intent.declaredSha256
  if (sizeMismatch || mimeMismatch || hashMismatch || blob.size > MAX_DIRECT_UPLOAD_BYTES) {
    const code =
      blob.size > MAX_DIRECT_UPLOAD_BYTES
        ? 'FILE_TOO_LARGE'
        : mimeMismatch
          ? 'INVALID_FILE_TYPE'
          : 'UPLOAD_INTENT_MISMATCH'
    yield* convexPromise(() =>
      ctx.db.patch(intent._id, {
        status: 'REJECTED',
        storageId: args.storageId,
        rejectedAt: now,
        rejectionReason: code,
      })
    )
    // The declared digest materially reduces confused-deputy copying because
    // a caller now needs the exact bytes/hash, not only metadata + storageId.
    // The provider still does not attest that this storageId came from the
    // URL we minted. Keep the bytes quarantined for attributed reconciliation;
    // an opaque caller-supplied ID must never become a deletion primitive.
    return { status: 'REJECTED', registered: false, code }
  }

  yield* convexPromise(() =>
    ctx.db.patch(intent._id, {
      status: 'INSPECTING',
      storageId: args.storageId,
      preparedAt: now,
      // The authority was exercised before the original deadline. Give the
      // bounded scanner/action enough time to finish without making the intent
      // reusable or unbounded.
      expiresAt: now + VDR_UPLOAD_PREPARED_GRACE_MS,
    })
  )
  const replaceDocumentId = intent.replaceDocumentId
  const replacement = replaceDocumentId
    ? yield* convexPromise(() => ctx.db.get(replaceDocumentId))
    : null
  return {
    status: 'READY',
    bound: {
      intentId: intent._id,
      requestedByProfileId: intent.requestedByProfileId,
      companyId: intent.companyId,
      replaceDocumentId: intent.replaceDocumentId,
      fileName: intent.fileName,
      declaredMimeType: intent.declaredMimeType,
      declaredByteSize: intent.declaredByteSize,
      declaredSha256: intent.declaredSha256,
      name: intent.name,
      description: intent.description,
      accessLevel: intent.accessLevel,
      classification: intent.classification,
      folder: intent.folder,
      expiresAt: intent.documentExpiresAt,
    },
    size: blob.size,
    contentType,
    // Canonical hex: ya probamos arriba que coincide con el digest del blob.
    sha256: intent.declaredSha256,
    expectedCurrentVersionNumber: replacement?.currentVersionNumber ?? (replacement ? 1 : 0),
  }
})

export const prepareDirectUploadIntent = internalMutation({
  args: {
    intentId: v.id('vdrUploadIntents'),
    storageId: v.id('_storage'),
  },
  handler: (ctx, args): Promise<PreparedUploadIntent> =>
    runConvex(prepareDirectUploadIntentProgram(ctx, args)),
})

const abandonDirectUploadIntentProgram = Effect.fn('VdrUploadIntent.abandon')(function* (
  ctx: MutationCtx,
  args: { intentId: Id<'vdrUploadIntents'> }
) {
  const auth = yield* requireAuthEffect(ctx)
  const { profile } = auth
  const intent = yield* convexPromise(() => ctx.db.get(args.intentId))
  if (!intent || intent.requestedByProfileId !== profile._id) {
    return yield* Effect.fail(unauthorized('El intento de subida no es válido para esta sesión.'))
  }
  yield* authorizeRoomScope(ctx, auth, intent)

  if (intent.status === 'ABORTED') return { aborted: true as const }
  if (
    (intent.status === 'ACTIVE' || intent.status === 'ISSUED' || intent.status === 'EXPIRED') &&
    !intent.storageId &&
    !intent.preparedAt
  ) {
    yield* convexPromise(() =>
      ctx.db.patch(intent._id, {
        status: 'ABORTED',
        abortedAt: Date.now(),
      })
    )
    return { aborted: true as const }
  }
  if (
    (intent.status === 'ACTIVE' || intent.status === 'ISSUED') &&
    (intent.storageId || intent.preparedAt)
  ) {
    const now = Date.now()
    yield* convexPromise(() =>
      ctx.db.patch(
        intent._id,
        intent.expiresAt <= now
          ? { status: 'UNCERTAIN', uncertainAt: now }
          : { status: 'INSPECTING' }
      )
    )
  }
  return { aborted: false as const, code: 'UPLOAD_INTENT_UNCERTAIN' as const }
})

export const abandonDirectUploadIntent = mutation({
  args: { intentId: v.id('vdrUploadIntents') },
  handler: (ctx, args) => runConvex(abandonDirectUploadIntentProgram(ctx, args)),
})

const expireIssuedUploadIntentsProgram = Effect.fn('VdrUploadIntent.expireIssued')(function* (
  ctx: MutationCtx,
  args: { limit?: number }
) {
  const now = Date.now()
  const requestedLimit = args.limit ?? MAX_EXPIRY_BATCH
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, MAX_EXPIRY_BATCH))
    : MAX_EXPIRY_BATCH
  const [active, legacy, inspecting, staleUncertain] = yield* convexPromise(() =>
    Promise.all([
      ctx.db
        .query('vdrUploadIntents')
        .withIndex('by_status_expiresAt', (q) => q.eq('status', 'ACTIVE').lte('expiresAt', now))
        .take(limit),
      ctx.db
        .query('vdrUploadIntents')
        .withIndex('by_status_expiresAt', (q) => q.eq('status', 'ISSUED').lte('expiresAt', now))
        .take(limit),
      ctx.db
        .query('vdrUploadIntents')
        .withIndex('by_status_expiresAt', (q) => q.eq('status', 'INSPECTING').lte('expiresAt', now))
        .take(limit),
      ctx.db
        .query('vdrUploadIntents')
        .withIndex('by_status_expiresAt', (q) =>
          q.eq('status', 'UNCERTAIN').lte('expiresAt', now - UNCERTAIN_QUARANTINE_MS)
        )
        .take(limit),
    ])
  )
  const expired = [...active, ...legacy, ...inspecting, ...staleUncertain]
    .sort((left, right) => left.expiresAt - right.expiresAt)
    .slice(0, limit)

  for (const intent of expired) {
    if (intent.status === 'UNCERTAIN') {
      yield* convexPromise(() =>
        ctx.db.patch(intent._id, {
          status: 'REJECTED',
          rejectedAt: now,
          rejectionReason: 'UNCERTAIN_RECONCILIATION_REQUIRED',
        })
      )
    } else if (
      intent.status === 'INSPECTING' ||
      intent.storageId !== undefined ||
      intent.preparedAt !== undefined
    ) {
      yield* convexPromise(() =>
        ctx.db.patch(intent._id, { status: 'UNCERTAIN', uncertainAt: now })
      )
    } else {
      yield* convexPromise(() =>
        ctx.db.patch(intent._id, { status: 'EXPIRED', expiredAt: now })
      )
    }
  }

  // Convex upload URLs do not expose a storageId until a browser completes
  // the POST. Expiring an abandoned intent therefore cannot truthfully claim
  // to delete an unknown blob; this bounded transition only closes authority.
  return { expired: expired.length, hasMore: expired.length === limit }
})

export const expireIssuedUploadIntents = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: (ctx, args) => runConvex(expireIssuedUploadIntentsProgram(ctx, args)),
})
