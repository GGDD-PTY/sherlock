import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type CapturePayload = {
  properties: Record<string, unknown> & {
    $exception_list: Array<{ type: string; value: string }>
  }
}

function payloadOf(fetchMock: ReturnType<typeof vi.fn>): CapturePayload {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit
  return JSON.parse(String(init.body)) as CapturePayload
}

function stubProductionEnv() {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test_project_key')
  vi.stubEnv('POSTHOG_INGEST_HOST', 'https://us.i.posthog.com')
}

function okFetch() {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('onRequestError', () => {
  beforeEach(() => {
    vi.resetModules()
    stubProductionEnv()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('reports a render error with route, locale, router context and requestId', async () => {
    const fetchMock = okFetch()
    const { onRequestError } = await import('@/instrumentation')

    await onRequestError(
      new Error('render boom'),
      {
        path: '/es/vdr/deal-1?email=private@example.com',
        method: 'GET',
        headers: { 'x-request-id': 'request-9' },
      },
      { routerKind: 'App Router', routePath: '/[locale]/vdr/[dealId]', routeType: 'render' }
    )

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://us.i.posthog.com/e/')
    const payload = payloadOf(fetchMock)
    expect(payload.properties).toMatchObject({
      requestId: 'request-9',
      status: 500,
      route: '/[locale]/vdr/[dealId]',
      locale: 'es',
      routerKind: 'App Router',
      routeType: 'render',
      distinct_id: 'server',
      $process_person_profile: false,
    })
    expect(payload.properties.$exception_list[0]).toMatchObject({
      type: 'Error',
      value: 'render boom',
    })
  })

  it('never ships headers, cookies or the raw request path', async () => {
    const fetchMock = okFetch()
    const { onRequestError } = await import('@/instrumentation')

    await onRequestError(
      new Error('action boom'),
      {
        path: '/es/my-company/documents?email=private@example.com',
        method: 'POST',
        headers: {
          cookie: 'wos-session=super-secret',
          authorization: 'Bearer super-secret',
          'x-request-id': 'request-10',
        },
      },
      { routerKind: 'App Router', routePath: '/[locale]/my-company/documents', routeType: 'action' }
    )

    expect(fetchMock).toHaveBeenCalledOnce()
    const serialized = JSON.stringify(payloadOf(fetchMock))
    expect(serialized).not.toContain('super-secret')
    expect(serialized).not.toContain('cookie')
    expect(serialized).not.toContain('authorization')
    expect(serialized).not.toContain('private@example.com')
    expect(serialized).not.toContain('/es/my-company/documents')
  })

  it('does not repeat an error that apiError already reported', async () => {
    const fetchMock = okFetch()
    const { apiError } = await import('@/lib/api/response')
    const { onRequestError } = await import('@/instrumentation')
    const error = new Error('double boom')

    apiError('request-11', 500, { error: 'internal_error' }, { error, route: '/api/vdr/export' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())

    await onRequestError(
      error,
      { path: '/api/vdr/export', method: 'POST', headers: {} },
      { routerKind: 'App Router', routePath: '/api/vdr/export', routeType: 'route' }
    )

    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('still reports a route handler error that never reached apiError', async () => {
    const fetchMock = okFetch()
    const { onRequestError } = await import('@/instrumentation')

    await onRequestError(
      new TypeError('uncaught handler boom'),
      { path: '/api/vdr/export', method: 'POST', headers: {} },
      { routerKind: 'App Router', routePath: '/api/vdr/export', routeType: 'route' }
    )

    expect(fetchMock).toHaveBeenCalledOnce()
    const payload = payloadOf(fetchMock)
    expect(payload.properties.route).toBe('/api/vdr/export')
    expect(payload.properties.requestId).toMatch(/^request-\d+-[a-z0-9]+$/)
    expect(payload.properties.locale).toBeUndefined()
  })
})

// ============================================================================
// EL CAMINO DE RENDER ES EL ÚNICO QUE NO PASA POR apiError()
// ============================================================================
// Un 500 de página, de RSC o de un handler que revienta sin `apiError()` sólo
// llega por `onRequestError`, donde `after()` TIRA (`after.js` exige un work
// store de request y lanza E468 fuera de él). El fallback dejaba la entrega
// como promesa flotante que la función serverless puede congelar antes de que
// asiente: el aviso del camino de render no salía. `onRequestError` es una
// promesa que Next sí awaitea, y la respuesta ya salió, así que esperar acá no
// le cuesta un milisegundo al cliente.
// ============================================================================
describe('onRequestError — la entrega del aviso no queda flotando', () => {
  beforeEach(() => {
    vi.resetModules()
    stubProductionEnv()
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://example.convex.cloud')
    vi.stubEnv('CONVEX_DEPLOY_KEY', 'prod:example|deadbeef')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.doUnmock('next/server')
    vi.doUnmock('@/lib/convex/admin-client')
  })

  it('espera la entrega a Convex cuando after() no existe fuera de la request', async () => {
    okFetch()
    let entregado = false
    const mutation = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      entregado = true
    })
    vi.doMock('next/server', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('next/server')
      return {
        ...actual,
        after: () => {
          throw new Error('`after` was called outside a request scope')
        },
      }
    })
    vi.doMock('@/lib/convex/admin-client', () => ({
      getConvexAdminClient: () => ({ mutation, query: vi.fn(), setAdminAuth: vi.fn() }),
    }))
    const { onRequestError } = await import('@/instrumentation')

    await onRequestError(
      new TypeError('render boom'),
      { path: '/es/vdr/deal-1', method: 'GET', headers: {} },
      { routerKind: 'App Router', routePath: '/[locale]/vdr/[dealId]', routeType: 'render' }
    )

    expect(entregado).toBe(true)
  })

  it('no espera nada cuando after() sí agenda la entrega', async () => {
    okFetch()
    const mutation = vi.fn()
    vi.doMock('next/server', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('next/server')
      return { ...actual, after: vi.fn() }
    })
    vi.doMock('@/lib/convex/admin-client', () => ({
      getConvexAdminClient: () => ({ mutation, query: vi.fn(), setAdminAuth: vi.fn() }),
    }))
    const { onRequestError } = await import('@/instrumentation')

    await onRequestError(
      new TypeError('render boom'),
      { path: '/es/vdr/deal-1', method: 'GET', headers: {} },
      { routerKind: 'App Router', routePath: '/[locale]/vdr/[dealId]', routeType: 'render' }
    )

    expect(mutation).not.toHaveBeenCalled()
  })
})
