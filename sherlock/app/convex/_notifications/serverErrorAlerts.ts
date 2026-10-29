// ============================================================================
// SERVER ERROR ALERTS — un 5xx despierta a un humano (A7)
// ============================================================================
// El plan del sitio pide que "funcional" se sostenga cuando nadie está
// haciendo clic: hoy un 500 en producción sólo deja un `$exception` en PostHog
// que alguien tiene que ir a buscar. Acá el 500 sale a buscar a alguien, por el
// MISMO canal que ya usa `teamAlerts`: campanita para todo perfil ADMIN y
// correo por Resend.
//
// LA UNIDAD ES LA VENTANA, NO LA EXCEPCIÓN. `dedupeKey` es
// `<plantilla de ruta>|<nombre del error>`: veinte 500 del mismo handler son un
// incidente. La fila que abre la ventana manda el correo de una vez; toda
// repetición dentro de los 15 minutos siguientes cuesta UNA escritura: sube
// `occurrences` en la fila y nada más — ni campanitas ni correo, porque un 5xx
// barato y repetido no puede volverse una tormenta de escrituras. La ventana
// siguiente hereda ese conteo en
// `suppressedRepeats` y lo dice en su correo, así que nada se pierde en
// silencio — sólo se agrupa.
//
// POR QUÉ EL CORREO SALE INLINE Y NO CALENDARIZADO. `teamAlerts` difiere su
// envío porque su unidad es una tanda que sigue creciendo; acá la ventana se
// abre YA cerrada al correo, así que no hay nada que esperar. El enqueue de
// Resend es transaccional dentro de esta misma mutación.
//
// LO QUE ESTE MÓDULO NO VE. El payload llega redactado desde el lado app
// (`src/lib/observability/server-error-alert.ts`) y acá se vuelve a acotar: no
// existe camino por el que un header, una cookie, un cuerpo, un stack o un
// path con ids llegue a una fila o a un correo.
//
// GEMELAS. `by_dedupeKey` no es un índice único y una transacción no ve la fila
// que otra está insertando: dos 5xx simultáneos pueden abrir dos ventanas. El
// correo se deduplica antes de enviar contra las filas hermanas que YA
// despacharon dentro de la ventana de gemelas (segundos). Campanitas duplicadas
// en ese caso son un riesgo conocido y aceptado; correos duplicados, no.
// ============================================================================

import { Effect, Schema } from 'effect'

import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { convexPromise, runConvex } from '../_helpers/effect'
import { sendServerErrorAlertEmail } from '../email'
import {
  SERVER_ERROR_ALERT_MAX_DIGEST_LENGTH,
  SERVER_ERROR_ALERT_MAX_MESSAGE_LENGTH,
  SERVER_ERROR_ALERT_MAX_NAME_LENGTH,
  SERVER_ERROR_ALERT_MAX_REQUEST_ID_LENGTH,
  SERVER_ERROR_ALERT_MAX_ROUTE_LENGTH,
  SERVER_ERROR_ALERT_WINDOW_MS,
  scrubAlertMessage,
} from './serverErrorAlertRedaction'
import { adminRecipientsEffect } from './teamAlerts'
export const SERVER_ERROR_ALERT_TWIN_WINDOW_MS = 5 * 1000
const SERVER_ERROR_ALERT_MAX_REPEATS = 1_000_000
// Techo global de ventanas NUEVAS por ventana. El debounce es por llave; esto
// es lo que impide que una caída de Convex — N handlers × 2 o 3 nombres de
// error — se convierta en decenas de correos y campanitas en un minuto.
export const SERVER_ERROR_ALERT_MAX_OPEN_WINDOWS = 5
const SERVER_ERROR_ALERT_SIBLING_SCAN = 8

export const SERVER_ERROR_ALERT_ENTITY = 'server_error_alert'
export const SERVER_ERROR_ALERT_LINK = '/admin'
export const OBSERVABILITY_PROBE_ACTION = 'OBSERVABILITY_PROBE_TRIGGERED'
const OBSERVABILITY_PROBE_ENTITY_TYPE = 'OBSERVABILITY_PROBE'

const UNKNOWN_ROUTE = '/unknown'
const DEFAULT_ERROR_NAME = 'ServerError'

export type ServerErrorAlertArgs = {
  route: string
  errorName: string
  status: number
  message: string
  requestId: string
  method?: string
  synthetic?: boolean
  /** 5xx que el proceso ya silenció en su propia ventana y no escribió. */
  repeats?: number
  /** Huella del mensaje tachado, para correlacionar con PostHog. */
  digest?: string
}

// LAS COTAS DE LA REDACCIÓN, OTRA VEZ, PERO COMO ESTRUCTURA. Son las mismas
// constantes que usa `serverErrorAlertRedaction` y las mismas que el lado app
// pone en el schema de su payload: acá cierran el segundo cinturón. `normalize`
// las cumple por construcción —todo pasa por `bounded`— así que un fallo del
// `make` no es entrada del cliente, es un `bounded` que se aflojó, y sube como
// defecto. La forma del literal (que la ruta empiece con `/`) NO se exige acá a
// propósito: `bounded` recorta a 200 y una ruta patológica podría perder su
// barra, y perder la FILA de un 5xx es peor que registrarla con una ruta fea.
const NormalizedServerErrorSchema = Schema.Struct({
  route: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(SERVER_ERROR_ALERT_MAX_ROUTE_LENGTH))
  ),
  errorName: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(SERVER_ERROR_ALERT_MAX_NAME_LENGTH))
  ),
  status: Schema.Number.pipe(Schema.check(Schema.isInt())),
  message: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(SERVER_ERROR_ALERT_MAX_MESSAGE_LENGTH))
  ),
  requestId: Schema.String.pipe(
    Schema.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(SERVER_ERROR_ALERT_MAX_REQUEST_ID_LENGTH)
    )
  ),
  synthetic: Schema.Boolean,
  repeats: Schema.Number.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(SERVER_ERROR_ALERT_MAX_REPEATS)
    )
  ),
  /** Huella del mensaje tachado: hexadecimal en minúscula, o vacía. */
  digest: Schema.String.pipe(
    Schema.check(
      Schema.isPattern(new RegExp(`^[a-f0-9]{0,${SERVER_ERROR_ALERT_MAX_DIGEST_LENGTH}}$`))
    )
  ),
  method: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z]{3,10}$/)))),
})

type NormalizedServerError = typeof NormalizedServerErrorSchema.Type

function bounded(value: string, max: number, fallback: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, max)
  return trimmed || fallback
}

function boundedRepeats(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return 1
  return Math.min(value, SERVER_ERROR_ALERT_MAX_REPEATS)
}

// Segundo cinturón sobre el del lado app: esta mutación es interna, pero la
// fila y el correo que produce son duraderos y la redacción no puede depender
// de que un solo módulo la haya hecho bien.
function normalize(args: ServerErrorAlertArgs): NormalizedServerError {
  const method = args.method?.trim().toUpperCase()
  return NormalizedServerErrorSchema.make({
    route: bounded(args.route, SERVER_ERROR_ALERT_MAX_ROUTE_LENGTH, UNKNOWN_ROUTE),
    errorName: bounded(args.errorName, SERVER_ERROR_ALERT_MAX_NAME_LENGTH, DEFAULT_ERROR_NAME),
    status: Number.isInteger(args.status) ? args.status : 500,
    message: bounded(
      scrubAlertMessage(args.message),
      SERVER_ERROR_ALERT_MAX_MESSAGE_LENGTH,
      DEFAULT_ERROR_NAME
    ),
    requestId: bounded(args.requestId, SERVER_ERROR_ALERT_MAX_REQUEST_ID_LENGTH, 'sin-request-id'),
    synthetic: args.synthetic === true,
    repeats: boundedRepeats(args.repeats),
    digest: (args.digest ?? '')
      .replace(/[^a-f0-9]/gi, '')
      .slice(0, SERVER_ERROR_ALERT_MAX_DIGEST_LENGTH),
    ...(method && /^[A-Z]{3,10}$/.test(method) ? { method } : {}),
  })
}

// La campanita SÓLO se escribe al abrir la ventana, así que su copy describe el
// primer 5xx del incidente. Lo que se repita después no la reescribe: vive en
// `occurrences` de la fila y sale en el correo de la ventana siguiente.
function copyFor(alert: {
  route: string
  errorName: string
  status: number
  message: string
  requestId: string
  synthetic: boolean
  suppressedRepeats: number
}): { title: string; message: string } {
  const prefix = alert.synthetic ? 'Probe sintético' : `Error ${alert.status}`
  const carried =
    alert.suppressedRepeats > 0
      ? ` Antes de este aviso se silenciaron ${alert.suppressedRepeats} repeticiones.`
      : ''

  return {
    title: `${prefix} en ${alert.route}`,
    message: `${alert.errorName}: ${alert.message} requestId ${alert.requestId}.${carried}`,
  }
}

const siblingsOf = Effect.fn('ServerErrorAlerts.siblings')(function* (
  ctx: MutationCtx,
  dedupeKey: string
) {
  return yield* convexPromise(() =>
    ctx.db
      .query('serverErrorAlerts')
      .withIndex('by_dedupeKey', (q) => q.eq('dedupeKey', dedupeKey))
      .order('desc')
      .take(SERVER_ERROR_ALERT_SIBLING_SCAN)
  )
})

// UNA SOLA ESCRITURA POR REPETICIÓN, y ninguna campanita. Un 5xx barato y
// público (un cuerpo malformado que revienta un handler) se repite miles de
// veces por minuto: patchear las hasta 25 campanitas en cada una convierte la
// tormenta de errores en una tormenta de escrituras a Convex, y `after()`
// mantiene vivo el isolate para pagarla. Las campanitas se escriben UNA vez,
// al abrir la ventana; lo que pase después vive en el contador de la fila y
// sale en el correo de la ventana siguiente (`suppressedRepeats`).
const appendToWindow = Effect.fn('ServerErrorAlerts.appendToWindow')(function* (
  ctx: MutationCtx,
  alert: Doc<'serverErrorAlerts'>,
  input: NormalizedServerError,
  now: number
) {
  yield* convexPromise(() =>
    ctx.db.patch(alert._id, {
      occurrences: alert.occurrences + input.repeats,
      lastEventAt: now,
      // El último 5xx es el que un humano va a mirar primero.
      requestId: input.requestId,
      message: input.message,
      status: input.status,
      ...(input.method ? { method: input.method } : {}),
    })
  )
})

// El probe lo atraviesa: es como el operador comprueba que el canal sirve, y si
// la tormenta lo silencia concluye que la alerta está rota.
const isFanoutThrottled = Effect.fn('ServerErrorAlerts.isFanoutThrottled')(function* (
  ctx: MutationCtx,
  input: NormalizedServerError,
  now: number
) {
  if (input.synthetic) return false
  const recent = yield* convexPromise(() =>
    ctx.db
      .query('serverErrorAlerts')
      .withIndex('by_openedAt', (q) => q.gt('openedAt', now - SERVER_ERROR_ALERT_WINDOW_MS))
      .take(SERVER_ERROR_ALERT_MAX_OPEN_WINDOWS)
  )
  return recent.length >= SERVER_ERROR_ALERT_MAX_OPEN_WINDOWS
})

const openWindow = Effect.fn('ServerErrorAlerts.openWindow')(function* (
  ctx: MutationCtx,
  input: NormalizedServerError,
  dedupeKey: string,
  suppressedRepeats: number,
  now: number
) {
  const throttled = yield* isFanoutThrottled(ctx, input, now)
  const admins = throttled ? [] : yield* adminRecipientsEffect(ctx)
  // Ni sin destinatarios ni pasado el techo hay `return` mudo: la fila es el
  // único registro de que producción se rompió. Se escribe igual y el ruido
  // queda en el log del deployment.
  if (throttled || admins.length === 0) {
    yield* Effect.logWarning(
      `[serverErrorAlerts] ${dedupeKey} ${
        throttled
          ? `pasa el techo de ${SERVER_ERROR_ALERT_MAX_OPEN_WINDOWS} ventanas nuevas`
          : 'sin destinatarios ADMIN'
      }: se registra la fila, pero no hay campanita ni correo`
    )
  }

  const alertId = yield* convexPromise(() =>
    ctx.db.insert('serverErrorAlerts', {
      dedupeKey,
      route: input.route,
      errorName: input.errorName,
      status: input.status,
      message: input.message,
      requestId: input.requestId,
      synthetic: input.synthetic,
      occurrences: input.repeats,
      suppressedRepeats,
      notificationIds: [],
      ...(input.digest ? { digest: input.digest } : {}),
      openedAt: now,
      lastEventAt: now,
      ...(input.method ? { method: input.method } : {}),
    })
  )

  if (admins.length === 0) return

  const copy = copyFor({ ...input, suppressedRepeats })
  const notificationIds: Array<Id<'notifications'>> = []
  for (const admin of admins) {
    notificationIds.push(
      yield* convexPromise(() =>
        ctx.db.insert('notifications', {
          userId: admin._id,
          type: 'system',
          title: copy.title,
          message: copy.message,
          link: SERVER_ERROR_ALERT_LINK,
          isRead: false,
          entityType: SERVER_ERROR_ALERT_ENTITY,
          entityId: alertId,
        })
      )
    )
  }
  yield* convexPromise(() => ctx.db.patch(alertId, { notificationIds }))

  const twinAlreadySent = (yield* siblingsOf(ctx, dedupeKey)).some(
    (row) =>
      row._id !== alertId &&
      row.emailedAt !== undefined &&
      Math.abs(row.openedAt - now) <= SERVER_ERROR_ALERT_TWIN_WINDOW_MS
  )
  if (twinAlreadySent) return

  yield* convexPromise(() => ctx.db.patch(alertId, { emailedAt: now }))
  for (const admin of admins) {
    yield* convexPromise(() =>
      sendServerErrorAlertEmail(ctx, {
        recipientProfileId: admin._id,
        link: SERVER_ERROR_ALERT_LINK,
        route: input.route,
        errorName: input.errorName,
        status: input.status,
        message: input.message,
        requestId: input.requestId,
        method: input.method,
        synthetic: input.synthetic,
        digest: input.digest || undefined,
        occurrences: input.repeats,
        suppressedRepeats,
      })
    )
  }
})

/**
 * El probe es una acción de OPERADOR: la dispara un bearer de servidor, no una
 * sesión admin, así que no hay `adminProfileId` que poner en `adminAuditLogs`.
 * Queda en `activityLogs` sin `userId`, que es donde el repo registra lo que
 * hace el servidor por su cuenta.
 */
const auditProbe = Effect.fn('ServerErrorAlerts.auditProbe')(function* (
  ctx: MutationCtx,
  input: NormalizedServerError,
  now: number
) {
  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      action: OBSERVABILITY_PROBE_ACTION,
      entityType: OBSERVABILITY_PROBE_ENTITY_TYPE,
      entityId: input.requestId,
      metadata: {
        resourceType: OBSERVABILITY_PROBE_ENTITY_TYPE,
        resourceId: input.requestId,
        details: {
          route: input.route,
          status: input.status,
          errorName: input.errorName,
          firedAt: now,
        },
      },
    })
  )
})

/**
 * Registra un 5xx del servidor y despierta al equipo si abre ventana nueva.
 * Idempotente por ventana: dentro de los 15 minutos siguientes sólo cuenta.
 */
const recordServerErrorEffect = Effect.fn('ServerErrorAlerts.record')(function* (
  ctx: MutationCtx,
  args: ServerErrorAlertArgs
) {
  const now = Date.now()
  const input = normalize(args)
  const dedupeKey = `${input.route}|${input.errorName}`

  if (input.synthetic) {
    yield* auditProbe(ctx, input, now)
  }

  const siblings = yield* siblingsOf(ctx, dedupeKey)
  const openWindowRow = siblings.find((row) => row.openedAt + SERVER_ERROR_ALERT_WINDOW_MS > now)
  if (openWindowRow) {
    yield* appendToWindow(ctx, openWindowRow, input, now)
    return
  }

  // Lo que la ventana anterior silenció viaja en el correo de esta, y sólo si
  // acaba de cerrarse: arrastrar el conteo de una de hace horas haría que el
  // correo dijera "se silenciaron N repeticiones" de algo que ya avisó ayer.
  // `- 1` cuando esa ventana sí mandó correo, porque su primera ocurrencia tuvo
  // aviso propio; entero cuando el techo global la dejó muda.
  const previous = siblings[0]
  const carries = previous && now - previous.lastEventAt <= SERVER_ERROR_ALERT_WINDOW_MS
  const suppressedRepeats = !carries
    ? 0
    : previous.emailedAt === undefined
      ? previous.occurrences
      : Math.max(0, previous.occurrences - 1)
  yield* openWindow(ctx, input, dedupeKey, suppressedRepeats, now)
})

export function recordServerError(ctx: MutationCtx, args: ServerErrorAlertArgs): Promise<void> {
  return runConvex(recordServerErrorEffect(ctx, args))
}
