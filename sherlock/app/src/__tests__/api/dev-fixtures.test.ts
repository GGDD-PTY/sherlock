import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadGet() {
  const { GET } = await import('@/app/api/dev-fixtures/[name]/route')
  return GET
}

function request(name: string, search = '') {
  return new Request(`http://localhost/api/dev-fixtures/${name}${search}`)
}

describe('GET /api/dev-fixtures/[name]', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 404 in production even for an allowlisted fixture with dev-auth on', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', 'true')
    const GET = await loadGet()

    const response = await GET(request('andina-solar-modelo.xlsx'), {
      params: Promise.resolve({ name: 'andina-solar-modelo.xlsx' }),
    })

    expect(response.status).toBe(404)
    expect(await response.arrayBuffer()).toHaveProperty('byteLength', 0)
  })

  it('returns 404 when the viewer bench is off outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', 'false')
    const GET = await loadGet()

    const response = await GET(request('andina-solar-modelo.xlsx'), {
      params: Promise.resolve({ name: 'andina-solar-modelo.xlsx' }),
    })

    expect(response.status).toBe(404)
  })

  it.each([
    '../package.json',
    'secret.pdf',
    'andina-solar/estados-financieros-fy24.pdf',
    'andina-solar-eeff.PDF',
  ])('returns 404 for a name that is not on the closed allowlist (%s)', async (name) => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', 'true')
    const GET = await loadGet()

    const response = await GET(request(name), {
      params: Promise.resolve({ name }),
    })

    expect(response.status).toBe(404)
  })

  it('serves an allowlisted fixture with a private cache when the bench is enabled', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', 'true')
    const GET = await loadGet()

    const response = await GET(request('andina-solar-modelo.xlsx'), {
      params: Promise.resolve({ name: 'andina-solar-modelo.xlsx' }),
    })
    const body = new Uint8Array(await response.arrayBuffer())

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(Array.from(body.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
  })
})
