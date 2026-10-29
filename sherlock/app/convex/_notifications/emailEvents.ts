// ============================================================================
// EMAIL EVENTS — cuando un correo del equipo no llega, el equipo se entera
// ============================================================================
// Resend firma cada evento y `convex/http.ts` lo entrega al componente, que
// avanza `emails.status` y llama a `_recordEmailFailure`. Acá sólo importan
// los tres tipos que significan "no llegó": el resto se ignora sin escribir.
// Idempotente: Resend reintenta y el mismo evento no abre dos campanitas.
// ============================================================================

import { Effect } from 'effect'

import type { EmailEvent, EmailId } from '@convex-dev/resend'
import type { MutationCtx } from '../_generated/server'
import { convexPromise, runConvex } from '../_helpers/effect'
import { adminRecipientsEffect } from './teamAlerts'

export const EMAIL_FAILURE_ENTITY = 'email_failure'
export const EMAIL_FAILURE_LINK = '/admin'

type FailureType = 'email.bounced' | 'email.complained' | 'email.failed'
type FailureEvent = Extract<EmailEvent, { type: FailureType }>

const FAILURE_COPY: Record<
  FailureType,
  (recipient: string, subject: string, detail: string) => { title: string; message: string }
> = {
  'email.bounced': (recipient, subject, detail) => ({
    title: `Rebotó un correo a ${recipient}`,
    message: `"${subject}" no llegó a ${recipient}${detail ? ` (${detail})` : ''}. Revisa el buzón o avísale por otra vía.`,
  }),
  'email.complained': (recipient, subject) => ({
    title: `${recipient} marcó un correo como spam`,
    message: `"${subject}" fue reportado como no deseado por ${recipient}. Los próximos avisos pueden no llegarle.`,
  }),
  'email.failed': (recipient, subject, detail) => ({
    title: `Falló el envío a ${recipient}`,
    message: `Resend no pudo enviar "${subject}" a ${recipient}${detail ? ` (${detail})` : ''}.`,
  }),
}

function isFailure(event: EmailEvent): event is FailureEvent {
  return event.type in FAILURE_COPY
}

function recipientsOf(to: string | string[]): string {
  return (Array.isArray(to) ? to : [to]).join(', ')
}

function detailOf(event: FailureEvent): string {
  if (event.type === 'email.bounced') return event.data.bounce?.message ?? ''
  if (event.type === 'email.failed') return event.data.failed?.reason ?? ''
  return ''
}

const recordEmailFailureEffect = Effect.fn('EmailEvents.recordFailure')(function* (
  ctx: MutationCtx,
  args: { id: EmailId; event: EmailEvent }
) {
  if (!isFailure(args.event)) return

  const event = args.event
  const entityId = `${args.id}:${event.type}`
  const copy = FAILURE_COPY[event.type](
    recipientsOf(event.data.to),
    event.data.subject,
    detailOf(event)
  )

  for (const admin of yield* adminRecipientsEffect(ctx)) {
    const existing = yield* convexPromise(() =>
      ctx.db
        .query('notifications')
        .withIndex('by_userId_type', (q) => q.eq('userId', admin._id).eq('type', 'system'))
        .filter((q) => q.eq(q.field('entityId'), entityId))
        .first()
    )
    if (existing) continue

    yield* convexPromise(() =>
      ctx.db.insert('notifications', {
        userId: admin._id,
        type: 'system',
        title: copy.title,
        message: copy.message,
        link: EMAIL_FAILURE_LINK,
        isRead: false,
        entityType: EMAIL_FAILURE_ENTITY,
        entityId,
      })
    )
  }
})

export function recordEmailFailure(
  ctx: MutationCtx,
  args: { id: EmailId; event: EmailEvent }
): Promise<void> {
  return runConvex(recordEmailFailureEffect(ctx, args))
}
