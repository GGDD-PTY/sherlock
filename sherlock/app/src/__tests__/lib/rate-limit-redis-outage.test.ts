// ============================================================================
// TESTS: checkRateLimitDistributed — comportamiento ante caída de Redis
// ============================================================================
// Contrato: con Redis configurado pero fallando, en producción el limiter
// NIEGA la request (fail-closed) en vez de degradar a memoria local, donde
// cada instancia tendría su propio contador (bypass del cap multi-instancia).
// RATE_LIMIT_FAIL_MODE=open|closed permite forzar cualquiera de los dos modos.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: Object.assign(
    vi.fn().mockImplementation(() => ({
      limit: vi.fn().mockRejectedValue(new Error('redis unreachable')),
    })),
    { slidingWindow: vi.fn() }
  ),
}))

vi.mock('@upstash/redis', () => ({
  Redis: { fromEnv: vi.fn().mockReturnValue({}) },
}))

async function importFreshRateLimit() {
  vi.resetModules()
  return await import('@/lib/utils/rate-limit')
}

describe('checkRateLimitDistributed con Redis configurado pero caído', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://fake.upstash.io')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'fake-token')
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('en producción niega la request (fail-closed) con retryAfter acotado', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { checkRateLimitDistributed } = await importFreshRateLimit()

    const result = await checkRateLimitDistributed('user-1', { limit: 5, windowSec: 60 })

    expect(result.success).toBe(false)
    expect(result.remaining).toBe(0)
    expect(result.retryAfterSec).toBeGreaterThan(0)
    expect(result.retryAfterSec).toBeLessThanOrEqual(60)
  })

  it('RATE_LIMIT_FAIL_MODE=open fuerza el fallback a memoria incluso en producción', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('RATE_LIMIT_FAIL_MODE', 'open')
    const { checkRateLimitDistributed } = await importFreshRateLimit()

    const result = await checkRateLimitDistributed('user-2', { limit: 5, windowSec: 60 })

    expect(result.success).toBe(true)
  })

  it('fuera de producción degrada a memoria (desarrollo sigue operable sin Redis sano)', async () => {
    const { checkRateLimitDistributed } = await importFreshRateLimit()

    const result = await checkRateLimitDistributed('user-3', { limit: 5, windowSec: 60 })

    expect(result.success).toBe(true)
  })

  it('RATE_LIMIT_FAIL_MODE=closed fuerza fail-closed también fuera de producción', async () => {
    vi.stubEnv('RATE_LIMIT_FAIL_MODE', 'closed')
    const { checkRateLimitDistributed } = await importFreshRateLimit()

    const result = await checkRateLimitDistributed('user-4', { limit: 5, windowSec: 60 })

    expect(result.success).toBe(false)
  })
})
