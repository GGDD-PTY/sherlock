import { afterEach, describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'

import { respond, RouteOperationError, runRouteEffect } from '@/lib/api/effect-route'

const REQUEST = () => new Request('https://sherlock.capital/api/prueba')

function errorCalls(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls as unknown as ReadonlyArray<ReadonlyArray<unknown>>
}

describe('runRouteEffect: lo que sale al log de un fallo', () => {
  afterEach(() => vi.restoreAllMocks())

  // El fallo se loguea dentro del programa, así que las anotaciones de la ruta
  // viajan en el fiber y las agrega `lib/effect/logger.ts`. Sin eso, el aviso
  // no dice de qué petición ni de qué ruta habla.
  it('lleva requestId y route junto a la operación que falló', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await runRouteEffect(
      REQUEST(),
      'GET /api/prueba',
      Effect.fail(new RouteOperationError({ operation: 'convex.listar', message: 'boom' }))
    )

    expect(response.status).toBe(500)

    const line = errorCalls(error).find(([message]) => message === 'Route operation failed')
    expect(line).toBeDefined()

    const [, payload, annotations] = line as ReadonlyArray<unknown>
    expect(payload).toMatchObject({ operation: 'convex.listar' })
    expect(annotations).toMatchObject({ route: 'GET /api/prueba' })
    expect((annotations as { requestId: unknown }).requestId).toEqual(expect.any(String))
  })

  it('un defecto sale con las mismas anotaciones', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await runRouteEffect(
      REQUEST(),
      'GET /api/prueba',
      Effect.sync(() => {
        throw new Error('defecto')
      })
    )

    expect(response.status).toBe(500)

    const line = errorCalls(error).find(([message]) => message === 'Route defect')
    expect(line).toBeDefined()
    expect((line as ReadonlyArray<unknown>)[2]).toMatchObject({ route: 'GET /api/prueba' })
  })

  // `RouteResponse` no es un fallo: es la respuesta que la ruta decidió
  // devolver. Loguearla llenaría el log de errores que no lo son.
  it('no loguea la respuesta que la ruta devuelve por el canal de error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await runRouteEffect(
      REQUEST(),
      'GET /api/prueba',
      Effect.fail(respond(new Response('no autorizado', { status: 401 })))
    )

    expect(response.status).toBe(401)
    expect(errorCalls(error)).toEqual([])
  })
})
