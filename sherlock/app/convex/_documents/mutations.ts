import { v } from 'convex/values'
import { Effect } from 'effect'

import type { Doc, Id } from '../_generated/dataModel'
import { internalMutation, mutation, type MutationCtx } from '../_generated/server'
import { requireAuth } from '../_helpers/auth'
import { logAdminAction } from '../_helpers/auditLog'
import { evaluateCompanyManagementAuthorization } from '../_helpers/companyAuthorization'
import { convexPromise, convexSync, runConvex } from '../_helpers/effect'
import type { AppError } from '../_helpers/errors'
import { invalidState, validationFailed } from '../_helpers/errors'
import { normalizeSha256Hex } from '../_helpers/sha256'
// La frontera de `shared.ts` y la de `_helpers/auth` se cruzan por
// `convexPromise` a propósito, no por sus variantes `...Effect`: las suites de
// este módulo reemplazan esos dos módulos enteros con `vi.mock`, así que el
// nombre que importan es parte del contrato. Effect entra igual —el cuerpo del
// handler es un programa— pero el borde que los tests pinnean no se mueve.
import {
  cleanUndefinedFields,
  findDocumentByStorageId,
  loadDocumentOrThrow,
  loadCompanyOrThrow,
  recordDocumentFolderChange,
  requireCompanyOwnerOrAdmin,
  revokeGrantsForDocument,
  validateVdrShellFolderDestination,
} from './shared'
import { inferDocumentClassification } from './policy'
import { matchesDeclaredMimeType } from './fileInspection'
import {
  buildDocumentPurgePlanEffect,
  DELIVERED_RENDITION_MESSAGE,
  executeDocumentPurgePlanEffect,
  findDeliverableBackedByDocuments,
  loadCompletedDeliverablesEffect,
} from './purge'
import {
  recordClientWithdrawalActivityEffect,
  withdrawRenditionsForDocumentsEffect,
} from '../_deliverables/clientWithdrawal'
import { notifyTeamDeliverableWithdrawnEffect } from '../_notifications/deliverables'
import {
  adminVdrCapabilityValidator,
  requireAdminVdrCapability,
  withoutAdminVdrCapability,
} from '../_adminVdr/capability'
import { adminVdrTarget } from '../_adminVdr/capabilityFormat'

// El vocabulario sale del schema, no de una copia: si la tabla gana un nivel de
// acceso o una clasificación, estos alias lo heredan y los handlers dejan de
// compilar donde falte la rama.
type AccessLevel = NonNullable<Doc<'documents'>['accessLevel']>
type Classification = NonNullable<Doc<'documents'>['classification']>
type SignatureKind = NonNullable<Doc<'documentVersions'>['signatureKind']>

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

type CreateArgs = {
  adminCapability?: string
  companyId: Id<'companies'>
  name: string
  description?: string
  fileType?: string
  fileSize?: number
  storageId?: Id<'_storage'>
  storagePath?: string
  accessLevel?: AccessLevel
  classification?: Classification
  folder?: string
  expiresAt?: number
}

const createProgram = Effect.fn('Documents.create')(function* (
  ctx: MutationCtx,
  args: CreateArgs
): Effect.fn.Return<Id<'documents'>, AppError> {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const company = yield* convexPromise(() => loadCompanyOrThrow(ctx, args.companyId))
  yield* convexPromise(() =>
    requireCompanyOwnerOrAdmin(
      ctx,
      auth,
      company,
      'Solo el dueño de la empresa puede subir documentos'
    )
  )
  yield* convexPromise(() =>
    requireAdminVdrCapability({
      ctx,
      auth,
      capability: args.adminCapability,
      company,
      action: 'DOCUMENT_CREATE',
      target: adminVdrTarget('COMPANY', `${args.companyId}`),
      input: withoutAdminVdrCapability(args),
    })
  )

  if (args.storageId || args.storagePath) {
    return yield* Effect.fail(
      validationFailed(
        'Los archivos VDR se registran con registerDirectUpload (camino directo) o desde /api/documents/upload, con validación server-side',
        'storageId'
      )
    )
  }

  return yield* convexPromise(() =>
    ctx.db.insert('documents', {
      companyId: args.companyId,
      name: args.name,
      description: args.description,
      fileType: args.fileType,
      fileSize: args.fileSize,
      storageId: args.storageId,
      lifecycleStatus: 'ACTIVE',
      storagePath: args.storagePath,
      accessLevel: args.accessLevel || 'NDA_REQUIRED',
      classification: inferDocumentClassification(
        args.accessLevel || 'NDA_REQUIRED',
        args.classification
      ),
      protectionPolicyVersion: 'trust-os-v1',
      folder: args.folder || 'General',
      expiresAt: args.expiresAt,
      isExpired: false,
    })
  )
})

export const create = mutation({
  args: {
    adminCapability: adminVdrCapabilityValidator,
    companyId: v.id('companies'),
    name: v.string(),
    description: v.optional(v.string()),
    fileType: v.optional(v.string()),
    fileSize: v.optional(v.number()),
    storageId: v.optional(v.id('_storage')),
    storagePath: v.optional(v.string()),
    accessLevel: accessLevelValidator,
    classification: classificationValidator,
    folder: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  handler: (ctx, args) => runConvex(createProgram(ctx, args)),
})

type CreateFromValidatedUploadArgs = {
  companyId: Id<'companies'>
  uploaderProfileId: Id<'profiles'>
  uploaderRole: 'COMPANY' | 'ADMIN'
  uploaderProviderUserId: string
  name: string
  description?: string
  fileType?: string
  fileSize?: number
  storageId: Id<'_storage'>
  signatureKind?: SignatureKind
  malwareScanStatus?: 'NOT_CONFIGURED' | 'CLEAN'
  scannerEngine?: string
  scannerScanId?: string
  scannerDefinitionVersion?: string
  scannedAt?: number
  accessLevel?: AccessLevel
  classification?: Classification
  folder?: string
  expiresAt?: number
}

const createFromValidatedUploadProgram = Effect.fn('Documents.createFromValidatedUpload')(
  function* (
    ctx: MutationCtx,
    args: CreateFromValidatedUploadArgs
  ): Effect.fn.Return<Id<'documents'>, AppError> {
    const uploaderProfile = yield* convexPromise(() => ctx.db.get(args.uploaderProfileId))
    if (
      !uploaderProfile ||
      uploaderProfile.role !== args.uploaderRole ||
      uploaderProfile.isActive === false
    ) {
      return yield* Effect.fail(
        validationFailed('La identidad de quien sube el documento no es válida', 'uploader')
      )
    }
    const uploaderUser = yield* convexPromise(() => ctx.db.get(uploaderProfile.userId))
    if (
      !uploaderUser ||
      uploaderUser.workosUserId !== args.uploaderProviderUserId ||
      args.uploaderProviderUserId.trim().length === 0
    ) {
      return yield* Effect.fail(
        validationFailed('La identidad de quien sube el documento no es válida', 'uploader')
      )
    }

    const company = yield* convexPromise(() => loadCompanyOrThrow(ctx, args.companyId))
    const management = yield* convexPromise(() =>
      evaluateCompanyManagementAuthorization(
        ctx,
        {
          identity: {
            subject: args.uploaderProviderUserId,
            authProvider: 'workos',
          },
          user: uploaderUser,
          profile: uploaderProfile,
        },
        company
      )
    )
    if (!management.authorized) {
      return yield* Effect.fail(
        validationFailed('No tienes permiso para subir documentos a esta empresa', 'companyId')
      )
    }

    const blob = yield* convexPromise(() => ctx.db.system.get(args.storageId))
    if (!blob) {
      return yield* Effect.fail(
        validationFailed('El archivo no existe en el almacenamiento', 'storageId')
      )
    }
    const existingDocument = yield* convexPromise(() =>
      findDocumentByStorageId(ctx, args.storageId)
    )
    if (existingDocument) {
      // `storageId` es la llave natural de idempotencia del carril /api. Si la
      // escritura anterior commiteó pero la respuesta se perdió, devolver el
      // mismo documento evita duplicar filas o borrar su blob durante cleanup.
      if (existingDocument.companyId === args.companyId) {
        return existingDocument._id
      }
      return yield* Effect.fail(
        validationFailed('Este archivo ya está registrado como documento', 'storageId')
      )
    }
    const contentType = blob.contentType ?? args.fileType ?? ''
    const signatureVerified = Boolean(
      args.signatureKind && matchesDeclaredMimeType(contentType, args.signatureKind)
    )
    const now = Date.now()
    const accessLevel = args.accessLevel || 'NDA_REQUIRED'
    const documentId = yield* convexPromise(() =>
      ctx.db.insert('documents', {
        companyId: args.companyId,
        name: args.name,
        description: args.description,
        fileType: contentType,
        fileSize: blob.size,
        storageId: args.storageId,
        lifecycleStatus: signatureVerified ? 'ACTIVE' : 'QUARANTINED',
        currentVersionNumber: 1,
        accessLevel,
        classification: inferDocumentClassification(accessLevel, args.classification),
        protectionPolicyVersion: 'trust-os-v2',
        updatedAt: now,
        folder: args.folder || 'General',
        sourceType: 'USER_UPLOAD',
        expiresAt: args.expiresAt,
        isExpired: false,
      })
    )
    const versionId = yield* convexPromise(() =>
      ctx.db.insert('documentVersions', {
        documentId,
        companyId: args.companyId,
        versionNumber: 1,
        storageId: args.storageId,
        displayName: args.name,
        declaredMimeType: args.fileType ?? contentType,
        detectedMimeType: contentType,
        byteSize: blob.size,
        sha256: normalizeSha256Hex(blob.sha256) ?? blob.sha256,
        signatureKind: args.signatureKind ?? 'UNKNOWN',
        verificationStatus: signatureVerified ? 'SIGNATURE_VERIFIED' : 'QUARANTINED',
        malwareScanStatus: signatureVerified
          ? (args.malwareScanStatus ?? 'NOT_CONFIGURED')
          : 'PENDING',
        scannerEngine: args.scannerEngine,
        scannerScanId: args.scannerScanId,
        scannerDefinitionVersion: args.scannerDefinitionVersion,
        scannedAt: args.scannedAt,
        publicationStatus: signatureVerified ? 'PUBLISHED' : 'DRAFT',
        createdAt: now,
        createdByProfileId: args.uploaderProfileId,
        publishedAt: signatureVerified ? now : undefined,
      })
    )
    yield* convexPromise(() =>
      ctx.db.patch(documentId, {
        currentVersionId: versionId,
        publishedVersionId: signatureVerified ? versionId : undefined,
      })
    )
    if (uploaderProfile.role === 'ADMIN') {
      yield* convexPromise(() =>
        logAdminAction({
          ctx,
          adminProfileId: uploaderProfile._id,
          adminEmail: uploaderUser.email,
          action: 'DOCUMENT_UPLOAD',
          targetType: 'DOCUMENT',
          targetId: `${documentId}`,
          newValue: {
            versionNumber: 1,
            verificationStatus: signatureVerified ? 'SIGNATURE_VERIFIED' : 'QUARANTINED',
            malwareScanStatus: signatureVerified
              ? (args.malwareScanStatus ?? 'NOT_CONFIGURED')
              : 'PENDING',
          },
        })
      )
    }
    return documentId
  }
)

export const createFromValidatedUpload = internalMutation({
  args: {
    companyId: v.id('companies'),
    uploaderProfileId: v.id('profiles'),
    uploaderRole: v.union(v.literal('COMPANY'), v.literal('ADMIN')),
    uploaderProviderUserId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    fileType: v.optional(v.string()),
    fileSize: v.optional(v.number()),
    storageId: v.id('_storage'),
    signatureKind: v.optional(
      v.union(
        v.literal('PDF'),
        v.literal('ZIP'),
        v.literal('OLE'),
        v.literal('TEXT'),
        v.literal('UNKNOWN')
      )
    ),
    malwareScanStatus: v.optional(v.union(v.literal('NOT_CONFIGURED'), v.literal('CLEAN'))),
    scannerEngine: v.optional(v.string()),
    scannerScanId: v.optional(v.string()),
    scannerDefinitionVersion: v.optional(v.string()),
    scannedAt: v.optional(v.number()),
    accessLevel: accessLevelValidator,
    classification: classificationValidator,
    folder: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  handler: (ctx, args) => runConvex(createFromValidatedUploadProgram(ctx, args)),
})

// ============================================================================
// COMPATIBILIDAD FAIL-CLOSED DEL REGISTRO DIRECTO LEGACY
// ============================================================================
// La UI vigente usa issueDirectUploadIntent + inspectAndRegisterDirectUpload.
// Esa pareja liga perfil, sala, metadata, hash y storageId antes de publicar.
// Mantener el nombre público evita que un cliente viejo falle con una función
// inexistente, pero jamás vuelve a interpretar un storageId opaco como autoridad
// de escritura o borrado. No se consulta el blob: así tampoco existe un oráculo
// sobre storageIds de otra sesión.
const registerDirectUploadProgram = Effect.fn('Documents.registerDirectUploadLegacy')(function* (
  ctx: MutationCtx
): Effect.fn.Return<never, AppError> {
  yield* convexPromise(() => requireAuth(ctx))
  return yield* Effect.fail(
    invalidState(
      'Esta versión del flujo de subida ya no está disponible. Inicia una nueva carga segura.',
      'LEGACY_DIRECT_UPLOAD_DISABLED'
    )
  )
})

export const registerDirectUpload = mutation({
  args: {
    companyId: v.id('companies'),
    storageId: v.id('_storage'),
    name: v.string(),
    description: v.optional(v.string()),
    accessLevel: accessLevelValidator,
    classification: classificationValidator,
    folder: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  handler: (ctx) => runConvex(registerDirectUploadProgram(ctx)),
})

const deleteStorageFileProgram = Effect.fn('Documents.deleteOrphanStorageFile')(function* (
  ctx: MutationCtx,
  args: { storageId: Id<'_storage'> }
) {
  // `by_storageId` existe en el schema; el `.filter()` anterior leía la tabla
  // entera porque Convex filtra DESPUÉS de leer.
  const referencedDocument = yield* convexPromise(() =>
    findDocumentByStorageId(ctx, args.storageId)
  )

  if (referencedDocument) {
    yield* Effect.logWarning('[CLEANUP] Storage file is still referenced; skipping delete')
    return { deleted: false as const, reason: 'referenced-document' as const }
  }

  yield* convexPromise(() => ctx.storage.delete(args.storageId))
  yield* Effect.log('[CLEANUP] Orphaned storage file deleted')
  return { deleted: true as const }
})

export const deleteStorageFileInternal = internalMutation({
  args: {
    storageId: v.id('_storage'),
  },
  handler: (ctx, args) => runConvex(deleteStorageFileProgram(ctx, args)),
})

type UpdateArgs = {
  adminCapability?: string
  documentId: Id<'documents'>
  name?: string
  description?: string
  accessLevel?: AccessLevel
  classification?: Classification
  folder?: string
  expiresAt?: number | null
}

const updateProgram = Effect.fn('Documents.update')(function* (
  ctx: MutationCtx,
  args: UpdateArgs
): Effect.fn.Return<Doc<'documents'> | null, AppError> {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const { user, profile } = auth
  const document = yield* convexPromise(() => loadDocumentOrThrow(ctx, args.documentId))
  const company = yield* convexPromise(() =>
    loadCompanyOrThrow(ctx, document.companyId, 'Empresa del documento no encontrada')
  )
  yield* convexPromise(() =>
    requireCompanyOwnerOrAdmin(
      ctx,
      auth,
      company,
      'Solo el dueño de la empresa puede actualizar documentos'
    )
  )
  yield* convexPromise(() =>
    requireAdminVdrCapability({
      ctx,
      auth,
      capability: args.adminCapability,
      company,
      action: 'DOCUMENT_UPDATE',
      target: adminVdrTarget('DOCUMENT', `${document._id}`),
      input: withoutAdminVdrCapability(args),
    })
  )

  const {
    documentId,
    expiresAt,
    adminCapability: _adminCapability,
    folder: requestedFolder,
    ...updates
  } = args
  const nextFolder =
    requestedFolder === undefined
      ? undefined
      : yield* convexSync(() => validateVdrShellFolderDestination(requestedFolder))
  const nextAccessLevel = args.accessLevel ?? document.accessLevel
  // Docs legacy pueden no tener `classification` guardada (campo opcional en
  // el schema); su clasificación EFECTIVA se deriva del nivel de acceso
  // ACTUAL. Materializarla antes de aplicar el nuevo nivel para que bajar el
  // acceso no desclasifique en silencio (NDA_REQUIRED→PUBLIC caería a
  // PUBLIC_TEASER si se infiriera del nivel nuevo).
  const nextClassification = inferDocumentClassification(
    nextAccessLevel,
    args.classification ??
      inferDocumentClassification(document.accessLevel, document.classification)
  )
  const cleanUpdates = cleanUndefinedFields({
    ...updates,
    ...(nextFolder === undefined ? {} : { folder: nextFolder }),
    expiresAt,
    classification: nextClassification,
    protectionPolicyVersion: 'trust-os-v1',
    // La columna "Actualizado" del data room necesita una fecha real; sin esto
    // solo podría mostrar la de creación.
    updatedAt: Date.now(),
  })
  // Convex borra un campo con `undefined` en patch. `null` es el sentinel
  // explícito del cliente para distinguir "quitar vencimiento" de "no tocarlo".
  if (expiresAt === null) cleanUpdates.expiresAt = undefined
  // El "antes" se captura ANTES del patch: después, `document` ya no es una
  // fuente confiable de la carpeta anterior.
  const previousFolder = document.folder
  yield* convexPromise(() => ctx.db.patch(documentId, cleanUpdates))
  // El diálogo de edición manda la carpeta junto al resto de la metadata, así
  // que "vino un folder" no equivale a "hubo movimiento": solo un cambio real
  // es un hecho que la sala debe ver. Mismo evento y mismo payload que el lote.
  if (nextFolder !== undefined && nextFolder !== previousFolder) {
    yield* convexPromise(() =>
      recordDocumentFolderChange(ctx, {
        profileId: profile._id,
        document,
        previousFolder,
        nextFolder,
      })
    )
  }
  if (profile.role === 'ADMIN') {
    yield* convexPromise(() =>
      logAdminAction({
        ctx,
        adminProfileId: profile._id,
        adminEmail: user.email,
        action: 'DOCUMENT_METADATA_UPDATE',
        targetType: 'DOCUMENT',
        targetId: `${document._id}`,
        previousValue: cleanUndefinedFields({
          name: document.name,
          description: document.description,
          accessLevel: document.accessLevel,
          classification: document.classification,
          folder: document.folder,
          expiresAt: document.expiresAt,
        }),
        newValue: cleanUndefinedFields({
          ...cleanUpdates,
          ...(expiresAt === null ? { expiresAt: null } : {}),
        }),
      })
    )
  }
  return yield* convexPromise(() => ctx.db.get(documentId))
})

export const update = mutation({
  args: {
    adminCapability: adminVdrCapabilityValidator,
    documentId: v.id('documents'),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    accessLevel: accessLevelValidator,
    classification: classificationValidator,
    folder: v.optional(v.string()),
    expiresAt: v.optional(v.union(v.number(), v.null())),
  },
  handler: (ctx, args) => runConvex(updateProgram(ctx, args)),
})

type RemoveArgs = { documentId: Id<'documents'>; adminCapability?: string }

const removeProgram = Effect.fn('Documents.archive')(function* (
  ctx: MutationCtx,
  args: RemoveArgs
): Effect.fn.Return<{ archived: true }, AppError> {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const { user, profile } = auth
  const document = yield* convexPromise(() => loadDocumentOrThrow(ctx, args.documentId))
  const company = yield* convexPromise(() =>
    loadCompanyOrThrow(ctx, document.companyId, 'Empresa del documento no encontrada')
  )
  yield* convexPromise(() =>
    requireCompanyOwnerOrAdmin(
      ctx,
      auth,
      company,
      'Solo el dueño de la empresa puede archivar documentos'
    )
  )
  yield* convexPromise(() =>
    requireAdminVdrCapability({
      ctx,
      auth,
      capability: args.adminCapability,
      company,
      action: 'DOCUMENT_ARCHIVE',
      target: adminVdrTarget('DOCUMENT', `${document._id}`),
      input: withoutAdminVdrCapability(args),
    })
  )
  if (document.lifecycleStatus === 'ARCHIVED') {
    return yield* Effect.fail(
      invalidState('Este documento ya está archivado.', 'DOCUMENT_ALREADY_ARCHIVED')
    )
  }

  // ==========================================================================
  // QUITAR DE LA SALA UNA ENTREGA DEL EQUIPO
  // ==========================================================================
  // [F] 2026-09-17, textual: «cada cliente, dueño de sus documentos, no podemos
  // prohibirle borrar sus documentos de su VDR (no es lo mismo que de nuestro
  // database, sino de su VDR solamente)». Archivar ES quitar de la sala: la
  // fila, los bytes, las versiones y la auditoría se quedan; lo que sale es el
  // acceso. Por eso el dueño pasa aunque el documento respalde un entregable
  // APPROVED o DELIVERED, y lo que antes era una negativa ahora es un registro:
  // la rendition queda marcada como retirada y el equipo recibe el aviso.
  //
  // Dos cosas NO cambian. La purga física (`Documents.purge`, abajo, y
  // `_documents/purge.ts`) sigue negando la entrega: ahí sí mueren los bytes.
  // Y el ADMIN con capability sigue rechazado con el mismo mensaje: el equipo
  // retira su entrega desde Admin, no archivando el documento por debajo del
  // slot.
  const completedDeliverables = yield* loadCompletedDeliverablesEffect(ctx, document.companyId)
  const backedDeliverable = findDeliverableBackedByDocuments(
    completedDeliverables,
    new Set([`${document._id}`])
  )
  if (backedDeliverable && profile.role === 'ADMIN') {
    return yield* Effect.fail(validationFailed(DELIVERED_RENDITION_MESSAGE, 'documentId'))
  }

  const now = Date.now()
  yield* convexPromise(() =>
    revokeGrantsForDocument(ctx, args.documentId, 'DOCUMENT_ARCHIVED')
  )

  if (document.currentVersionId) {
    const currentVersionId = document.currentVersionId
    const currentVersion = yield* convexPromise(() => ctx.db.get(currentVersionId))
    if (currentVersion?.documentId === document._id) {
      yield* convexPromise(() =>
        ctx.db.patch(currentVersion._id, { publicationStatus: 'ARCHIVED' })
      )
    }
  }

  // Archivar es intencionalmente no destructivo: conserva bytes, hashes,
  // versiones y logs para auditoría/legal hold. La purga física será un flujo
  // separado, explícito y sujeto a política de retención.
  yield* convexPromise(() =>
    ctx.db.patch(args.documentId, {
      lifecycleStatus: 'ARCHIVED',
      archivedAt: now,
      archivedByProfileId: profile._id,
      updatedAt: now,
      protectionPolicyVersion: 'trust-os-v2',
    })
  )
  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      userId: profile._id,
      action: 'VDR_DOCUMENT_ARCHIVED',
      entityType: 'DOCUMENT',
      entityId: `${document._id}`,
      metadata: {
        resourceType: 'COMPANY',
        resourceId: `${document.companyId}`,
      },
    })
  )

  // El slot que citaba este documento se entera: su rendition queda marcada
  // como retirada por el cliente, queda su fila de auditoría propia y el equipo
  // recibe la campanita y el correo. Corre DESPUÉS de archivar porque el hecho
  // que se registra es el archivado.
  if (backedDeliverable) {
    const withdrawals = yield* withdrawRenditionsForDocumentsEffect(ctx, {
      completed: completedDeliverables,
      documentIds: new Set([`${document._id}`]),
      profileId: profile._id,
      now,
    })
    yield* recordClientWithdrawalActivityEffect(ctx, {
      companyId: document.companyId,
      profileId: profile._id,
      withdrawals,
    })
    yield* notifyTeamDeliverableWithdrawnEffect(ctx, {
      company,
      documentNames: [document.name],
      withdrawals,
    })
  }

  if (profile.role === 'ADMIN') {
    yield* convexPromise(() =>
      logAdminAction({
        ctx,
        adminProfileId: profile._id,
        adminEmail: user.email,
        action: 'DOCUMENT_ARCHIVE',
        targetType: 'DOCUMENT',
        targetId: `${document._id}`,
        previousValue: { lifecycleStatus: document.lifecycleStatus ?? 'ACTIVE' },
        newValue: { lifecycleStatus: 'ARCHIVED', archivedAt: now },
      })
    )
  }

  return { archived: true as const }
})

export const remove = mutation({
  args: { documentId: v.id('documents'), adminCapability: adminVdrCapabilityValidator },
  handler: (ctx, args) => runConvex(removeProgram(ctx, args)),
})

// ============================================================================
// BORRADO PERMANENTE DEL DUEÑO DE LA SALA
// ============================================================================
// `remove` (arriba) ARCHIVA a propósito: conserva bytes, versiones y auditoría.
// Esto es lo otro que el cliente pide sobre SU sala — «cualquier documento
// dentro del VDR de cada quien, debe poder borrar sus archivos» — y por eso es
// una mutation PÚBLICA, no la de operador (`operatorPurge.deleteDocumentsHard`,
// que sigue detrás del deploy key y borra por lote con confirmación humana).
//
// La compuerta es la misma de archivar: dueño de la empresa del documento, o
// ADMIN, vía `requireCompanyOwnerOrAdmin`. Cada id se autoriza por separado
// contra SU empresa, así que un lote que mezcla salas muere en el primer id
// ajeno y no borra nada: el plan se arma después de validar el lote entero.
//
// El legal hold gana siempre y se rechaza con el MISMO código que la purga de
// operador (`validationFailed` sobre `documentIds`): un documento retenido no
// se borra ni con el dueño pidiéndolo.
//
// El borrado físico (filas de custodia + blobs sin dueño vivo) lo hacen
// `buildDocumentPurgePlan` / `executeDocumentPurgePlan`, los mismos de
// `_documents/purge.ts`: un solo lugar decide qué muere con un documento.
// ============================================================================

/** Techo del lote: la barra de selección de la sala no ofrece más. */
const MAX_PURGE_BATCH = 50

type PurgeArgs = {
  adminCapability?: string
  documentIds: Id<'documents'>[]
}

const purgeProgram = Effect.fn('Documents.purge')(function* (
  ctx: MutationCtx,
  args: PurgeArgs
): Effect.fn.Return<{ purged: number }, AppError> {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const { user, profile } = auth

  if (args.documentIds.length === 0) {
    return yield* Effect.fail(
      validationFailed('Selecciona al menos un documento para borrar.', 'documentIds')
    )
  }
  if (args.documentIds.length > MAX_PURGE_BATCH) {
    return yield* Effect.fail(
      validationFailed(
        `No puedes borrar más de ${MAX_PURGE_BATCH} documentos a la vez.`,
        'documentIds'
      )
    )
  }
  const distinct = new Set(args.documentIds.map((id) => `${id}`))
  if (distinct.size !== args.documentIds.length) {
    return yield* Effect.fail(
      validationFailed('documentIds contiene ids duplicados.', 'documentIds')
    )
  }

  // Primero se valida el lote ENTERO y sólo después se borra: un id ajeno,
  // retenido o entregado tiene que dejar la sala exactamente como estaba.
  //
  // Los entregables APPROVED/DELIVERED de cada empresa, en caché: el lote puede
  // tocar varias salas y cada consulta va por índice de empresa. La regla la
  // sirve `./purge` y la comparten la purga de operador
  // (`loadValidatedPurgeDocuments`) y el archivado (`Documents.archive`).
  const completedDeliverablesByCompany = new Map<string, Doc<'deliverables'>[]>()
  const completedDeliverablesOf = Effect.fn('Documents.purge.completedDeliverables')(function* (
    companyId: Id<'companies'>
  ) {
    const cached = completedDeliverablesByCompany.get(`${companyId}`)
    if (cached) return cached
    const completed = yield* loadCompletedDeliverablesEffect(ctx, companyId)
    completedDeliverablesByCompany.set(`${companyId}`, completed)
    return completed
  })

  // Paso 1: quién puede borrar cada id. La empresa de cada documento decide,
  // no una que venga en los argumentos.
  const documents: Doc<'documents'>[] = []
  const rooms = new Map<string, Doc<'companies'>>()
  for (const documentId of args.documentIds) {
    const document = yield* convexPromise(() => loadDocumentOrThrow(ctx, documentId))
    let company = rooms.get(`${document.companyId}`)
    if (!company) {
      company = yield* convexPromise(() =>
        loadCompanyOrThrow(ctx, document.companyId, 'Empresa del documento no encontrada')
      )
      rooms.set(`${document.companyId}`, company)
    }
    yield* convexPromise(() =>
      requireCompanyOwnerOrAdmin(
        ctx,
        auth,
        company,
        'Solo el dueño de la empresa puede borrar documentos'
      )
    )
    documents.push(document)
  }

  // Paso 2: la capability delegada, igual que en `remove` y `bulkUpdate`. Un
  // ADMIN sin ella no borra nada: el rol abre la puerta, la capability
  // acredita el gesto exacto (sala, acción, input) firmado en esta sesión.
  // Por eso se ata a UNA sala — un lote que cruza empresas no tiene una sola
  // a la que atarla — y el lote mezclado se rechaza antes de mirar nada más.
  const [room] = [...rooms.values()]
  if (profile.role === 'ADMIN' && rooms.size !== 1) {
    return yield* Effect.fail(
      validationFailed('Todos los documentos deben pertenecer a la misma empresa.', 'documentIds')
    )
  }
  yield* convexPromise(() =>
    requireAdminVdrCapability({
      ctx,
      auth,
      capability: args.adminCapability,
      company: room,
      action: 'DOCUMENT_PURGE',
      target: adminVdrTarget('COMPANY', `${room._id}`),
      input: withoutAdminVdrCapability(args),
    })
  )

  // Paso 3: las reglas de negocio. Se validan TODAS antes de la primera
  // escritura: un id retenido o entregado deja la sala como estaba.
  for (const document of documents) {
    const activeHold = yield* convexPromise(() =>
      ctx.db
        .query('documentLegalHolds')
        .withIndex('by_document_status', (q) =>
          q.eq('documentId', document._id).eq('status', 'ACTIVE')
        )
        .first()
    )
    if (activeHold) {
      return yield* Effect.fail(
        validationFailed(
          `El documento ${document._id} tiene un legal hold ACTIVE; ningún borrado ocurrió.`,
          'documentIds'
        )
      )
    }

    // Un entregable ya aprobado o entregado es trabajo del equipo publicado en
    // la sala: BORRARLO mata los bytes y deja el slot apuntando a nada. Al
    // dueño le queda «Quitar de la sala», que archiva sin destruir y avisa al
    // equipo ([F] 2026-09-17).
    const completed = yield* completedDeliverablesOf(document.companyId)
    if (findDeliverableBackedByDocuments(completed, new Set([`${document._id}`]))) {
      return yield* Effect.fail(validationFailed(DELIVERED_RENDITION_MESSAGE, 'documentIds'))
    }
  }

  const plan = yield* buildDocumentPurgePlanEffect(ctx, documents)
  const totals = {
    documents: plan.rows.length,
    versions: plan.rows.reduce((n, rowPlan) => n + rowPlan.versions.length, 0),
    grants: plan.rows.reduce((n, rowPlan) => n + rowPlan.grants.length, 0),
    textRows: plan.rows.reduce((n, rowPlan) => n + rowPlan.textRows.length, 0),
    blobs: plan.blobs.length,
  }

  yield* executeDocumentPurgePlanEffect(ctx, plan)

  for (const document of documents) {
    yield* convexPromise(() =>
      ctx.db.insert('activityLogs', {
        userId: profile._id,
        action: 'VDR_DOCUMENT_DELETED',
        entityType: 'DOCUMENT',
        entityId: `${document._id}`,
        metadata: {
          resourceType: 'COMPANY',
          resourceId: `${document.companyId}`,
        },
      })
    )
  }

  if (profile.role === 'ADMIN') {
    yield* convexPromise(() =>
      logAdminAction({
        ctx,
        adminProfileId: profile._id,
        adminEmail: user.email,
        action: 'DOCUMENT_PURGE',
        targetType: 'DOCUMENT',
        targetId: documents.map((document) => `${document._id}`).join(','),
        previousValue: {
          documents: documents.map((document) => ({
            id: `${document._id}`,
            name: document.name,
            lifecycleStatus: document.lifecycleStatus ?? null,
          })),
        },
        newValue: { totals },
      })
    )
  }

  return { purged: totals.documents }
})

export const purge = mutation({
  args: {
    adminCapability: adminVdrCapabilityValidator,
    documentIds: v.array(v.id('documents')),
  },
  handler: (ctx, args) => runConvex(purgeProgram(ctx, args)),
})
