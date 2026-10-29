// ============================================================================
// DELIVERABLES — el cliente se entera de que el equipo publicó algo en su sala
// ============================================================================
// La campanita no nombra el documento ni copia la nota del equipo: un dueño
// revocado leía ambos en la bandeja. El enlace sigue abriendo la versión. El
// correo es genérico (sin nombre de empresa ni de archivo) y sólo invita a
// entrar. Una notificación por versión publicada: `entityId` es la versión.
// ============================================================================

import { Effect } from 'effect'

import type { ClientWithdrawal } from '../_deliverables/clientWithdrawal'
import { DELIVERABLE_KIND_TEAM_LABELS } from '../_deliverables/model'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { normalizeCompanyName } from '../_helpers/companyName'
import { convexPromise, runConvex } from '../_helpers/effect'
import type { AppError } from '../_helpers/errors'
import { sendDeliverableWithdrawnEmail, sendProductEmail } from '../email'
import { adminRecipientsEffect } from './teamAlerts'

const DELIVERABLE_NOTIFICATION_TYPE = 'document_shared' as const
const DELIVERABLE_NOTIFICATION_ENTITY = 'document_version'
const DELIVERABLE_NOTIFICATION_PATH = '/my-company/documents'

// El aviso abre el documento que anuncia, en la versión que anuncia. La sala
// lee `?source=<documentId>:<versionId>` (`workspace-url-state.ts`); sin eso el
// cliente caía en la sala general y tenía que adivinar cuál archivo era.
function deliverableNotificationLink(args: {
  documentId: Id<'documents'>
  versionId: Id<'documentVersions'>
}): string {
  return `${DELIVERABLE_NOTIFICATION_PATH}?source=${args.documentId}:${args.versionId}`
}

export type DeliverableNotificationOutcome = 'created' | 'refreshed' | 'skipped'

export function deliverableNotificationCopy(_args: {
  name: string
  label?: string
  note?: string
}): { title: string; message: string } {
  return {
    title: 'Nuevo en tu sala',
    message: 'El equipo publicó un documento en tu sala. Ábrelo para revisarlo.',
  }
}

type NotifyDeliverablePublishedArgs = {
  company: Doc<'companies'>
  documentId: Id<'documents'>
  versionId: Id<'documentVersions'>
  name: string
  label?: string
  note?: string
}

const notifyDeliverablePublishedEffect = Effect.fn('Deliverables.notifyPublished')(function* (
  ctx: MutationCtx,
  args: NotifyDeliverablePublishedArgs
): Effect.fn.Return<DeliverableNotificationOutcome, AppError> {
  const copy = deliverableNotificationCopy(args)
  const link = deliverableNotificationLink(args)
  const existing = yield* convexPromise(() =>
    ctx.db
      .query('notifications')
      .withIndex('by_userId_type', (q) =>
        q.eq('userId', args.company.ownerId).eq('type', DELIVERABLE_NOTIFICATION_TYPE)
      )
      .filter((q) => q.eq(q.field('entityId'), args.versionId))
      .first()
  )

  // La dedupe es por versión, y la versión no cambia cuando el sello mueve el
  // slot después de un push que salió sin `--slot`: el aviso viejo decía «El
  // equipo publicó…» sin la nota y ya estaba leído. No se abre otra fila: la
  // de esa versión se actualiza en sitio con el texto de hoy y vuelve a no
  // leída, así la campanita suena otra vez. El correo no se repite: el de esta
  // versión ya salió. Con el mismo texto y sin leer no hay nada que tocar.
  if (existing) {
    const unchanged =
      existing.title === copy.title &&
      existing.message === copy.message &&
      existing.isRead === false
    if (unchanged) return 'skipped'
    yield* convexPromise(() =>
      ctx.db.patch(existing._id, { title: copy.title, message: copy.message, link, isRead: false })
    )
    return 'refreshed'
  }

  yield* convexPromise(() =>
    ctx.db.insert('notifications', {
      userId: args.company.ownerId,
      type: DELIVERABLE_NOTIFICATION_TYPE,
      title: copy.title,
      message: copy.message,
      link,
      isRead: false,
      entityType: DELIVERABLE_NOTIFICATION_ENTITY,
      entityId: args.versionId,
    })
  )

  yield* convexPromise(() =>
    sendProductEmail(ctx, {
      recipientProfileId: args.company.ownerId,
      event: 'deliverable_published',
    })
  )
  return 'created'
})

export function notifyDeliverablePublished(
  ctx: MutationCtx,
  args: NotifyDeliverablePublishedArgs
): Promise<DeliverableNotificationOutcome> {
  return runConvex(notifyDeliverablePublishedEffect(ctx, args))
}

// ============================================================================
// RETIRO DEL CLIENTE — el equipo se entera de que le quitaron una entrega
// ============================================================================
// Mismo carril interno que el resto de los avisos del equipo: campanita para
// todo perfil ADMIN activo (`adminRecipientsEffect`) y correo por
// `convex/email.ts`, fail-open. No hay canal nuevo ni tabla nueva.
//
// El aviso nombra las tres cosas que el equipo necesita para actuar: qué
// empresa, qué documento y qué entregable se quedó sin respaldo. Va inline en
// la mutación del cliente y no calendarizado como el de soporte: acá no hay
// fila compartida que dos transacciones puedan pelearse — cada campanita es un
// insert nuevo — y el correo ya es fail-open por construcción.
// ============================================================================

const WITHDRAWN_NOTIFICATION_ENTITY = 'deliverable'
const ADMIN_COMPANY_ROOM_PATH = '/admin/companies'

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`
}

function deliverableWithdrawnCopy(args: {
  companyName: string
  documentNames: readonly string[]
  withdrawals: readonly Pick<ClientWithdrawal, 'kind' | 'fullyWithdrawn'>[]
}): { title: string; message: string } {
  const documents = listOf(args.documentNames.map((name) => `«${name}»`))
  const labelOf = (withdrawal: Pick<ClientWithdrawal, 'kind'>) =>
    DELIVERABLE_KIND_TEAM_LABELS[withdrawal.kind]
  const kinds = listOf(args.withdrawals.map(labelOf))
  const emptied = args.withdrawals.filter((withdrawal) => withdrawal.fullyWithdrawn)

  // Con un solo entregable la frase no repite su nombre, que acaba de aparecer
  // en la oración anterior. Nombrarlo solo sirve cuando el lote tocó varios y
  // no todos quedaron vacíos.
  const single = args.withdrawals.length === 1
  const tail =
    emptied.length === 0
      ? single
        ? 'El entregable conserva otra entrega vigente.'
        : 'Cada entregable conserva otra entrega vigente.'
      : emptied.length === args.withdrawals.length
        ? single
          ? 'El entregable se quedó sin entrega vigente.'
          : 'Esos entregables se quedaron sin entrega vigente.'
        : emptied.length === 1
          ? `${listOf(emptied.map(labelOf))} se quedó sin entrega vigente.`
          : `${listOf(emptied.map(labelOf))} se quedaron sin entrega vigente.`

  return {
    title: `Entrega retirada: ${args.companyName}`,
    message: `${args.companyName} quitó ${documents} de su sala. Era la entrega de ${kinds}. ${tail}`,
  }
}

// El nombre del documento también lo escribe el cliente y sale al mismo texto
// plano del correo. No hay «nombre inválido» que rechazar acá, el documento ya
// existe: se limpia para que ocupe una sola línea y un largo razonable.
const DOCUMENT_NAME_MAX_LENGTH = 160

function cleanDocumentName(name: string): string {
  const clean = name
    .normalize('NFKC')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.slice(0, DOCUMENT_NAME_MAX_LENGTH) || 'Documento sin nombre'
}

type NotifyDeliverableWithdrawnArgs = {
  company: Doc<'companies'>
  documentNames: readonly string[]
  withdrawals: readonly ClientWithdrawal[]
}

const notifyTeamDeliverableWithdrawnEffect = Effect.fn('Deliverables.notifyWithdrawn')(function* (
  ctx: MutationCtx,
  args: NotifyDeliverableWithdrawnArgs
) {
  if (args.withdrawals.length === 0) return

  // El mismo normalizador que el resto del carril interno
  // (`teamAlerts.ts`, `_support/teamEmail.ts`, `_admin/overview.ts`). El nombre
  // lo escribe el cliente y de acá sale al asunto y al texto plano del correo,
  // que no escapan nada: un `\r\n` en el nombre falsearía una segunda alerta.
  const companyName = normalizeCompanyName(args.company.name) ?? 'Empresa sin identificar'
  const documentNames = args.documentNames.map(cleanDocumentName)
  const copy = deliverableWithdrawnCopy({ ...args, documentNames, companyName })
  const link = `${ADMIN_COMPANY_ROOM_PATH}/${args.company._id}/documents`

  const recipients = yield* adminRecipientsEffect(ctx)
  // Sin destinatarios el retiro no se pierde: la fila de auditoría ya quedó
  // escrita y el log del deployment dice por qué no sonó nada.
  if (recipients.length === 0) {
    yield* Effect.logWarning(
      '[DELIVERABLES] Retiro del cliente sin destinatarios ADMIN: queda la fila de auditoría, no hay campanita ni correo.'
    )
    return
  }

  for (const recipient of recipients) {
    yield* convexPromise(() =>
      ctx.db.insert('notifications', {
        userId: recipient._id,
        type: 'system',
        title: copy.title,
        message: copy.message,
        link,
        isRead: false,
        entityType: WITHDRAWN_NOTIFICATION_ENTITY,
        entityId: `${args.withdrawals[0].deliverableId}`,
      })
    )
    yield* convexPromise(() =>
      sendDeliverableWithdrawnEmail(ctx, {
        recipientProfileId: recipient._id,
        companyName,
        summary: copy.message,
        documentNames,
        link,
      })
    )
  }
})

/**
 * Avisa al equipo que el cliente quitó de su sala un documento que respaldaba
 * una entrega. Se llama DESPUÉS de archivar: el hecho ya ocurrió y el aviso no
 * puede revertirlo.
 */
export { notifyTeamDeliverableWithdrawnEffect }
