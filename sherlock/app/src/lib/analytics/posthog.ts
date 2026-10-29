// ============================================================================
// POSTHOG ANALYTICS UTILITIES
// ============================================================================
// Funciones centralizadas para tracking de eventos en PostHog.
// Esto te permite ver EXACTAMENTE cómo usan tu app los usuarios.
//
// PostHog FREE tier incluye:
// - 1 millón de eventos/mes
// - 5,000 session replays/mes
// - 1 millón de feature flag requests/mes
// - 250 survey responses/mes
//
// ===== LAZY LOADING OPTIMIZATION =====
// PostHog se carga dinámicamente para no bloquear el bundle inicial.
// Esto mejora LCP y TTI significativamente (~177KB menos en main bundle).
//
// ===== LA COSTURA CON EFFECT =====
// Lo único que este módulo hace de forma síncrona es encolar: `track` conserva
// su firma `void` porque la consumen componentes React y la landing la llama
// en el gesto de soltar un archivo. El programa Effect que drena la cola —con
// sus errores tipados, sus spans y su borde `runServerEffectExit`— sigue
// viviendo en `posthog-drain.ts` y se carga con `import()` la primera vez que
// hay algo que enviar: esa frontera de carga diferida NO se movió. Lo que
// cambió es `flushQueue`: su único fallo real (el chunk que no llegó) ahora
// tiene nombre (`Effect.fn` + `UnexpectedAppError`) en vez de un `catch`
// genérico.
//
// [F] 2026-09-09 levantó el bloqueo de peso de bundle que mantenía este
// archivo sin Effect: `effect/Effect` y, transitivamente, `effect/Schema` (vía
// `@/lib/effect/errors`) ahora viajan en el first-load JS de todo lo que llama
// `track()` — la landing y las dos salas. Medido en el reporte del lote.
//
// `flushQueue` corre con `runClientEffect`, no con `runServerEffect`. El
// runtime de servidor es la costura que un doble de pruebas sustituye para
// probar el drenaje sin reloj real. El de cliente no pasa por ese módulo: el
// logger conserva el nivel y la captura del drain sigue llegando.
// ============================================================================

import { Effect } from 'effect'

import type { AnalyticsEvent } from '@/lib/analytics/event-contract'
import { UnexpectedAppError } from '@/lib/effect/errors'
import { runClientEffect } from '@/lib/effect/client-runtime'

export type { AnalyticsEvent } from '@/lib/analytics/event-contract'

// ============================================================================
// MANUAL EVENT QUEUE
// ============================================================================
// Keep events in memory until the provider initializes PostHog. Synchronous
// capture failures retry with bounded exponential backoff.

const eventQueue: AnalyticsEvent[] = []
const MAX_QUEUE_SIZE = 100 // Prevent memory issues
const INITIAL_RETRY_DELAY = 5000 // 5 seconds
const MAX_RETRY_DELAY = 60000 // 1 minute
let currentRetryDelay = INITIAL_RETRY_DELAY
let flushInProgress = false

/** Reprograma el drenaje con backoff exponencial acotado. */
function scheduleRetry(): void {
  currentRetryDelay = Math.min(currentRetryDelay * 2, MAX_RETRY_DELAY)
  setTimeout(() => {
    flushInProgress = false
    void flushQueue()
  }, currentRetryDelay)
}

function resetRetryDelay(): void {
  currentRetryDelay = INITIAL_RETRY_DELAY
}

// El programa Effect llega por chunk aparte. La promesa se memoiza para que
// una tanda de eventos no dispare varias cargas, y se pide recién en el primer
// drenaje: una visita que no emite un solo evento no baja el chunk.
//
// El `catch` que limpia la memo es lo que hace que el backoff sirva de algo. Con
// la promesa fija, un chunk que no llegó una vez dejaba a `flushQueue`
// esperando para siempre la misma promesa rechazada: la analítica del cliente
// moría en esa pestaña y ningún reintento la revivía.
let drainModulePromise: Promise<typeof import('@/lib/analytics/posthog-drain')> | null = null

function loadDrainModule(): Promise<typeof import('@/lib/analytics/posthog-drain')> {
  drainModulePromise ??= import('@/lib/analytics/posthog-drain').catch((cause: unknown) => {
    drainModulePromise = null
    throw cause
  })
  return drainModulePromise
}

const flushQueueEffect = Effect.fn('Analytics.flushQueue')(function* () {
  const { drainAnalyticsQueue } = yield* Effect.tryPromise({
    try: () => loadDrainModule(),
    catch: (cause) =>
      new UnexpectedAppError({
        operation: 'analytics.loadDrainModule',
        message: 'No se pudo cargar el módulo de envío de analytics.',
        cause,
      }),
  })
  // `drainAnalyticsQueue` nunca rechaza (asienta su propio Exit en el borde),
  // así que acá es `Effect.promise`, no `Effect.tryPromise`.
  yield* Effect.promise(() => drainAnalyticsQueue(eventQueue, { scheduleRetry, resetRetryDelay }))
})

/**
 * Flushes the event queue with exponential backoff retry logic.
 * Attempts to send all queued events to PostHog.
 *
 * @internal
 */
async function flushQueue(): Promise<void> {
  // Prevent concurrent flush attempts
  if (flushInProgress || eventQueue.length === 0) return

  flushInProgress = true

  try {
    await runClientEffect(
      flushQueueEffect().pipe(
        Effect.catch((error) =>
          // Un chunk que no llegó no puede tumbar el gesto del cliente: los
          // eventos siguen en la cola y el backoff vuelve a intentar.
          Effect.logWarning('[Analytics] Failed to load the queue drain module:', error).pipe(
            Effect.andThen(Effect.sync(() => scheduleRetry()))
          )
        )
      )
    )
  } finally {
    flushInProgress = false
  }
}

// ============================================================================
// FUNCIÓN PRINCIPAL DE TRACKING
// ============================================================================

/**
 * Tracks one safe PostHog event with a memory-only pre-initialization queue.
 * Synchronous capture failures retry with exponential backoff.
 *
 * Usa lazy loading - PostHog se carga solo cuando se necesita.
 * Queue capacity: 100 events max (oldest removed if exceeded).
 *
 * @example
 * track({ event: 'intake_started', properties: { locale: 'es', mode: 'TEMPORARY' } })
 */
export function track<E extends AnalyticsEvent>(eventData: E): void {
  if (typeof window === 'undefined') return // No trackear en SSR

  // Queue before checking readiness so pre-initialization capture can never
  // drop the event.
  eventQueue.push(eventData)

  // Enforce max queue size (prevent memory issues)
  if (eventQueue.length > MAX_QUEUE_SIZE) {
    const removed = eventQueue.shift() // Remove oldest
    console.warn('[Analytics] Queue full, removed oldest event:', removed?.event)
  }

  // Attempt to flush queue immediately
  void flushQueue()
}
