import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const JWKS = {
  keys: [{ kty: 'RSA', kid: 'dev-local-mcp-1', alg: 'RS256', use: 'sig', n: 'n', e: 'AQAB' }],
}

async function loadRoute() {
  return import('@/app/api/dev/jwks/route')
}

describe('GET /api/dev/jwks', () => {
  const jwksPath = join(process.cwd(), '.convex-local', 'dev-jwks.json')
  let backup: Buffer | null = null

  beforeEach(() => {
    vi.resetModules()
    backup = existsSync(jwksPath) ? readFileSync(jwksPath) : null
    mkdirSync(dirname(jwksPath), { recursive: true })
    writeFileSync(jwksPath, JSON.stringify(JWKS))
  })

  afterEach(() => {
    if (backup) writeFileSync(jwksPath, backup)
    else rmSync(jwksPath, { force: true })
    vi.unstubAllEnvs()
  })

  it('returns 404 in production even with dev-auth on and a loopback URL', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', 'true')
    const { GET } = await loadRoute()

    const response = await GET(new Request('http://localhost:3114/api/dev/jwks'))

    expect(response.status).toBe(404)
  })

  it('returns 404 when DEV_AUTH is off', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', 'false')
    vi.stubEnv('BYPASS_AUTH', 'false')
    vi.stubEnv('NEXT_PUBLIC_BYPASS_AUTH', 'false')
    const { GET } = await loadRoute()

    const response = await GET(new Request('http://localhost:3114/api/dev/jwks'))

    expect(response.status).toBe(404)
  })

  it('returns 404 for a non-loopback host', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', 'true')
    const { GET } = await loadRoute()

    const response = await GET(new Request('https://www.sherlock.capital/api/dev/jwks'))

    expect(response.status).toBe(404)
  })

  it('serves the JWKS on loopback when DEV_AUTH is on', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', 'true')
    const { GET } = await loadRoute()

    const response = await GET(new Request('http://localhost:3114/api/dev/jwks'))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual(JWKS)
  })

  it('hides every verb except a gated GET', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', 'true')
    const route = await loadRoute()

    expect(route.POST().status).toBe(404)
    expect(route.PUT().status).toBe(404)
    expect(route.PATCH().status).toBe(404)
    expect(route.DELETE().status).toBe(404)
    expect(route.OPTIONS().status).toBe(404)
  })
})
