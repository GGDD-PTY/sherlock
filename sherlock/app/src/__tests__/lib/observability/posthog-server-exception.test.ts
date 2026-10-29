import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type CapturePayload = {
  api_key: string
  event: string
  properties: Record<string, unknown> & {
    $exception_list: Array<{
      type: string
      value: string
      stacktrace: { type: string; frames: Array<Record<string, unknown>> }
    }>
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

describe('captureServerException', () => {
  beforeEach(() => {
    vi.resetModules()
    stubProductionEnv()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('posts a $exception event with name, message, raw frames, requestId, status and route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { captureServerException } = await import('@/lib/observability/posthog-server-exception')

    const error = new TypeError('boom')
    error.stack = [
      'TypeError: boom',
      '    at handler (/app/src/app/api/vdr/export/route.ts:210:9)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n')

    await expect(
      captureServerException({
        error,
        requestId: 'request-1',
        status: 500,
        route: '/api/vdr/export?email=private@example.com#secret',
        locale: 'es',
      })
    ).resolves.toBe(true)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://us.i.posthog.com/e/')
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.cache).toBe('no-store')
    expect(init.signal).toBeInstanceOf(AbortSignal)

    const payload = payloadOf(fetchMock)
    expect(payload.api_key).toBe('phc_test_project_key')
    expect(payload.event).toBe('$exception')
    expect(payload.properties.distinct_id).toBe('server')
    expect(payload.properties.requestId).toBe('request-1')
    expect(payload.properties.status).toBe(500)
    expect(payload.properties.route).toBe('/api/vdr/export')
    expect(payload.properties.locale).toBe('es')
    expect(payload.properties.$process_person_profile).toBe(false)
    expect(payload.properties.$exception_list).toHaveLength(1)
    expect(payload.properties.$exception_list[0]).toMatchObject({
      type: 'TypeError',
      value: 'boom',
      stacktrace: { type: 'raw' },
    })
    expect(payload.properties.$exception_list[0]?.stacktrace.frames[0]).toMatchObject({
      filename: '/app/src/app/api/vdr/export/route.ts',
      function: 'handler',
      lineno: 210,
      colno: 9,
      in_app: true,
    })
    expect(payload.properties.$exception_list[0]?.stacktrace.frames[1]).toMatchObject({
      in_app: false,
    })
  })

  it('never carries request headers, cookies, bodies or a user identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { captureServerException } = await import('@/lib/observability/posthog-server-exception')

    await captureServerException({
      error: new Error('boom'),
      requestId: 'request-2',
      status: 503,
      route: '/api/intake/claim',
    })

    const payload = payloadOf(fetchMock)
    expect(payload.properties).not.toHaveProperty('headers')
    expect(payload.properties).not.toHaveProperty('cookie')
    expect(payload.properties).not.toHaveProperty('body')
    expect(payload.properties).not.toHaveProperty('email')
    expect(payload.properties).not.toHaveProperty('userId')
    expect(payload.properties.$geoip_disable).toBe(true)
    expect(Object.keys(payload.properties).sort()).toEqual([
      '$exception_level',
      '$exception_list',
      '$geoip_disable',
      '$process_person_profile',
      'distinct_id',
      'requestId',
      'route',
      'status',
      'token',
    ])
  })

  it('rejects a locale that is not es or en', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { captureServerException } = await import('@/lib/observability/posthog-server-exception')

    await captureServerException({
      error: new Error('boom'),
      requestId: 'request-3',
      status: 500,
      locale: 'pt-BR',
    })

    expect(payloadOf(fetchMock).properties).not.toHaveProperty('locale')
  })

  it('describes the status when no error object reaches the helper', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { captureServerException } = await import('@/lib/observability/posthog-server-exception')

    await captureServerException({ requestId: 'request-4', status: 502 })

    expect(payloadOf(fetchMock).properties.$exception_list[0]).toEqual({
      type: 'ServerError',
      value: 'HTTP 502',
      mechanism: { handled: true, type: 'generic' },
      stacktrace: { type: 'raw', frames: [] },
    })
  })

  it.each([
    ['the project key is missing', 'NEXT_PUBLIC_POSTHOG_KEY', ''],
    ['the ingest host is missing', 'POSTHOG_INGEST_HOST', ''],
    ['the ingest host is not https', 'POSTHOG_INGEST_HOST', 'http://us.i.posthog.com'],
    ['the ingest host carries a query', 'POSTHOG_INGEST_HOST', 'https://us.i.posthog.com/?a=b'],
  ])('stays silent when %s', async (_label, name, value) => {
    vi.stubEnv(name, value)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { captureServerException } = await import('@/lib/observability/posthog-server-exception')

    await expect(
      captureServerException({ error: new Error('boom'), requestId: 'request-5', status: 500 })
    ).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stays silent outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { captureServerException } = await import('@/lib/observability/posthog-server-exception')

    await expect(
      captureServerException({ error: new Error('boom'), requestId: 'request-6', status: 500 })
    ).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never throws or retries when the capture request fails or times out', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))
    vi.stubGlobal('fetch', fetchMock)
    const { captureServerException } = await import('@/lib/observability/posthog-server-exception')

    await expect(
      captureServerException({ error: new Error('boom'), requestId: 'request-7', status: 500 })
    ).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('apiError exception capture', () => {
  beforeEach(() => {
    vi.resetModules()
    stubProductionEnv()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('reports a 5xx response to PostHog with the caught error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { apiError } = await import('@/lib/api/response')

    const response = apiError(
      'request-500',
      500,
      { error: 'No se pudo exportar' },
      {
        error: new Error('convex down'),
        route: '/api/vdr/export',
      }
    )

    expect(response.status).toBe(500)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const payload = payloadOf(fetchMock)
    expect(payload.properties.requestId).toBe('request-500')
    expect(payload.properties.route).toBe('/api/vdr/export')
    expect(payload.properties.$exception_list[0]).toMatchObject({ value: 'convex down' })
  })

  it('does not report a 4xx response', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { apiError } = await import('@/lib/api/response')

    apiError('request-400', 400, { error: 'Solicitud inválida' })

    await Promise.resolve()
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
