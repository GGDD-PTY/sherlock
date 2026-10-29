// ============================================================================
// LA COTA DE 3 s DE LA ALERTA DE 5xx — camino de fallo
// ============================================================================
// La entrega corre agendada con `after()`, así que ningún cliente paga su
// tiempo — pero sin cota una mutación colgada mantiene viva la función
// serverless hasta que la plataforma la corta. La ola de Effect puso ese techo
// y una sola tentativa (el aviso no lleva llave de idempotencia). Acá se
// ejercita con `TestClock`, sin reloj real.
// ============================================================================

import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { beforeEach, vi } from 'vitest'

import type { ExternalServiceError } from '@/lib/effect/errors'

const convexAdmin = vi.hoisted(() => ({ mutation: vi.fn() }))

vi.mock('@/lib/convex/admin-client', () => ({
  getConvexAdminClient: () => ({
    mutation: convexAdmin.mutation,
    query: vi.fn(),
    setAdminAuth: vi.fn(),
  }),
}))

vi.mock(
  '@/lib/effect/runtime',
  async () => (await import('../../utils/effect-runtime-seam')).capturingRuntimeModule
)

import { deliverServerErrorAlert } from '@/lib/observability/server-error-alert'
import {
  resetCapturedEffects,
  takeCapturedEffect,
  whenEffectCaptured,
} from '../../utils/effect-runtime-seam'

const DELIVERY = {
  route: '/api/vdr/documents',
  errorName: 'TypeError',
  status: 500,
  message: 'boom',
  digest: 'a3f9c1d2',
  requestId: 'request-9',
  method: 'POST',
  synthetic: false,
  repeats: 1,
} as const

describe('deliverServerErrorAlert — cota de tiempo y tentativa única', () => {
  beforeEach(() => {
    resetCapturedEffects()
    convexAdmin.mutation.mockReset()
  })

  it.effect('a los 3 s abandona una mutación colgada y no la repite', () =>
    Effect.gen(function* () {
      let attempts = 0
      convexAdmin.mutation.mockImplementation(() => {
        attempts += 1
        return new Promise<never>(() => {})
      })

      void deliverServerErrorAlert({ ...DELIVERY })
      // Los dos imports son diferidos: el programa se compone un microtask
      // después de la llamada.
      yield* Effect.promise(() => whenEffectCaptured())
      const fiber = yield* Effect.forkChild(
        takeCapturedEffect<unknown, ExternalServiceError>().pipe(Effect.flip)
      )

      yield* TestClock.adjust('3 seconds')
      const error = yield* Fiber.join(fiber)

      assert.strictEqual(error.reason, 'timeout')
      assert.strictEqual(error.service, 'Convex')
      assert.strictEqual(error.operation, 'notifications._recordServerError')
      assert.strictEqual(attempts, 1)
    })
  )

  it.effect('un rechazo de Convex tampoco se reintenta: la fila no se infla', () =>
    Effect.gen(function* () {
      let attempts = 0
      convexAdmin.mutation.mockImplementation(() => {
        attempts += 1
        return Promise.reject(new Error('permission denied for deployment xyz'))
      })

      void deliverServerErrorAlert({ ...DELIVERY })
      yield* Effect.promise(() => whenEffectCaptured())
      const fiber = yield* Effect.forkChild(
        takeCapturedEffect<unknown, ExternalServiceError>().pipe(Effect.flip)
      )

      yield* TestClock.adjust('1 hour')
      const error = yield* Fiber.join(fiber)

      assert.strictEqual(error.reason, 'transport')
      assert.strictEqual(attempts, 1)
    })
  )
})
