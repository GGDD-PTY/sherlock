import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

function mockRouteDependencies() {
  vi.doMock('@/lib/utils/rate-limit', () => ({
    checkRateLimitDistributed: vi.fn().mockResolvedValue({
      success: true,
      remaining: 99,
      resetAt: new Date(),
      retryAfterSec: 0,
    }),
    createRateLimitResponse: vi.fn(
      () => new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429 })
    ),
    getClientIp: vi.fn(() => '127.0.0.1'),
    RATE_LIMIT_PRESETS: {
      healthCheck: { windowMs: 60_000, maxRequests: 120 },
    },
  }))

  vi.doMock('@/lib/logger', () => ({
    createLogger: vi.fn(() => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    })),
  }))
}

async function loadHealthRoute() {
  vi.resetModules()
  mockRouteDependencies()
  return import('@/app/api/health/route')
}

function healthRequest() {
  return new Request('http://localhost:3000/api/health')
}

function setProductionEnvironment() {
  process.env = {
    ...process.env,
    NODE_ENV: 'production',
  }
}

describe('GET /api/health', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      NEXT_PUBLIC_CONVEX_URL: 'https://convex.test',
    }
    // El sha del deploy lo pone Vercel; una máquina que lo tenga exportado no
    // puede cambiar lo que estos casos esperan.
    delete process.env.VERCEL_GIT_COMMIT_SHA
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('returns healthy when Convex is up', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { GET } = await loadHealthRoute()
    const response = await GET(healthRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Cache')).toBe('MISS')
    expect(body.status).toBe('healthy')
    expect(body.checks.convex.status).toBe('up')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns unhealthy when Convex URL is not configured', async () => {
    delete process.env.NEXT_PUBLIC_CONVEX_URL
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { GET } = await loadHealthRoute()
    const response = await GET(healthRequest())
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.status).toBe('unhealthy')
    expect(body.checks.convex).toEqual({
      status: 'down',
      error: 'NEXT_PUBLIC_CONVEX_URL not configured',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns unhealthy when Convex responds with a 5xx', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)

    const { GET } = await loadHealthRoute()
    const response = await GET(healthRequest())
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.status).toBe('unhealthy')
    expect(body.checks.convex.status).toBe('down')
  })

  it('returns a cached response inside the health cache window', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { GET } = await loadHealthRoute()
    const firstResponse = await GET(healthRequest())
    const secondResponse = await GET(healthRequest())
    const body = await secondResponse.json()

    expect(firstResponse.headers.get('X-Cache')).toBe('MISS')
    expect(secondResponse.headers.get('X-Cache')).toBe('HIT')
    expect(body.status).toBe('healthy')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns public health only in production (no service secret path exists anymore)', async () => {
    setProductionEnvironment()
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { GET } = await loadHealthRoute()
    const response = await GET(healthRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body).toEqual({
      status: 'healthy',
      timestamp: expect.any(String),
      sha: null,
    })
    expect(body).not.toHaveProperty('checks')
    expect(body).not.toHaveProperty('uptime')
    expect(body).not.toHaveProperty('version')
  })

  it('publishes the deploy sha in the public production response', async () => {
    setProductionEnvironment()
    process.env.VERCEL_GIT_COMMIT_SHA = 'fa1eade47b73733d6312d5abfad33ce9e4068081'
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { GET } = await loadHealthRoute()
    const response = await GET(healthRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      status: 'healthy',
      timestamp: expect.any(String),
      sha: 'fa1eade47b73733d6312d5abfad33ce9e4068081',
    })
  })

  it('reports sha null when the deploy carries no git metadata', async () => {
    setProductionEnvironment()
    delete process.env.VERCEL_GIT_COMMIT_SHA
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { GET } = await loadHealthRoute()
    const response = await GET(healthRequest())
    const body = await response.json()

    expect(body.sha).toBeNull()
  })

  it('returns detailed health outside production', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { GET } = await loadHealthRoute()
    const response = await GET(healthRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body.status).toBe('healthy')
    expect(body.checks.convex.status).toBe('up')
    expect(body).toHaveProperty('uptime')
    expect(body).toHaveProperty('version')
    expect(body).toHaveProperty('sha')
  })

  it('does not leak detailed cached health to later public production requests', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { GET } = await loadHealthRoute()
    const detailedResponse = await GET(healthRequest())
    setProductionEnvironment()
    const publicResponse = await GET(healthRequest())
    const publicBody = await publicResponse.json()

    expect(detailedResponse.headers.get('X-Cache')).toBe('MISS')
    expect(publicResponse.headers.get('X-Cache')).toBe('HIT')
    expect(publicResponse.headers.get('Cache-Control')).toBe('private, no-store')
    expect(publicBody).toEqual({
      status: 'healthy',
      timestamp: expect.any(String),
      sha: null,
    })
    expect(publicBody).not.toHaveProperty('checks')
    expect(publicBody).not.toHaveProperty('uptime')
    expect(publicBody).not.toHaveProperty('version')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
