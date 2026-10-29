import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockIntlMiddleware = vi.fn((_request: NextRequest) => {
  const response = NextResponse.next()
  response.headers.set('x-test-intl-middleware', 'hit')
  return response
})

// Una caja mutable y no `mockResolvedValueOnce` porque varios tests llaman al
// proxy más de una vez con la misma sesión.
const authkitSession: {
  current: { user: { id: string } | null; accessToken?: string; sessionId?: string }
} = {
  current: { user: null },
}

const mockAuthkit = vi.fn(async () => ({
  session: authkitSession.current,
  headers: new Headers([['x-test-authkit-source', 'hit']]),
  authorizationUrl: 'http://localhost:3000/login',
}))

// El rol del panel sale del perfil de Convex, no del JWT de WorkOS: el proxy
// abre su propio cliente HTTP y lo consulta antes de renderizar.
const mockConvexSetAuth = vi.fn()
const mockConvexQuery = vi.fn(async (): Promise<unknown> => null)

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    setAuth = mockConvexSetAuth
    query = mockConvexQuery
  },
}))

const mockPartitionAuthkitHeaders = vi.fn((_request: NextRequest, _headers: Headers) => ({
  requestHeaders: new Headers([['x-test-authkit-request', 'hit']]),
  responseHeaders: new Headers([['x-test-authkit-response', 'hit']]),
}))

const mockApplyResponseHeaders = vi.fn((response: NextResponse, headers: Headers) => {
  for (const [name, value] of headers) {
    response.headers.set(name, value)
  }

  return response
})

const metadataRouteCases = [
  { path: '/robots.txt', mode: 'WorkOS', devAuthEnabled: false },
  { path: '/sitemap.xml', mode: 'WorkOS', devAuthEnabled: false },
  { path: '/auth.md', mode: 'WorkOS', devAuthEnabled: false },
  { path: '/robots.txt', mode: 'dev-auth', devAuthEnabled: true },
  { path: '/sitemap.xml', mode: 'dev-auth', devAuthEnabled: true },
  { path: '/auth.md', mode: 'dev-auth', devAuthEnabled: true },
] as const

vi.mock('next-intl/middleware', () => ({
  default: () => mockIntlMiddleware,
}))

vi.mock('@workos-inc/authkit-nextjs', () => ({
  authkit: mockAuthkit,
  partitionAuthkitHeaders: mockPartitionAuthkitHeaders,
  applyResponseHeaders: mockApplyResponseHeaders,
}))

describe('proxy', () => {
  beforeEach(() => {
    vi.resetModules()
    mockIntlMiddleware.mockClear()
    mockAuthkit.mockClear()
    mockPartitionAuthkitHeaders.mockClear()
    mockApplyResponseHeaders.mockClear()
    mockConvexSetAuth.mockClear()
    mockConvexQuery.mockClear()
    mockConvexQuery.mockResolvedValue(null)
    authkitSession.current = { user: null }
    delete process.env.BYPASS_AUTH
    delete process.env.NEXT_PUBLIC_BYPASS_AUTH
    delete process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED
    delete process.env.NEXT_PUBLIC_APP_URL
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([undefined, 'qa-565-boundary-anonymous', 'qa request<>:565'])(
    'returns a correlated no-store 401 for unauthenticated API requests with ID %s',
    async (incomingId) => {
      vi.stubEnv('NODE_ENV', 'production')
      const { proxy } = await import('@/proxy')
      const headers = new Headers()
      if (incomingId !== undefined) headers.set('x-request-id', incomingId)
      const response = await proxy(
        new NextRequest('https://www.sherlock.capital/api/admin/activity', { headers })
      )

      const requestId = response.headers.get('x-request-id')
      expect(response.status).toBe(401)
      expect(requestId).toMatch(/^[A-Za-z0-9_.:-]+$/)
      if (incomingId !== undefined) {
        expect(requestId).toBe(incomingId.replace(/[^A-Za-z0-9_.:-]/g, ''))
      }
      expect(response.headers.get('x-correlation-id')).toBe(requestId)
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('x-test-authkit-response')).toBe('hit')
      expect(response.headers.has('x-test-authkit-request')).toBe(false)
      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized', requestId })
    }
  )

  const intakeModeOffRoutes = [
    '/api/intake/data',
    '/api/intake/documents',
    '/api/intake/session',
    '/api/intake/support',
    '/api/intake/uploads',
    '/api/intake/uploads/register',
  ] as const

  it.each(intakeModeOffRoutes)(
    'answers %s with the intake 404 when demo mode is off',
    async (path) => {
      vi.stubEnv('NODE_ENV', 'production')
      delete process.env.INTAKE_DEMO_MODE
      const { proxy } = await import('@/proxy')
      const response = await proxy(
        new NextRequest(`https://www.sherlock.capital${path}`, {
          headers: { 'x-request-id': 'intake-off' },
        })
      )

      expect(response.status).toBe(404)
      expect(mockAuthkit).not.toHaveBeenCalled()
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      await expect(response.json()).resolves.toEqual({
        error: 'Recurso no disponible',
        requestId: 'intake-off',
      })
    }
  )

  it.each(['/api/intake/claim', '/api/intake/destination'] as const)(
    'keeps %s behind auth when demo mode is off',
    async (path) => {
      vi.stubEnv('NODE_ENV', 'production')
      delete process.env.INTAKE_DEMO_MODE
      const { proxy } = await import('@/proxy')
      const response = await proxy(
        new NextRequest(`https://www.sherlock.capital${path}`, {
          headers: { 'x-request-id': 'intake-auth' },
        })
      )

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({
        error: 'Unauthorized',
        requestId: 'intake-auth',
      })
    }
  )

  it('answers intake session with the same 404 in dev-auth when demo mode is off', async () => {
    process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
    delete process.env.INTAKE_DEMO_MODE
    const { proxy } = await import('@/proxy')
    const response = await proxy(
      new NextRequest('http://localhost:3000/api/intake/session', {
        headers: { 'x-request-id': 'intake-dev-off' },
      })
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      error: 'Recurso no disponible',
      requestId: 'intake-dev-off',
    })
  })

  it('leaves intake session public when demo mode is on', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('INTAKE_DEMO_MODE', 'true')
    const { proxy } = await import('@/proxy')
    const response = await proxy(
      new NextRequest('https://www.sherlock.capital/api/intake/session', {
        headers: { 'x-request-id': 'intake-on' },
      })
    )

    expect(response.status).not.toBe(404)
    expect(response.status).not.toBe(401)
    expect(mockAuthkit).not.toHaveBeenCalled()
  })

  // ===== UNA SOLA CARA: ESPAÑOL ([F] 2026-09-01) =====
  // El inglés dejó de servirse como cara del sitio. Los mensajes `en` siguen en
  // el árbol y sus contratos verdes, así que este candado fija la ÚNICA
  // diferencia: /en/* responde 308 al mismo camino en /es, antes de AuthKit y
  // sin pasar por el router de i18n. Un 404 o un 200 en /en son regresiones.
  it.each([
    ['/en', '/es'],
    ['/en/ayuda', '/es/ayuda'],
    ['/en/my-company/documents', '/es/my-company/documents'],
    ['/en/design-system/components/button', '/es/design-system/components/button'],
  ])('redirects the retired English face %s to %s', async (path, expected) => {
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

    expect(response.status).toBe(308)
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe(expected)
    expect(mockAuthkit).not.toHaveBeenCalled()
    expect(mockIntlMiddleware).not.toHaveBeenCalled()
  })

  it('keeps the query string when retiring the English face', async () => {
    const { proxy } = await import('@/proxy')

    const response = await proxy(
      new NextRequest('http://localhost:3000/en/my-company/documents?room=company&q=2024')
    )

    expect(response.status).toBe(308)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.pathname).toBe('/es/my-company/documents')
    expect(location.search).toBe('?room=company&q=2024')
  })

  it.each(['/es/design-system'])(
    'serves non-production showcase leaf %s without AuthKit',
    async (path) => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockAuthkit).not.toHaveBeenCalled()
      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1)
      expect(response.status).not.toBe(307)
    }
  )

  it.each(['/es/design-system/nested', '/es/design-system/components/button'])(
    'rewrites nested showcase path %s to localized 404 without AuthKit',
    async (path) => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockAuthkit).not.toHaveBeenCalled()
      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      expect(response.status).toBe(404)
      expect(response.headers.get('x-middleware-rewrite')).toMatch(/\/(es|en)\/__not-found__$/)
    }
  )

  it('returns a direct production 404 for the showcase leaf before AuthKit', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { proxy } = await import('@/proxy')

    const response = await proxy(
      new NextRequest('http://localhost:3000/es/design-system', {
        headers: { 'x-vercel-ip-country': 'US' },
      })
    )

    expect(mockAuthkit).not.toHaveBeenCalled()
    expect(mockIntlMiddleware).not.toHaveBeenCalled()
    expect(response.status).toBe(404)
    expect(response.headers.get('x-middleware-rewrite')).toBeNull()
  })

  it.each(['/callback?code=abc&state=xyz', '/login', '/logout', '/signup'])(
    'lets root AuthKit route %s reach its route handler without i18n middleware',
    async (path) => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      expect(response.headers.get('x-test-intl-middleware')).toBeNull()
      expect(response.headers.get('x-middleware-next')).toBe('1')
    }
  )

  it.each(metadataRouteCases)(
    'lets public metadata route $path bypass AuthKit and i18n middleware in $mode mode',
    async ({ path, devAuthEnabled }) => {
      if (devAuthEnabled) {
        process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
      }
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockAuthkit).not.toHaveBeenCalled()
      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      expect(response.headers.get('x-test-intl-middleware')).toBeNull()
      expect(response.headers.get('x-middleware-next')).toBe('1')
    }
  )

  it.each([
    '/api/vdr-mcp',
    // Las dos PRM del único recurso protegido: la raíz que el cliente MCP pide
    // primero y la de path. Ambas llevan bearer propio, sin sesión.
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/api/vdr-mcp',
    '/api/observability/probe',
  ])('lets the exact bearer-bound route %s reach its own boundary', async (path) => {
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

    expect(mockAuthkit).not.toHaveBeenCalled()
    expect(mockIntlMiddleware).not.toHaveBeenCalled()
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  // Las rutas del puente con Mycroft (/api/mcp y las tres patas privadas del
  // worker) se borraron el 2026-09-06 ([F], DECISIONS): hoy caen en el gate de
  // auth como cualquier ruta sin registrar.
  it.each([
    '/api/mcp',
    '/api/vdr-mcp/neighbor',
    '/api/internal/model-runs/claim',
    '/api/internal/model-runs/start',
    '/api/internal/model-runs/receipt',
    '/api/observability',
    '/api/observability/probe/neighbor',
  ])('does not widen the bearer-bound proxy exception to %s', async (path) => {
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

    expect(mockAuthkit).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(401)
  })

  // El cliente MCP de Claude Code pide la PRM raíz antes que la de path. Un
  // 307 de locale le devolvía HTML, así que caía al registro dinámico en
  // `/register` y reportaba «Dynamic Client Registration rejected (HTTP 404)».
  // Bajo `/.well-known/` no hay negociación de locale: lo que no está
  // registrado es un 404 JSON acá mismo, sin `location`.
  it.each([
    '/.well-known/otra-cosa',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource/api/vdr-mcp/neighbor',
  ])('answers the unregistered well-known path %s with a JSON 404', async (path) => {
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

    expect(mockAuthkit).not.toHaveBeenCalled()
    expect(mockIntlMiddleware).not.toHaveBeenCalled()
    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ error: 'not_found' })
  })

  it.each(['/.well-known/otra-cosa', '/.well-known/oauth-protected-resource/api/vdr-mcp/neighbor'])(
    'answers the unregistered well-known path %s with a JSON 404 in dev-auth too',
    async (path) => {
      process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      expect(response.status).toBe(404)
      expect(response.headers.get('location')).toBeNull()
      await expect(response.json()).resolves.toEqual({ error: 'not_found' })
    }
  )

  // [F] 2026-09-07 09:00: «si la página no existe, no debería existir y
  // redirigir». `/dashboard` y `/data-room` se borraron del árbol y salieron de
  // las listas de segmentos, así que el deny-by-default las reescribe al 404
  // localizado — ni sesión, ni negociación de locale, ni redirect que las
  // mantenga vivas como atajo.
  it.each(['/es/dashboard', '/es/data-room'])(
    'answers the deleted redirect-only route %s with the localized 404',
    async (path) => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockAuthkit).not.toHaveBeenCalled()
      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      expect(response.status).not.toBe(307)
      expect(response.headers.get('x-middleware-rewrite')).toBe(
        'http://localhost:3000/es/__not-found__'
      )
    }
  )

  it.each(['/es/vdr-guest'])(
    'keeps the guest verification leaf public and applies non-leaking headers at %s',
    async (path) => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockAuthkit).toHaveBeenCalledTimes(1)
      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1)
      expect(response.status).not.toBe(307)
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('x-robots-tag')).toContain('noindex')
    }
  )

  it('rewrites unknown localized routes to the catch-all 404 without AuthKit (fail-closed)', async () => {
    const { proxy } = await import('@/proxy')

    const response = await proxy(
      new NextRequest('http://localhost:3000/es/this-page-does-not-exist-xyz')
    )

    expect(mockAuthkit).not.toHaveBeenCalled()
    expect(mockIntlMiddleware).not.toHaveBeenCalled()
    expect(response.status).not.toBe(307)
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'http://localhost:3000/es/__not-found__'
    )
  })

  // QA post-deploy de #776: `/es/dev-login` respondía 200 e indexable en prod y
  // staging mientras sus hermanos de desarrollo daban 404. Sin dev-auth el
  // segmento no existe; con dev-auth sigue público porque es el destino del
  // redirect de toda ruta protegida.
  it('answers /es/dev-login with the localized 404 before AuthKit when dev-auth is off', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest('https://www.sherlock.capital/es/dev-login'))

    expect(mockAuthkit).not.toHaveBeenCalled()
    expect(mockIntlMiddleware).not.toHaveBeenCalled()
    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'https://www.sherlock.capital/es/__not-found__'
    )
  })

  it('keeps /es/dev-login public in dev-auth mode', async () => {
    process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest('http://localhost:3000/es/dev-login?as=company'))

    expect(response.status).not.toBe(404)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('x-middleware-rewrite')).toBeNull()
    expect(response.headers.get('x-test-intl-middleware')).toBe('hit')
  })

  it('keeps unknown nested protected routes behind WorkOS AuthKit', async () => {
    const { proxy } = await import('@/proxy')

    const response = await proxy(
      new NextRequest('http://localhost:3000/es/admin/this-page-does-not-exist-xyz')
    )

    expect(mockAuthkit).toHaveBeenCalledTimes(1)
    expect(mockIntlMiddleware).not.toHaveBeenCalled()
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/login')
  })

  // [F] 2026-09-07 09:00: el perfil y el editor del marketplace salieron del
  // árbol; la información de la empresa vive en la sala. Sus URLs viejas no
  // tienen sucesor: responden 404 antes de AuthKit, como cualquier hoja
  // retirada, y la sala sigue detrás de la sesión.
  it.each(['/es/my-company/profile', '/es/my-company/edit', '/es/my-company/edit/anything'])(
    'rewrites the retired company profile path %s to the localized 404 without AuthKit',
    async (path) => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockAuthkit).not.toHaveBeenCalled()
      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      expect(response.status).toBe(404)
      expect(response.headers.get('x-middleware-rewrite')).toBe(
        'http://localhost:3000/es/__not-found__'
      )
    }
  )

  it.each([
    '/es/my-company/documents',
    '/es/my-company/documents/activity',
    '/es/my-company/company',
    '/es/my-company/preparation',
    '/es/my-company/team',
    '/es/my-company/guests',
  ])('keeps the room path %s behind WorkOS AuthKit', async (path) => {
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

    expect(mockAuthkit).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/login')
  })

  it('keeps every (app) route-group segment behind auth unless index-public', async () => {
    // Guard against the unknown-route 404 fall-through silently exposing a new
    // (app) route whose segment was never added to PROTECTED_PAGE_SEGMENTS.
    const PUBLIC_INDEX_SEGMENTS: string[] = []
    const appGroupDir = join(process.cwd(), 'src/app/[locale]/(app)')
    const protectedSegments = readdirSync(appGroupDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((segment) => !PUBLIC_INDEX_SEGMENTS.includes(segment))

    expect(protectedSegments.length).toBeGreaterThan(0)

    const { proxy } = await import('@/proxy')

    for (const segment of protectedSegments) {
      mockAuthkit.mockClear()

      const response = await proxy(new NextRequest(`http://localhost:3000/es/${segment}`))

      expect(mockAuthkit, `/es/${segment} must stay behind WorkOS AuthKit`).toHaveBeenCalledTimes(1)
      expect(response.status, `/es/${segment} must redirect unauthenticated users`).toBe(307)
      expect(response.headers.get('location')).toBe('http://localhost:3000/login')
    }
  })

  it.each(['/es/mycroft', '/es/mycroft/nested'])(
    'redirects the retired intake path %s to the localized home before AuthKit',
    async (path) => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}?utm=x`))

      expect(mockAuthkit).not.toHaveBeenCalled()
      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      expect(response.status).toBe(307)
      const locale = path.split('/')[1]
      expect(response.headers.get('location')).toBe(`http://localhost:3000/${locale}`)
    }
  )

  // ES: las URLs del marketplace no existen ([F] 2026-09-16 22:00: «estas URLs
  // tienen que ser borradas y eliminadas por completo»). No hay lista de
  // segmentos retirados ni 410: son segmentos desconocidos y caen al 404
  // fail-closed como cualquier otro, antes de AuthKit. El candado es que el
  // proxy no los nombre.
  it.each([
    '/es/investors',
    '/es/investors/nested',
    '/es/deals',
    '/es/companies',
    '/es/pricing',
    '/es/precios',
    '/es/checkout',
    '/es/messages',
    '/es/portfolio',
    '/es/my-company/deals',
  ])('treats the former marketplace path %s as an unknown route (404) before AuthKit', async (path) => {
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

    expect(mockAuthkit).not.toHaveBeenCalled()
    expect(mockIntlMiddleware).not.toHaveBeenCalled()
    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('x-middleware-rewrite')).toMatch(/\/es\/__not-found__$/)
  })

  it.each(['/es/investors', '/es/deals'])(
    'treats %s as an unknown route (404) in dev-auth mode too',
    async (path) => {
      process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      expect(response.status).toBe(404)
      expect(response.headers.get('location')).toBeNull()
    }
  )

  it('does not carry a retired-segment list or a 410 branch', () => {
    const source = readFileSync(join(process.cwd(), 'src/proxy.ts'), 'utf8')

    expect(source).not.toContain('410')
    expect(source).not.toContain('unpublished')
    for (const segment of ['investors', 'deals', 'companies', 'pricing', 'precios']) {
      expect(source, `proxy.ts must not name the retired segment ${segment}`).not.toMatch(
        new RegExp(`['"\`]${segment}['"\`]`)
      )
    }
  })

  it('sends the unlocalized /mycroft to locale negotiation before the home redirect', async () => {
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest('http://localhost:3000/mycroft'))

    expect(mockAuthkit).not.toHaveBeenCalled()
    expect(mockIntlMiddleware).toHaveBeenCalledTimes(1)
    expect(response.headers.get('x-test-intl-middleware')).toBe('hit')
  })

  // ===== UN SOLO HUB DE AYUDA ([F] 2026-09-01) =====
  // /help (Centro de Ayuda) y /roadmap se fusionaron en /ayuda. Las dos rutas
  // viejas circularon en navbar, footer, 404 y sitemap, así que responden 308 —
  // permanente y sin método perdido — antes de AuthKit y sin tocar el router.
  it.each([
    ['/es/help', '/es/ayuda'],
    ['/es/roadmap', '/es/ayuda'],
  ])('redirects the retired hub path %s to %s before AuthKit', async (path, expected) => {
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest(`http://localhost:3000${path}?utm=x`))

    expect(response.status).toBe(308)
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe(expected)
    expect(mockAuthkit).not.toHaveBeenCalled()
    expect(mockIntlMiddleware).not.toHaveBeenCalled()
  })

  it.each(['/es/help', '/es/roadmap'])(
    'redirects the retired hub path %s to the hub in dev-auth mode too',
    async (path) => {
      process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe('http://localhost:3000/es/ayuda')
    }
  )

  it.each(['/es/mycroft'])(
    'redirects the retired intake path %s home in dev-auth mode too',
    async (path) => {
      process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      expect(response.status).toBe(307)
      const locale = path.split('/')[1]
      expect(response.headers.get('location')).toBe(`http://localhost:3000/${locale}`)
    }
  )

  it.each([
    '/es/ayuda/anything',
    '/es/help/anything',
    '/es/terms/nested',
    '/es/legal/foo',
    '/es/roadmap/votes',
  ])(
    'rewrites nested paths under leaf public segments (%s) to the localized 404 without AuthKit',
    async (path) => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockAuthkit).not.toHaveBeenCalled()
      expect(response.status).toBe(404)
      const locale = path.split('/')[1]
      expect(response.headers.get('x-middleware-rewrite')).toBe(
        `http://localhost:3000/${locale}/__not-found__`
      )
    }
  )

  it.each(['/es/vdr-guest/copied-handle', '/es/vdr-guest/anything/nested'])(
    'returns a direct privacy-hardened 404 for guest nested path %s',
    async (path) => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockAuthkit).not.toHaveBeenCalled()
      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      expect(response.status).toBe(404)
      expect(response.headers.get('x-middleware-rewrite')).toBeNull()
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('x-robots-tag')).toContain('noindex')
    }
  )

  it('lets authenticated dev-auth API routes reach their route handlers without i18n middleware', async () => {
    process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
    const { proxy } = await import('@/proxy')

    const response = await proxy(
      new NextRequest('http://localhost:3000/api/documents/upload', {
        headers: {
          cookie: 'sherlock_dev_user=dev_company_001; sherlock_dev_role=COMPANY',
        },
      })
    )

    expect(mockIntlMiddleware).not.toHaveBeenCalled()
    expect(response.headers.get('x-test-intl-middleware')).toBeNull()
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it.each([undefined, 'qa-dev-request', 'qa request<>:dev'])(
    'returns a correlated no-store 401 for unauthenticated dev-auth APIs with ID %s',
    async (incomingId) => {
      process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
      const { proxy } = await import('@/proxy')
      const headers = new Headers()
      if (incomingId !== undefined) headers.set('x-request-id', incomingId)
      const response = await proxy(
        new NextRequest('http://localhost:3000/api/documents/upload', { headers })
      )

      const requestId = response.headers.get('x-request-id')
      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      expect(mockAuthkit).not.toHaveBeenCalled()
      expect(response.status).toBe(401)
      expect(requestId).toMatch(/^[A-Za-z0-9_.:-]+$/)
      if (incomingId !== undefined) {
        expect(requestId).toBe(incomingId.replace(/[^A-Za-z0-9_.:-]/g, ''))
      }
      expect(response.headers.get('x-correlation-id')).toBe(requestId)
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized', requestId })
    }
  )

  it('lets the public health check API reach its route handler in dev-auth mode', async () => {
    process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest('http://localhost:3000/api/health'))

    expect(mockIntlMiddleware).not.toHaveBeenCalled()
    expect(response.headers.get('x-test-intl-middleware')).toBeNull()
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it('lets only the exact guest VDR API allowlist bypass WorkOS in dev-auth mode', async () => {
    process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
    const { proxy } = await import('@/proxy')

    const guest = await proxy(new NextRequest('http://localhost:3000/api/vdr/guest/session'))
    const unregisteredGuestNested = await proxy(
      new NextRequest('http://localhost:3000/api/vdr/guest/internal/session')
    )
    const neighboringPrivate = await proxy(
      new NextRequest('http://localhost:3000/api/vdr/internal/session')
    )
    const nestedGuestDocument = await proxy(
      new NextRequest('http://localhost:3000/api/vdr/guest/documents/document_1/extra')
    )

    expect(guest.headers.get('x-middleware-next')).toBe('1')
    for (const response of [unregisteredGuestNested, nestedGuestDocument, neighboringPrivate]) {
      const requestId = response.headers.get('x-request-id')
      expect(response.status).toBe(401)
      expect(requestId).toMatch(/^[A-Za-z0-9_.:-]+$/)
      expect(response.headers.get('cache-control')).toContain('no-store')
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized', requestId })
    }
  })

  it.each([
    '/api/vdr/guest/documents/document_1',
    '/api/vdr/guest/logout',
    '/api/vdr/guest/nda',
    '/api/vdr/guest/otp/request',
    '/api/vdr/guest/room',
    '/api/vdr/guest/session',
    '/api/vdr/guest/verify',
  ])('lets the guest VDR endpoint %s reach its cookie/HMAC auth without WorkOS', async (path) => {
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

    expect(mockAuthkit).not.toHaveBeenCalled()
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it.each(['/es/ayuda', '/es/terms', '/es/privacy'])(
    'runs AuthKit state for public WorkOS page %s before i18n',
    async (path) => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockAuthkit).toHaveBeenCalledTimes(1)
      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1)
      expect(mockPartitionAuthkitHeaders).toHaveBeenCalledTimes(1)
      expect(mockApplyResponseHeaders).toHaveBeenCalledTimes(1)
      expect(response.headers.get('x-test-intl-middleware')).toBe('hit')
      expect(response.headers.get('x-test-authkit-response')).toBe('hit')
      expect(response.status).not.toBe(307)
    }
  )

  it.each(['/ayuda', '/terms', '/privacy'])(
    'sends unlocalized public page %s to locale negotiation, not to the auth check',
    async (path) => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1)
      expect(response.headers.get('x-test-intl-middleware')).toBe('hit')
      expect(response.status).not.toBe(307)
      // AuthKit no corre en este hop: un path sin locale se resuelve a su
      // equivalente localizado ANTES de la comprobación de sesión (ver
      // isLocalelessPagePath en src/proxy.ts). El request que sigue al 307
      // vuelve a entrar por el proxy y ahí sí pasa por AuthKit con normalidad.
      expect(mockAuthkit).not.toHaveBeenCalled()
    }
  )

  it('builds the public sitemap from NEXT_PUBLIC_APP_URL for the only locale', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://metadata.example.com'
    const { default: sitemap } = await import('@/app/sitemap')

    const entries = sitemap()
    const urls = entries.map((entry) => entry.url)

    expect(entries).toHaveLength(5)
    expect(urls).toEqual([
      'https://metadata.example.com/es',
      'https://metadata.example.com/es/ayuda',
      'https://metadata.example.com/es/privacy',
      'https://metadata.example.com/es/terms',
      'https://metadata.example.com/es/legal',
    ])
    expect(urls.some((url) => url.includes('/en'))).toBe(false)
    // Un `hreflang` alterno anuncia una cara que ya no se sirve: sin segundo
    // locale la entrada no lleva `alternates.languages`.
    for (const entry of entries) {
      expect(entry.alternates?.languages).toBeUndefined()
    }
  })

  it('keeps direct root login and callback URLs available', async () => {
    const { proxy } = await import('@/proxy')

    for (const path of ['/login', '/callback?code=abc&state=xyz']) {
      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))
      expect(response.status).toBe(200)
      expect(response.headers.get('x-middleware-next')).toBe('1')
    }
  })
})

// ============================================================================
// LOCALE-LESS PATHS (staging walkthrough, 2026-07-25)
// ============================================================================
// A path with no locale prefix matches no route — every page lives under
// /[locale]/. Locale negotiation must run before the auth check without becoming
// a way around the protected-route boundary.
// ============================================================================
describe('proxy — locale-less paths', () => {
  beforeEach(() => {
    vi.resetModules()
    mockIntlMiddleware.mockClear()
    mockAuthkit.mockClear()
    delete process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED
  })

  it.each(['/admin', '/onboarding', '/onboarding/provision', '/settings'])(
    'does not let the locale-less form of protected route %s escape auth',
    async (segment) => {
      const { proxy } = await import('@/proxy')

      // Hop 1: no locale, so next-intl redirects to the negotiated locale. No
      // session is granted here — nothing is served yet.
      await proxy(new NextRequest(`http://localhost:3000${segment}`))
      expect(mockIntlMiddleware).toHaveBeenCalledTimes(1)

      // Hop 2: the browser follows that redirect, and the localized form is
      // still gated exactly as before. THIS is the assertion that keeps the
      // negotiation from becoming an auth bypass.
      mockIntlMiddleware.mockClear()
      const localized = await proxy(new NextRequest(`http://localhost:3000/es${segment}`))

      expect(mockAuthkit, `/es${segment} must stay behind WorkOS AuthKit`).toHaveBeenCalledTimes(1)
      expect(localized.status).toBe(307)
      expect(localized.headers.get('location')).toBe('http://localhost:3000/login')
    }
  )

  it('leaves locale-less API routes alone — they are not localized pages', async () => {
    const { proxy } = await import('@/proxy')

    await proxy(new NextRequest('http://localhost:3000/api/documents/upload'))

    expect(mockIntlMiddleware, 'API routes must never be locale-negotiated').not.toHaveBeenCalled()
    expect(mockAuthkit).toHaveBeenCalledTimes(1)
  })

  it.each(['/callback?code=abc', '/login', '/logout', '/signup'])(
    'leaves root AuthKit route %s alone',
    async (path) => {
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}`))

      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      expect(response.headers.get('x-middleware-next')).toBe('1')
    }
  )
})

// ============================================================================
// COMPUERTA DE ROL DEL PANEL
// ============================================================================
// `requireRole` vive dentro de la página, y para cuando decide, el shell de
// `/admin` (layout + loading.tsx) ya salió por streaming: el `redirect()` llega
// detrás de un 200 y el navegador lo cobra como hydration mismatch. El rebote
// se decide acá, antes de renderizar nada. `requireRole` se queda en cada
// página como defensa en profundidad y sigue siendo quien resuelve el step-up.
// ============================================================================
describe('proxy — admin role gate', () => {
  beforeEach(() => {
    vi.resetModules()
    mockIntlMiddleware.mockClear()
    mockAuthkit.mockClear()
    mockConvexSetAuth.mockClear()
    mockConvexQuery.mockClear()
    mockConvexQuery.mockResolvedValue(null)
    authkitSession.current = { user: null }
    delete process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://convex.example.test')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(['/es/admin', '/es/admin/companies', '/es/admin/gdpr'])(
    'bounces a WorkOS COMPANY session off %s with a 307 to its own home',
    async (path) => {
      authkitSession.current = { user: { id: 'user_01' }, accessToken: 'access-token-01' }
      mockConvexQuery.mockResolvedValue({ user: {}, profile: { role: 'COMPANY' } })
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}?tab=x`))

      expect(mockConvexSetAuth).toHaveBeenCalledWith('access-token-01')
      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toBe('http://localhost:3000/es/my-company/documents')
      // El rebote ocurre ANTES del render: nada del shell de /admin se emitió.
      expect(mockIntlMiddleware).not.toHaveBeenCalled()
    }
  )

  // ===== STEP-UP DEL ADMIN (A1-05) =====
  // El marcador `sherlock_admin_step_up` va atado al `sub` y al `sid` de WorkOS
  // y firmado con el secreto de step-up; el proxy lo verifica con la misma
  // función que `requireRole`, así que la decisión es una sola.
  const ADMIN_STEP_UP_SECRET = 'proxy-test-admin-step-up-secret-with-entropy'

  async function adminStepUpCookie(binding: { subject: string; sessionId: string }) {
    vi.stubEnv('WORKOS_ADMIN_STEP_UP_COOKIE_SECRET', ADMIN_STEP_UP_SECRET)
    const { ADMIN_STEP_UP_COOKIE_NAME, createAdminStepUpCookieValue } =
      await import('@/lib/auth/admin-step-up')
    const marker = createAdminStepUpCookieValue('Passkey', binding)
    if (!marker) throw new Error('No se pudo acuñar el marcador de step-up para la prueba')
    return `${ADMIN_STEP_UP_COOKIE_NAME}=${marker}`
  }

  it('lets a WorkOS ADMIN session with a recent step-up marker through to the panel', async () => {
    authkitSession.current = {
      user: { id: 'user_02' },
      accessToken: 'access-token-02',
      sessionId: 'session_02',
    }
    mockConvexQuery.mockResolvedValue({ user: {}, profile: { role: 'ADMIN' } })
    const cookie = await adminStepUpCookie({ subject: 'user_02', sessionId: 'session_02' })
    const { proxy } = await import('@/proxy')

    const response = await proxy(
      new NextRequest('http://localhost:3000/es/admin', { headers: { cookie } })
    )

    expect(mockIntlMiddleware).toHaveBeenCalledTimes(1)
    expect(response.status).not.toBe(307)
  })

  it.each(['/es/admin', '/es/admin/companies'])(
    'bounces a WorkOS ADMIN without a step-up marker off %s to settings before the shell',
    async (path) => {
      authkitSession.current = {
        user: { id: 'user_02' },
        accessToken: 'access-token-02',
        sessionId: 'session_02',
      }
      mockConvexQuery.mockResolvedValue({ user: {}, profile: { role: 'ADMIN' } })
      vi.stubEnv('WORKOS_ADMIN_STEP_UP_COOKIE_SECRET', ADMIN_STEP_UP_SECRET)
      const { proxy } = await import('@/proxy')

      const response = await proxy(new NextRequest(`http://localhost:3000${path}?tab=x`))

      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toBe(
        'http://localhost:3000/es/settings?error=admin-mfa-required'
      )
      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      expect(response.headers.get('x-test-authkit-response')).toBe('hit')
    }
  )

  it('does not honour a step-up marker minted for another WorkOS session', async () => {
    authkitSession.current = {
      user: { id: 'user_02' },
      accessToken: 'access-token-02',
      sessionId: 'session_02',
    }
    mockConvexQuery.mockResolvedValue({ user: {}, profile: { role: 'ADMIN' } })
    const cookie = await adminStepUpCookie({ subject: 'user_02', sessionId: 'session_previous' })
    const { proxy } = await import('@/proxy')

    const response = await proxy(
      new NextRequest('http://localhost:3000/es/admin', { headers: { cookie } })
    )

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/es/settings?error=admin-mfa-required'
    )
    expect(mockIntlMiddleware).not.toHaveBeenCalled()
  })

  it('never asks for the step-up marker outside the admin segment', async () => {
    authkitSession.current = {
      user: { id: 'user_02' },
      accessToken: 'access-token-02',
      sessionId: 'session_02',
    }
    mockConvexQuery.mockResolvedValue({ user: {}, profile: { role: 'ADMIN' } })
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest('http://localhost:3000/es/settings'))

    expect(mockConvexQuery).not.toHaveBeenCalled()
    expect(response.status).not.toBe(307)
  })

  it('only pays the Convex lookup on the admin segment', async () => {
    authkitSession.current = { user: { id: 'user_03' }, accessToken: 'access-token-03' }
    const { proxy } = await import('@/proxy')

    await proxy(new NextRequest('http://localhost:3000/es/my-company/documents'))
    await proxy(new NextRequest('http://localhost:3000/es/settings'))
    await proxy(new NextRequest('http://localhost:3000/api/admin/activity'))

    expect(mockConvexQuery).not.toHaveBeenCalled()
  })

  it('never asks Convex for a request that has no session yet', async () => {
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest('http://localhost:3000/es/admin'))

    expect(mockConvexQuery).not.toHaveBeenCalled()
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/login')
  })

  it.each([
    ['a Convex failure', () => mockConvexQuery.mockRejectedValue(new Error('convex down'))],
    ['a session without a Convex profile yet', () => mockConvexQuery.mockResolvedValue(null)],
  ])('lets the request reach requireRole on %s instead of erroring', async (_case, arrange) => {
    authkitSession.current = { user: { id: 'user_04' }, accessToken: 'access-token-04' }
    arrange()
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest('http://localhost:3000/es/admin'))

    expect(mockIntlMiddleware).toHaveBeenCalledTimes(1)
    expect(response.status).not.toBe(307)
    expect(response.status).toBeLessThan(500)
  })

  it('defers to requireRole when the Convex URL is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', '')
    authkitSession.current = { user: { id: 'user_05' }, accessToken: 'access-token-05' }
    const { proxy } = await import('@/proxy')

    const response = await proxy(new NextRequest('http://localhost:3000/es/admin'))

    expect(mockConvexQuery).not.toHaveBeenCalled()
    expect(mockIntlMiddleware).toHaveBeenCalledTimes(1)
    expect(response.status).not.toBe(307)
  })

  it.each(['/es/admin', '/es/admin/companies'])(
    'bounces a dev-auth COMPANY session off %s without touching Convex',
    async (path) => {
      process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
      const { proxy } = await import('@/proxy')

      const response = await proxy(
        new NextRequest(`http://localhost:3000${path}`, {
          headers: { cookie: 'sherlock_dev_user=dev_company_001; sherlock_dev_role=COMPANY' },
        })
      )

      expect(mockConvexQuery).not.toHaveBeenCalled()
      expect(mockIntlMiddleware).not.toHaveBeenCalled()
      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toBe('http://localhost:3000/es/my-company/documents')
    }
  )

  it('lets a dev-auth ADMIN session into the panel', async () => {
    process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
    const { proxy } = await import('@/proxy')

    const response = await proxy(
      new NextRequest('http://localhost:3000/es/admin', {
        headers: { cookie: 'sherlock_dev_user=dev_admin_001; sherlock_dev_role=ADMIN' },
      })
    )

    expect(mockIntlMiddleware).toHaveBeenCalledTimes(1)
    expect(response.status).not.toBe(307)
  })

  // Igual que `requireRole`: ahí el rol que decide es `user.role`, el REAL, no
  // el efectivo. Un ADMIN mirando la app como empresa conserva el panel.
  it('keeps a dev-auth ADMIN in the panel while viewing as COMPANY', async () => {
    process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
    const { proxy } = await import('@/proxy')

    const response = await proxy(
      new NextRequest('http://localhost:3000/es/admin', {
        headers: { cookie: 'sherlock_dev_user=dev_admin_001; sherlock_dev_role=COMPANY' },
      })
    )

    expect(mockIntlMiddleware).toHaveBeenCalledTimes(1)
    expect(response.status).not.toBe(307)
  })
})
