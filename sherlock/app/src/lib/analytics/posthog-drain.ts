// ============================================================================
// DRENAJE DE LA COLA DE ANALYTICS — EL PROGRAMA EFFECT
// ============================================================================
// Los dos puntos que pueden fallar — cargar el módulo del SDK y capturar un
// evento — son Effects con error tipado y span. El borde corre con
// `runServerEffectExit`, que asienta el Exit en vez de relanzar: este módulo
// nunca rechaza.
//
// ===== POR QUÉ VIVE APARTE DE `posthog.ts` ([F] 2026-09-08) =====
// `track()` es síncrono y lo llaman componentes React en el gesto del cliente
// (soltar un archivo en la landing). Tenerlo en el mismo módulo que este
// programa metía el runtime de fibras y `Schema` en el first-load JS de la
// landing y de las dos salas. Nada se revirtió: el programa entero se mudó a
// este hermano, que `posthog.ts` carga con `import()` cuando hay algo que
// drenar. `track()` sigue encolando en el mismo tick, así que el momento del
// evento no cambió.
// ============================================================================

import { Effect, Schema } from 'effect'

import type { PostHog } from 'posthog-js'
import type { AnalyticsEvent } from '@/lib/analytics/event-contract'
import { runServerEffect, runServerEffectExit } from '@/lib/effect/runtime'

// ============================================================================
// ERRORES TIPADOS
// ============================================================================
// No se exportan: el contrato de este módulo es una sola función.

class AnalyticsClientLoadError extends Schema.TaggedError<AnalyticsClientLoadError>()(
  'AnalyticsClientLoadError',
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

class AnalyticsCaptureError extends Schema.TaggedError<AnalyticsCaptureError>()(
  'AnalyticsCaptureError',
  {
    event: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

/** Ganchos de estado que conserva `posthog.ts`: la cola es suya, no de acá. */
export type AnalyticsDrainHooks = {
  /** Reprograma el drenaje con backoff exponencial acotado. */
  scheduleRetry: () => void
  /** Vuelve el backoff a su valor inicial tras un envío exitoso. */
  resetRetryDelay: () => void
}

// ============================================================================
// LAZY POSTHOG INSTANCE
// ============================================================================
// En lugar de importar posthog directamente, usamos una promesa lazy
// que solo carga el módulo cuando se necesita por primera vez.

let posthogPromise: Promise<PostHog | null> | null = null
let posthogInstance: PostHog | null = null

const importPostHogClient = Effect.fn('Analytics.importClient')(function* () {
  const loaded = yield* Effect.tryPromise({
    try: () => import('posthog-js'),
    catch: (cause) =>
      new AnalyticsClientLoadError({
        message: 'No se pudo cargar el módulo de PostHog en el navegador.',
        cause,
      }),
  })
  posthogInstance = loaded.default
  return loaded.default
})

/**
 * Carga el módulo una sola vez y memoiza la promesa. Un fallo de carga limpia
 * la memoización — la siguiente pasada del backoff vuelve a intentar — y nunca
 * rechaza: el Exit se asienta acá adentro.
 */
function loadPostHogClientOnce(): Promise<PostHog | null> {
  posthogPromise ??= runServerEffect(
    importPostHogClient().pipe(
      // El aviso sale por el logger de la capa, como los otros dos de este
      // archivo: un `console.warn` acá adentro se saltaba el nivel y el span.
      Effect.tapError((error) => Effect.logWarning('[Analytics] Failed to load PostHog:', error)),
      Effect.match({
        onSuccess: (client): PostHog | null => client,
        onFailure: (): PostHog | null => {
          posthogPromise = null
          return null
        },
      })
    )
  )
  return posthogPromise
}

/**
 * Obtiene la instancia de PostHog de forma lazy.
 * La primera llamada carga el módulo, las siguientes usan el cache.
 *
 * Manual events stay queued until the provider initializes the shared client.
 */
const resolveReadyPostHog = Effect.fn('Analytics.resolveClient')(function* () {
  if (typeof window === 'undefined') return null
  if (posthogInstance?.__loaded) return posthogInstance

  const posthog = yield* Effect.promise(() => loadPostHogClientOnce())
  return posthog?.__loaded ? posthog : null
})

const capturePostHogEvent = Effect.fn('Analytics.capture')(function* (
  posthog: PostHog,
  event: AnalyticsEvent
) {
  return yield* Effect.try({
    try: () => posthog.capture(event.event, event.properties || {}),
    catch: (cause) =>
      new AnalyticsCaptureError({
        event: event.event,
        message: 'PostHog rechazó la captura del evento en el mismo tick.',
        cause,
      }),
  })
})

const drainQueue = Effect.fn('Analytics.drainQueue')(function* (
  eventQueue: AnalyticsEvent[],
  hooks: AnalyticsDrainHooks
) {
  const posthog = yield* resolveReadyPostHog()

  if (!posthog) {
    // PostHog not available, schedule retry with exponential backoff
    yield* Effect.sync(hooks.scheduleRetry)
    return
  }

  // PostHog available, try to send all queued events
  let successCount = 0

  while (eventQueue.length > 0) {
    const event = eventQueue[0]
    if (!event) break

    const failure = yield* capturePostHogEvent(posthog, event).pipe(
      Effect.match({
        onSuccess: (): AnalyticsCaptureError | null => null,
        onFailure: (error): AnalyticsCaptureError | null => error,
      })
    )
    if (failure) {
      yield* Effect.logWarning('[Analytics] Failed to send queued event, will retry:', failure)

      // Exponential backoff on failure + schedule retry for remaining events
      hooks.scheduleRetry()
      return // Stop processing, will retry later
    }

    eventQueue.shift() // Remove on success
    successCount++

    // Reset retry delay on successful send
    hooks.resetRetryDelay()
  }

  if (successCount > 0 && process.env.NODE_ENV === 'development') {
    yield* Effect.log(`[Analytics] Successfully flushed ${successCount} queued events`)
  }
})

/**
 * Drena la cola que le presta `posthog.ts`. Nunca rechaza: el Exit se asienta
 * en el borde.
 */
export async function drainAnalyticsQueue(
  eventQueue: AnalyticsEvent[],
  hooks: AnalyticsDrainHooks
): Promise<void> {
  await runServerEffectExit(drainQueue(eventQueue, hooks))
}
