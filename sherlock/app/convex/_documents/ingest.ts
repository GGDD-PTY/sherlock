import { makeFunctionReference } from 'convex/server'
import { Effect } from 'effect'

import { internal } from '../_generated/api'
import { v } from 'convex/values'

import type { Doc, Id } from '../_generated/dataModel'
import { action, internalMutation, type ActionCtx, type MutationCtx } from '../_generated/server'
import type { AuthResult } from '../_helpers/auth'
import { requireAuthEffect } from '../_helpers/auth.identity'
import { logAdminAction } from '../_helpers/auditLog'
import { convexPromise, runConvex } from '../_helpers/effect'
import type { AppError } from '../_helpers/errors'
import { invalidState, unauthorized, validationFailed } from '../_helpers/errors'
import { normalizeSha256Hex } from '../_helpers/sha256'
import {
  detectFileSignature,
  inspectCsvFile,
  inspectOfficeFile,
  inspectZipSafety,
  matchesDeclaredMimeType,
  type FileSignature,
} from './fileInspection'
import { inferDocumentClassification } from './policy'
import { requiresConfiguredScanner, scanFileWithConfiguredGateway } from './scanner'
import {
  findDocumentByStorageIdEffect,
  loadCompanyOrThrowEffect,
  requireCompanyOwnerOrAdminEffect,
  revokeGrantsForDocumentEffect,
} from './shared'
import {
  isDirectUploadMimeType,
  MAX_DIRECT_UPLOAD_BYTES,
  directUploadRejection,
  type DirectUploadRejection,
} from './uploadLimits'
import {
  consumeBoundUploadIntentEffect,
  rejectBoundUploadIntentEffect,
  requireBoundUploadIntentEffect,
  type BoundUploadIntent,
  type UploadIntentRejection,
} from './uploadIntents'

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
const signatureValidator = v.union(
  v.literal('PDF'),
  v.literal('ZIP'),
  v.literal('OLE'),
  v.literal('TEXT'),
  v.literal('UNKNOWN')
)
const unsafeUploadReasonValidator = v.union(
  v.literal('INVALID_FILE_SIGNATURE'),
  v.literal('INVALID_ARCHIVE'),
  v.literal('ENCRYPTED_ARCHIVE'),
  v.literal('ZIP_BOMB'),
  v.literal('MALWARE_DETECTED'),
  v.literal('SCAN_UNAVAILABLE')
)
type UnsafeUploadReason =
  | 'INVALID_FILE_SIGNATURE'
  | 'INVALID_ARCHIVE'
  | 'ENCRYPTED_ARCHIVE'
  | 'ZIP_BOMB'
  | 'MALWARE_DETECTED'
  | 'SCAN_UNAVAILABLE'

const boundIngestArgs = {
  intentId: v.id('vdrUploadIntents'),
  requestedByProfileId: v.id('profiles'),
  companyId: v.id('companies'),
  storageId: v.id('_storage'),
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

type IngestArgs = BoundUploadIntent & {
  storageId: Id<'_storage'>
}

type DirectUploadActionArgs = {
  intentId: Id<'vdrUploadIntents'>
  storageId: Id<'_storage'>
}

type PreflightResult =
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

type StorageBlobMetadata = {
  _id: Id<'_storage'>
  _creationTime: number
  size: number
  sha256: string
  contentType?: string
}

const authorizeAndLoadBlob = Effect.fn('DocumentIngest.authorizeAndLoadBlob')(function* (
  ctx: MutationCtx,
  args: IngestArgs
): Effect.fn.Return<
  {
    auth: AuthResult
    blob: StorageBlobMetadata
    existingDocument: Doc<'documents'> | null
  },
  AppError
> {
  const auth = yield* requireAuthEffect(ctx)
  const { profile } = auth
  if (profile.role !== 'ADMIN' && profile.role !== 'COMPANY') {
    return yield* Effect.fail(
      unauthorized('Solo empresas o administradores pueden inspeccionar documentos VDR.')
    )
  }

  yield* requireBoundUploadIntentEffect(ctx, args, auth)

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

  const blob = yield* convexPromise(() => ctx.db.system.get(args.storageId))
  if (!blob) {
    return yield* Effect.fail(
      validationFailed('El archivo no existe en el almacenamiento.', 'storageId')
    )
  }
  const existingDocument = yield* findDocumentByStorageIdEffect(ctx, args.storageId)
  if (existingDocument) {
    return yield* Effect.fail(
      validationFailed('Este archivo ya está registrado como documento.', 'storageId')
    )
  }
  if (blob.size > MAX_DIRECT_UPLOAD_BYTES) {
    return yield* Effect.fail(
      validationFailed('El archivo supera el límite permitido.', 'storageId')
    )
  }
  const contentType = blob.contentType ?? ''
  if (normalizeSha256Hex(blob.sha256) !== args.declaredSha256) {
    return yield* Effect.fail(
      validationFailed('La huella del archivo no coincide con el intento.', 'storageId')
    )
  }
  if (!isDirectUploadMimeType(contentType)) {
    return yield* Effect.fail(
      validationFailed('El tipo de archivo no está permitido.', 'storageId')
    )
  }

  return { auth, blob, existingDocument }
})

const rejectUnsafeUploadProgram = Effect.fn('DocumentIngest.rejectUnsafe')(function* (
  ctx: MutationCtx,
  args: IngestArgs & { reason: UnsafeUploadReason }
): Effect.fn.Return<DirectUploadRejection, AppError> {
  const auth = yield* requireAuthEffect(ctx)
  const { profile } = auth
  yield* requireBoundUploadIntentEffect(ctx, args, auth)
  const existingDocument = yield* findDocumentByStorageIdEffect(ctx, args.storageId)
  if (existingDocument) {
    // Otro intento ya publicó este mismo blob. Nunca borrar bytes que ahora
    // respaldan un documento, aunque esta action duplicada llegue tarde.
    return yield* Effect.fail(
      validationFailed('Este archivo ya está registrado como documento.', 'storageId')
    )
  }
  yield* rejectBoundUploadIntentEffect(ctx, args, auth, args.reason)
  // Convex does not attest uploadUrl -> storageId. Terminalize and quarantine
  // the bytes, but never turn an opaque caller-supplied ID into a delete
  // primitive. A future GC may delete only with attributable upload evidence.
  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      userId: profile._id,
      action: 'VDR_DOCUMENT_INGEST_REJECTED',
      entityType: 'DOCUMENT_INGEST',
      entityId: `${args.storageId}`,
      metadata: {
        resourceType: 'COMPANY',
        resourceId: `${args.companyId}`,
        details: { outcome: args.reason },
      },
    })
  )
  return directUploadRejection(args.reason)
})

export const rejectUnsafeUpload = internalMutation({
  args: { ...boundIngestArgs, reason: unsafeUploadReasonValidator },
  handler: (ctx, args): Promise<DirectUploadRejection> =>
    runConvex(rejectUnsafeUploadProgram(ctx, args)),
})

type FinalizeArgs = IngestArgs & {
  inspectedSize: number
  inspectedSha256: string
  signature: FileSignature
  malwareScanStatus: 'NOT_CONFIGURED' | 'CLEAN'
  scannerEngine?: string
  scannerScanId?: string
  scannerDefinitionVersion?: string
  scannedAt?: number
  expectedCurrentVersionNumber: number
}

const finalizeInspectedUploadProgram = Effect.fn('DocumentIngest.finalize')(function* (
  ctx: MutationCtx,
  args: FinalizeArgs
): Effect.fn.Return<Id<'documents'>, AppError> {
  const { auth, blob, existingDocument } = yield* authorizeAndLoadBlob(ctx, args)
  const { user, profile } = auth
  if (existingDocument) {
    return yield* Effect.fail(
      validationFailed('Este archivo ya está registrado como documento.', 'storageId')
    )
  }
  const contentType = blob.contentType ?? ''
  if (
    blob.size !== args.inspectedSize ||
    normalizeSha256Hex(blob.sha256) !== normalizeSha256Hex(args.inspectedSha256) ||
    !matchesDeclaredMimeType(contentType, args.signature)
  ) {
    return yield* Effect.fail(
      validationFailed('La inspección del archivo no coincide con el blob registrado.', 'storageId')
    )
  }

  const now = Date.now()
  const replaceDocumentId = args.replaceDocumentId
  const replacement = replaceDocumentId
    ? yield* convexPromise(() => ctx.db.get(replaceDocumentId))
    : null
  const accessLevel = args.accessLevel ?? replacement?.accessLevel ?? 'NDA_REQUIRED'
  const classification = inferDocumentClassification(
    accessLevel,
    args.classification ?? replacement?.classification
  )
  const description = args.description ?? replacement?.description
  const folder = args.folder ?? replacement?.folder ?? 'General'
  const expiresAt = args.expiresAt ?? replacement?.expiresAt
  const observedVersionNumber = replacement?.currentVersionNumber ?? (replacement ? 1 : 0)
  if (observedVersionNumber !== args.expectedCurrentVersionNumber) {
    return yield* Effect.fail(
      invalidState(
        'El documento cambió mientras se verificaba. Vuelve a subir la versión.',
        'REVISION_CONFLICT'
      )
    )
  }

  let documentId: Id<'documents'>
  let versionNumber: number
  let replacesVersionId: Id<'documentVersions'> | undefined
  if (replacement) {
    documentId = replacement._id
    versionNumber = observedVersionNumber + 1
    replacesVersionId = replacement.currentVersionId

    const currentVersionId = replacement.currentVersionId
    if (currentVersionId) {
      const currentVersion = yield* convexPromise(() => ctx.db.get(currentVersionId))
      if (
        !currentVersion ||
        currentVersion.documentId !== replacement._id ||
        currentVersion.versionNumber !== observedVersionNumber
      ) {
        return yield* Effect.fail(
          invalidState('El historial del documento requiere reconciliación.', 'VERSION_DRIFT')
        )
      }
      yield* convexPromise(() =>
        ctx.db.patch(currentVersion._id, { publicationStatus: 'SUPERSEDED' })
      )
    } else if (replacement.storageId) {
      const replacementStorageId = replacement.storageId
      const legacyBlob = yield* convexPromise(() => ctx.db.system.get(replacementStorageId))
      if (legacyBlob) {
        replacesVersionId = yield* convexPromise(() =>
          ctx.db.insert('documentVersions', {
            documentId: replacement._id,
            companyId: replacement.companyId,
            versionNumber: 1,
            storageId: replacementStorageId,
            displayName: replacement.name,
            declaredMimeType: legacyBlob.contentType ?? replacement.fileType ?? 'unknown',
            detectedMimeType: replacement.fileType ?? 'unknown',
            byteSize: legacyBlob.size,
            sha256: normalizeSha256Hex(legacyBlob.sha256) ?? legacyBlob.sha256,
            signatureKind: 'UNKNOWN',
            verificationStatus: 'QUARANTINED',
            malwareScanStatus: 'NOT_CONFIGURED',
            publicationStatus: 'SUPERSEDED',
            createdAt: replacement._creationTime,
            createdByProfileId: profile._id,
          })
        )
      }
    }
  } else {
    versionNumber = 1
    documentId = yield* convexPromise(() =>
      ctx.db.insert('documents', {
        companyId: args.companyId,
        name: args.name,
        description: args.description,
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
        expiresAt,
        isExpired: false,
      })
    )
  }
  const versionId = yield* convexPromise(() =>
    ctx.db.insert('documentVersions', {
      documentId,
      companyId: args.companyId,
      versionNumber,
      storageId: args.storageId,
      displayName: args.name,
      declaredMimeType: contentType,
      detectedMimeType: contentType,
      byteSize: blob.size,
      sha256: args.declaredSha256,
      signatureKind: args.signature,
      verificationStatus: 'SIGNATURE_VERIFIED',
      malwareScanStatus: args.malwareScanStatus,
      scannerEngine: args.scannerEngine,
      scannerScanId: args.scannerScanId,
      scannerDefinitionVersion: args.scannerDefinitionVersion,
      scannedAt: args.scannedAt,
      publicationStatus: 'PUBLISHED',
      replacesVersionId,
      createdAt: now,
      createdByProfileId: profile._id,
      publishedAt: now,
    })
  )
  yield* convexPromise(() =>
    ctx.db.patch(documentId, {
      name: args.name,
      description,
      fileType: contentType,
      fileSize: blob.size,
      storageId: args.storageId,
      lifecycleStatus: 'ACTIVE',
      currentVersionNumber: versionNumber,
      currentVersionId: versionId,
      publishedVersionId: versionId,
      accessLevel,
      classification,
      protectionPolicyVersion: 'trust-os-v2',
      updatedAt: now,
      folder,
      expiresAt,
      isExpired: false,
    })
  )
  if (replacement) {
    yield* revokeGrantsForDocumentEffect(ctx, documentId, 'DOCUMENT_VERSION_SUPERSEDED')
  }
  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      userId: profile._id,
      action: 'VDR_DOCUMENT_VERSION_INGESTED',
      entityType: 'DOCUMENT_VERSION',
      entityId: `${versionId}`,
      metadata: {
        resourceType: 'COMPANY',
        resourceId: `${args.companyId}`,
        details: {
          versionNumber,
          verificationStatus: 'SIGNATURE_VERIFIED',
          malwareScanStatus: args.malwareScanStatus,
        },
      },
    })
  )
  if (profile.role === 'ADMIN') {
    yield* convexPromise(() =>
      logAdminAction({
        ctx,
        adminProfileId: profile._id,
        adminEmail: user.email,
        action: 'DOCUMENT_UPLOAD',
        targetType: 'DOCUMENT',
        targetId: `${documentId}`,
        newValue: {
          versionNumber,
          verificationStatus: 'SIGNATURE_VERIFIED',
          malwareScanStatus: args.malwareScanStatus,
        },
      })
    )
  }
  // Same Convex transaction as the immutable version + stable pointer writes.
  // A concurrent replay cannot consume the intent twice; any failure here
  // rolls the document writes back as one atomic unit.
  yield* consumeBoundUploadIntentEffect(ctx, args, auth, documentId, versionId)
  // El aviso al equipo se CALENDARIZA, no se ejecuta acá: escribe una fila
  // `teamAlerts` compartida por toda la empresa y ese conflicto se resuelve al
  // hacer commit, fuera de cualquier try/catch. Inline, un pico de subidas
  // concurrentes le costaría al cliente su documento.
  if (profile.role !== 'ADMIN') {
    yield* convexPromise(() =>
      ctx.scheduler.runAfter(0, internal.notifications._recordVdrUpload, {
        companyId: args.companyId,
        fileName: args.name,
        folder,
      })
    )
  }
  return documentId
})

export const finalizeInspectedUpload = internalMutation({
  args: {
    ...boundIngestArgs,
    inspectedSize: v.number(),
    inspectedSha256: v.string(),
    signature: signatureValidator,
    malwareScanStatus: v.union(v.literal('NOT_CONFIGURED'), v.literal('CLEAN')),
    scannerEngine: v.optional(v.string()),
    scannerScanId: v.optional(v.string()),
    scannerDefinitionVersion: v.optional(v.string()),
    scannedAt: v.optional(v.number()),
    expectedCurrentVersionNumber: v.number(),
  },
  handler: (ctx, args): Promise<Id<'documents'>> =>
    runConvex(finalizeInspectedUploadProgram(ctx, args)),
})

const prepareIntentRef = makeFunctionReference<'mutation', DirectUploadActionArgs, PreflightResult>(
  '_documents/uploadIntents:prepareDirectUploadIntent'
)
const rejectRef = makeFunctionReference<
  'mutation',
  IngestArgs & { reason: UnsafeUploadReason },
  DirectUploadRejection
>('_documents/ingest:rejectUnsafeUpload')
const finalizeRef = makeFunctionReference<'mutation', FinalizeArgs, Id<'documents'>>(
  '_documents/ingest:finalizeInspectedUpload'
)

// La inspección corre en una ACTION, no en una mutation: es el único lugar del
// aislado donde se puede leer el blob completo y hablar con el gateway de
// escaneo. Cada paso decide con el veredicto tipado que devuelve el módulo de
// inspección; nadie interpreta un `null` ambiguo.
const inspectAndRegisterProgram = Effect.fn('DocumentIngest.inspectAndRegister')(function* (
  ctx: ActionCtx,
  args: DirectUploadActionArgs
): Effect.fn.Return<Id<'documents'> | DirectUploadRejection | UploadIntentRejection, AppError> {
  const preflightResult = yield* convexPromise(() => ctx.runMutation(prepareIntentRef, args))
  if (preflightResult.status === 'ALREADY_REGISTERED') {
    return preflightResult.documentId
  }
  if (preflightResult.status === 'REJECTED' || preflightResult.status === 'BLOCKED') {
    return { registered: false, code: preflightResult.code }
  }
  const ingestArgs: IngestArgs = {
    ...preflightResult.bound,
    storageId: args.storageId,
  }
  const reject = (reason: UnsafeUploadReason) =>
    convexPromise(() => ctx.runMutation(rejectRef, { ...ingestArgs, reason }))

  const blob = yield* convexPromise(() => ctx.storage.get(args.storageId))
  if (!blob || blob.size !== preflightResult.size) {
    return yield* reject('SCAN_UNAVAILABLE')
  }

  const header = new Uint8Array(yield* convexPromise(() => blob.slice(0, 16).arrayBuffer()))
  const signature = detectFileSignature(header)
  if (!matchesDeclaredMimeType(preflightResult.contentType, signature)) {
    return yield* reject('INVALID_FILE_SIGNATURE')
  }

  if (signature === 'ZIP') {
    const zipSafety = yield* convexPromise(() => inspectZipSafety(blob))
    if (!zipSafety.safe) {
      return yield* reject(zipSafety.code)
    }
  }

  if (preflightResult.contentType === 'text/csv') {
    const csv = yield* convexPromise(() => inspectCsvFile(blob))
    if (!csv.safe) {
      return yield* reject('INVALID_FILE_SIGNATURE')
    }
  } else if (preflightResult.contentType !== 'application/pdf') {
    const officeOk = yield* convexPromise(() =>
      inspectOfficeFile(blob, preflightResult.contentType)
    )
    if (!officeOk) {
      return yield* reject('INVALID_FILE_SIGNATURE')
    }
  }

  const scan = yield* convexPromise(() =>
    scanFileWithConfiguredGateway(blob, preflightResult.sha256)
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

  return yield* convexPromise(() =>
    ctx.runMutation(finalizeRef, {
      ...ingestArgs,
      inspectedSize: preflightResult.size,
      inspectedSha256: preflightResult.sha256,
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
      expectedCurrentVersionNumber: preflightResult.expectedCurrentVersionNumber,
    })
  )
})

export const inspectAndRegisterDirectUpload = action({
  args: {
    intentId: v.id('vdrUploadIntents'),
    storageId: v.id('_storage'),
  },
  handler: (ctx, args): Promise<Id<'documents'> | DirectUploadRejection | UploadIntentRejection> =>
    runConvex(inspectAndRegisterProgram(ctx, args)),
})
