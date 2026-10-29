// ============================================================================
// VDR WRITE — server-proof upload for the client MCP
// ============================================================================
// HMAC authenticates the app tier. Authorization is recomputed from the
// WorkOS subject on every entry: only the COMPANY owner of the room may
// issue or confirm. Inspection reuses the same signature/zip/csv/office
// scanners as the web path; the document row is the same USER_UPLOAD
// ingest, with access logged as `upload_mcp` and the team alert scheduled
// through `_recordVdrUpload`.
// ============================================================================

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { Effect } from 'effect'

import { internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { internalMutation, type ActionCtx, type MutationCtx } from '../_generated/server'
import {
  detectFileSignature,
  inspectCsvFile,
  inspectOfficeFile,
  inspectZipSafety,
  matchesDeclaredMimeType,
  type FileSignature,
} from '../_documents/fileInspection'
import { inferDocumentClassification } from '../_documents/policy'
import { scanFileWithConfiguredGateway } from '../_documents/scanner'
import {
  findDocumentByStorageIdEffect,
  recordDocumentAccessLog,
  validateVdrShellFolderDestination,
} from '../_documents/shared'
import {
  directUploadLimitBytesForMimeType,
  isDirectUploadMimeType,
  MAX_DIRECT_UPLOAD_BYTES,
  mcpReadableUploadLimitBytes,
  VDR_MCP_READ_MAX_BYTES,
  type DirectUploadRejection,
} from '../_documents/uploadLimits'
import type { UploadIntentRejection } from '../_documents/uploadIntents'
import { convexPromise, convexSync, runConvex } from '../_helpers/effect'
import type { AppError } from '../_helpers/errors'
import { invalidState, unauthorized, validationFailed } from '../_helpers/errors'
import { enforceRateLimit } from '../_helpers/rateLimit'
import { normalizeSha256Hex } from '../_helpers/sha256'
import { isVdrReadFailure, resolveVdrReadBinding } from '../_vdrRead/binding'
import { requireVdrReadServerProof } from '../_vdrRead/serverProof'

const VDR_UPLOAD_INTENT_TTL_MS = 10 * 60 * 1000
const MAX_FILE_NAME_LENGTH = 180
const MAX_DESCRIPTION_LENGTH = 2_000
const MCP_UPLOAD_RATE_LIMIT = 10
const MCP_UPLOAD_RATE_WINDOW_MS = 60 * 60 * 1_000

const proofArgs = {
  serverIssuedAt: v.number(),
  serverProof: v.string(),
} as const

type VdrWriteFailure = Readonly<{ code: 'DENIED' | 'NOT_FOUND' }>

export type IssuedMcpUpload =
  | VdrWriteFailure
  | { registered: false; code: UploadIntentRejection['code'] }
  | {
      intentId: Id<'vdrUploadIntents'>
      uploadUrl: string
      expiresAt: number
    }

export type RegisteredMcpUpload =
  | VdrWriteFailure
  | DirectUploadRejection
  | { registered: false; code: UploadIntentRejection['code'] }
  | {
      documentId: Id<'documents'>
      versionId: Id<'documentVersions'>
      versionNumero: number
      nombre: string
      carpeta: string
    }

type IssueArgs = {
  principalId: string
  salaId?: string
  carpeta: string
  nombre: string
  mime: string
  tamanoBytes: number
  nota?: string
  serverIssuedAt: number
  serverProof: string
}

type RegisterArgs = {
  principalId: string
  salaId?: string
  intentId: Id<'vdrUploadIntents'>
  storageId: Id<'_storage'>
  serverIssuedAt: number
  serverProof: string
}

type PreparedMcpUpload =
  | {
      status: 'ALREADY_REGISTERED'
      documentId: Id<'documents'>
      versionId: Id<'documentVersions'>
      versionNumero: number
      nombre: string
      carpeta: string
    }
  | {
      status: 'READY'
      intentId: Id<'vdrUploadIntents'>
      requestedByProfileId: Id<'profiles'>
      companyId: Id<'companies'>
      storageId: Id<'_storage'>
      fileName: string
      declaredMimeType: string
      declaredByteSize: number
      declaredSha256: string
      name: string
      description?: string
      folder: string
      size: number
      contentType: string
      sha256: string
    }
  | { status: 'REJECTED'; registered: false; code: UploadIntentRejection['code'] }
  | VdrWriteFailure

type UnsafeUploadReason =
  | 'INVALID_FILE_SIGNATURE'
  | 'INVALID_ARCHIVE'
  | 'ENCRYPTED_ARCHIVE'
  | 'ZIP_BOMB'
  | 'MALWARE_DETECTED'
  | 'SCAN_UNAVAILABLE'

const unsafeUploadReasonValidator = v.union(
  v.literal('INVALID_FILE_SIGNATURE'),
  v.literal('INVALID_ARCHIVE'),
  v.literal('ENCRYPTED_ARCHIVE'),
  v.literal('ZIP_BOMB'),
  v.literal('MALWARE_DETECTED'),
  v.literal('SCAN_UNAVAILABLE')
)

function randomSha256Hex(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 32 || code === 127) return true
  }
  return false
}

function collapseSpaces(value: string): string {
  return value.split(/\s+/u).join(' ')
}

function normalizeText(value: string, maximum: number, field: string): string {
  const normalized = collapseSpaces(value.normalize('NFKC').trim())
  if (normalized.length === 0 || normalized.length > maximum || hasControlChars(normalized)) {
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
  const normalized = collapseSpaces(value.normalize('NFKC').trim())
  if (normalized.length === 0) return undefined
  if (normalized.length > maximum || hasControlChars(normalized)) {
    throw validationFailed(`El campo ${field} no es válido.`, field)
  }
  return normalized
}

const requireCompanyOwnerBinding = Effect.fn('VdrWrite.requireCompanyOwner')(function* (
  ctx: MutationCtx,
  args: { principalId: string; salaId?: string }
) {
  const binding = yield* convexPromise(() =>
    resolveVdrReadBinding(ctx, {
      principalId: args.principalId,
      salaId: args.salaId,
    })
  )
  if (isVdrReadFailure(binding)) return binding
  // MCP write is the client's own room, never the team's.
  if (binding.role !== 'COMPANY') return { code: 'NOT_FOUND' as const }
  return binding
})

export const issueUploadIntentProgram = Effect.fn('VdrWrite.issueIntent')(function* (
  ctx: MutationCtx,
  args: IssueArgs
): Effect.fn.Return<IssuedMcpUpload, AppError> {
  yield* convexPromise(() =>
    requireVdrReadServerProof({
      operation: 'ISSUE_UPLOAD_INTENT',
      issuedAt: args.serverIssuedAt,
      proof: args.serverProof,
      bindingParts: [
        args.principalId,
        args.salaId ?? '',
        args.carpeta,
        args.nombre,
        args.mime,
        String(args.tamanoBytes),
        args.nota ?? '',
      ],
    })
  )

  const binding = yield* requireCompanyOwnerBinding(ctx, args)
  if ('code' in binding) return binding

  const folder = yield* convexSync(() => validateVdrShellFolderDestination(args.carpeta))
  const nombre = yield* convexSync(() => normalizeText(args.nombre, MAX_FILE_NAME_LENGTH, 'nombre'))
  const nota = yield* convexSync(() =>
    normalizeOptionalText(args.nota, MAX_DESCRIPTION_LENGTH, 'nota')
  )
  const mime = args.mime.trim().toLowerCase()
  if (!isDirectUploadMimeType(mime)) {
    return { registered: false, code: 'INVALID_FILE_TYPE' }
  }
  if (!Number.isSafeInteger(args.tamanoBytes) || args.tamanoBytes <= 0) {
    return yield* Effect.fail(
      validationFailed('El tamaño declarado del archivo no está permitido.', 'tamano_bytes')
    )
  }
  if (args.tamanoBytes > mcpReadableUploadLimitBytes(mime)) {
    return { registered: false, code: 'FILE_TOO_LARGE' }
  }

  const { company } = binding
  const { profile } = binding.auth
  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `vdrMcpUpload:${profile._id}`,
      limit: MCP_UPLOAD_RATE_LIMIT,
      windowMs: MCP_UPLOAD_RATE_WINDOW_MS,
    })
  )

  const now = Date.now()
  const intentId = yield* convexPromise(() =>
    ctx.db.insert('vdrUploadIntents', {
      companyId: company._id,
      requestedByProfileId: profile._id,
      status: 'ACTIVE',
      fileName: nombre,
      declaredMimeType: mime,
      declaredByteSize: args.tamanoBytes,
      // El agente no trae huella: se sella una al azar y se sustituye por la
      // del blob en el prepare, cuando Convex ya la calculó.
      declaredSha256: randomSha256Hex(),
      name: nombre,
      description: nota,
      accessLevel: 'NDA_REQUIRED',
      folder,
      createdAt: now,
      expiresAt: now + VDR_UPLOAD_INTENT_TTL_MS,
    })
  )
  const uploadUrl = yield* convexPromise(() => ctx.storage.generateUploadUrl())
  return { intentId, uploadUrl, expiresAt: now + VDR_UPLOAD_INTENT_TTL_MS }
})

const prepareMcpUploadProgram = Effect.fn('VdrWrite.prepare')(function* (
  ctx: MutationCtx,
  args: {
    principalId: string
    salaId?: string
      intentId: Id<'vdrUploadIntents'>
    storageId: Id<'_storage'>
  }
): Effect.fn.Return<PreparedMcpUpload, AppError> {
  const binding = yield* requireCompanyOwnerBinding(ctx, args)
  if ('code' in binding) return binding

  const intent = yield* convexPromise(() => ctx.db.get(args.intentId))
  if (
    !intent ||
    intent.requestedByProfileId !== binding.auth.profile._id ||
    intent.companyId !== binding.company._id
  ) {
    return { code: 'NOT_FOUND' }
  }

  const consumedDocumentId = intent.documentId
  const consumedVersionId = intent.documentVersionId
  if (intent.status === 'CONSUMED' && consumedDocumentId && consumedVersionId) {
    if (intent.storageId === args.storageId) {
      const document = yield* convexPromise(() => ctx.db.get(consumedDocumentId))
      const version = yield* convexPromise(() => ctx.db.get(consumedVersionId))
      return {
        status: 'ALREADY_REGISTERED',
        documentId: consumedDocumentId,
        versionId: consumedVersionId,
        versionNumero: version?.versionNumber ?? document?.currentVersionNumber ?? 1,
        nombre: document?.name ?? intent.name,
        carpeta: document?.folder ?? intent.folder,
      }
    }
    return { code: 'NOT_FOUND' }
  }

  const now = Date.now()
  if (intent.expiresAt <= now) {
    yield* convexPromise(() => ctx.db.patch(intent._id, { status: 'EXPIRED', expiredAt: now }))
    return { status: 'REJECTED', registered: false, code: 'UPLOAD_INTENT_EXPIRED' }
  }
  if (intent.status !== 'ACTIVE' && intent.status !== 'ISSUED') {
    return yield* Effect.fail(
      invalidState('El intento de subida ya no está activo.', 'UPLOAD_INTENT_TERMINAL')
    )
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
  const realSha256 = normalizeSha256Hex(blob.sha256)
  if (
    sizeMismatch ||
    mimeMismatch ||
    !realSha256 ||
    blob.size > MAX_DIRECT_UPLOAD_BYTES ||
    blob.size > directUploadLimitBytesForMimeType(intent.declaredMimeType) ||
    blob.size > VDR_MCP_READ_MAX_BYTES
  ) {
    const code =
      blob.size > MAX_DIRECT_UPLOAD_BYTES ||
      blob.size > directUploadLimitBytesForMimeType(intent.declaredMimeType) ||
      blob.size > VDR_MCP_READ_MAX_BYTES
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
    return { status: 'REJECTED', registered: false, code }
  }

  yield* convexPromise(() =>
    ctx.db.patch(intent._id, {
      status: 'INSPECTING',
      storageId: args.storageId,
      declaredSha256: realSha256,
      preparedAt: now,
    })
  )

  return {
    status: 'READY',
    intentId: intent._id,
    requestedByProfileId: intent.requestedByProfileId,
    companyId: intent.companyId,
    storageId: args.storageId,
    fileName: intent.fileName,
    declaredMimeType: intent.declaredMimeType,
    declaredByteSize: intent.declaredByteSize,
    declaredSha256: realSha256,
    name: intent.name,
    description: intent.description,
    folder: intent.folder,
    size: blob.size,
    contentType,
    sha256: realSha256,
  }
})

const rejectMcpUploadProgram = Effect.fn('VdrWrite.reject')(function* (
  ctx: MutationCtx,
  args: {
    principalId: string
    salaId?: string
      intentId: Id<'vdrUploadIntents'>
    storageId: Id<'_storage'>
    reason: UnsafeUploadReason
  }
): Effect.fn.Return<DirectUploadRejection, AppError> {
  const binding = yield* requireCompanyOwnerBinding(ctx, args)
  if ('code' in binding) {
    return yield* Effect.fail(unauthorized('El intento de subida no es válido para esta sesión.'))
  }
  const intent = yield* convexPromise(() => ctx.db.get(args.intentId))
  if (
    !intent ||
    intent.requestedByProfileId !== binding.auth.profile._id ||
    intent.companyId !== binding.company._id
  ) {
    return yield* Effect.fail(unauthorized('El intento de subida no es válido para esta sesión.'))
  }
  const now = Date.now()
  yield* convexPromise(() =>
    ctx.db.patch(intent._id, {
      status: 'REJECTED',
      storageId: args.storageId,
      rejectedAt: now,
      rejectionReason: args.reason,
    })
  )
  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      userId: binding.auth.profile._id,
      action: 'VDR_DOCUMENT_INGEST_REJECTED',
      entityType: 'DOCUMENT_INGEST',
      entityId: args.storageId,
      metadata: {
        resourceType: 'COMPANY',
        resourceId: intent.companyId,
        details: { outcome: args.reason },
      },
    })
  )
  return { registered: false, code: args.reason }
})

type FinalizeArgs = {
  principalId: string
  salaId?: string
  intentId: Id<'vdrUploadIntents'>
  storageId: Id<'_storage'>
  inspectedSize: number
  inspectedSha256: string
  signature: FileSignature
  malwareScanStatus: 'NOT_CONFIGURED' | 'CLEAN'
  scannerEngine?: string
  scannerScanId?: string
  scannerDefinitionVersion?: string
  scannedAt?: number
}

const finalizeMcpUploadProgram = Effect.fn('VdrWrite.finalize')(function* (
  ctx: MutationCtx,
  args: FinalizeArgs
): Effect.fn.Return<
  {
    documentId: Id<'documents'>
    versionId: Id<'documentVersions'>
    versionNumero: number
    nombre: string
    carpeta: string
  },
  AppError
> {
  const binding = yield* requireCompanyOwnerBinding(ctx, args)
  if ('code' in binding) {
    return yield* Effect.fail(unauthorized('El intento de subida no es válido para esta sesión.'))
  }
  const { profile } = binding.auth
  const intent = yield* convexPromise(() => ctx.db.get(args.intentId))
  if (
    !intent ||
    intent.requestedByProfileId !== profile._id ||
    intent.companyId !== binding.company._id ||
    intent.storageId !== args.storageId ||
    intent.status !== 'INSPECTING'
  ) {
    return yield* Effect.fail(unauthorized('El intento de subida no es válido para esta sesión.'))
  }

  const blob = yield* convexPromise(() => ctx.db.system.get(args.storageId))
  if (!blob) {
    return yield* Effect.fail(
      validationFailed('El archivo no existe en el almacenamiento.', 'storageId')
    )
  }
  const contentType = (blob.contentType ?? '').trim().toLowerCase()
  if (
    blob.size !== args.inspectedSize ||
    normalizeSha256Hex(blob.sha256) !== args.inspectedSha256 ||
    !matchesDeclaredMimeType(contentType, args.signature)
  ) {
    return yield* Effect.fail(
      validationFailed('La inspección del archivo no coincide con el blob registrado.', 'storageId')
    )
  }

  const existingDocument = yield* findDocumentByStorageIdEffect(ctx, args.storageId)
  if (existingDocument) {
    return yield* Effect.fail(
      validationFailed('Este archivo ya está registrado como documento.', 'storageId')
    )
  }

  const now = Date.now()
  const accessLevel = intent.accessLevel ?? 'NDA_REQUIRED'
  const classification = inferDocumentClassification(accessLevel, intent.classification)
  const folder = intent.folder
  const versionNumber = 1
  const documentId = yield* convexPromise(() =>
    ctx.db.insert('documents', {
      companyId: intent.companyId,
      name: intent.name,
      description: intent.description,
      fileType: contentType,
      fileSize: blob.size,
      storageId: args.storageId,
      lifecycleStatus: 'ACTIVE',
      currentVersionNumber: versionNumber,
      accessLevel,
      classification,
      protectionPolicyVersion: 'trust-os-v2',
      updatedAt: now,
      folder,
      sourceType: 'USER_UPLOAD',
      isExpired: false,
    })
  )
  const versionId = yield* convexPromise(() =>
    ctx.db.insert('documentVersions', {
      documentId,
      companyId: intent.companyId,
      versionNumber,
      storageId: args.storageId,
      displayName: intent.name,
      declaredMimeType: contentType,
      detectedMimeType: contentType,
      byteSize: blob.size,
      sha256: args.inspectedSha256,
      signatureKind: args.signature,
      verificationStatus: 'SIGNATURE_VERIFIED',
      malwareScanStatus: args.malwareScanStatus,
      scannerEngine: args.scannerEngine,
      scannerScanId: args.scannerScanId,
      scannerDefinitionVersion: args.scannerDefinitionVersion,
      scannedAt: args.scannedAt,
      publicationStatus: 'PUBLISHED',
      createdAt: now,
      createdByProfileId: profile._id,
      publishedAt: now,
    })
  )
  yield* convexPromise(() =>
    ctx.db.patch(documentId, {
      currentVersionId: versionId,
      publishedVersionId: versionId,
    })
  )
  yield* convexPromise(() =>
    ctx.db.patch(intent._id, {
      status: 'CONSUMED',
      documentId,
      documentVersionId: versionId,
      consumedAt: now,
    })
  )
  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      userId: profile._id,
      action: 'VDR_DOCUMENT_VERSION_INGESTED',
      entityType: 'DOCUMENT_VERSION',
      entityId: versionId,
      metadata: {
        resourceType: 'COMPANY',
        resourceId: intent.companyId,
        details: {
          versionNumber,
          verificationStatus: 'SIGNATURE_VERIFIED',
          malwareScanStatus: args.malwareScanStatus,
          source: 'mcp',
        },
      },
    })
  )
  const document = yield* convexPromise(() => ctx.db.get(documentId))
  if (document) {
    yield* convexPromise(() =>
      recordDocumentAccessLog(ctx, {
        documentId,
        companyId: intent.companyId,
        accessedById: profile._id,
        action: 'upload_mcp',
        evaluation: {
          decision: 'ALLOW',
          outcome: 'ALLOWED_OWNER',
          reason: 'El propietario del data room puede acceder al documento.',
          classification,
          riskScore: 0,
          stepUpRequirement: 'NONE',
        },
        accessLevel,
      })
    )
  }
  yield* convexPromise(() =>
    ctx.scheduler.runAfter(0, internal.notifications._recordVdrUpload, {
      companyId: intent.companyId,
      fileName: intent.name,
      folder,
    })
  )
  return {
    documentId,
    versionId,
    versionNumero: versionNumber,
    nombre: intent.name,
    carpeta: folder,
  }
})

export const prepareMcpUploadFromServer = internalMutation({
  args: {
    principalId: v.string(),
    salaId: v.optional(v.string()),
    intentId: v.id('vdrUploadIntents'),
    storageId: v.id('_storage'),
  },
  handler: (ctx, args): Promise<PreparedMcpUpload> => runConvex(prepareMcpUploadProgram(ctx, args)),
})

export const rejectMcpUploadFromServer = internalMutation({
  args: {
    principalId: v.string(),
    salaId: v.optional(v.string()),
    intentId: v.id('vdrUploadIntents'),
    storageId: v.id('_storage'),
    reason: unsafeUploadReasonValidator,
  },
  handler: (ctx, args): Promise<DirectUploadRejection> =>
    runConvex(rejectMcpUploadProgram(ctx, args)),
})

const signatureValidator = v.union(
  v.literal('PDF'),
  v.literal('ZIP'),
  v.literal('OLE'),
  v.literal('TEXT'),
  v.literal('UNKNOWN')
)

export const finalizeMcpUploadFromServer = internalMutation({
  args: {
    principalId: v.string(),
    salaId: v.optional(v.string()),
    intentId: v.id('vdrUploadIntents'),
    storageId: v.id('_storage'),
    inspectedSize: v.number(),
    inspectedSha256: v.string(),
    signature: signatureValidator,
    malwareScanStatus: v.union(v.literal('NOT_CONFIGURED'), v.literal('CLEAN')),
    scannerEngine: v.optional(v.string()),
    scannerScanId: v.optional(v.string()),
    scannerDefinitionVersion: v.optional(v.string()),
    scannedAt: v.optional(v.number()),
  },
  handler: (ctx, args) => runConvex(finalizeMcpUploadProgram(ctx, args)),
})

type PrepareArgs = {
  principalId: string
  salaId?: string
  intentId: Id<'vdrUploadIntents'>
  storageId: Id<'_storage'>
}

const prepareRef = makeFunctionReference<'mutation', PrepareArgs, PreparedMcpUpload>(
  '_vdrWrite/upload:prepareMcpUploadFromServer'
)
const rejectRef = makeFunctionReference<
  'mutation',
  PrepareArgs & {
    intentId: Id<'vdrUploadIntents'>
    storageId: Id<'_storage'>
    reason: UnsafeUploadReason
  },
  DirectUploadRejection
>('_vdrWrite/upload:rejectMcpUploadFromServer')
const finalizeRef = makeFunctionReference<'mutation', FinalizeArgs, RegisteredMcpUpload>(
  '_vdrWrite/upload:finalizeMcpUploadFromServer'
)

export const registerUploadProgram = Effect.fn('VdrWrite.register')(function* (
  ctx: ActionCtx,
  args: RegisterArgs
): Effect.fn.Return<RegisteredMcpUpload, AppError> {
  yield* convexPromise(() =>
    requireVdrReadServerProof({
      operation: 'REGISTER_UPLOAD',
      issuedAt: args.serverIssuedAt,
      proof: args.serverProof,
      bindingParts: [args.principalId, args.intentId, args.storageId],
    })
  )

  const scope = {
    principalId: args.principalId,
    salaId: args.salaId,
  }
  const prepared = yield* convexPromise(() =>
    ctx.runMutation(prepareRef, {
      ...scope,
      intentId: args.intentId,
      storageId: args.storageId,
    })
  )
  if ('code' in prepared && !('status' in prepared)) return prepared
  if (prepared.status === 'ALREADY_REGISTERED') {
    return {
      documentId: prepared.documentId,
      versionId: prepared.versionId,
      versionNumero: prepared.versionNumero,
      nombre: prepared.nombre,
      carpeta: prepared.carpeta,
    }
  }
  if (prepared.status === 'REJECTED') {
    return { registered: false, code: prepared.code }
  }

  const reject = (reason: UnsafeUploadReason) =>
    convexPromise(() =>
      ctx.runMutation(rejectRef, {
        ...scope,
        intentId: prepared.intentId,
        storageId: prepared.storageId,
        reason,
      })
    )

  const blob = yield* convexPromise(() => ctx.storage.get(prepared.storageId))
  if (!blob || blob.size !== prepared.size) {
    return yield* reject('SCAN_UNAVAILABLE')
  }

  const header = new Uint8Array(yield* convexPromise(() => blob.slice(0, 16).arrayBuffer()))
  const signature = detectFileSignature(header)
  if (!matchesDeclaredMimeType(prepared.contentType, signature)) {
    return yield* reject('INVALID_FILE_SIGNATURE')
  }
  if (signature === 'ZIP') {
    const zipSafety = yield* convexPromise(() => inspectZipSafety(blob))
    if (!zipSafety.safe) return yield* reject(zipSafety.code)
  }
  if (prepared.contentType === 'text/csv') {
    const csv = yield* convexPromise(() => inspectCsvFile(blob))
    if (!csv.safe) return yield* reject('INVALID_FILE_SIGNATURE')
  } else if (prepared.contentType !== 'application/pdf') {
    const officeOk = yield* convexPromise(() => inspectOfficeFile(blob, prepared.contentType))
    if (!officeOk) return yield* reject('INVALID_FILE_SIGNATURE')
  }

  const scan = yield* convexPromise(() => scanFileWithConfiguredGateway(blob, prepared.sha256))
  if (scan.status === 'INFECTED') return yield* reject('MALWARE_DETECTED')
  if (scan.status === 'ERROR') return yield* reject('SCAN_UNAVAILABLE')

  return yield* convexPromise(() =>
    ctx.runMutation(finalizeRef, {
      ...scope,
      intentId: prepared.intentId,
      storageId: prepared.storageId,
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
})

export const issueUploadArgs = {
  principalId: v.string(),
  salaId: v.optional(v.string()),
  carpeta: v.string(),
  nombre: v.string(),
  mime: v.string(),
  tamanoBytes: v.number(),
  nota: v.optional(v.string()),
  ...proofArgs,
} as const

export const registerUploadArgs = {
  principalId: v.string(),
  salaId: v.optional(v.string()),
  intentId: v.id('vdrUploadIntents'),
  storageId: v.id('_storage'),
  ...proofArgs,
} as const
