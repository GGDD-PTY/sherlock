import { describe, it, expect } from 'vitest'
import { apiError, apiSuccess, getOrCreateRequestId, withRequestIdHeader } from '@/lib/api/response'

describe('lib/api/response', () => {
  const createRequest = (requestId?: string) =>
    new Request('https://example.com', {
      method: 'GET',
      headers: requestId ? { 'x-request-id': requestId } : undefined,
    } as RequestInit)

  it('uses existing x-request-id header when present', async () => {
    const request = createRequest('existing-id')
    const requestId = getOrCreateRequestId(request)
    expect(requestId).toBe('existing-id')
  })

  // El `x-request-id` es texto del CLIENTE y lo repetimos en el cuerpo, en dos
  // cabeceras, en cada log y en la fila del aviso de 5xx. Se sanea en la
  // frontera: forma conocida, largo acotado, y si no queda nada, uno propio.
  it('sanitizes a client x-request-id instead of echoing it raw', () => {
    expect(getOrCreateRequestId(createRequest('req_A-1.2:3'))).toBe('req_A-1.2:3')
    expect(getOrCreateRequestId(createRequest('id con espacios y <script>'))).toBe(
      'idconespaciosyscript'
    )
    expect(getOrCreateRequestId(createRequest('x'.repeat(500))).length).toBe(128)
    expect(getOrCreateRequestId(createRequest('@'))).toMatch(/^request-\d+-[a-z0-9]+$/)
  })

  it('generates request id when x-request-id header is missing', () => {
    const request = createRequest()
    const requestId = getOrCreateRequestId(request)
    expect(requestId).toMatch(/^request-\d+-[a-z0-9]+$/)
  })

  it('adds request id header to response', async () => {
    const request = createRequest()
    const requestId = getOrCreateRequestId(request)
    const response = withRequestIdHeader(new Response('ok'), requestId)

    expect(response.headers.get('x-request-id')).toBe(requestId)
    expect(response.headers.get('x-correlation-id')).toBe(requestId)
  })

  it('builds apiSuccess response with request id and status', async () => {
    const response = apiSuccess({ ok: true }, 'success-id')
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBe('success-id')
    expect(response.headers.get('x-correlation-id')).toBe('success-id')
    expect(data).toEqual({ requestId: 'success-id', ok: true })
  })

  it('builds apiError response with request id and status', async () => {
    const response = apiError('error-id', 422, {
      error: 'Invalid payload',
      code: 'INVALID_JSON',
    })
    const data = await response.json()

    expect(response.status).toBe(422)
    expect(response.headers.get('x-request-id')).toBe('error-id')
    expect(response.headers.get('x-correlation-id')).toBe('error-id')
    expect(data).toEqual({ requestId: 'error-id', error: 'Invalid payload', code: 'INVALID_JSON' })
  })
})

describe('withRequestIdHeader and Cache-Control', () => {
  it('denies caching when the route set no Cache-Control', () => {
    const response = withRequestIdHeader(new Response('ok'), 'req-1')
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('keeps a Cache-Control the route already set', () => {
    const response = withRequestIdHeader(
      new Response('ok', { headers: { 'Cache-Control': 'public, max-age=10' } }),
      'req-2'
    )
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=10')
    expect(response.headers.get('x-request-id')).toBe('req-2')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})
