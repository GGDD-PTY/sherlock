// ============================================================================
// LA COTA DE 8 s DE LA EMISIÓN DE CAPABILITY ADMIN — camino de fallo
// ============================================================================
// `adminVdrCapabilities:issue` es una mutación: repetirla acuñaría dos
// capabilities para la misma acción, así que la ola de Effect la dejó con cero
// reintentos y techo de 8 s. Sin ese techo la ruta admin queda colgada. Se
// prueba con `TestClock`, sin reloj real.
// ============================================================================

import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { beforeEach, vi } from 'vitest'

import type { Id } from '@/../convex/_generated/dataModel'
import type { ApiUser } from '@/lib/api/with-auth'
import type { ExternalServiceError } from '@/lib/effect/errors'

const convex = vi.hoisted(() => ({ mutation: vi.fn() }))

vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () =>
    Promise.resolve({
      client: { mutation: convex.mutation },
      token: 'workos_access_token',
      isAuthenticated: true,
    }),
}))
vi.mock(
  '@/lib/effect/runtime',
  async () => (await import('../../utils/effect-runtime-seam')).capturingRuntimeModule
)

import { issueAdminVdrCapability } from '@/lib/auth/admin-vdr-capability-server'
import { resetCapturedEffects, takeCapturedEffect } from '../../utils/effect-runtime-seam'

const ADMIN: ApiUser = {
  id: 'workos_admin',
  email: 'fixture-4622a879@example.com',
  role: 'ADMIN',
  profileId: 'profile_admin' as Id<'profiles'>,
  sessionId: 'session_admin_test_001',
}

describe('issueAdminVdrCapability — cota de tiempo y emisión única', () => {
  beforeEach(() => {
    resetCapturedEffects()
    convex.mutation.mockReset()
    vi.stubEnv(
      'ADMIN_VDR_CAPABILITY_SECRET',
      'test-admin-vdr-capability-secret-with-strong-entropy'
    )
    vi.stubEnv('WORKOS_CLIENT_ID', 'client_01HTESTADMINVDRCAPABILITY')
  })

  it.effect('a los 8 s abandona la emisión colgada sin acuñar una segunda', () =>
    Effect.gen(function* () {
      let attempts = 0
      convex.mutation.mockImplementation(() => {
        attempts += 1
        return new Promise<never>(() => {})
      })

      void issueAdminVdrCapability({
        user: ADMIN,
        companyId: 'company_1' as Id<'companies'>,
        action: 'DOCUMENT_ARCHIVE',
        target: 'document_1',
        input: { documentId: 'document_1' },
      })
      const fiber = yield* Effect.forkChild(
        takeCapturedEffect<unknown, ExternalServiceError>().pipe(Effect.flip)
      )

      yield* TestClock.adjust('8 seconds')
      const error = yield* Fiber.join(fiber)

      assert.strictEqual(error.reason, 'timeout')
      assert.strictEqual(error.operation, 'adminVdrCapabilities.issue')
      assert.strictEqual(attempts, 1)
    })
  )
})
