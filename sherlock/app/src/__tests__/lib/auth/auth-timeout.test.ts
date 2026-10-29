// ============================================================================
// LA COTA DE 8 s DE `auth()` — camino de fallo
// ============================================================================
// `auth()` corre en cada request de API. La ola de Effect le puso techo de
// tiempo a `withAuth()` y cero reintentos: un rechazo de sesión de AuthKit es
// determinista. Con WorkOS colgado el programa FALLA con `ExternalServiceError`
// (`reason: 'timeout'`) en vez de colgar el handler, y ese fallo no se disfraza
// de sesión nula: `requireApiAuth` lo lee como 500, no como 401 (A1-03). Se
// prueba con `TestClock`, sin reloj real.
// ============================================================================

import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { beforeEach, vi } from 'vitest'

const workos = vi.hoisted(() => ({ withAuth: vi.fn() }))

vi.mock('@workos-inc/authkit-nextjs', () => ({ withAuth: () => workos.withAuth() }))
vi.mock(
  '@/lib/effect/runtime',
  async () => (await import('../../utils/effect-runtime-seam')).capturingRuntimeModule
)

import { auth, type Session } from '@/lib/auth/auth'
import type { ExternalServiceError } from '@/lib/effect/errors'
import { resetCapturedEffects, takeCapturedEffect } from '../../utils/effect-runtime-seam'

describe('auth() — cota de tiempo de la sesión de WorkOS', () => {
  beforeEach(() => {
    resetCapturedEffects()
    workos.withAuth.mockReset()
  })

  it.effect('a los 8 s falla con el timeout tipado en vez de colgar el handler', () =>
    Effect.gen(function* () {
      let attempts = 0
      workos.withAuth.mockImplementation(() => {
        attempts += 1
        return new Promise<never>(() => {})
      })

      void auth()
      // `flip` pone el fallo en el canal de éxito: si el programa devolviera
      // una sesión (nula o no) en vez de fallar, el join sería el que falla.
      const fiber = yield* Effect.forkChild(
        Effect.flip(takeCapturedEffect<Session | null, ExternalServiceError>())
      )

      yield* TestClock.adjust('8 seconds')
      const failure = yield* Fiber.join(fiber)

      assert.strictEqual(failure._tag, 'ExternalServiceError')
      assert.strictEqual(failure.reason, 'timeout')
      assert.strictEqual(failure.service, 'WorkOS')
      assert.strictEqual(attempts, 1)
    })
  )
})
