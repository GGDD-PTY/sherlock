import { v } from 'convex/values'
import { Effect } from 'effect'

import type { Id } from './_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { loadDeliverablePublishedVersion } from './_documents/deliverableVersion'
import {
  loadCompanyOrThrow,
  recordDocumentAccessLog,
  requireCompanyOwnerOrAdmin,
  resolveDownloadAccess,
  validateVdrShellFolderDestination,
  VDR_SHELL_FOLDER_VALUES,
} from './_documents/shared'
import { getAuthenticatedCompany, requireAuth } from './_helpers/auth'
import { convexPromise, convexSync, runConvex } from './_helpers/effect'
import { enforceRateLimit } from './_helpers/rateLimit'
import { notFound, validationFailed } from './_helpers/errors'
import { getVdrShellFolderValue } from '../src/lib/vdr/document-taxonomy'

type ShellFolder = (typeof VDR_SHELL_FOLDER_VALUES)[number]

// La sala y el zip tienen que contar la MISMA historia: si el shell muestra un
// documento bajo «3. Financieros», el export no puede meterlo en Corporativos.
// Por eso se reusa la función canónica de la taxonomía (`getVdrShellFolderValue`,
// pura y sin React/Next) en vez de una segunda tabla de alias que envejece sola.
function resolveExportShellFolder(folder: string | undefined): ShellFolder {
  return getVdrShellFolderValue(folder) as ShellFolder
}

// `documentAccessLogs` no tiene campo libre y NO se le agrega uno por esto: la
// evidencia del zip viaja en `userAgent`, el unico campo descriptivo que este
// camino no usaba. Sin la marca, exportar la sala entera y bajar un archivo
// suelto dejan filas identicas y la bitacora no puede reconstruir el lote.
const EXPORT_AUDIT_MARKER_PREFIX = 'vdr-zip-export'
const EXPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function buildExportAuditMarker(args: {
  exportId: string
  folder: string | null
  count: number
}): string {
  return `${EXPORT_AUDIT_MARKER_PREFIX} exportId=${args.exportId} folder=${args.folder ?? 'all'} count=${args.count}`
}

const loadExportCompany = Effect.fn('VdrExport.loadExportCompany')(function* (
  ctx: QueryCtx | MutationCtx,
  companyId: Id<'companies'> | undefined
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const denied = 'No tienes permiso para exportar esta sala.'

  if (companyId) {
    const company = yield* convexPromise(() => loadCompanyOrThrow(ctx, companyId))
    yield* convexPromise(() => requireCompanyOwnerOrAdmin(ctx, auth, company, denied))
    return { auth, company }
  }

  if (auth.profile.role === 'ADMIN') {
    return yield* Effect.fail(
      validationFailed('Falta el identificador de la empresa.', 'companyId')
    )
  }

  const { company } = yield* convexPromise(() => getAuthenticatedCompany(ctx))
  if (!company) {
    return yield* Effect.fail(notFound('Empresa'))
  }

  yield* convexPromise(() => requireCompanyOwnerOrAdmin(ctx, auth, company, denied))
  return { auth, company }
})

const listExportableDocumentsProgram = Effect.fn('VdrExport.listExportableDocuments')(function* (
  ctx: QueryCtx,
  args: { companyId?: Id<'companies'>; folder?: string }
) {
  const { company } = yield* loadExportCompany(ctx, args.companyId)
  const folder = args.folder
  const folderFilter = folder
    ? yield* convexSync(() => validateVdrShellFolderDestination(folder))
    : null
  const now = Date.now()

  // La consulta ya viene acotada por la sala de UNA empresa a traves del
  // indice: un `.take()` encima solo lograba truncar el zip sin decirlo, y el
  // cliente se llevaba una sala incompleta creyendola completa.
  const documents = yield* convexPromise(() =>
    ctx.db
      .query('documents')
      .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
      .collect()
  )

  const exportable: Array<{
    documentId: Id<'documents'>
    name: string
    folder: ShellFolder
    byteSize: number
    storageUrl: string
    versionId: Id<'documentVersions'>
  }> = []

  for (const document of documents) {
    const shellFolder = resolveExportShellFolder(document.folder)
    if (folderFilter && shellFolder !== folderFilter) continue

    const version = yield* convexPromise(() => loadDeliverablePublishedVersion(ctx, document, now))
    if (!version) continue

    const storageUrl = yield* convexPromise(() => ctx.storage.getUrl(version.storageId))
    if (!storageUrl) continue

    exportable.push({
      documentId: document._id,
      name: document.name,
      folder: shellFolder,
      byteSize: version.byteSize,
      storageUrl,
      versionId: version._id,
    })
  }

  return {
    companyId: company._id,
    companyName: company.name,
    documents: exportable,
  }
})

export const listExportableDocuments = query({
  args: {
    companyId: v.optional(v.id('companies')),
    folder: v.optional(v.string()),
  },
  handler: (ctx, args) => runConvex(listExportableDocumentsProgram(ctx, args)),
})

const recordRoomExportProgram = Effect.fn('VdrExport.recordRoomExport')(function* (
  ctx: MutationCtx,
  args: {
    companyId: Id<'companies'>
    folder?: string
    exportId: string
    documentIds: Array<Id<'documents'>>
  }
) {
  const { auth, company } = yield* loadExportCompany(ctx, args.companyId)
  // El orden importa: la carpeta y el identificador se validan ANTES de gastar
  // presupuesto de rate limit, igual que antes. La diferencia es que la carpeta
  // se valida una sola vez y el resultado se reusa; antes se validaba dos veces
  // y la segunda pasada era la única cuyo valor alguien miraba.
  const folder = args.folder
  const folderFilter = folder
    ? yield* convexSync(() => validateVdrShellFolderDestination(folder))
    : null
  if (!EXPORT_ID_PATTERN.test(args.exportId)) {
    return yield* Effect.fail(
      validationFailed('El identificador del export no es valido.', 'exportId')
    )
  }

  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `vdrExport:${auth.profile._id}`,
      limit: 10,
      windowMs: 10 * 60 * 1000,
    })
  )

  const now = Date.now()
  const marker = buildExportAuditMarker({
    exportId: args.exportId,
    folder: folderFilter,
    count: args.documentIds.length,
  })
  let logged = 0

  for (const documentId of args.documentIds) {
    const document = yield* convexPromise(() => ctx.db.get(documentId))
    if (!document || document.companyId !== company._id) continue

    const shellFolder = resolveExportShellFolder(document.folder)
    if (folderFilter && shellFolder !== folderFilter) continue

    const version = yield* convexPromise(() => loadDeliverablePublishedVersion(ctx, document, now))
    if (!version) continue

    const evaluation = yield* convexPromise(() =>
      resolveDownloadAccess(ctx, auth, document)
    )
    yield* convexPromise(() =>
      recordDocumentAccessLog(ctx, {
        documentId: document._id,
        companyId: company._id,
        accessedById: auth.profile._id,
        action: evaluation.decision === 'ALLOW' ? 'DOWNLOAD' : 'DOWNLOAD_DENIED',
        evaluation,
        accessLevel: document.accessLevel,
        userAgent: marker,
      })
    )
    logged += 1
  }

  return { logged }
})

export const recordRoomExport = mutation({
  args: {
    companyId: v.id('companies'),
    folder: v.optional(v.string()),
    // Identificador opaco del lote, generado por la ruta antes de streamear.
    exportId: v.string(),
    documentIds: v.array(v.id('documents')),
  },
  handler: (ctx, args) => runConvex(recordRoomExportProgram(ctx, args)),
})
