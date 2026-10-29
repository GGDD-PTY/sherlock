// ============================================================================
// EL IO COMPARTIDO DEL VDR
// ============================================================================
// Cada lectura de `ctx.db` cruza por `convexPromise` y cada guarda que hoy
// expresa su invariante lanzando cruza por el canal de error con su `AppError`.
// Los bordes Promise se conservan byte por byte: los callers que todavía son
// `async` llaman a la misma función y siguen recibiendo el mismo throw.
//
// Nada de esto corre en una action: son queries y mutations, así que aquí no
// hay timers, ni `Effect.retry` con schedule, ni `fetch`.
// ============================================================================

import { Effect } from 'effect'

import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { AuthResult } from '../_helpers/auth'
import { hasOwnership } from '../_helpers/auth'
import { convexPromise, runConvex } from '../_helpers/effect'
import type { AppError } from '../_helpers/errors'
import { notFound, unauthorized, validationFailed } from '../_helpers/errors'
import { evaluateCompanyManagementAuthorization } from '../_helpers/companyAuthorization'
import {
  evaluateDocumentAccessDecision,
  getDocumentAccessErrorMessage,
  inferDocumentClassification,
  type DocumentAccessEvaluation,
} from './policy'

type DbContext = { db: QueryCtx['db'] }

// El backend no puede importar la taxonomía de cliente sin romper la dirección
// de dependencias. El test de paridad en `documentFolderMoveAudit.test.ts`
// mantiene esta lista alineada con `src/lib/vdr/document-taxonomy.ts`.
export const VDR_SHELL_FOLDER_VALUES = [
  'room_legal',
  'room_corporate',
  'room_financial',
  'room_operations',
  'room_marketing',
] as const

const VDR_SHELL_FOLDER_VALUE_SET = new Set<string>(VDR_SHELL_FOLDER_VALUES)
const MAX_VDR_SHELL_FOLDER_LENGTH = 120

/** Normaliza y valida destinos nuevos; los aliases legacy se siguen leyendo. */
export function validateVdrShellFolderDestination(folder: string): string {
  const normalizedFolder = folder.trim()

  if (normalizedFolder.length === 0 || normalizedFolder.length > MAX_VDR_SHELL_FOLDER_LENGTH) {
    throw validationFailed(
      `La carpeta debe tener entre 1 y ${MAX_VDR_SHELL_FOLDER_LENGTH} caracteres.`,
      'folder'
    )
  }

  if (!VDR_SHELL_FOLDER_VALUE_SET.has(normalizedFolder)) {
    throw validationFailed('La carpeta debe ser un destino válido de la sala.', 'folder')
  }

  return normalizedFolder
}

export const requireCompanyOwnerOrAdminEffect = Effect.fn('VdrShared.requireCompanyOwnerOrAdmin')(
  function* (
    ctx: DbContext,
    auth: AuthResult,
    company: Doc<'companies'>,
    message: string
  ): Effect.fn.Return<void, AppError> {
    const decision = yield* convexPromise(() =>
      evaluateCompanyManagementAuthorization(ctx, auth, company)
    )
    if (!decision.authorized) {
      return yield* Effect.fail(unauthorized(message))
    }
  }
)

export function requireCompanyOwnerOrAdmin(
  ctx: DbContext,
  auth: AuthResult,
  company: Doc<'companies'>,
  message: string
): Promise<void> {
  return runConvex(requireCompanyOwnerOrAdminEffect(ctx, auth, company, message))
}

export const loadCompanyOrThrowEffect = Effect.fn('VdrShared.loadCompany')(function* (
  ctx: DbContext,
  companyId: Id<'companies'>,
  _message = 'Empresa no encontrada'
): Effect.fn.Return<Doc<'companies'>, AppError> {
  const company = yield* convexPromise(() => ctx.db.get(companyId))
  if (!company) return yield* Effect.fail(notFound('Empresa', companyId))
  return company
})

export function loadCompanyOrThrow(
  ctx: DbContext,
  companyId: Id<'companies'>,
  message = 'Empresa no encontrada'
): Promise<Doc<'companies'>> {
  return runConvex(loadCompanyOrThrowEffect(ctx, companyId, message))
}

const loadDocumentOrThrowEffect = Effect.fn('VdrShared.loadDocument')(function* (
  ctx: DbContext,
  documentId: Id<'documents'>,
  _message = 'Documento no encontrado'
): Effect.fn.Return<Doc<'documents'>, AppError> {
  const document = yield* convexPromise(() => ctx.db.get(documentId))
  if (!document) return yield* Effect.fail(notFound('Documento', documentId))
  return document
})

export function loadDocumentOrThrow(
  ctx: DbContext,
  documentId: Id<'documents'>,
  message = 'Documento no encontrado'
): Promise<Doc<'documents'>> {
  return runConvex(loadDocumentOrThrowEffect(ctx, documentId, message))
}

const findDocumentByStoragePathEffect = Effect.fn('VdrShared.findByStoragePath')(function* (
  ctx: DbContext,
  storagePath: string
) {
  return yield* convexPromise(() =>
    ctx.db
      .query('documents')
      .withIndex('by_storagePath', (q) => q.eq('storagePath', storagePath))
      .unique()
  )
})

export function findDocumentByStoragePath(
  ctx: DbContext,
  storagePath: string
): Promise<Doc<'documents'> | null> {
  return runConvex(findDocumentByStoragePathEffect(ctx, storagePath))
}

// ES: Devuelve el documento VDR (si existe) que apunta a este storageId.
// Se usa para negar la resolución directa de URLs de documentos protegidos:
// el acceso a documentos SIEMPRE debe pasar por el flujo de grants, nunca por
// getStorageUrl (que exige un asset intent consumido para avatar/logo).
// La búsqueda incluye TODAS las versiones inmutables. Sin esta segunda rama,
// reemplazar una versión quitaba el storageId antiguo de `documents` y ese blob
// histórico podía volver a parecer un upload genérico no protegido.
// EN: Returns the VDR document (if any) backed by this storageId, including
// superseded and archived immutable versions.
export const findDocumentByStorageIdEffect = Effect.fn('VdrShared.findByStorageId')(function* (
  ctx: DbContext,
  storageId: Id<'_storage'>
) {
  const currentDocument = yield* convexPromise(() =>
    ctx.db
      .query('documents')
      .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
      .first()
  )

  if (currentDocument) return currentDocument

  const immutableVersion = yield* convexPromise(() =>
    ctx.db
      .query('documentVersions')
      .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
      .first()
  )

  if (!immutableVersion) return null
  return yield* convexPromise(() => ctx.db.get(immutableVersion.documentId))
})

export function findDocumentByStorageId(
  ctx: DbContext,
  storageId: Id<'_storage'>
): Promise<Doc<'documents'> | null> {
  return runConvex(findDocumentByStorageIdEffect(ctx, storageId))
}

export const getCompanyDocumentsEffect = Effect.fn('VdrShared.getCompanyDocuments')(function* (
  ctx: DbContext,
  companyId: Id<'companies'>
) {
  const documents = yield* convexPromise(() =>
    ctx.db
      .query('documents')
      .withIndex('by_companyId', (q) => q.eq('companyId', companyId))
      .collect()
  )

  // Archived records remain addressable for audit and retention, but never
  // reappear in the active room, folders, activity rollups, or projections.
  return documents.filter((document) => document.lifecycleStatus !== 'ARCHIVED')
})

export const assertDocumentAccessEffect = Effect.fn('VdrShared.assertDocumentAccess')(function* (
  ctx: DbContext,
  auth: AuthResult,
  document: Doc<'documents'>
): Effect.fn.Return<void, AppError> {
  const evaluation = yield* evaluateDocumentAccessEffect(ctx, auth, document)

  if (evaluation.decision !== 'ALLOW') {
    return yield* Effect.fail(unauthorized(getDocumentAccessErrorMessage(evaluation)))
  }
})

const resolveDownloadAccessEffect = Effect.fn('VdrShared.resolveDownloadAccess')(function* (
  ctx: DbContext,
  auth: AuthResult,
  document: Doc<'documents'>
) {
  return yield* evaluateDocumentAccessEffect(ctx, auth, document)
})

export function resolveDownloadAccess(
  ctx: DbContext,
  auth: AuthResult,
  document: Doc<'documents'>
): Promise<DocumentAccessEvaluation> {
  return runConvex(resolveDownloadAccessEffect(ctx, auth, document))
}

// ES: Todo lo que la evaluación de acceso necesita y que NO varía por
// documento: (profile, company) fijan la empresa y su sala. Listar un data room
// de N documentos costaba ~5 lecturas POR documento con los mismos resultados;
// el baseline las hace UNA vez y la evaluación por documento pasa a ser pura
// (cero lecturas).
// EN: per-(profile, company) snapshot so per-document evaluation is pure.
export interface DocumentAccessBaseline {
  profile: Doc<'profiles'>
  company: Doc<'companies'> | null
  companyManagementAuthorized: boolean
  evaluatedAt: number
}

const buildDocumentAccessBaselineEffect = Effect.fn('VdrShared.buildAccessBaseline')(
  function* (
    ctx: DbContext,
    profile: Doc<'profiles'>,
    companyId: Id<'companies'>,
    managementAuth?: AuthResult
  ): Effect.fn.Return<DocumentAccessBaseline, AppError> {
    const company = yield* convexPromise(() => ctx.db.get(companyId))
    // Projected reads deliberately omit managementAuth. A stored profile
    // is never enough to reconstruct issuer authority; only the live session may
    // turn on the management branch, and it must describe this exact profile.
    const canEvaluateManagement =
      company !== null && managementAuth !== undefined && managementAuth.profile._id === profile._id
    const companyManagementAuthorized = canEvaluateManagement
      ? (yield* convexPromise(() =>
          evaluateCompanyManagementAuthorization(ctx, managementAuth, company)
        )).authorized
      : false
    return {
      profile,
      company,
      companyManagementAuthorized,
      evaluatedAt: Date.now(),
    }
  }
)

export function buildDocumentAccessBaseline(
  ctx: DbContext,
  profile: Doc<'profiles'>,
  companyId: Id<'companies'>,
  managementAuth?: AuthResult
): Promise<DocumentAccessBaseline> {
  return runConvex(buildDocumentAccessBaselineEffect(ctx, profile, companyId, managementAuth))
}


export function evaluateDocumentAccessWithBaseline(
  baseline: DocumentAccessBaseline,
  document: Doc<'documents'>
): DocumentAccessEvaluation {
  const { profile, company } = baseline

  if (document.lifecycleStatus === 'QUARANTINED') {
    return {
      decision: 'DENY',
      outcome: 'DENIED_DOCUMENT_QUARANTINED',
      reason: 'Este archivo permanece en cuarentena hasta completar su verificación.',
      classification: inferDocumentClassification(document.accessLevel, document.classification),
      riskScore: 100,
      stepUpRequirement: 'NONE',
    }
  }

  if (document.lifecycleStatus === 'ARCHIVED') {
    return {
      decision: 'DENY',
      outcome: 'DENIED_DOCUMENT_ARCHIVED',
      reason: 'Este documento está archivado y no puede entregarse.',
      classification: inferDocumentClassification(document.accessLevel, document.classification),
      riskScore: 100,
      stepUpRequirement: 'NONE',
    }
  }

  if (!company) {
    return {
      decision: 'DENY',
      outcome: 'DENIED_COMPANY_NOT_FOUND',
      reason: 'La empresa asociada al documento no existe.',
      classification: inferDocumentClassification(document.accessLevel, document.classification),
      riskScore: 100,
      stepUpRequirement: 'NONE',
    }
  }

  if (
    profile.role !== 'ADMIN' &&
    hasOwnership(profile, company.ownerId) &&
    !baseline.companyManagementAuthorized
  ) {
    return {
      decision: 'DENY',
      outcome: 'DENIED_COMPANY_AUTHORIZATION_REVOKED',
      reason: 'La autorización de esta empresa ya no está vigente.',
      classification: inferDocumentClassification(document.accessLevel, document.classification),
      riskScore: 100,
      stepUpRequirement: 'NONE',
    }
  }

  // La sala es una por empresa: quien no tenga autorización de gestión vigente
  // sobre ella no puede abrir su biblioteca. Es la rama que antes exigía scope
  // de sala, con exactamente la misma compuerta. Va DESPUÉS de la revocación
  // para que el dueño que perdió su autorización conserve su código preciso.
  if (!baseline.companyManagementAuthorized) {
    return {
      decision: 'DENY',
      outcome: 'DENIED_COMPANY_ROOM_NOT_SHARED',
      reason: 'La biblioteca corporativa no es una sala compartida.',
      classification: inferDocumentClassification(document.accessLevel, document.classification),
      riskScore: 100,
      stepUpRequirement: 'NONE',
    }
  }

  const isOwner = baseline.companyManagementAuthorized
  return evaluateDocumentAccessDecision({
    profile,
    document,
    isOwner,
  })
}

// Wrapper para callers de documento único (assertDocumentAccess y
// resolveDownloadAccess). Requiere el AuthResult vivo a propósito: las decisiones
// de management no se pueden reconstruir desde un profile persistido.
const evaluateDocumentAccessEffect = Effect.fn('VdrShared.evaluateDocumentAccess')(function* (
  ctx: DbContext,
  auth: AuthResult,
  document: Doc<'documents'>
) {
  const baseline = yield* buildDocumentAccessBaselineEffect(
    ctx,
    auth.profile,
    document.companyId,
    auth
  )
  return evaluateDocumentAccessWithBaseline(baseline, document)
})

export function evaluateDocumentAccess(
  ctx: DbContext,
  auth: AuthResult,
  document: Doc<'documents'>
): Promise<DocumentAccessEvaluation> {
  return runConvex(evaluateDocumentAccessEffect(ctx, auth, document))
}

type DocumentAccessLogInput = {
  documentId: Id<'documents'>
  // Requerido a propósito: la sala a la que pertenece el acceso no puede
  // quedarse fuera por olvido en un call site nuevo — sin ella la fila es
  // invisible para la vista de actividad del emisor.
  companyId: Id<'companies'>
  accessedById: Id<'profiles'>
  action: string
  evaluation: DocumentAccessEvaluation
  accessLevel?: Doc<'documents'>['accessLevel']
  ipAddress?: string
  userAgent?: string
  grantId?: Id<'documentAccessGrants'>
}

const recordDocumentAccessLogEffect = Effect.fn('VdrShared.recordAccessLog')(function* (
  ctx: Pick<MutationCtx, 'db'>,
  args: DocumentAccessLogInput
) {
  return yield* convexPromise(() =>
    ctx.db.insert('documentAccessLogs', {
      documentId: args.documentId,
      companyId: args.companyId,
      accessedById: args.accessedById,
      accessedAt: Date.now(),
      action: args.action,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      decision: args.evaluation.decision,
      outcome: args.evaluation.outcome,
      reason: args.evaluation.reason,
      stepUpRequirement: args.evaluation.stepUpRequirement,
      riskScore: args.evaluation.riskScore,
      classification: args.evaluation.classification,
      accessLevel: args.accessLevel,
      grantId: args.grantId,
    })
  )
})

export function recordDocumentAccessLog(
  ctx: Pick<MutationCtx, 'db'>,
  args: DocumentAccessLogInput
): Promise<Id<'documentAccessLogs'>> {
  return runConvex(recordDocumentAccessLogEffect(ctx, args))
}

// ES: Mover un documento entre carpetas es UN hecho de negocio con DOS caminos
// de entrada — el arrastre individual del árbol del VDR (`documents.update` con
// `folder`) y la operación en lote (`documents.bulkUpdate` con `MOVE_FOLDER`).
// La evidencia de sala se construye acá, una sola vez, para que ninguno de los
// dos pueda quedarse mudo ni divergir en la forma del payload. La decisión de SI
// hay movimiento vive en cada call site: el lote registra cada documento de la
// selección, el camino individual solo cuando la carpeta cambia de verdad.
// EN: one move, one row shape — the caller decides whether a move happened.
const DOCUMENT_FOLDER_CHANGED_ACTION = 'VDR_DOCUMENT_FOLDER_CHANGED'

// La carpeta es opcional en el schema; un documento sin carpeta vive en el
// bucket por defecto, y así debe leerse el "antes" de la bitácora.
export const DEFAULT_DOCUMENT_FOLDER = 'General'

type DocumentFolderChangeInput = {
  profileId: Id<'profiles'>
  document: Doc<'documents'>
  // Se recibe explícito en vez de leerse de `document` para que el orden
  // respecto al `patch` no pueda alterar el "antes" registrado.
  previousFolder: string | undefined
  nextFolder: string
}

export const recordDocumentFolderChangeEffect = Effect.fn('VdrShared.recordFolderChange')(
  function* (ctx: Pick<MutationCtx, 'db'>, args: DocumentFolderChangeInput) {
    return yield* convexPromise(() =>
      ctx.db.insert('activityLogs', {
        userId: args.profileId,
        action: DOCUMENT_FOLDER_CHANGED_ACTION,
        entityType: 'DOCUMENT',
        entityId: `${args.document._id}`,
        metadata: {
          resourceType: 'COMPANY',
          resourceId: `${args.document.companyId}`,
          operation: 'MOVE_FOLDER',
          previousValue: { folder: args.previousFolder ?? DEFAULT_DOCUMENT_FOLDER },
          newValue: { folder: args.nextFolder },
        },
      })
    )
  }
)

export function recordDocumentFolderChange(
  ctx: Pick<MutationCtx, 'db'>,
  args: DocumentFolderChangeInput
): Promise<Id<'activityLogs'>> {
  return runConvex(recordDocumentFolderChangeEffect(ctx, args))
}

export function createDocumentAccessGrantToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID().replace(/-/g, '')}`
}

export async function hashDocumentAccessGrantToken(token: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(token)
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer)
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function cleanUndefinedFields(updates: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined))
}

// Proyección por lista blanca (`convex/AGENTS.md:8`): la fila cruda de
// `documents` trae `storageId`/`storagePath` y otros internos que ningún
// consumidor del cliente lee hoy.
/**
 * Lo que ve quien administra la sala (dueño, gestión, admin): toda la ficha
 * menos los punteros de storage. `storageId`/`storagePath` no dan acceso por sí
 * solos y el cliente nunca los usa: los bytes salen por la entrega firmada.
 * Lista blanca explícita (`convex/AGENTS.md`): un campo nuevo del schema entra
 * aquí a propósito, no por arrastre.
 */
export function projectCompanyOwnerDocument(document: Doc<'documents'>) {
  return {
    _id: document._id,
    _creationTime: document._creationTime,
    companyId: document.companyId,
    name: document.name,
    description: document.description,
    fileType: document.fileType,
    fileSize: document.fileSize,
    lifecycleStatus: document.lifecycleStatus,
    currentVersionId: document.currentVersionId,
    publishedVersionId: document.publishedVersionId,
    currentVersionNumber: document.currentVersionNumber,
    archivedAt: document.archivedAt,
    archivedByProfileId: document.archivedByProfileId,
    accessLevel: document.accessLevel,
    classification: document.classification,
    protectionPolicyVersion: document.protectionPolicyVersion,
    updatedAt: document.updatedAt,
    folder: document.folder,
    sourceType: document.sourceType,
    sourceUrl: document.sourceUrl,
    sourceName: document.sourceName,
    provenanceNotes: document.provenanceNotes,
    expiresAt: document.expiresAt,
    isExpired: document.isExpired,
  }
}

export function projectCompanyMemberDocumentIndex(document: Doc<'documents'>) {
  return {
    _id: document._id,
    _creationTime: document._creationTime,
    companyId: document.companyId,
    name: document.name,
    fileType: document.fileType,
    folder: document.folder,
    accessLevel: document.accessLevel,
    classification: document.classification,
    expiresAt: document.expiresAt,
    lifecycleStatus: document.lifecycleStatus,
    currentVersionNumber: document.currentVersionNumber,
  }
}

export const revokeGrantsForDocumentEffect = Effect.fn('VdrShared.revokeGrants')(function* (
  ctx: Pick<MutationCtx, 'db'>,
  documentId: Id<'documents'>,
  reason: string,
  now = Date.now()
) {
  const grants = yield* convexPromise(() =>
    ctx.db
      .query('documentAccessGrants')
      .withIndex('by_documentId', (q) => q.eq('documentId', documentId))
      .collect()
  )

  let revokedCount = 0

  for (const grant of grants) {
    if (grant.revokedAt === undefined && grant.expiresAt > now) {
      yield* convexPromise(() => ctx.db.patch(grant._id, { revokedAt: now, outcome: reason }))
      revokedCount += 1
    }
  }

  return revokedCount
})

export function revokeGrantsForDocument(
  ctx: Pick<MutationCtx, 'db'>,
  documentId: Id<'documents'>,
  reason: string,
  now = Date.now()
): Promise<number> {
  return runConvex(revokeGrantsForDocumentEffect(ctx, documentId, reason, now))
}
