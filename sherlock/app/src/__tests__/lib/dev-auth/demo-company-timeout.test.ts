// ============================================================================
// LA COTA DE 5 s DE LA SALA DEMO — camino de fallo
// ============================================================================
// La lectura a Convex corre dentro del render de la sala demo. La ola de
// Effect le puso techo de tiempo y cero reintentos: el carril demo prefiere
// caer al fixture local antes que hacer esperar al render. Acá se prueba con
// `TestClock`, sin reloj real.
// ============================================================================

import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { beforeEach, vi } from 'vitest'

const convex = vi.hoisted(() => ({ fetchQuery: vi.fn() }))

vi.mock('convex/nextjs', () => ({
  fetchQuery: (...args: unknown[]) => convex.fetchQuery(...args),
}))
vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: { getCompanyByOwner: 'companies.getCompanyByOwner' },
    _demoSeed: { roomForDevCompany: '_demoSeed.roomForDevCompany' },
  },
}))
vi.mock(
  '@/lib/effect/runtime',
  async () => (await import('../../utils/effect-runtime-seam')).capturingRuntimeModule
)

import { resolveDemoCompany, type DemoCompanyResolution } from '@/lib/dev-auth/demo-company'
import { DEMO_PUBLIC_COMPANIES } from '@/lib/dev-auth/demo-data'
import { resetCapturedEffects, takeCapturedEffect } from '../../utils/effect-runtime-seam'

describe('resolveDemoCompany — cota de tiempo hacia el fixture', () => {
  beforeEach(() => {
    resetCapturedEffects()
    convex.fetchQuery.mockReset()
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://kindly-mole-736.convex.cloud')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it.effect('a los 5 s abandona la lectura colgada y renderiza el fixture local', () =>
    Effect.gen(function* () {
      let attempts = 0
      convex.fetchQuery.mockImplementation(() => {
        attempts += 1
        return new Promise<never>(() => {})
      })

      void resolveDemoCompany('profile_dev_company')
      const fiber = yield* Effect.forkChild(takeCapturedEffect<DemoCompanyResolution, never>())

      yield* TestClock.adjust('5 seconds')
      const resolution = yield* Fiber.join(fiber)

      // El fixture es el que dice que no hay documentos ni bytes que pedir.
      assert.strictEqual(resolution.isFixture, true)
      assert.strictEqual(resolution.company?._id, DEMO_PUBLIC_COMPANIES[0]?._id)
      // Cero reintentos: una sola lectura, no dos ni tres.
      assert.strictEqual(attempts, 1)
    })
  )
})
