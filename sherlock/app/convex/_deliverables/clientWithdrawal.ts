// ============================================================================
// RETIRO DEL CLIENTE — qué le pasa al entregable cuando el dueño quita su
// documento de la sala
// ============================================================================
// [F] 2026-09-17: el cliente es dueño de su VDR y puede quitar de él cualquier
// documento suyo, incluido el que respalda una entrega ya aprobada o entregada.
// Quitar de la sala es ARCHIVAR (`Documents.archive`, `DocumentBulk.update`):
// la fila, los bytes y la auditoría se quedan; lo que sale es el acceso.
//
// La purga física es otra cosa y no pasa por acá: ahí sí mueren los bytes y la
// regla de custodia de `_documents/purge.ts` sigue negando la entrega.
//
// Qué hace este módulo: marca la rendition retirada en el slot que la citaba.
// No toca `status` — la máquina de estados es del equipo — y no borra la
// rendition: el puntero al documento archivado es la evidencia de qué se
// entregó. Los lectores no se confunden porque `listForCompany` ya esconde toda
// rendition sin versión publicada, y un documento archivado no la tiene
// (`loadDeliverablePublishedVersion`).
// ============================================================================

import { Effect } from 'effect'

import { loadDeliverablePublishedVersion } from '../_documents/deliverableVersion'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { convexPromise } from '../_helpers/effect'

export type ClientWithdrawal = {
  deliverableId: Id<'deliverables'>
  kind: Doc<'deliverables'>['kind']
  status: Doc<'deliverables'>['status']
  /** Los documentos de ESTE slot que el cliente acaba de quitar de la sala. */
  documentIds: Id<'documents'>[]
  /** Ya no le queda ninguna rendition vigente. */
  fullyWithdrawn: boolean
}

/**
 * ¿Al slot le queda una entrega que el cliente pueda abrir?
 *
 * La respuesta NO sale de los sellos de retiro: una rendition deja de ser
 * usable sin que nadie la retire — el dueño le puso un vencimiento pasado, la
 * versión dejó de estar publicada, el scan no quedó limpio. Contar sellos
 * afirmaba «conserva otra entrega vigente» sobre un slot que el cliente ya veía
 * vacío. Se pregunta exactamente lo que proyecta `deliverables.listForCompany`,
 * que es lo que el cliente ve: `loadDeliverablePublishedVersion`.
 */
const hasUsableRenditionEffect = Effect.fn('Deliverables.hasUsableRendition')(function* (
  ctx: MutationCtx,
  args: {
    companyId: Id<'companies'>
    renditions: readonly { documentId: Id<'documents'> }[]
  }
) {
  for (const rendition of args.renditions) {
    const document = yield* convexPromise(() => ctx.db.get(rendition.documentId))
    if (!document || document.companyId !== args.companyId) continue
    const version = yield* convexPromise(() => loadDeliverablePublishedVersion(ctx, document))
    if (version) return true
  }
  return false
})

/**
 * Marca como retiradas las renditions que apuntan a los documentos quitados.
 *
 * `completed` llega ya cargado (`loadCompletedDeliverablesEffect`): quien llama
 * ya lo necesitó para decidir si el gesto toca una entrega, y el lote de la
 * sala puede tocar varios documentos del MISMO slot. Un solo patch por
 * entregable evita que el segundo documento del lote escriba sobre una copia en
 * memoria que quedó vieja después del primero.
 *
 * CONTRATO: se llama justo después de archivar, y sus dos puertas
 * (`Documents.archive`, `DocumentBulk.update`) rechazan antes de escribir un
 * documento que ya estaba archivado. Por eso el sello ANTERIOR no frena nada:
 * una rendition que cita un documento archivado en ESTA transacción se retiró
 * ahora, y el sello se reescribe con quién y cuándo. Filtrar por «todavía no
 * tiene sello» dejaba mudo el segundo retiro de un documento que el equipo
 * había devuelto a la sala (`operatorRestore`): sin fila de auditoría y sin
 * aviso.
 */
export const withdrawRenditionsForDocumentsEffect = Effect.fn('Deliverables.withdrawRenditions')(
  function* (
    ctx: MutationCtx,
    args: {
      completed: readonly Doc<'deliverables'>[]
      documentIds: ReadonlySet<string>
      profileId: Id<'profiles'>
      now: number
    }
  ) {
    const withdrawals: ClientWithdrawal[] = []

    for (const deliverable of args.completed) {
      const renditions = deliverable.renditions ?? []
      const affected = renditions.filter((rendition) =>
        args.documentIds.has(`${rendition.documentId}`)
      )
      if (affected.length === 0) continue

      const next = renditions.map((rendition) =>
        args.documentIds.has(`${rendition.documentId}`)
          ? {
              ...rendition,
              withdrawnByClientAt: args.now,
              withdrawnByProfileId: args.profileId,
            }
          : rendition
      )

      yield* convexPromise(() =>
        ctx.db.patch(deliverable._id, { renditions: next, updatedAt: args.now })
      )

      const stillUsable = yield* hasUsableRenditionEffect(ctx, {
        companyId: deliverable.companyId,
        renditions: next,
      })

      withdrawals.push({
        deliverableId: deliverable._id,
        kind: deliverable.kind,
        status: deliverable.status,
        documentIds: affected.map((rendition) => rendition.documentId),
        fullyWithdrawn: !stillUsable,
      })
    }

    return withdrawals
  }
)

/** La acción propia del retiro en el log de actividad de la sala. */
const CLIENT_WITHDRAWAL_ACTIVITY_ACTION = 'VDR_DELIVERABLE_WITHDRAWN_BY_CLIENT'

/**
 * Una fila de auditoría por entregable afectado. El documento archivado ya dejó
 * la suya (`VDR_DOCUMENT_ARCHIVED`); esta responde la otra pregunta: qué
 * entrega del equipo se quedó sin respaldo y por decisión de quién.
 */
export const recordClientWithdrawalActivityEffect = Effect.fn('Deliverables.withdrawalActivity')(
  function* (
    ctx: MutationCtx,
    args: {
      companyId: Id<'companies'>
      profileId: Id<'profiles'>
      withdrawals: readonly ClientWithdrawal[]
    }
  ) {
    for (const withdrawal of args.withdrawals) {
      yield* convexPromise(() =>
        ctx.db.insert('activityLogs', {
          userId: args.profileId,
          action: CLIENT_WITHDRAWAL_ACTIVITY_ACTION,
          entityType: 'DELIVERABLE',
          entityId: `${withdrawal.deliverableId}`,
          metadata: {
            resourceType: 'COMPANY',
            resourceId: `${args.companyId}`,
            kind: withdrawal.kind,
            status: withdrawal.status,
            documentIds: withdrawal.documentIds.map((documentId) => `${documentId}`),
            fullyWithdrawn: withdrawal.fullyWithdrawn,
          },
        })
      )
    }
  }
)
