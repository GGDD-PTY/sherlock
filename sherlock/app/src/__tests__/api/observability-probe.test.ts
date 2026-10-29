// ============================================================================
// POST /api/observability/probe — las puertas del probe de 5xx (A7)
// ============================================================================
// Contratos: todo lo que no traiga el bearer correcto responde 404 — secreto
// sin configurar, bearer ausente, esquema equivocado o secreto que no cuadra —
// para que la respuesta no diga si el probe existe en este deployment ni si el
// intento se acercó; ninguno pasa por `captureServerException` (un rechazo no
// puede auto-dispararse como incidente). Con el bearer correcto devuelve 500
// con el requestId y ese sí atraviesa el camino de captura con
// `synthetic: true`.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

type CapturedException = {
  error: unknown
  requestId: string
  status: number
  route?: string
  synthetic?: boolean
}

const captureServerException = vi.fn(async (_input: CapturedException) => true)
const mockRateLimit = vi.fn(async (_identifier: string, _config?: unknown) => ({
  success: true,
  remaining: 10,
  resetAt: new Date(Date.now() + 60_000),
  retryAfterSec: 0,
}))

vi.mock('@/lib/observability/posthog-server-exception', () => ({
  captureServerException: (input: CapturedException) => captureServerException(input),
  wasServerExceptionCaptured: () => false,
}))
vi.mock('@/lib/utils/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/rate-limit')>()
  return {
    ...actual,
    checkRateLimitDistributed: (identifier: string, config?: unknown) =>
      mockRateLimit(identifier, config),
  }
})

const SECRET = 'observability-probe-secret-for-tests-123456' // gitleaks:allow -- deterministic test fixture, not a provider credential

function request(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/api/observability/probe', {
    method: 'POST',
    headers,
  })
}

async function loadRoute() {
  return await import('@/app/api/observability/probe/route')
}

describe('POST /api/observability/probe', () => {
  beforeEach(() => {
    vi.resetModules()
    captureServerException.mockClear()
    mockRateLimit.mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('responde 404 y no captura nada cuando el secreto no está configurado', async () => {
    vi.stubEnv('OBSERVABILITY_PROBE_SECRET', '')
    const { POST } = await loadRoute()

    const response = await POST(request({ authorization: `Bearer ${SECRET}` }))

    expect(response.status).toBe(404)
    expect(captureServerException).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({ error: 'No encontrado' })
  })

  it('responde 404 cuando el secreto configurado es demasiado corto', async () => {
    vi.stubEnv('OBSERVABILITY_PROBE_SECRET', 'corto')
    const { POST } = await loadRoute()

    const response = await POST(request({ authorization: 'Bearer corto' }))

    expect(response.status).toBe(404)
    expect(captureServerException).not.toHaveBeenCalled()
  })

  // UNA SOLA RESPUESTA PARA TODO RECHAZO. Con 401 sin bearer y 403 con bearer
  // equivocado, un curl decía dos cosas gratis: que el probe está armado en
  // este deployment, y — porque la comparación se cortaba por largo — si el
  // intento tenía el largo correcto. El 404 es el mismo que da una ruta que no
  // existe; quién intentó qué queda en el log del servidor.
  it('responde 404 a todo rechazo, sin decir si el probe existe, nunca 5xx', async () => {
    vi.stubEnv('OBSERVABILITY_PROBE_SECRET', SECRET)
    const { POST } = await loadRoute()

    const rechazos: Array<Record<string, string>> = [
      {},
      { authorization: `Basic ${SECRET}` },
      { authorization: `Bearer ${'z'.repeat(SECRET.length)}` },
      { authorization: 'Bearer zzz' },
      { authorization: `Bearer ${'z'.repeat(5_000)}` },
    ]
    for (const headers of rechazos) {
      const response = await POST(request(headers))
      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({ error: 'No encontrado' })
    }

    expect(captureServerException).not.toHaveBeenCalled()
  })

  // Sin handler propio, Next contesta 405 a un GET y eso también delata que la
  // ruta existe.
  it('un GET responde 404 como cualquier ruta ausente', async () => {
    vi.stubEnv('OBSERVABILITY_PROBE_SECRET', SECRET)
    const { GET } = await loadRoute()

    const response = await GET(request())

    expect(response.status).toBe(404)
    expect(captureServerException).not.toHaveBeenCalled()
  })

  it('con el bearer correcto devuelve 500 con requestId y dispara la captura sintética', async () => {
    vi.stubEnv('OBSERVABILITY_PROBE_SECRET', SECRET)
    const { POST } = await loadRoute()
    const { OBSERVABILITY_PROBE_ROUTE, OBSERVABILITY_PROBE_ERROR_NAME } =
      await import('@/lib/observability/probe')

    const response = await POST(
      request({ authorization: `Bearer ${SECRET}`, 'x-request-id': 'probe-request-1' })
    )

    expect(response.status).toBe(500)
    expect(response.headers.get('x-request-id')).toBe('probe-request-1')
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    await expect(response.json()).resolves.toMatchObject({
      requestId: 'probe-request-1',
      synthetic: true,
    })

    expect(captureServerException).toHaveBeenCalledOnce()
    const captured = captureServerException.mock.calls[0]?.[0]
    expect(captured?.route).toBe(OBSERVABILITY_PROBE_ROUTE)
    expect(captured?.status).toBe(500)
    expect(captured?.synthetic).toBe(true)
    expect(captured?.requestId).toBe('probe-request-1')
    expect((captured?.error as Error).name).toBe(OBSERVABILITY_PROBE_ERROR_NAME)
  })

  it('respeta el rate limit y no dispara la captura cuando lo excede', async () => {
    vi.stubEnv('OBSERVABILITY_PROBE_SECRET', SECRET)
    mockRateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
      retryAfterSec: 42,
    })
    const { POST } = await loadRoute()

    const response = await POST(request({ authorization: `Bearer ${SECRET}` }))

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('42')
    // El 429 también es una respuesta de la API: envelope con requestId y los
    // headers de seguridad, no un `new Response` a mano.
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    await expect(response.json()).resolves.toMatchObject({ retryAfter: 42 })
    expect(captureServerException).not.toHaveBeenCalled()
  })

  it('limita también después de autenticar, con un tope global aparte del de IP', async () => {
    vi.stubEnv('OBSERVABILITY_PROBE_SECRET', SECRET)
    mockRateLimit.mockResolvedValueOnce({
      success: true,
      remaining: 9,
      resetAt: new Date(Date.now() + 60_000),
      retryAfterSec: 0,
    })
    mockRateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 300_000),
      retryAfterSec: 300,
    })
    const { POST } = await loadRoute()

    const response = await POST(request({ authorization: `Bearer ${SECRET}` }))

    expect(response.status).toBe(429)
    expect(mockRateLimit).toHaveBeenCalledTimes(2)
    expect(mockRateLimit.mock.calls[0]?.[0]).toMatch(/^observability-probe:attempt:/)
    expect(mockRateLimit.mock.calls[1]?.[0]).toBe('observability-probe:fire')
    expect(captureServerException).not.toHaveBeenCalled()
  })
})
