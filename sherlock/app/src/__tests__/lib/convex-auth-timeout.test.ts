// ============================================================================
// LAS COTAS Y EL ÚNICO REINTENTO DE CONVEX-AUTH — camino de fallo
// ============================================================================
// Dos políticas que la ola de Effect introdujo y que nadie ejercitaba:
//   1. `withAuth()` de WorkOS lleva techo de 8 s y CERO reintentos — un rechazo
//      de sesión es determinista y esto corre en cada página.
//   2. `users.getCurrentUserState` lleva UN reintento por ser lectura
//      idempotente: cubre el parpadeo de red sin convertir una caída de Convex
//      en segundos de espera.
// El programa se captura en el borde `runServerEffect` y se maneja con
// `TestClock`: ni un milisegundo de reloj real.
// ============================================================================

import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { beforeEach, vi } from 'vitest'

const workos = vi.hoisted(() => ({ withAuth: vi.fn() }))
const convex = vi.hoisted(() => ({ query: vi.fn(), setAuth: vi.fn() }))

vi.mock('@workos-inc/authkit-nextjs', () => ({ withAuth: () => workos.withAuth() }))
vi.mock('convex/browser', () => ({
  ConvexHttpClient: class MockConvexHttpClient {
    setAuth = convex.setAuth
    query = convex.query
    mutation = vi.fn()
  },
}))
vi.mock(
  '@/lib/effect/runtime',
  async () => (await import('../utils/effect-runtime-seam')).capturingRuntimeModule
)

import {
  getAuthenticatedConvex,
  getCurrentAuthenticatedUserState,
  type AuthenticatedConvexClient,
  type CurrentAuthenticatedUserState,
} from '@/lib/convex-auth'
import { resetCapturedEffects, takeCapturedEffect } from '../utils/effect-runtime-seam'

const USER_STATE = {
  user: { _id: 'user_convex_123', email: 'ada@example.com' },
  profile: { _id: 'profile_123', role: 'COMPANY' },
}

describe('convex-auth — cota de WorkOS y reintento de la lectura', () => {
  beforeEach(() => {
    resetCapturedEffects()
    workos.withAuth.mockReset()
    convex.query.mockReset()
    convex.setAuth.mockReset()
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://test.convex.cloud')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    workos.withAuth.mockResolvedValue({
      user: { id: 'user_workos_123', email: 'ada@example.com' },
      accessToken: 'workos_access_token_for_tests',
    })
  })

  it.effect('a los 8 s abandona una sesión de WorkOS colgada y no la reintenta', () =>
    Effect.gen(function* () {
      let attempts = 0
      workos.withAuth.mockImplementation(() => {
        attempts += 1
        return new Promise<never>(() => {})
      })

      void getAuthenticatedConvex()
      const fiber =
        yield* Effect.forkChild(takeCapturedEffect<AuthenticatedConvexClient | null, never>())

      yield* TestClock.adjust('8 seconds')
      const resolved = yield* Fiber.join(fiber)

      assert.strictEqual(resolved, null)
      assert.strictEqual(attempts, 1)
      assert.strictEqual(convex.setAuth.mock.calls.length, 0)
    })
  )

  it.effect('recupera el estado del usuario en el segundo intento tras un parpadeo', () =>
    Effect.gen(function* () {
      let attempts = 0
      convex.query.mockImplementation(() => {
        attempts += 1
        return attempts < 2 ? Promise.reject(new Error('ECONNRESET')) : Promise.resolve(USER_STATE)
      })

      void getCurrentAuthenticatedUserState({ requireConvexAuth: true })
      const fiber =
        yield* Effect.forkChild(takeCapturedEffect<CurrentAuthenticatedUserState | null, never>())

      // El backoff exponencial arranca en 150 ms: el reintento cae ahí.
      yield* TestClock.adjust('150 millis')
      const state = yield* Fiber.join(fiber)

      assert.strictEqual(state?.user?._id, USER_STATE.user._id)
      assert.strictEqual(state?.profile?._id, USER_STATE.profile._id)
      assert.strictEqual(attempts, 2)
    })
  )

  it.effect('deja de reintentar la lectura en el segundo intento, no en un tercero', () =>
    Effect.gen(function* () {
      let attempts = 0
      convex.query.mockImplementation(() => {
        attempts += 1
        return Promise.reject(new Error('convex unavailable'))
      })

      void getCurrentAuthenticatedUserState({ requireConvexAuth: true })
      const fiber =
        yield* Effect.forkChild(takeCapturedEffect<CurrentAuthenticatedUserState | null, never>())

      yield* TestClock.adjust('150 millis')
      const state = yield* Fiber.join(fiber)

      assert.strictEqual(state, null)
      assert.strictEqual(attempts, 2)

      // Una hora más de reloj virtual no despierta un tercer intento.
      yield* TestClock.adjust('1 hour')
      assert.strictEqual(attempts, 2)
    })
  )
})
