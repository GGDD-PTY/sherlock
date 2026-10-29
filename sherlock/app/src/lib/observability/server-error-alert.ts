// ============================================================================
// ALERTA DE 5xx AL EQUIPO — el segundo canal de `captureServerException`
// ============================================================================
// PostHog ARCHIVA el `$exception` para que alguien lo busque. Esto DESPIERTA a
// alguien: una campanita para todo perfil ADMIN y un correo por el mismo carril
// de Resend que ya usa `teamAlerts`. El dedupe vive en Convex — una ventana de
// 15 minutos por (plantilla de ruta, nombre del error) — para que una caída no
// vacíe la cuota diaria de Resend.
//
// TRES REGLAS QUE NO SE NEGOCIAN:
//
// 1. NUNCA BLOQUEA. `reportServerErrorToTeam` es síncrona y devuelve void: el
//    trabajo se agenda con `after()`, que mantiene viva la función serverless
//    hasta que la promesa se asienta SIN retrasar la respuesta. Fuera de una
//    request (instrumentation, tests) `after()` tira y la entrega queda
//    anotada para `settlePendingServerErrorAlerts()`. Ningún camino de
//    `captureServerException` la awaitea, y hay un candado de arquitectura que
//    lo fija.
//
// 2. NUNCA TIRA. Todo va envuelto: una alerta rota no puede convertir un 500
//    en dos, ni cambiar el cuerpo que el cliente ya iba a recibir.
//
// 2b. SÓLO PRODUCCIÓN DE VERDAD (`VERCEL_ENV` y `NODE_ENV` en `production`).
//    Un 500 de preview o de un `next dev` apuntado al deployment equivocado
//    le mandaría correo al equipo de verdad. Fuera de ahí el 5xx sigue yendo
//    a PostHog igual; lo único que no ocurre es Convex y el correo.
//
// 3. NUNCA VIAJA EL REQUEST. Sale exactamente lo que deja pasar
//    `buildServerErrorAlertPayload`: plantilla de ruta, método, status, nombre
//    del error, 120 caracteres de mensaje tachado y su huella. Headers,
//    cookies, cuerpo, stack y query string no tienen camino hasta acá. Y como
//    `apiError()` recibe la ruta como string literal de cada handler, los
//    segmentos que parezcan un identificador se tachan igual: un descuido en un
//    call site no puede filtrar el id de una sala ni de un documento.
//
// 3b. EL PAYLOAD ES UN SCHEMA CON LAS COTAS DE LA REDACCIÓN ADENTRO. La regla 3
//    era una promesa del comentario: la firmaba `buildServerErrorAlertPayload` y
//    nada la verificaba. Ahora las cotas —200 de ruta, 120 de mensaje, el
//    patrón del nombre y del requestId, el rango 5xx— son `Schema.check` y el
//    payload se construye con `make`: una redacción que deje pasar algo más
//    largo o con otra forma no llega a Convex, se cae acá.
// ============================================================================

import { after } from 'next/server'
import { Effect, Schema } from 'effect'

import { ExternalServiceError } from '@/lib/effect/errors'
import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'
import {
  SERVER_ERROR_ALERT_MAX_MESSAGE_LENGTH,
  SERVER_ERROR_ALERT_MAX_NAME_LENGTH,
  SERVER_ERROR_ALERT_MAX_REQUEST_ID_LENGTH,
  SERVER_ERROR_ALERT_MAX_ROUTE_LENGTH,
  SERVER_ERROR_ALERT_WINDOW_MS,
  alertMessageDigest,
  cappedAlertText,
  scrubAlertMessage,
} from '@/../convex/_notifications/serverErrorAlertRedaction'

export const SERVER_ERROR_ALERT_REDACTED_SEGMENT = ':id'
export const SERVER_ERROR_ALERT_UNKNOWN_ROUTE = '/unknown'
const DEFAULT_ERROR_NAME = 'ServerError'
// La entrega corre agendada DESPUÉS de la respuesta, así que ningún cliente
// paga este tiempo — pero sin cota una mutación colgada mantiene viva la
// función serverless hasta que la plataforma la corta. `externalCall` la acota.
const ALERT_DELIVERY_TIMEOUT_MS = 3_000

/**
 * El nombre del fallo REAL, no el del sobre. `externalCall` envuelve la causa en
 * `ExternalServiceError`; loguear ese nombre borraría la única señal útil que se
 * deja salir. Sigue saliendo sólo el nombre: el mensaje de Convex puede traer
 * detalles del deployment.
 */
function alertFailureName(error: unknown): string {
  const root = error instanceof ExternalServiceError ? error.cause : error
  return root instanceof Error ? root.name : 'UnknownError'
}

export type ServerErrorAlertInput = {
  error?: unknown
  requestId: string
  status: number
  route?: string
  method?: string
  synthetic?: boolean
}

// Cada campo lleva la cota que la redacción promete. Son las mismas constantes
// que usa `serverErrorAlertRedaction`, no una segunda copia de los números.
const alertPayloadFields = {
  route: Schema.String.pipe(
    Schema.check(Schema.isMaxLength(SERVER_ERROR_ALERT_MAX_ROUTE_LENGTH), Schema.isStartsWith('/'))
  ),
  errorName: Schema.String.pipe(
    Schema.check(
      Schema.isPattern(/^[A-Za-z0-9_.$-]+$/),
      Schema.isMaxLength(SERVER_ERROR_ALERT_MAX_NAME_LENGTH)
    )
  ),
  status: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(500), Schema.isLessThanOrEqualTo(599))
  ),
  message: Schema.String.pipe(
    Schema.check(Schema.isMaxLength(SERVER_ERROR_ALERT_MAX_MESSAGE_LENGTH))
  ),
  /** Huella del mensaje tachado: correlaciona el aviso con PostHog. */
  digest: Schema.String,
  requestId: Schema.String.pipe(
    Schema.check(
      Schema.isPattern(/^[A-Za-z0-9_.:-]+$/),
      Schema.isMaxLength(SERVER_ERROR_ALERT_MAX_REQUEST_ID_LENGTH)
    )
  ),
  method: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z]{3,10}$/)))),
  synthetic: Schema.Boolean,
}

const ServerErrorAlertPayloadSchema = Schema.Struct(alertPayloadFields)

export type ServerErrorAlertPayload = typeof ServerErrorAlertPayloadSchema.Type

/** Lo que de verdad sale del proceso: el payload más lo que se silenció antes. */
const ServerErrorAlertDeliverySchema = Schema.Struct({
  ...alertPayloadFields,
  repeats: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
})

export type ServerErrorAlertDelivery = typeof ServerErrorAlertDeliverySchema.Type

// Un segmento de plantilla (`[id]`, `[...slug]`, `:id`) es texto fijo del
// código: se deja tal cual para que la llave de dedupe sea legible.
function isTemplateSegment(segment: string): boolean {
  return segment.startsWith('[') || segment.startsWith(':')
}

// Heurística deliberadamente generosa: sobre-tachar una ruta sólo empeora la
// legibilidad del aviso; sub-tachar filtra un id de sala a un correo.
function looksLikeIdentifier(segment: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true
  if (/^\d{4,}$/.test(segment)) return true
  // Ids de Convex, storage ids y tokens base64url: opacos, largos y con dígito.
  return segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment) && /\d/.test(segment)
}

function redactAlertRoute(route: string | undefined): string {
  const pathname = route?.split('?')[0]?.split('#')[0]?.trim()
  if (!pathname || !pathname.startsWith('/')) return SERVER_ERROR_ALERT_UNKNOWN_ROUTE

  const redacted = pathname
    .split('/')
    .map((segment) =>
      segment && !isTemplateSegment(segment) && looksLikeIdentifier(segment)
        ? SERVER_ERROR_ALERT_REDACTED_SEGMENT
        : segment
    )
    .join('/')

  return cappedAlertText(redacted, SERVER_ERROR_ALERT_MAX_ROUTE_LENGTH)
}

function errorNameOf(error: unknown): string {
  const raw = error instanceof Error ? error.name : DEFAULT_ERROR_NAME
  const sanitized = raw
    .replace(/[^A-Za-z0-9_.$-]/g, '')
    .slice(0, SERVER_ERROR_ALERT_MAX_NAME_LENGTH)
  return sanitized || DEFAULT_ERROR_NAME
}

function messageOf(error: unknown, status: number): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return `HTTP ${status}`
}

// `getOrCreateRequestId()` devuelve el `x-request-id` del CLIENTE tal cual. Un
// valor que se queda en nada al sanitizar (`@`, sólo espacios, emojis) NO puede
// cancelar el aviso: eso sería un interruptor para apagar la alarma desde fuera
// induciendo un 5xx. Se genera uno del lado servidor con la misma forma que
// `getOrCreateRequestId`, y el aviso sale igual.
function safeRequestId(value: string | undefined): string {
  const sanitized = value
    ?.replace(/[^A-Za-z0-9_.:-]/g, '')
    .slice(0, SERVER_ERROR_ALERT_MAX_REQUEST_ID_LENGTH)
  return sanitized || `alert-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function safeMethod(value: string | undefined): string | undefined {
  const method = value?.trim().toUpperCase()
  return method && /^[A-Z]{3,10}$/.test(method) ? method : undefined
}

/**
 * Traduce lo que vio el servidor al único payload que puede salir del proceso.
 * Devuelve `null` sólo cuando no hay nada que avisar: el status no es 5xx. Nada
 * que venga del cliente puede provocar ese `null`.
 */
export function buildServerErrorAlertPayload(
  input: ServerErrorAlertInput
): ServerErrorAlertPayload | null {
  if (!Number.isInteger(input.status) || input.status < 500 || input.status > 599) return null

  const requestId = safeRequestId(input.requestId)
  const method = safeMethod(input.method)
  const scrubbed = scrubAlertMessage(messageOf(input.error, input.status))

  // `make` valida contra las cotas de la redacción. Si algún día un cambio deja
  // pasar una ruta sin tachar o un nombre con caracteres libres, revienta acá y
  // no en el correo del equipo.
  return ServerErrorAlertPayloadSchema.make({
    route: redactAlertRoute(input.route),
    errorName: errorNameOf(input.error),
    status: input.status,
    message: cappedAlertText(scrubbed, SERVER_ERROR_ALERT_MAX_MESSAGE_LENGTH),
    digest: alertMessageDigest(scrubbed),
    requestId,
    ...(method ? { method } : {}),
    synthetic: input.synthetic === true,
  })
}

/**
 * Los dos imports son diferidos a propósito. Este módulo lo alcanza
 * `posthog-server-exception`, que a su vez entra en el grafo de `lib/api/
 * response` — o sea, en el de TODA ruta de API. El cliente de Convex y su api
 * generada se cargan sólo cuando de verdad hubo un 5xx.
 */
async function loadAlertChannel() {
  const [{ getConvexAdminClient }, { internal }] = await Promise.all([
    import('@/lib/convex/admin-client'),
    import('@/../convex/_generated/api'),
  ])

  const convex = getConvexAdminClient()
  return convex ? { convex, internal } : null
}

type AlertChannel = NonNullable<Awaited<ReturnType<typeof loadAlertChannel>>>

/**
 * El programa de la entrega, con su fallo en el TIPO: lo único que puede fallar
 * de forma esperada es la llamada a Convex, y sale como `ExternalServiceError`.
 *
 * El canal entra como parámetro y no se carga adentro a propósito: los dos
 * imports son diferidos y resolverlos dentro del programa metería un evento
 * asíncrono real entre el fork y la cota de 3 s, que es justo lo que
 * `server-error-alert-timeout.test.ts` mide con `TestClock`.
 */
const recordServerError = Effect.fn('ServerErrorAlert.deliver')(function* (
  channel: AlertChannel,
  payload: ServerErrorAlertDelivery
): Effect.fn.Return<boolean, ExternalServiceError> {
  yield* externalCall({
    service: 'Convex',
    operation: 'notifications._recordServerError',
    timeout: ALERT_DELIVERY_TIMEOUT_MS,
    // El aviso no lleva llave de idempotencia: quien deduplica es la ventana
    // de Convex, y un reintento de transporte inflaría el conteo de la fila.
    retries: 0,
    run: () =>
      channel.convex.mutation(channel.internal.notifications._recordServerError, { ...payload }),
  })

  return true
})

/**
 * Sin cliente admin configurado (dev sin deploy key, tests) es un no-op
 * silencioso: la alerta es un extra, no una dependencia.
 *
 * El manejo del fallo vive en el BORDE, no dentro del programa: quien corre la
 * entrega es quien decide que un aviso perdido no puede convertir un 500 en dos,
 * y así el `Effect` conserva su error en el tipo para quien lo componga.
 */
export async function deliverServerErrorAlert(payload: ServerErrorAlertDelivery): Promise<boolean> {
  try {
    const channel = await loadAlertChannel()
    if (!channel) return false

    return await runServerEffect(recordServerError(channel, payload))
  } catch (error) {
    // Sólo el nombre: el mensaje de Convex puede traer detalles del deployment.
    console.warn(
      '[observability] no se pudo registrar la alerta de 5xx en Convex',
      alertFailureName(error)
    )
    return false
  }
}

// `after()` mantiene viva la función hasta que la promesa se asienta, sin
// retrasar la respuesta. Fuera de una request TIRA (`after` exige el work store
// del request y lanza E468 sin él): ahí la entrega se anota como pendiente en
// vez de quedar flotando, porque el camino de render — páginas, RSC, handlers
// que revientan sin `apiError()` — sólo llega por `onRequestError`, y una
// promesa suelta la puede congelar la función serverless antes de que asiente.
const pendingAlerts = new Set<Promise<unknown>>()

function scheduleAfterResponse(task: () => Promise<unknown>): void {
  try {
    after(task)
  } catch {
    const pending = task().finally(() => pendingAlerts.delete(pending))
    pendingAlerts.add(pending)
  }
}

/**
 * Espera las entregas que `after()` no pudo agendar. La awaitea
 * `onRequestError`, que Next sí espera y que corre con la respuesta ya enviada:
 * ningún cliente paga este tiempo. En el camino de `apiError()` no hay nada
 * pendiente y es un no-op.
 */
export async function settlePendingServerErrorAlerts(): Promise<void> {
  if (pendingAlerts.size === 0) return
  await Promise.allSettled([...pendingAlerts])
}

/**
 * SÓLO PRODUCCIÓN DE VERDAD. `VERCEL_ENV` distingue el deployment de produccion
 * de un preview, y `NODE_ENV` distingue un servidor de un `next dev` o de la
 * suite. Sin las dos, un 500 de preview —o un worktree apuntado al deployment
 * equivocado— le manda correo a los hasta 25 perfiles ADMIN de verdad. Fuera de
 * produccion el 5xx sigue yendo a PostHog exactamente como antes; lo unico que
 * no ocurre es la escritura en Convex y el correo.
 */
function isProductionAlertLane(): boolean {
  return process.env.VERCEL_ENV === 'production' && process.env.NODE_ENV === 'production'
}

/**
 * Las dos variables que `getConvexAdminClient()` exige. Se comprueban ANTES de
 * agendar nada: sin ellas no hay canal, y así un deployment sin configurar no
 * paga imports diferidos ni deja promesas flotando por cada 5xx.
 */
function isAlertDeliveryConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_CONVEX_URL && process.env.CONVEX_DEPLOY_KEY)
}

// LA VENTANA CORTA LAS ESCRITURAS, NO SÓLO EL CORREO. El dedupe de Convex ya
// evitaba el segundo correo, pero cada 5xx seguía costando una mutación con
// deploy key: un cuerpo malformado que revienta un handler público llega miles
// de veces por minuto. La ventana se corta ACÁ, antes del round trip. Lo que se
// silencia no se pierde: viaja como `repeats` en la primera entrega de la
// ventana siguiente y Convex lo suma al conteo de la fila.
//
// Es memoria del proceso, así que el corte es por isolate: una tormenta paga
// una escritura por isolate vivo, no una por 5xx. El probe sintético nunca se
// silencia — es una acción de operador y su auditoría se escribe siempre.
const LOCAL_WINDOW_MAX_KEYS = 500
const openWindows = new Map<string, { openedAt: number; suppressed: number }>()

function evictWindows(now: number): void {
  for (const [key, window] of openWindows) {
    if (window.openedAt + SERVER_ERROR_ALERT_WINDOW_MS <= now) openWindows.delete(key)
  }
  // `Map` itera en orden de inserción: la primera llave es la más vieja.
  while (openWindows.size >= LOCAL_WINDOW_MAX_KEYS) {
    const oldest = openWindows.keys().next().value
    if (oldest === undefined) break
    openWindows.delete(oldest)
  }
}

function claimAlertWindow(
  payload: ServerErrorAlertPayload,
  now: number
): ServerErrorAlertDelivery | null {
  if (payload.synthetic) return ServerErrorAlertDeliverySchema.make({ ...payload, repeats: 1 })

  const key = `${payload.route}|${payload.errorName}`
  const open = openWindows.get(key)
  if (open && open.openedAt + SERVER_ERROR_ALERT_WINDOW_MS > now) {
    open.suppressed += 1
    return null
  }

  if (openWindows.size >= LOCAL_WINDOW_MAX_KEYS) evictWindows(now)
  openWindows.set(key, { openedAt: now, suppressed: 0 })
  return ServerErrorAlertDeliverySchema.make({ ...payload, repeats: 1 + (open?.suppressed ?? 0) })
}

/**
 * Punto de entrada del segundo canal. Síncrona y void a propósito: quien la
 * llama no puede awaitearla ni por accidente.
 */
export function reportServerErrorToTeam(input: ServerErrorAlertInput): void {
  try {
    if (!isProductionAlertLane() || !isAlertDeliveryConfigured()) return
    const built = buildServerErrorAlertPayload(input)
    if (!built) return
    const payload = claimAlertWindow(built, Date.now())
    if (!payload) return
    scheduleAfterResponse(() => deliverServerErrorAlert(payload))
  } catch {
    // Un fallo del aviso no puede convertir un 500 en dos.
  }
}
