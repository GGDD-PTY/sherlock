// ============================================================================
// LA COTA DE 8 s DEL WORKSPACE TEMPORAL — camino de fallo
// ============================================================================
// `resolveIntakeWorkspace` corre dentro del render de la sala temporal: sin
// techo de tiempo, un Convex colgado cuelga la página. La ola de Effect puso
// esa cota y cero reintentos — el proof del intake es de un solo uso — y la
// caída es a `null`, que es lo mismo que hacía el `catch` de antes. Acá se
// ejercita con `TestClock`.
// ============================================================================

import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { afterEach, beforeEach, vi } from 'vitest'

const convex = vi.hoisted(() => ({ mutation: vi.fn() }))

vi.mock('@/lib/convex-auth', () => ({
  getUnauthenticatedConvex: () => ({ mutation: convex.mutation }),
}))
vi.mock(
  '@/lib/effect/runtime',
  async () => (await import('../../utils/effect-runtime-seam')).capturingRuntimeModule
)

import { resolveIntakeWorkspace, type IntakeWorkspaceView } from '@/lib/intake/session'
import { resetCapturedEffects, takeCapturedEffect } from '../../utils/effect-runtime-seam'

const SESSION_TOKEN = 's'.repeat(43)

describe('resolveIntakeWorkspace — cota de tiempo hacia null', () => {
  beforeEach(() => {
    resetCapturedEffects()
    convex.mutation.mockReset()
    vi.stubEnv('INTAKE_SERVER_SECRET', 'intake-server-secret-for-tests-1234567890')
    vi.stubEnv('INTAKE_SERVER_AUDIENCE', 'sherlock-test:intake')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.effect('a los 8 s renderiza la sala sin documentos en vez de colgarse', () =>
    Effect.gen(function* () {
      let attempts = 0
      convex.mutation.mockImplementation(() => {
        attempts += 1
        return new Promise<never>(() => {})
      })

      void resolveIntakeWorkspace(SESSION_TOKEN)
      const fiber = yield* Effect.forkChild(takeCapturedEffect<IntakeWorkspaceView | null, never>())

      yield* TestClock.adjust('8 seconds')
      const workspace = yield* Fiber.join(fiber)

      assert.strictEqual(workspace, null)
      // El nonce del proof es de un solo uso: una segunda vuelta la rechazaría
      // el propio servidor.
      assert.strictEqual(attempts, 1)
    })
  )
})
