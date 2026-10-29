// ============================================================================
// ENTREGA A MANO — el acto que mueve el rail del cliente
// ============================================================================
// Dos carriles llevan el mismo entregable a la sala: `bun run vdr:push --slot`
// (deploy key, sin sesión) y el botón «Marcar como entrega» del panel del
// equipo (sesión ADMIN, sobre un documento que ya está subido). Lo que el
// cliente ve tiene que ser idéntico en los dos, así que el avance del slot vive
// UNA vez acá y no una copia por llamador.
//
// Quien entrega ES la persona: produjo el entregable en Mycroft y lo vetó a
// mano antes de publicarlo. Su acto colapsa producción, revisión, aprobación y
// entrega, así que el slot termina en DELIVERED — pero recorriendo los saltos
// que `manualDeliverySteps` deriva de la máquina, nunca inventando uno.
// ============================================================================

import { Effect, Schema } from 'effect'

import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { logAdminAction } from '../_helpers/auditLog'
import { convexPromise, runConvex } from '../_helpers/effect'
import { invalidState, validationFailed } from '../_helpers/errors'
import { type DeliverableKind, type DeliverableRenditionFormat, manualDeliverySteps } from './model'

// La nota es el sello de la versión y el texto que el cliente lee en la
// campanita. Se acota UNA vez, en la frontera, para los tres carriles que la
// reciben (el botón del panel, el push con bytes y el sello sobre la versión
// vigente); aguas abajo nadie la vuelve a validar.
const DELIVERY_NOTE_MAX_LENGTH = 500

// La cota se declara una vez y el mensaje del cliente la cita: el número que se
// valida y el que se le dice a la persona no pueden separarse.
const DeliveryNoteSchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(DELIVERY_NOTE_MAX_LENGTH))
)

const isDeliveryNote = Schema.is(DeliveryNoteSchema)

export function normalizeDeliveryNote(note: string): string {
  const trimmed = note.trim()
  if (!isDeliveryNote(trimmed)) {
    throw validationFailed(
      `La nota de la entrega va entre 1 y ${DELIVERY_NOTE_MAX_LENGTH} caracteres.`,
      'note'
    )
  }
  return trimmed
}

// El rail del cliente promete un documento que se puede abrir: un slot
// "Entregado" sin rendition citable es una promesa vacía. Solo los tres
// formatos que el oficio produce hoy tienen dónde aterrizar — el HTML nativo no
// viaja por estos carriles (los dos mueven archivos, no páginas).
const RENDITION_FORMAT_BY_MIME: Record<string, DeliverableRenditionFormat> = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
}

export function renditionFormatForMimeType(
  contentType: string | undefined
): DeliverableRenditionFormat | undefined {
  return contentType ? RENDITION_FORMAT_BY_MIME[contentType] : undefined
}

// El corte es por DOCUMENTO, no por versión: el slot que ya cita este
// documento lo entregó bajo su kind, y una v2 del mismo archivo no gana un
// segundo slot. Sin este corte, entregar el mismo xlsx como MODEL y después
// como TEASER dejaba el TEASER "Entregado" con el archivo del modelo mientras
// la campanita — deduplicada por versión — nunca volvía a sonar. Los tres
// carriles que mueven el rail (el botón del panel, el push con bytes y el
// sello sobre la versión vigente) pasan por acá antes de avanzar el slot.
// Acotado por diseño (un slot por kind): los ≤ 8 del cliente entran en una
// lectura.
const assertNotDeliveredAsOtherKindEffect = Effect.fn('Deliverables.assertNotDeliveredAsOtherKind')(
  function* (
    ctx: MutationCtx,
    input: { companyId: Id<'companies'>; kind: DeliverableKind; documentId: Id<'documents'> }
  ) {
    const slots = yield* convexPromise(() =>
      ctx.db
        .query('deliverables')
        .withIndex('by_companyId', (q) => q.eq('companyId', input.companyId))
        .collect()
    )
    const deliveredAsOtherKind = slots.find(
      (row) =>
        row.kind !== input.kind &&
        row.status === 'DELIVERED' &&
        (row.renditions ?? []).some((rendition) => rendition.documentId === input.documentId)
    )
    if (deliveredAsOtherKind) {
      yield* Effect.fail(
        invalidState(
          `Este documento ya se entregó como ${deliveredAsOtherKind.kind}: para entregarlo como ` +
            `${input.kind} sube un documento distinto.`,
          deliveredAsOtherKind.status
        )
      )
    }
  }
)

export function assertNotDeliveredAsOtherKind(
  ctx: MutationCtx,
  input: { companyId: Id<'companies'>; kind: DeliverableKind; documentId: Id<'documents'> }
): Promise<void> {
  return runConvex(assertNotDeliveredAsOtherKindEffect(ctx, input))
}

type AdvanceDeliverableSlotInput = {
  companyId: Id<'companies'>
  kind: DeliverableKind
  documentId: Id<'documents'>
  format: DeliverableRenditionFormat
  actor: { profileId: Id<'profiles'>; email: string }
  now: number
  // Quién movió el rail y por qué, tal como lo lee un auditor: el carril de
  // operador firma con su actor sintético, la UI del equipo con la persona.
  auditActor: string
  auditNotes: string
}

const advanceDeliverableSlotEffect = Effect.fn('Deliverables.advanceSlot')(function* (
  ctx: MutationCtx,
  input: AdvanceDeliverableSlotInput
) {
  const existing = yield* convexPromise(() =>
    ctx.db
      .query('deliverables')
      .withIndex('by_company_kind', (q) =>
        q.eq('companyId', input.companyId).eq('kind', input.kind)
      )
      .first()
  )

  const from = existing?.status ?? 'REQUESTED'
  const steps = manualDeliverySteps(from)
  if (!steps || steps.length === 0) {
    return yield* Effect.fail(
      invalidState(`El slot ${input.kind} no tiene camino de entrega desde ${from}.`, from)
    )
  }
  const to = steps[steps.length - 1]

  const deliverableId =
    existing?._id ??
    (yield* convexPromise(() =>
      ctx.db.insert('deliverables', {
        companyId: input.companyId,
        kind: input.kind,
        status: from,
        requestedByProfileId: input.actor.profileId,
        updatedAt: input.now,
      })
    ))

  yield* convexPromise(() =>
    ctx.db.patch(deliverableId, {
      status: to,
      producedBy: 'TEAM',
      renditions: [
        ...(existing?.renditions ?? []).filter((rendition) => rendition.format !== input.format),
        { format: input.format, documentId: input.documentId },
      ],
      reviewedByProfileId: input.actor.profileId,
      approvedAt: input.now,
      deliveredAt: input.now,
      updatedAt: input.now,
    })
  )

  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: input.actor.profileId,
      adminEmail: input.actor.email,
      action: 'DELIVERABLE_TRANSITION',
      targetType: 'DELIVERABLE',
      targetId: `${deliverableId}`,
      previousValue: { status: from },
      newValue: {
        actor: input.auditActor,
        status: to,
        // El camino completo queda escrito: que un solo acto haya recorrido la
        // revisión y la aprobación es justo lo que un auditor tiene que ver.
        path: [from, ...steps].join(' → '),
        kind: input.kind,
        documentId: `${input.documentId}`,
        format: input.format,
      },
      notes: input.auditNotes,
    })
  )

  return { deliverableId, kind: input.kind, from, to }
})

export function advanceDeliverableSlot(ctx: MutationCtx, input: AdvanceDeliverableSlotInput) {
  return runConvex(advanceDeliverableSlotEffect(ctx, input))
}
