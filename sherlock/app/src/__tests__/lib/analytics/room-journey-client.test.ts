// ============================================================================
// LA COTA DE 1,5 s DEL POST DE RECORRIDO — camino de fallo
// ============================================================================
// `trackRoomJourney` corre en el gesto del cliente: abrir un documento, entrar
// a la sala. La ola de Effect le puso techo de tiempo y una sola tentativa, y
// nada de eso se ejercitaba. El programa se captura en el borde
// `runServerEffect` y se maneja con `TestClock`: ni un milisegundo de reloj
// real. Ver `src/__tests__/utils/effect-runtime-seam.ts`.
//
// El programa vive en `room-journey-drain.ts` y la fachada lo carga con
// `import()` para no meter Effect en el first-load JS de la sala, así que la
// prueba espera con `whenEffectCaptured()` a que ese chunk llegue al borde.
// ============================================================================

import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { afterEach, beforeEach, vi } from 'vitest'

import type { ExternalServiceError } from '@/lib/effect/errors'

vi.mock(
  '@/lib/effect/runtime',
  async () => (await import('../../utils/effect-runtime-seam')).capturingRuntimeModule
)

import { trackRoomJourney } from '@/lib/analytics/room-journey'
import {
  resetCapturedEffects,
  takeCapturedEffect,
  whenEffectCaptured,
} from '../../utils/effect-runtime-seam'

/** El programa que `trackRoomJourney` iba a correr, ya volteado a su fallo. */
function capturedJourneyFailure() {
  return takeCapturedEffect<unknown, ExternalServiceError>().pipe(Effect.flip)
}

describe('trackRoomJourney — cota de tiempo y tentativa única', () => {
  beforeEach(() => {
    resetCapturedEffects()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.effect('a los 1,5 s corta el POST, aborta la petición y no la reintenta', () =>
    Effect.gen(function* () {
      let attempts = 0
      let aborts = 0
      vi.stubGlobal('fetch', (_input: unknown, init: { signal: AbortSignal }) => {
        attempts += 1
        return new Promise<never>((_resolve, reject) => {
          init.signal.addEventListener(
            'abort',
            () => {
              aborts += 1
              reject(init.signal.reason)
            },
            { once: true }
          )
        })
      })

      void trackRoomJourney('room_entered', {})
      yield* Effect.promise(() => whenEffectCaptured())
      const fiber = yield* Effect.forkChild(capturedJourneyFailure())

      // Justo en el techo: el sueño de la cota vence en 1 500 ms exactos.
      yield* TestClock.adjust('1500 millis')
      const error = yield* Fiber.join(fiber)

      assert.strictEqual(error.reason, 'timeout')
      assert.strictEqual(error.service, 'SherlockJourneyIngest')
      assert.strictEqual(attempts, 1)
      assert.strictEqual(aborts, 1)
    })
  )

  it.effect('un fallo de transporte se reporta de una vez: el evento no se duplica', () =>
    Effect.gen(function* () {
      let attempts = 0
      vi.stubGlobal('fetch', () => {
        attempts += 1
        return Promise.reject(new TypeError('Failed to fetch'))
      })

      void trackRoomJourney('document_opened', { documentKind: 'spreadsheet' })
      yield* Effect.promise(() => whenEffectCaptured())
      const fiber = yield* Effect.forkChild(capturedJourneyFailure())

      // Una hora de reloj virtual: no hay reintento que esperar.
      yield* TestClock.adjust('1 hour')
      const error = yield* Fiber.join(fiber)

      assert.strictEqual(error.reason, 'transport')
      assert.strictEqual(error.operation, 'journey.document_opened')
      assert.strictEqual(attempts, 1)
    })
  )
})
