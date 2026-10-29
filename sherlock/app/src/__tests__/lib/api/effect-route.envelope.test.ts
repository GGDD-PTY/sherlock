import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'

import { respond, runRouteEffect } from '@/lib/api/effect-route'

const REQUEST = () => new Request('https://sherlock.capital/api/prueba')
const NO_STORE = 'no-store, no-cache, must-revalidate'

// El sobre lo pone `runRouteEffect`, no cada ruta: una respuesta cruda
// (`NextResponse.json`, un stream) y un rechazo temprano por el canal de error
// (429 del rate limit, 401 de auth) salen con las mismas cabeceras.
describe('runRouteEffect: el sobre de toda respuesta', () => {
  it('una respuesta cruda de la ruta sale con requestId, no-store y nosniff', async () => {
    const response = await runRouteEffect(
      REQUEST(),
      'GET /api/prueba',
      Effect.succeed(new Response('ok'))
    )

    const requestId = response.headers.get('x-request-id')
    expect(requestId).toEqual(expect.any(String))
    expect(response.headers.get('x-correlation-id')).toBe(requestId)
    expect(response.headers.get('Cache-Control')).toBe(NO_STORE)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(await response.text()).toBe('ok')
  })

  it('un rechazo temprano por el canal de error recibe el sobre y conserva sus cabeceras', async () => {
    const response = await runRouteEffect(
      REQUEST(),
      'GET /api/prueba',
      Effect.fail(
        respond(new Response('demasiadas', { status: 429, headers: { 'Retry-After': '7' } }))
      )
    )

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('7')
    expect(response.headers.get('x-request-id')).toEqual(expect.any(String))
    expect(response.headers.get('Cache-Control')).toBe(NO_STORE)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('un Cache-Control puesto por la ruta manda sobre el del sobre', async () => {
    const response = await runRouteEffect(
      REQUEST(),
      'GET /api/prueba',
      Effect.succeed(new Response('ok', { headers: { 'Cache-Control': 'private, no-store' } }))
    )

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('x-request-id')).toEqual(expect.any(String))
  })

  it('una respuesta con cabeceras inmutables sale envuelta en una copia con el mismo cuerpo', async () => {
    const immutable = new Response('cuerpo', {
      status: 206,
      headers: { 'Content-Type': 'text/plain' },
    })
    Object.defineProperty(immutable.headers, 'set', {
      value: () => {
        throw new TypeError('immutable')
      },
    })

    const response = await runRouteEffect(REQUEST(), 'GET /api/prueba', Effect.succeed(immutable))

    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Type')).toBe('text/plain')
    expect(response.headers.get('x-request-id')).toEqual(expect.any(String))
    expect(await response.text()).toBe('cuerpo')
  })
})
