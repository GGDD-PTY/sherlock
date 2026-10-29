import { afterEach, describe, expect, it, vi } from 'vitest'

import { readLandingDestination } from '@/lib/intake/landing-destination'

function respond(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })))
}

afterEach(() => vi.unstubAllGlobals())

describe('landing destination lookup', () => {
  it('continues anonymously only for the proxy unauthenticated response', async () => {
    respond(401, { error: 'Unauthorized', requestId: 'destination-anonymous' })
    await expect(readLandingDestination()).resolves.toEqual({ status: 'NONE' })
  })

  it.each([403, 429, 500, 503])('blocks continuation on HTTP %s', async (status) => {
    respond(status, { error: 'Solicitud no autorizada' })
    await expect(readLandingDestination()).resolves.toEqual({ status: 'UNAVAILABLE' })
  })

  it('does not treat an unexpected 401 as an anonymous session', async () => {
    respond(401, { error: 'Upstream authorization failed' })
    await expect(readLandingDestination()).resolves.toEqual({ status: 'UNAVAILABLE' })
  })

  it('distinguishes a successful lookup without an owned room', async () => {
    respond(200, { companyName: null })
    await expect(readLandingDestination()).resolves.toEqual({ status: 'NONE' })
  })

  it('returns the owned room name without surrounding whitespace', async () => {
    respond(200, { companyName: ' Sample Foods, S.A. ' })
    await expect(readLandingDestination()).resolves.toEqual({
      status: 'FOUND',
      companyName: 'Sample Foods, S.A.',
    })
  })

  it.each([null, {}, { companyName: 1 }, { companyName: ' ' }])(
    'blocks continuation for malformed response %j',
    async (body) => {
      respond(200, body)
      await expect(readLandingDestination()).resolves.toEqual({ status: 'UNAVAILABLE' })
    }
  )

  it('blocks continuation when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network unavailable')))
    await expect(readLandingDestination()).resolves.toEqual({ status: 'UNAVAILABLE' })
  })

  it('blocks continuation when the response is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Sign in</html>')))
    await expect(readLandingDestination()).resolves.toEqual({ status: 'UNAVAILABLE' })
  })
})
