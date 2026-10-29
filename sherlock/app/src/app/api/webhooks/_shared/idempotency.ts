// `internal.webhookEvents.registerEvent` devuelve `isNew: false` para CUALQUIER
// fila existente en `webhookEvents`, sin importar su status. Si tratamos eso
// como "duplicado" sin más, un evento que quedó en 'failed' (el handler
// respondió 500 y el proveedor va a reintentar) nunca vuelve a procesarse: el
// reintento colisiona con la fila existente y respondemos 200 sin hacer nada.
// Resultado: todo fallo transitorio se convierte en pérdida permanente
// (suscripción pagada que nunca se crea, KYC que nunca queda VERIFICADO, etc.).
//
// Aquí distinguimos estados TERMINALES (el evento ya se resolvió: no reprocesar)
// de estados REINTENTABLES (hay que volver a procesar cuando el proveedor
// reintente). Un `received` que sale de un claim vencido no prueba que el
// efecto no se haya aplicado.
//
// 'processing' NO se considera reintentable: puede haber otra request en vuelo
// procesando el mismo evento y reprocesarlo abriría una ventana de doble
// aplicación. Un processing cuyo claim ya venció no llega con ese status:
// `registerEvent` lo reclama y lo devuelve como 'received'.
//
// El orden que este módulo protege no cambia: el handler registra el evento en
// `webhookEvents` ANTES de procesarlo y solo después pregunta aquí si le toca
// procesar. Estas dos funciones son predicados puros; no registran nada.

import { Schema } from 'effect'

export type WebhookRegistration = {
  isNew: boolean
  eventId: string
  claimVersion?: number
  status: string
  message: string
}

/**
 * El vocabulario de `webhookEvents.status`, tal como lo valida Convex
 * (`convex/schema.ts`). Vive aquí para que la lista reintentable de abajo se
 * mida contra él en vez de contra strings sueltos.
 */
// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.

type WebhookEventStatus = 'received' | 'processing' | 'completed' | 'failed' | 'skipped'

/**
 * Estados que el caller vuelve a procesar cuando el proveedor reintenta.
 * - 'failed': el handler falló y respondió 500 → el proveedor reintenta.
 * - 'received': registrado pero jamás tomado, o un `processing` cuyo claim
 *   venció el lease y `registerEvent` devolvió este status. Vencer el lease
 *   no prueba que el efecto no se haya aplicado.
 *
 * El `satisfies` es la mitad que faltaba: un estado mal escrito aquí —o uno que
 * `webhookEvents` no conoce— deja de compilar en vez de convertirse en un
 * duplicado silencioso, que es como se ve un `Set<string>` cuando se equivoca.
 */
const REPLAYABLE_WEBHOOK_STATUSES = [
  'failed',
  'received',
] as const satisfies ReadonlyArray<WebhookEventStatus>

/**
 * El status llega como `string` desde Convex y se queda como `string`: un
 * estado que este código no conoce tiene que caer del lado terminal
 * (fail-closed), no romper el handler. `Schema.is` es esa pregunta, contra el
 * vocabulario y no contra una lista suelta.
 */
const isReplayableStatus = Schema.is(Schema.Literals(REPLAYABLE_WEBHOOK_STATUSES))

/**
 * True cuando el evento ya existía pero quedó en un estado no terminal y el
 * proveedor lo está reintentando.
 */
export function isReplayableWebhookRegistration(registration: WebhookRegistration): boolean {
  return !registration.isNew && isReplayableStatus(registration.status)
}

/**
 * True cuando el handler debe procesar el evento: o es nuevo, o es un reintento
 * de un evento que nunca llegó a aplicarse.
 */
export function shouldProcessWebhookEvent(registration: WebhookRegistration): boolean {
  return registration.isNew || isReplayableWebhookRegistration(registration)
}
