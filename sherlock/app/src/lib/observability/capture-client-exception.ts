// El boundary de error es la última pantalla que le queda al cliente: reportar
// no puede romperlo. Todo aquí es best-effort y silencioso.
//
// La pantalla de error puede aparecer en el primer render; el SDK de PostHog
// arranca al final (init tras `load` + idle). Antes, este módulo importaba
// `posthog-js`, veía `__loaded === false` y devolvía sin reportar: la ventana
// entre el primer error y el init era ciega. Ahora la excepción se encola y la
// entrega el sink que el provider registra al terminar el `init`.
//
// Este módulo NO importa `posthog-js`, ni estático ni dinámico. Hacerlo bajaría
// los ~70 KiB del SDK desde una pantalla de error, en plena ventana del LCP, y
// para nada: sin `init` el cliente no reporta igual. El sink es la única vía.

import { Schema } from 'effect'

// El sitio ships solo en `es` ([F] 2026-09-03). El segmento de la ruta se
// compara contra este catálogo, no contra un literal suelto en el `if`.
const ClientExceptionLocaleSchema = Schema.Literals(['es'])
const isClientExceptionLocale = Schema.is(ClientExceptionLocaleSchema)

type ClientExceptionProperties = {
  digest?: string
  locale?: typeof ClientExceptionLocaleSchema.Type
  route?: string
}

type QueuedException = {
  error: unknown
  properties: ClientExceptionProperties
}

/** Sink de excepciones: lo cumple `posthog.captureException` tras el `init`. */
export type ClientExceptionSink = {
  captureException: (error: unknown, properties?: Record<string, unknown>) => void
}

// Una pantalla de error normalmente reporta una excepción, no cien. La cota
// existe para que un loop de render no se coma la memoria; se conservan las más
// nuevas, que son las que describen el estado en el que quedó la página.
export const MAX_QUEUED_EXCEPTIONS = 20

const queuedExceptions: QueuedException[] = []
let sink: ClientExceptionSink | null = null

// El digest lo escribe Next y viaja al evento de PostHog: forma conocida y
// largo acotado, declarados una vez.
const isSafeDigest = Schema.is(
  Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/), Schema.isMaxLength(128)))
)

function safeDigest(digest: string | undefined): string | undefined {
  const normalized = digest?.trim()
  return normalized && isSafeDigest(normalized) ? normalized : undefined
}

function exceptionContext(): ClientExceptionProperties {
  const route = window.location?.pathname
  if (!route || route.length > 512) return {}

  const localeSegment = route.split('/')[1]
  return {
    ...(isClientExceptionLocale(localeSegment) ? { locale: localeSegment } : {}),
    route,
  }
}

function drainQueue(): void {
  if (!sink) return

  // `shift()` sobre un array no vacío devuelve el elemento, pero TypeScript no
  // lo sabe: el `as QueuedException` de antes era un cast a ciegas. El `while`
  // lo pregunta en vez de afirmarlo.
  let queued = queuedExceptions.shift()
  while (queued) {
    try {
      sink.captureException(queued.error, queued.properties)
    } catch {
      // Un fallo de captura no puede tumbar la pantalla de error, y tampoco
      // puede dejar la cola trabada: el evento se pierde y se sigue con el resto.
    }
    queued = queuedExceptions.shift()
  }
}

/**
 * Conecta el cliente ya inicializado como destino de las excepciones y vacía lo
 * que se haya acumulado antes. Lo llama `PostHogProvider` después del `init`;
 * `null` lo desconecta.
 */
export function registerExceptionSink(nextSink: ClientExceptionSink | null): void {
  sink = nextSink
  drainQueue()
}

/**
 * Reporta una excepción del cliente a PostHog. Si el SDK todavía no está
 * inicializado la deja en cola y se entrega cuando lo esté; nunca lanza.
 * `before_send` del provider sanitiza el evento y lo descarta en rutas
 * confidenciales.
 */
export function captureClientException(error: unknown, digest?: string): void {
  if (typeof window === 'undefined') return

  const safe = safeDigest(digest)
  // El contexto se toma AHORA: la cola puede vaciarse después de una navegación
  // y la ruta que importa es la que estaba rota, no la que se está mirando.
  const properties: ClientExceptionProperties = {
    ...(safe ? { digest: safe } : {}),
    ...exceptionContext(),
  }

  queuedExceptions.push({ error, properties })
  if (queuedExceptions.length > MAX_QUEUED_EXCEPTIONS) queuedExceptions.shift()

  drainQueue()
}
