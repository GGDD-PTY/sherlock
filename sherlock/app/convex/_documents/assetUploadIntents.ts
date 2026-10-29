// ============================================================================
// INTENTOS DE SUBIDA DE ACTIVOS PÚBLICOS (avatar / logo)
// ============================================================================
// Máquina de estados propia y separada de la del VDR: ISSUED → CONSUMED, con
// caídas a EXPIRED y REJECTED. Un blob que alguna vez entró por el carril del
// VDR nunca puede salir por este, ni al revés.
//
// La emisión y el finalizador son mutations (sin timers ni fetch); la
// inspección de bytes y el escaneo viven en la action, que es donde el aislado
// sí permite hablar con el gateway.
// ============================================================================

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { Effect, Schema } from 'effect'

import type { Doc, Id } from '../_generated/dataModel'
import {
  action,
  internalMutation,
  mutation,
  type ActionCtx,
  type MutationCtx,
} from '../_generated/server'
import { requireAuthEffect } from '../_helpers/auth.identity'
import { convexPromise, convexSync, runConvex } from '../_helpers/effect'
import type { AppError } from '../_helpers/errors'
import { invalidState, unauthorized, validationFailed } from '../_helpers/errors'
import { enforceRateLimit } from '../_helpers/rateLimit'
import { normalizeSha256Hex } from '../_helpers/sha256'
import {
  assetSignatureMatchesMimeType,
  detectAssetFileSignature,
  type AssetFileSignature,
} from './assetFileInspection'
import { requiresConfiguredScanner, scanFileWithConfiguredGateway } from './scanner'
import { findDocumentByStorageIdEffect } from './shared'
import { findVdrUploadIntentByStorageIdEffect } from './uploadIntents'

const ASSET_UPLOAD_INTENT_TTL_MS = 10 * 60 * 1000
const MAX_ASSET_UPLOAD_BYTES = 4 * 1024 * 1024
const MAX_ACTIVE_ASSET_INTENTS_PER_PROFILE = 5

const ASSET_PURPOSES = ['AVATAR', 'LOGO'] as const

const AssetPurposeSchema = Schema.Literals(ASSET_PURPOSES)

type AssetPurpose = typeof AssetPurposeSchema.Type

// El validador se armaba con `ASSET_PURPOSES[0]` y `[1]`, o sea por posición.
// Agregar un tercer propósito a la lista habría dejado el validador aceptando
// solo los dos primeros, y el typecheck no habría dicho nada. Ahora se
// construye recorriendo la lista del schema, que es la definición única.
const [firstPurpose, ...otherPurposes] = AssetPurposeSchema.literals
const purposeValidator = v.union(
  v.literal(firstPurpose),
  ...otherPurposes.map((purpose) => v.literal(purpose))
)

const PURPOSE_MIME_TYPES: Readonly<Record<AssetPurpose, readonly string[]>> = {
  AVATAR: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  LOGO: ['image/jpeg', 'image/png', 'image/webp'],
}

type AssetUploadRejection = {
  status: 'REJECTED'
  code: 'ASSET_UPLOAD_REJECTED' | 'ASSET_UPLOAD_EXPIRED'
}

type PreparedAssetUpload =
  | {
      status: 'READY'
      intentId: Id<'assetUploadIntents'>
      requestedByProfileId: Id<'profiles'>
      purpose: AssetPurpose
      storageId: Id<'_storage'>
      size: number
      contentType: string
      sha256: string
    }
  | { status: 'ALREADY_RESOLVED'; url: string }
  | AssetUploadRejection

type ResolveAssetUploadResult =
  | { resolved: true; url: string }
  | { resolved: false; code: 'ASSET_UPLOAD_REJECTED' | 'ASSET_UPLOAD_EXPIRED' }

const ASSET_REJECTION_REASONS = [
  'INVALID_ASSET_SIGNATURE',
  'MALWARE_DETECTED',
  'SCAN_UNAVAILABLE',
] as const

type AssetRejectionReason = (typeof ASSET_REJECTION_REASONS)[number]

const assetRejectionReasonValidator = v.union(
  v.literal(ASSET_REJECTION_REASONS[0]),
  v.literal(ASSET_REJECTION_REASONS[1]),
  v.literal(ASSET_REJECTION_REASONS[2])
)

type AssetDeclaration = {
  declaredMimeType: string
  declaredByteSize: number
  declaredSha256: string
}

function validateAssetDeclaration(args: {
  purpose: AssetPurpose
  declaredMimeType: string
  declaredByteSize: number
  declaredSha256: string
}): AssetDeclaration {
  const declaredMimeType = args.declaredMimeType.trim().toLowerCase()
  if (!PURPOSE_MIME_TYPES[args.purpose].includes(declaredMimeType)) {
    throw validationFailed('El tipo de imagen no está permitido.', 'declaredMimeType')
  }
  if (
    !Number.isSafeInteger(args.declaredByteSize) ||
    args.declaredByteSize <= 0 ||
    args.declaredByteSize > MAX_ASSET_UPLOAD_BYTES
  ) {
    throw validationFailed('El tamaño declarado no está permitido.', 'declaredByteSize')
  }
  const declaredSha256 = args.declaredSha256.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(declaredSha256)) {
    throw validationFailed('La huella del archivo no es válida.', 'declaredSha256')
  }
  return { declaredMimeType, declaredByteSize: args.declaredByteSize, declaredSha256 }
}

type IssueAssetIntentArgs = {
  purpose: AssetPurpose
  declaredMimeType: string
  declaredByteSize: number
  declaredSha256: string
}

const issueAssetUploadIntentProgram = Effect.fn('AssetUploadIntent.issue')(function* (
  ctx: MutationCtx,
  args: IssueAssetIntentArgs
): Effect.fn.Return<
  { intentId: Id<'assetUploadIntents'>; uploadUrl: string; expiresAt: number },
  AppError
> {
  const { profile } = yield* requireAuthEffect(ctx)
  if (profile.role !== 'ADMIN' && profile.role !== 'COMPANY') {
    return yield* Effect.fail(unauthorized('No autorizado para subir activos de perfil.'))
  }
  const declaration = yield* convexSync(() => validateAssetDeclaration(args))

  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `assetUploadIntent:${profile._id}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    })
  )

  const now = Date.now()
  const issued = yield* convexPromise(() =>
    ctx.db
      .query('assetUploadIntents')
      .withIndex('by_requester_status', (q) =>
        q.eq('requestedByProfileId', profile._id).eq('status', 'ISSUED')
      )
      .take(MAX_ACTIVE_ASSET_INTENTS_PER_PROFILE + 1)
  )
  let activeCount = 0
  for (const intent of issued) {
    if (intent.expiresAt <= now) {
      yield* convexPromise(() =>
        ctx.db.patch(intent._id, { status: 'EXPIRED', expiredAt: now })
      )
    } else {
      activeCount += 1
    }
  }
  if (activeCount >= MAX_ACTIVE_ASSET_INTENTS_PER_PROFILE) {
    return yield* Effect.fail(
      invalidState('Tienes demasiadas cargas de imagen pendientes.', 'ASSET_UPLOAD_INTENT_LIMIT')
    )
  }

  const expiresAt = now + ASSET_UPLOAD_INTENT_TTL_MS
  const intentId = yield* convexPromise(() =>
    ctx.db.insert('assetUploadIntents', {
      requestedByProfileId: profile._id,
      purpose: args.purpose,
      status: 'ISSUED',
      ...declaration,
      createdAt: now,
      expiresAt,
    })
  )
  const uploadUrl = yield* convexPromise(() => ctx.storage.generateUploadUrl())
  return { intentId, uploadUrl, expiresAt }
})

export const issueAssetUploadIntent = mutation({
  args: {
    purpose: purposeValidator,
    declaredMimeType: v.string(),
    declaredByteSize: v.number(),
    declaredSha256: v.string(),
  },
  handler: (ctx, args) => runConvex(issueAssetUploadIntentProgram(ctx, args)),
})

const rejectAssetIntent = Effect.fn('AssetUploadIntent.reject')(function* (
  ctx: MutationCtx,
  intent: Doc<'assetUploadIntents'>,
  storageId: Id<'_storage'>,
  reason: string
): Effect.fn.Return<AssetUploadRejection, AppError> {
  yield* convexPromise(() =>
    ctx.db.patch(intent._id, {
      status: 'REJECTED',
      storageId,
      rejectedAt: Date.now(),
      rejectionReason: reason,
    })
  )
  return { status: 'REJECTED', code: 'ASSET_UPLOAD_REJECTED' }
})

const prepareAssetUploadProgram = Effect.fn('AssetUploadIntent.prepare')(function* (
  ctx: MutationCtx,
  args: { intentId: Id<'assetUploadIntents'>; storageId: Id<'_storage'> }
): Effect.fn.Return<PreparedAssetUpload, AppError> {
  const { profile } = yield* requireAuthEffect(ctx)
  const intent = yield* convexPromise(() => ctx.db.get(args.intentId))
  if (!intent || intent.requestedByProfileId !== profile._id) {
    return yield* Effect.fail(
      unauthorized('La carga de imagen no está autorizada para esta sesión.')
    )
  }

  if (intent.status === 'CONSUMED') {
    if (intent.storageId !== args.storageId) {
      return yield* Effect.fail(
        invalidState('La carga de imagen ya fue consumida.', 'ASSET_UPLOAD_REPLAY')
      )
    }
    const url = yield* convexPromise(() => ctx.storage.getUrl(args.storageId))
    if (!url) {
      return yield* Effect.fail(
        invalidState('La imagen ya no está disponible.', 'ASSET_STORAGE_MISSING')
      )
    }
    return { status: 'ALREADY_RESOLVED', url }
  }
  if (intent.status !== 'ISSUED') {
    return yield* Effect.fail(
      invalidState('La carga de imagen ya no está activa.', 'ASSET_UPLOAD_TERMINAL')
    )
  }

  const now = Date.now()
  if (intent.expiresAt <= now) {
    yield* convexPromise(() =>
      ctx.db.patch(intent._id, { status: 'EXPIRED', expiredAt: now })
    )
    return { status: 'REJECTED', code: 'ASSET_UPLOAD_EXPIRED' }
  }
  if (intent.storageId && intent.storageId !== args.storageId) {
    return yield* Effect.fail(
      invalidState('La carga está ligada a otro archivo.', 'ASSET_UPLOAD_STORAGE_MISMATCH')
    )
  }

  // A blob that ever entered the VDR intent lane stays quarantined from the
  // public-asset lane, including terminal REJECTED/EXPIRED evidence.
  const vdrIntent = yield* findVdrUploadIntentByStorageIdEffect(ctx, args.storageId)
  if (vdrIntent) {
    return yield* rejectAssetIntent(ctx, intent, args.storageId, 'VDR_STORAGE_CONFLICT')
  }

  const backingDocument = yield* findDocumentByStorageIdEffect(ctx, args.storageId)
  if (backingDocument) {
    return yield* rejectAssetIntent(ctx, intent, args.storageId, 'DOCUMENT_STORAGE_CONFLICT')
  }

  const blob = yield* convexPromise(() => ctx.db.system.get(args.storageId))
  if (!blob) return yield* rejectAssetIntent(ctx, intent, args.storageId, 'STORAGE_NOT_FOUND')
  const contentType = (blob.contentType ?? '').trim().toLowerCase()
  if (
    blob.size !== intent.declaredByteSize ||
    blob.size > MAX_ASSET_UPLOAD_BYTES ||
    contentType !== intent.declaredMimeType ||
    normalizeSha256Hex(blob.sha256) !== intent.declaredSha256
  ) {
    return yield* rejectAssetIntent(ctx, intent, args.storageId, 'ASSET_METADATA_MISMATCH')
  }

  yield* convexPromise(() =>
    ctx.db.patch(intent._id, { storageId: args.storageId, preparedAt: now })
  )
  return {
    status: 'READY',
    intentId: intent._id,
    requestedByProfileId: intent.requestedByProfileId,
    purpose: intent.purpose,
    storageId: args.storageId,
    size: blob.size,
    contentType,
    sha256: intent.declaredSha256,
  }
})

export const prepareAssetUpload = internalMutation({
  args: {
    intentId: v.id('assetUploadIntents'),
    storageId: v.id('_storage'),
  },
  handler: (ctx, args): Promise<PreparedAssetUpload> =>
    runConvex(prepareAssetUploadProgram(ctx, args)),
})

const rejectInspectedAssetUploadProgram = Effect.fn('AssetUploadIntent.rejectInspected')(function* (
  ctx: MutationCtx,
  args: {
    intentId: Id<'assetUploadIntents'>
    storageId: Id<'_storage'>
    reason: AssetRejectionReason
  }
): Effect.fn.Return<AssetUploadRejection, AppError> {
  const { profile } = yield* requireAuthEffect(ctx)
  const intent = yield* convexPromise(() => ctx.db.get(args.intentId))
  if (
    !intent ||
    intent.requestedByProfileId !== profile._id ||
    intent.status !== 'ISSUED' ||
    intent.storageId !== args.storageId
  ) {
    return yield* Effect.fail(
      unauthorized('La carga de imagen no está autorizada para esta sesión.')
    )
  }
  return yield* rejectAssetIntent(ctx, intent, args.storageId, args.reason)
})

export const rejectInspectedAssetUpload = internalMutation({
  args: {
    intentId: v.id('assetUploadIntents'),
    storageId: v.id('_storage'),
    reason: assetRejectionReasonValidator,
  },
  handler: (ctx, args): Promise<AssetUploadRejection> =>
    runConvex(rejectInspectedAssetUploadProgram(ctx, args)),
})

type FinalizeAssetArgs = {
  intentId: Id<'assetUploadIntents'>
  storageId: Id<'_storage'>
  inspectedSize: number
  inspectedSha256: string
  signature: Exclude<AssetFileSignature, 'UNKNOWN'>
  malwareScanStatus: 'NOT_CONFIGURED' | 'CLEAN'
  scannerEngine?: string
  scannerScanId?: string
  scannerDefinitionVersion?: string
  scannedAt?: number
}

const finalizeAssetUploadProgram = Effect.fn('AssetUploadIntent.finalize')(function* (
  ctx: MutationCtx,
  args: FinalizeAssetArgs
): Effect.fn.Return<string, AppError> {
  const { profile } = yield* requireAuthEffect(ctx)
  const intent = yield* convexPromise(() => ctx.db.get(args.intentId))
  if (
    !intent ||
    intent.requestedByProfileId !== profile._id ||
    intent.status !== 'ISSUED' ||
    intent.storageId !== args.storageId
  ) {
    return yield* Effect.fail(
      unauthorized('La carga de imagen no está autorizada para esta sesión.')
    )
  }
  if (intent.expiresAt <= Date.now()) {
    return yield* Effect.fail(invalidState('La carga de imagen expiró.', 'ASSET_UPLOAD_EXPIRED'))
  }
  if (args.malwareScanStatus === 'NOT_CONFIGURED' && requiresConfiguredScanner(process.env)) {
    return yield* Effect.fail(
      invalidState('La verificación de seguridad no está disponible.', 'SCAN_UNAVAILABLE')
    )
  }

  const [vdrIntent, backingDocument, blob] = yield* Effect.all(
    [
      findVdrUploadIntentByStorageIdEffect(ctx, args.storageId),
      findDocumentByStorageIdEffect(ctx, args.storageId),
      convexPromise(() => ctx.db.system.get(args.storageId)),
    ] as const,
    { concurrency: 'unbounded' }
  )
  if (vdrIntent || backingDocument || !blob) {
    return yield* Effect.fail(
      unauthorized('La carga de imagen no está autorizada para esta sesión.')
    )
  }
  if (
    blob.size !== intent.declaredByteSize ||
    blob.size !== args.inspectedSize ||
    blob.contentType?.trim().toLowerCase() !== intent.declaredMimeType ||
    normalizeSha256Hex(blob.sha256) !== intent.declaredSha256 ||
    normalizeSha256Hex(args.inspectedSha256) !== intent.declaredSha256 ||
    !assetSignatureMatchesMimeType(intent.declaredMimeType, args.signature)
  ) {
    return yield* Effect.fail(
      unauthorized('La carga de imagen no está autorizada para esta sesión.')
    )
  }

  yield* convexPromise(() =>
    ctx.db.patch(intent._id, {
      status: 'CONSUMED',
      signatureKind: args.signature,
      malwareScanStatus: args.malwareScanStatus,
      scannerEngine: args.scannerEngine,
      scannerScanId: args.scannerScanId,
      scannerDefinitionVersion: args.scannerDefinitionVersion,
      scannedAt: args.scannedAt,
      consumedAt: Date.now(),
    })
  )
  const url = yield* convexPromise(() => ctx.storage.getUrl(args.storageId))
  if (!url) {
    return yield* Effect.fail(
      invalidState('La imagen no está disponible.', 'ASSET_STORAGE_MISSING')
    )
  }
  return url
})

export const finalizeAssetUpload = internalMutation({
  args: {
    intentId: v.id('assetUploadIntents'),
    storageId: v.id('_storage'),
    inspectedSize: v.number(),
    inspectedSha256: v.string(),
    signature: v.union(v.literal('JPEG'), v.literal('PNG'), v.literal('GIF'), v.literal('WEBP')),
    malwareScanStatus: v.union(v.literal('NOT_CONFIGURED'), v.literal('CLEAN')),
    scannerEngine: v.optional(v.string()),
    scannerScanId: v.optional(v.string()),
    scannerDefinitionVersion: v.optional(v.string()),
    scannedAt: v.optional(v.number()),
  },
  handler: (ctx, args): Promise<string> => runConvex(finalizeAssetUploadProgram(ctx, args)),
})

type ResolveAssetArgs = {
  intentId: Id<'assetUploadIntents'>
  storageId: Id<'_storage'>
}

const prepareAssetRef = makeFunctionReference<'mutation', ResolveAssetArgs, PreparedAssetUpload>(
  '_documents/assetUploadIntents:prepareAssetUpload'
)
const rejectAssetRef = makeFunctionReference<
  'mutation',
  ResolveAssetArgs & { reason: AssetRejectionReason },
  AssetUploadRejection
>('_documents/assetUploadIntents:rejectInspectedAssetUpload')
const finalizeAssetRef = makeFunctionReference<'mutation', FinalizeAssetArgs, string>(
  '_documents/assetUploadIntents:finalizeAssetUpload'
)

const resolveAssetUploadProgram = Effect.fn('AssetUploadIntent.resolve')(function* (
  ctx: ActionCtx,
  args: ResolveAssetArgs
): Effect.fn.Return<ResolveAssetUploadResult, AppError> {
  const prepared = yield* convexPromise(() => ctx.runMutation(prepareAssetRef, args))
  if (prepared.status === 'ALREADY_RESOLVED') {
    return { resolved: true, url: prepared.url }
  }
  if (prepared.status === 'REJECTED') {
    return { resolved: false, code: prepared.code }
  }

  const reject = Effect.fn('AssetUploadIntent.resolve.reject')(function* (
    reason: AssetRejectionReason
  ) {
    yield* convexPromise(() => ctx.runMutation(rejectAssetRef, { ...args, reason }))
    return { resolved: false, code: 'ASSET_UPLOAD_REJECTED' } satisfies ResolveAssetUploadResult
  })

  const blob = yield* convexPromise(() => ctx.storage.get(args.storageId))
  if (!blob || blob.size !== prepared.size) {
    return yield* reject('SCAN_UNAVAILABLE')
  }
  const header = new Uint8Array(yield* convexPromise(() => blob.slice(0, 16).arrayBuffer()))
  const signature = detectAssetFileSignature(header)
  if (signature === 'UNKNOWN' || !assetSignatureMatchesMimeType(prepared.contentType, signature)) {
    return yield* reject('INVALID_ASSET_SIGNATURE')
  }

  const scan = yield* convexPromise(() =>
    scanFileWithConfiguredGateway(blob, prepared.sha256)
  )
  if (scan.status === 'INFECTED') {
    return yield* reject('MALWARE_DETECTED')
  }
  if (
    scan.status === 'ERROR' ||
    (scan.status === 'NOT_CONFIGURED' && requiresConfiguredScanner(process.env))
  ) {
    return yield* reject('SCAN_UNAVAILABLE')
  }

  const url = yield* convexPromise(() =>
    ctx.runMutation(finalizeAssetRef, {
      ...args,
      inspectedSize: prepared.size,
      inspectedSha256: prepared.sha256,
      signature,
      malwareScanStatus: scan.status,
      ...(scan.status === 'CLEAN'
        ? {
            scannerEngine: scan.engine,
            scannerScanId: scan.scanId,
            scannerDefinitionVersion: scan.definitionVersion,
            scannedAt: scan.scannedAt,
          }
        : {}),
    })
  )
  return { resolved: true, url }
})

export const resolveAssetUpload = action({
  args: {
    intentId: v.id('assetUploadIntents'),
    storageId: v.id('_storage'),
  },
  handler: (ctx, args): Promise<ResolveAssetUploadResult> =>
    runConvex(resolveAssetUploadProgram(ctx, args)),
})
