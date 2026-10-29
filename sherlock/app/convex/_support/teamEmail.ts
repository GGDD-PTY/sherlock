// ============================================================================
// SOPORTE — el equipo se entera de que el cliente escribió
// ============================================================================
// «Habla con el equipo» guardaba el mensaje y encendía `adminUnread`, y nada
// más: el aviso solo existía dentro de /admin/support, o sea para quien ya
// estaba mirando. Este módulo cuelga ese mensaje del MISMO carril de correo que
// ya usan las subidas de documentos y el alta de un espacio: destinatarios =
// perfiles ADMIN activos leídos de la base (`adminRecipientsEffect`), envío por
// `convex/email.ts`, sin variable de entorno nueva y sin lista de correos
// escrita a mano.
//
// TRES REGLAS, Y LAS TRES SON DEL CARRIL QUE SE COPIA:
//
// 1. NO VA DENTRO DE LA TRANSACCIÓN DEL CLIENTE. La mutation del cliente solo
//    CALENDARIZA; el correo se arma y se encola en su propia mutación. Un fallo
//    del aviso no puede costarle al cliente su mensaje, y por eso
//    `scheduleSupportMessageEmail` además se traga cualquier fallo propio.
// 2. LA RÁFAGA ES UN CORREO. El cliente escribe dos o tres mensajes seguidos:
//    cada uno cancela el envío en vuelo y lo reprograma, igual que el debounce
//    de `teamAlerts`. `adminEmailPendingSince` ancla el techo para que un goteo
//    no posponga el aviso para siempre.
// 3. IDEMPOTENTE POR SECUENCIA. `adminEmailThroughSequence` dice hasta qué
//    mensaje ya se avisó y se escribe ANTES de encolar, así que un job
//    reintentado encuentra el hilo al día y no manda un segundo correo.
//
// Y una regla propia, de privacidad: el CUERPO del mensaje no sale del
// producto. El correo nombra la empresa, cuenta cuántos mensajes hay y lleva el
// enlace al hilo. El texto se lee donde ya está la autorización para leerlo.
// ============================================================================

import { Effect } from 'effect'

import { internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { normalizeCompanyName } from '../_helpers/companyName'
import { convexPromise, runConvex } from '../_helpers/effect'
import { adminRecipientsEffect } from '../_notifications/teamAlerts'
import { sendSupportMessageEmail } from '../email'

export const SUPPORT_TEAM_EMAIL_DEBOUNCE_MS = 60 * 1000
// Techo del debounce. El cliente puede mandar 12 mensajes cada 5 minutos, o sea
// uno cada 25 segundos: sin techo, ese goteo reprograma el envío para siempre y
// el equipo no se entera nunca.
const SUPPORT_TEAM_EMAIL_MAX_DELAY_MS = 10 * 60 * 1000
// Cota de los mensajes DEL CLIENTE que se cuentan para el correo. El filtro por
// autor va en la query, no después del `.take()`: filtrar después convierte la
// cota en un silencio — un hilo donde el equipo escribió 25 veces desde el
// último aviso llenaba la tanda con mensajes ADMIN, el conteo del cliente daba
// cero y el mensaje nuevo se quedaba sin correo con el marcador ya adelantado.
const PENDING_CLIENT_MESSAGE_SCAN_MAX = 25

const UNIDENTIFIED_COMPANY = 'Empresa sin identificar'
const ADMIN_SUPPORT_PATH = '/admin/support'

/** El debounce, recortado para que el aviso nunca pase del techo de la ventana. */
function emailDelayFor(pendingSince: number, now: number): number {
  const remaining = pendingSince + SUPPORT_TEAM_EMAIL_MAX_DELAY_MS - now
  return Math.max(0, Math.min(SUPPORT_TEAM_EMAIL_DEBOUNCE_MS, remaining))
}

// Cancelar un job que el backend ya corrió o ya recogió no es un error de este
// módulo, y no puede impedir que se programe el envío nuevo.
const cancelQuietly = Effect.fn('SupportTeamEmail.cancel')(function* (
  ctx: MutationCtx,
  jobId: Id<'_scheduled_functions'>
) {
  yield* convexPromise(() => ctx.scheduler.cancel(jobId)).pipe(Effect.catchCause(() => Effect.void))
})

const scheduleSupportMessageEmailEffect = Effect.fn('SupportTeamEmail.schedule')(function* (
  ctx: MutationCtx,
  args: { threadId: Id<'supportThreads'>; now: number }
) {
  const thread = yield* convexPromise(() => ctx.db.get(args.threadId))
  if (!thread || thread.scope.kind !== 'COMPANY') return
  if ((thread.adminEmailThroughSequence ?? 0) >= thread.lastSequence) return

  const pendingSince = thread.adminEmailJobId
    ? (thread.adminEmailPendingSince ?? args.now)
    : args.now
  if (thread.adminEmailJobId) {
    yield* cancelQuietly(ctx, thread.adminEmailJobId)
  }

  const adminEmailJobId = yield* convexPromise(() =>
    ctx.scheduler.runAfter(
      emailDelayFor(pendingSince, args.now),
      internal.notifications._dispatchSupportMessageEmail,
      { threadId: thread._id }
    )
  )
  yield* convexPromise(() =>
    ctx.db.patch(thread._id, { adminEmailJobId, adminEmailPendingSince: pendingSince })
  )
})

/**
 * Calendariza el aviso del equipo después de un mensaje del cliente. Lo llama
 * `convex/support.ts` dentro de la mutation del cliente, así que se traga
 * cualquier fallo propio: el mensaje ya está guardado y nada de este carril
 * puede revertirlo.
 */
export function scheduleSupportMessageEmail(
  ctx: MutationCtx,
  args: { threadId: Id<'supportThreads'>; now: number }
): Promise<void> {
  return runConvex(
    scheduleSupportMessageEmailEffect(ctx, args).pipe(
      Effect.asVoid,
      Effect.catchCause(() =>
        Effect.logWarning(
          '[SUPPORT] No se pudo calendarizar el aviso del equipo; el mensaje del cliente ya está guardado.'
        )
      )
    )
  )
}

const dispatchSupportMessageEmailEffect = Effect.fn('SupportTeamEmail.dispatch')(function* (
  ctx: MutationCtx,
  args: { threadId: Id<'supportThreads'> }
) {
  const thread = yield* convexPromise(() => ctx.db.get(args.threadId))
  if (!thread || thread.scope.kind !== 'COMPANY') return
  const companyId = thread.scope.companyId
  const announcedThrough = thread.adminEmailThroughSequence ?? 0
  if (announcedThrough >= thread.lastSequence) return

  // El marcador ANTES de encolar: un reintento del job encuentra el hilo al día
  // y se va sin mandar nada.
  yield* convexPromise(() =>
    ctx.db.patch(thread._id, {
      adminEmailThroughSequence: thread.lastSequence,
      adminEmailDispatchedAt: Date.now(),
      adminEmailJobId: undefined,
      adminEmailPendingSince: undefined,
    })
  )

  // La respuesta del admin también mueve `lastSequence`. Se cuentan los
  // mensajes DEL CLIENTE que quedaron sin avisar: si no hay ninguno, el equipo
  // no recibe un correo por su propia respuesta.
  const pending = yield* convexPromise(() =>
    ctx.db
      .query('supportMessages')
      .withIndex('by_thread_sequence', (q) =>
        q.eq('threadId', thread._id).gt('sequence', announcedThrough)
      )
      .filter((q) => q.eq(q.field('author.kind'), 'COMPANY'))
      .take(PENDING_CLIENT_MESSAGE_SCAN_MAX)
  )
  const messageCount = pending.length
  if (messageCount === 0) return

  const company = yield* convexPromise(() => ctx.db.get(companyId))
  const companyName = normalizeCompanyName(company?.name) ?? UNIDENTIFIED_COMPANY
  const link = `${ADMIN_SUPPORT_PATH}?thread=${thread._id}`

  const recipients = yield* adminRecipientsEffect(ctx)
  for (const recipient of recipients) {
    yield* convexPromise(() =>
      sendSupportMessageEmail(ctx, {
        recipientProfileId: recipient._id,
        companyName,
        messageCount,
        link,
      })
    )
  }
})

/**
 * Manda el aviso del hilo de soporte. Corre en su propia mutación interna,
 * fuera de la transacción del cliente, y es idempotente por
 * `adminEmailThroughSequence`.
 */
export function dispatchSupportMessageEmail(
  ctx: MutationCtx,
  args: { threadId: Id<'supportThreads'> }
): Promise<void> {
  return runConvex(dispatchSupportMessageEmailEffect(ctx, args))
}
