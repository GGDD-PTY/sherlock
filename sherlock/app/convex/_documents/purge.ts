// ============================================================================
// PURGA FÍSICA DE DOCUMENTOS — validación, plan y ejecución
// ============================================================================
// Tres pasos que corren dentro de UNA mutation: se valida el lote entero, se
// arma el plan y recién ahí se escribe. Como programas Effect el orden queda
// explícito y cada rechazo sale por el canal de error con su `AppError`, en vez
// de por un `throw` que el llamador tiene que adivinar.
//
// Nada de esto usa timers ni reintentos: corre en el aislado de una mutation,
// donde `Date.now()` está congelado y no hay schedule que avance.
// ============================================================================

import { Effect } from 'effect'

import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { convexPromise, runConvex } from '../_helpers/effect'
import type { AppError } from '../_helpers/errors'
import { notFound, validationFailed } from '../_helpers/errors'

type BlobOrigin = 'document' | 'version'

type DocumentPurgeRows = {
  document: Doc<'documents'>
  versions: Doc<'documentVersions'>[]
  grants: Doc<'documentAccessGrants'>[]
  textRows: Doc<'documentTextIndex'>[]
}

type DocumentPurgeBlob = {
  id: Id<'_storage'>
  origins: BlobOrigin[]
  documentIds: Id<'documents'>[]
}

export type DocumentPurgePlan = {
  rows: DocumentPurgeRows[]
  blobs: DocumentPurgeBlob[]
}

type BlobCandidate = {
  id: Id<'_storage'>
  origins: Set<BlobOrigin>
  documentIds: Set<Id<'documents'>>
}

// ============================================================================
// ENTREGAS DEL EQUIPO — UNA sola regla, y solo para el borrado
// ============================================================================
// Un documento que respalda un entregable APPROVED o DELIVERED es trabajo del
// equipo ya publicado en la sala. BORRARLO lo destruye: mueren la fila, las
// versiones y los bytes, y el slot se queda apuntando a nada. Por eso la purga
// —la de operador y la del dueño— lo niega: el equipo retira o reabre el
// entregable desde Admin y recién ahí el documento queda libre.
//
// QUITARLO DE LA SALA es otra cosa y ya no se niega ([F] 2026-09-17: «cada
// cliente, dueño de sus documentos, no podemos prohibirle borrar sus documentos
// de su VDR (no es lo mismo que de nuestro database, sino de su VDR
// solamente)»). Archivar conserva fila, bytes y auditoría, así que el dueño
// pasa: `Documents.archive` y `DocumentBulk.update` marcan la rendition como
// retirada (`_deliverables/clientWithdrawal.ts`) y avisan al equipo. Lo que
// esas dos puertas siguen leyendo de acá es QUIÉN está entregado
// (`loadCompletedDeliverablesEffect` + `findDeliverableBackedByDocuments`), y
// el ADMIN con capability sigue rechazado con el mensaje de abajo.

/**
 * El mensaje que ve quien intenta destruir los bytes de una entrega del equipo:
 * la purga de la sala, la de operador y el ADMIN que archiva. Uno solo, para
 * que la regla no tenga dos redacciones.
 */
export const DELIVERED_RENDITION_MESSAGE =
  'Este documento es una entrega del equipo; el equipo puede retirarla desde Admin.'

/** Los entregables de la empresa que ya están aprobados o entregados. */
export const loadCompletedDeliverablesEffect = Effect.fn('DocumentPurge.completedDeliverables')(
  function* (ctx: MutationCtx, companyId: Id<'companies'>) {
    const deliverables = yield* convexPromise(() =>
      ctx.db
        .query('deliverables')
        .withIndex('by_companyId', (q) => q.eq('companyId', companyId))
        .collect()
    )
    return deliverables.filter(
      (deliverable) => deliverable.status === 'APPROVED' || deliverable.status === 'DELIVERED'
    )
  }
)

/** El primer entregable completo que se quedaría sin una de sus renditions. */
export function findDeliverableBackedByDocuments(
  completed: readonly Doc<'deliverables'>[],
  documentIds: ReadonlySet<string>
): Doc<'deliverables'> | undefined {
  return completed.find((deliverable) =>
    (deliverable.renditions ?? []).some((rendition) => documentIds.has(`${rendition.documentId}`))
  )
}

const loadValidatedPurgeDocumentsEffect = Effect.fn('DocumentPurge.validate')(function* (
  ctx: MutationCtx,
  companyId: Id<'companies'>,
  documentIds: Id<'documents'>[]
): Effect.fn.Return<Doc<'documents'>[], AppError> {
  if (documentIds.length === 0) {
    return yield* Effect.fail(validationFailed('documentIds no puede venir vacío.', 'documentIds'))
  }

  const distinct = new Set(documentIds.map((id) => `${id}`))
  if (distinct.size !== documentIds.length) {
    return yield* Effect.fail(
      validationFailed('documentIds contiene ids duplicados.', 'documentIds')
    )
  }

  const documents: Doc<'documents'>[] = []
  for (const documentId of documentIds) {
    const document = yield* convexPromise(() => ctx.db.get(documentId))
    if (!document) return yield* Effect.fail(notFound('Documento', `${documentId}`))
    if (document.companyId !== companyId) {
      return yield* Effect.fail(
        validationFailed(
          `El documento ${documentId} no pertenece a la empresa confirmada; ningún borrado ocurrió.`,
          'documentIds'
        )
      )
    }

    const activeHold = yield* convexPromise(() =>
      ctx.db
        .query('documentLegalHolds')
        .withIndex('by_document_status', (q) =>
          q.eq('documentId', documentId).eq('status', 'ACTIVE')
        )
        .first()
    )
    if (activeHold) {
      return yield* Effect.fail(
        validationFailed(
          `El documento ${documentId} tiene un legal hold ACTIVE; ningún borrado ocurrió.`,
          'documentIds'
        )
      )
    }
    documents.push(document)
  }

  const completed = yield* loadCompletedDeliverablesEffect(ctx, companyId)
  const completedDeliverable = findDeliverableBackedByDocuments(completed, distinct)
  if (completedDeliverable) {
    return yield* Effect.fail(
      validationFailed(
        `La purga incluye una rendition del entregable ${completedDeliverable._id} (${completedDeliverable.status}); reemplázala o reabre el entregable antes de purgar. Ningún borrado ocurrió.`,
        'documentIds'
      )
    )
  }

  return documents
})

export function loadValidatedPurgeDocuments(
  ctx: MutationCtx,
  companyId: Id<'companies'>,
  documentIds: Id<'documents'>[]
): Promise<Doc<'documents'>[]> {
  return runConvex(loadValidatedPurgeDocumentsEffect(ctx, companyId, documentIds))
}

/**
 * ¿Queda alguna fila que apunte a este blob una vez descontadas las que el
 * llamador ya da por muertas? Sin descontar nada responde la pregunta de
 * huerfanía pura, que es lo que necesita el reporte de poda
 * (`operatorPrune.ts`); con `ignoreDocumentIds` responde la del lote de purga.
 */
const storageHasLiveOwnerEffect = Effect.fn('DocumentPurge.storageHasLiveOwner')(function* (
  ctx: MutationCtx,
  storageId: Id<'_storage'>,
  options: {
    ignoreDocumentIds?: ReadonlySet<string>
    ignoreVersionIds?: ReadonlySet<string>
  } = {}
) {
  const ignoreDocumentIds = options.ignoreDocumentIds ?? new Set<string>()
  const ignoreVersionIds = options.ignoreVersionIds ?? new Set<string>()

  const documents = yield* convexPromise(() =>
    ctx.db
      .query('documents')
      .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
      .collect()
  )
  if (documents.some((row) => !ignoreDocumentIds.has(`${row._id}`))) return true

  const versions = yield* convexPromise(() =>
    ctx.db
      .query('documentVersions')
      .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
      .collect()
  )
  if (
    versions.some(
      (row) => !ignoreVersionIds.has(`${row._id}`) && !ignoreDocumentIds.has(`${row.documentId}`)
    )
  ) {
    return true
  }

  const intakeDocument = yield* convexPromise(() =>
    ctx.db
      .query('intakeDocuments')
      .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
      .first()
  )
  if (intakeDocument) return true

  const intakeIntent = yield* convexPromise(() =>
    ctx.db
      .query('intakeUploadIntents')
      .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
      .first()
  )
  if (intakeIntent) return true

  // Un intento consumido conserva `storageId` y `documentId` como recibo de la
  // subida; si su documento está en el lote condenado, no es un dueño vivo.
  // Un intento sin documento (subida en curso) sí lo es.
  const vdrIntents = yield* convexPromise(() =>
    ctx.db
      .query('vdrUploadIntents')
      .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
      .collect()
  )
  if (
    vdrIntents.some(
      (row) => row.documentId === undefined || !ignoreDocumentIds.has(String(row.documentId))
    )
  ) {
    return true
  }

  const assetIntent = yield* convexPromise(() =>
    ctx.db
      .query('assetUploadIntents')
      .withIndex('by_storageId', (q) => q.eq('storageId', storageId))
      .first()
  )
  return assetIntent !== null
})

export function storageHasLiveOwner(
  ctx: MutationCtx,
  storageId: Id<'_storage'>,
  options: {
    ignoreDocumentIds?: ReadonlySet<string>
    ignoreVersionIds?: ReadonlySet<string>
  } = {}
): Promise<boolean> {
  return runConvex(storageHasLiveOwnerEffect(ctx, storageId, options))
}

function addBlobCandidate(
  candidates: Map<string, BlobCandidate>,
  storageId: Id<'_storage'>,
  origin: BlobOrigin,
  documentId: Id<'documents'>
): void {
  const key = `${storageId}`
  const candidate = candidates.get(key) ?? {
    id: storageId,
    origins: new Set<BlobOrigin>(),
    documentIds: new Set<Id<'documents'>>(),
  }
  candidate.origins.add(origin)
  candidate.documentIds.add(documentId)
  candidates.set(key, candidate)
}

export const buildDocumentPurgePlanEffect = Effect.fn('DocumentPurge.plan')(function* (
  ctx: MutationCtx,
  documents: Doc<'documents'>[]
) {
  const rows: DocumentPurgeRows[] = []
  const candidates = new Map<string, BlobCandidate>()
  const doomedDocumentIds = new Set(documents.map((document) => `${document._id}`))

  for (const document of documents) {
    const [versions, grants, textRows] = yield* convexPromise(() =>
      Promise.all([
        ctx.db
          .query('documentVersions')
          .withIndex('by_document_version', (q) => q.eq('documentId', document._id))
          .collect(),
        ctx.db
          .query('documentAccessGrants')
          .withIndex('by_documentId', (q) => q.eq('documentId', document._id))
          .collect(),
        ctx.db
          .query('documentTextIndex')
          .withIndex('by_documentId', (q) => q.eq('documentId', document._id))
          .collect(),
      ])
    )

    if (document.storageId) {
      addBlobCandidate(candidates, document.storageId, 'document', document._id)
    }
    for (const version of versions) {
      addBlobCandidate(candidates, version.storageId, 'version', document._id)
    }
    rows.push({ document, versions, grants, textRows })
  }

  const blobs: DocumentPurgeBlob[] = []
  for (const candidate of candidates.values()) {
    const stillOwned = yield* storageHasLiveOwnerEffect(ctx, candidate.id, {
      ignoreDocumentIds: doomedDocumentIds,
    })
    if (!stillOwned) {
      blobs.push({
        id: candidate.id,
        origins: [...candidate.origins],
        documentIds: [...candidate.documentIds],
      })
    }
  }

  return { rows, blobs } satisfies DocumentPurgePlan
})

export function buildDocumentPurgePlan(
  ctx: MutationCtx,
  documents: Doc<'documents'>[]
): Promise<DocumentPurgePlan> {
  return runConvex(buildDocumentPurgePlanEffect(ctx, documents))
}

export const executeDocumentPurgePlanEffect = Effect.fn('DocumentPurge.execute')(function* (
  ctx: MutationCtx,
  plan: DocumentPurgePlan
) {
  for (const rowPlan of plan.rows) {
    for (const row of rowPlan.grants) yield* convexPromise(() => ctx.db.delete(row._id))
    for (const row of rowPlan.textRows) yield* convexPromise(() => ctx.db.delete(row._id))
    for (const row of rowPlan.versions) yield* convexPromise(() => ctx.db.delete(row._id))
  }
  for (const blob of plan.blobs) yield* convexPromise(() => ctx.storage.delete(blob.id))
  for (const rowPlan of plan.rows) yield* convexPromise(() => ctx.db.delete(rowPlan.document._id))
})

export function executeDocumentPurgePlan(ctx: MutationCtx, plan: DocumentPurgePlan): Promise<void> {
  return runConvex(executeDocumentPurgePlanEffect(ctx, plan))
}
