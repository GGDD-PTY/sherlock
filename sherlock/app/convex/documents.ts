// Barril de la superficie `documents:*`. Convex direcciona por path TODO lo que
// un módulo de `convex/` exporte —con llamadores o sin ellos—, así que la lista
// de nombres es un contrato de seguridad, no documentación. Se declara una vez
// como `Schema.Literals` y el chequeo del final rompe el typecheck si el barril
// y la lista se separan, en cualquiera de las dos direcciones: un `export`
// nuevo que nadie declaró, o un nombre declarado que ya no existe.
// ES: `getAccessLogs` se eliminó (2026-07-28): cero callers y devolvía la fila
// cruda del log MÁS el profile crudo de la contraparte a cualquier owner. Una
// función sin llamadores sigue siendo direccionable por path desde cualquier
// cliente autenticado; la vista viva y proyectada es `getRoomActivity`.
import { Schema } from 'effect'

export {
  get,
  listVersions,
  getByCompany,
  getFolders,
  getRoomActivity,
  getManualReviewQueue,
} from './_documents/queries'

export { create, registerDirectUpload, update, remove, purge } from './_documents/mutations'
export { inspectAndRegisterDirectUpload } from './_documents/ingest'
export {
  abandonDirectUploadIntent,
  expireIssuedUploadIntents,
  issueDirectUploadIntent,
} from './_documents/uploadIntents'
export { issueAssetUploadIntent, resolveAssetUpload } from './_documents/assetUploadIntents'
export { restoreVersion } from './_documents/versions'
export { bulkUpdate } from './_documents/bulk'
export { getGovernanceStatus, placeLegalHold, releaseLegalHold } from './_documents/governance'

export {
  getStorageUrl,
  logLocalStorageAccess,
  getDocumentAccessGrant,
  getDownloadUrl,
  consumeDownloadGrant,
  releaseFailedDelivery,
} from './_documents/storage'

export {
  _backfillAccessLogCompanyId,
  _logBulkAccessEvent,
  _logBulkDownloadEvent,
  _markExpiredDocuments,
  _revokeDocumentGrantsBatch,
} from './_documents/internals'

const DeclaredSchema = Schema.Literals([
  'get',
  'listVersions',
  'getByCompany',
  'getFolders',
  'getRoomActivity',
  'getManualReviewQueue',
  'create',
  'registerDirectUpload',
  'update',
  'remove',
  'purge',
  'inspectAndRegisterDirectUpload',
  'abandonDirectUploadIntent',
  'expireIssuedUploadIntents',
  'issueDirectUploadIntent',
  'issueAssetUploadIntent',
  'resolveAssetUpload',
  'restoreVersion',
  'bulkUpdate',
  'getGovernanceStatus',
  'placeLegalHold',
  'releaseLegalHold',
  'getStorageUrl',
  'logLocalStorageAccess',
  'getDocumentAccessGrant',
  'getDownloadUrl',
  'consumeDownloadGrant',
  'releaseFailedDelivery',
  '_backfillAccessLogCompanyId',
  '_logBulkAccessEvent',
  '_logBulkDownloadEvent',
  '_markExpiredDocuments',
  '_revokeDocumentGrantsBatch',
])

const isDeclaredDocumentsExport = Schema.is(DeclaredSchema)

// Corre al cargar el módulo, no solo cuando alguien tipea el archivo: un
// literal repetido o mal escrito en el catálogo de arriba falla acá en cada
// cold start del isolate, no solo cuando alguien corre `tsc`.
if (!DeclaredSchema.literals.every(isDeclaredDocumentsExport)) {
  console.error('[convex/documents] catálogo de exports mal formado')
}

type Exported = keyof typeof import('./documents')
type Assert<T extends true> = T
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export type _SurfaceMatchesDeclaration = Assert<Exact<Exported, typeof DeclaredSchema.Type>>
