// ============================================================================
// ONBOARDING ANALYTICS HOOK
// ============================================================================
// Hook personalizado para trackear eventos de onboarding con timing.
// Maneja el ciclo de vida completo: start, step_viewed, step_completed, etc.
//
// Características:
// - Lazy loading de PostHog (no afecta el bundle inicial)
// - Duración de pasos en millisegundos
// - Tiempo total de sesión de onboarding
// - Detección automática de abandono
// - Non-blocking: errores en analytics no afectan el flujo de la app
//
// ===== LA COSTURA CON EFFECT =====
// «Non-blocking» estaba escrito cinco veces: cinco `try { track(event) } catch
// (error) { console.warn(...) }` idénticos, cada uno con su `error: unknown`.
// Ahora hay un solo programa —`emitOnboardingEvent`— con error tipado
// (`OnboardingTrackError`), span con nombre y el aviso en un único lugar. Cada
// callback lo corre en su borde con `runClientSync`: el programa ya no puede
// fallar cuando llega ahí, así que sigue siendo síncrono y sigue sin poder
// tumbar el gesto del cliente.
// ============================================================================

import { useCallback, useRef, useEffect } from 'react'
import { Effect, Schema } from 'effect'

import type { AnalyticsEvent } from '@/lib/analytics/posthog'
import { track } from '@/lib/analytics/posthog'
import { runClientSync } from '@/lib/effect/client-runtime'

interface OnboardingSession {
  role: 'COMPANY'
  startTime: number
  lastStepTime: number
  currentStep: number
  stepTimings: Record<number, number> // step -> timeSpentMs
}

// ============================================================================
// EL PROGRAMA
// ============================================================================

/**
 * Lo único que puede fallar acá: `track` capturando en el mismo tick. No se
 * exporta — el contrato del hook son sus cuatro callbacks `void`.
 */
class OnboardingTrackError extends Schema.TaggedError<OnboardingTrackError>()(
  'OnboardingTrackError',
  {
    event: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

/**
 * Emite un evento y se traga su fallo, avisando por consola. `etapa` es la
 * palabra que ya iba en cada aviso ('started', 'step viewed', …), para que el
 * texto no cambie.
 */
const emitOnboardingEvent = Effect.fn('OnboardingAnalytics.emit')(function* (
  event: AnalyticsEvent,
  etapa: string
): Effect.fn.Return<void> {
  yield* Effect.try({
    try: () => track(event),
    catch: (cause) =>
      new OnboardingTrackError({
        event: event.event,
        message: `PostHog rechazó ${event.event} en el mismo tick.`,
        cause,
      }),
  }).pipe(
    Effect.catch((error) => Effect.logWarning(`[OnboardingAnalytics] Failed to track ${etapa}:`, error))
  )
})

/** El único borde: analytics nunca interrumpe el flujo del onboarding. */
function emit(event: AnalyticsEvent, etapa: string): void {
  runClientSync(emitOnboardingEvent(event, etapa))
}

/**
 * Hook para gestionar analytics de onboarding.
 * Trackea el flujo completo: inicio, pasos, completación, abandono.
 *
 * @param role - COMPANY
 * @returns Objeto con funciones para trackear eventos
 *
 * @example
 * const onboarding = useOnboardingAnalytics('COMPANY')
 *
 * // Al entrar en el onboarding
 * useEffect(() => {
 *   onboarding.trackStarted()
 * }, [])
 *
 * // Al ver un paso
 * useEffect(() => {
 *   onboarding.trackStepViewed(1, 'Basic Information')
 * }, [currentStep])
 *
 * // Al completar un paso
 * onboarding.trackStepCompleted(1, 'Basic Information')
 *
 * // Al abandonar
 * useEffect(() => {
 *   return () => onboarding.trackAbandoned()
 * }, [])
 */
export function useOnboardingAnalytics(role: 'COMPANY') {
  // Ref para evitar re-renderizado
  const sessionRef = useRef<OnboardingSession | null>(null)
  const completedRef = useRef(false)

  // The onboarding timing state is intentionally memory-only.
  useEffect(() => {
    if (typeof window === 'undefined') return

    const now = Date.now()
    sessionRef.current = {
      role,
      startTime: now,
      lastStepTime: now,
      currentStep: 1,
      stepTimings: {},
    }
  }, [role])

  // ===== CLEANUP: Trackear abandono si no se completó =====
  useEffect(() => {
    return () => {
      // Solo ejecutar si no completó explícitamente
      if (!completedRef.current && sessionRef.current) {
        trackAbandonedInternal(sessionRef.current)
      }
    }
  }, [])

  // ===== TRACKEAR INICIO DE ONBOARDING =====
  const trackStarted = useCallback(() => {
    if (!sessionRef.current) return

    emit({ event: 'onboarding_started', properties: { role } }, 'started')
  }, [role])

  // ===== TRACKEAR VISTA DE PASO =====
  const trackStepViewed = useCallback(
    (step: number, _stepName: string) => {
      if (!sessionRef.current) return

      // Actualizar sesión
      sessionRef.current.currentStep = step
      sessionRef.current.lastStepTime = Date.now()

      emit(
        {
          event: 'onboarding_step_viewed',
          properties: {
            role,
            step,
          },
        },
        'step viewed'
      )
    },
    [role]
  )

  // ===== TRACKEAR COMPLETACIÓN DE PASO =====
  const trackStepCompleted = useCallback(
    (step: number, _stepName: string) => {
      if (!sessionRef.current) return

      const now = Date.now()
      const timeSpentMs = now - sessionRef.current.lastStepTime

      // Guardar timing del paso
      sessionRef.current.stepTimings[step] = timeSpentMs
      sessionRef.current.currentStep = step

      emit(
        {
          event: 'onboarding_step_completed',
          properties: {
            role,
            step,
            timeSpentMs,
          },
        },
        'step completed'
      )

      sessionRef.current.lastStepTime = now
    },
    [role]
  )

  // ===== TRACKEAR COMPLETACIÓN DE ONBOARDING =====
  const trackCompleted = useCallback(
    (totalSteps: number, stepsCompleted: number) => {
      if (!sessionRef.current) return

      completedRef.current = true
      const now = Date.now()
      const totalTimeMs = now - sessionRef.current.startTime

      emit(
        {
          event: 'onboarding_completed',
          properties: {
            role,
            totalSteps,
            stepsCompleted,
            totalTimeMs,
          },
        },
        'completed'
      )
    },
    [role]
  )

  return {
    trackStarted,
    trackStepViewed,
    trackStepCompleted,
    trackCompleted,
  }
}

// ===== FUNCIONES INTERNAS =====

/**
 * Trackea abandono de onboarding (llamado automáticamente en cleanup)
 */
function trackAbandonedInternal(session: OnboardingSession) {
  const now = Date.now()
  const totalTimeMs = now - session.startTime
  const timeOnLastStepMs = now - session.lastStepTime

  emit(
    {
      event: 'onboarding_abandoned',
      properties: {
        role: session.role,
        lastStepReached: session.currentStep,
        timeOnLastStepMs,
        totalTimeMs,
      },
    },
    'abandoned'
  )
}
