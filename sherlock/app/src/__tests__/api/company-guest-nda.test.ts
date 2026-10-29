import { beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mutation = vi.fn()
vi.mock('@/lib/convex-auth', () => ({ getUnauthenticatedConvex: () => ({ mutation }) }))
vi.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitDistributed: vi.fn(async () => ({ success: true })),
  getClientIp: () => '127.0.0.1',
  RATE_LIMIT_PRESETS: { api: {}, auth: {} },
  createRateLimitResponse: () => new Response(null, { status: 429 }),
}))
import { GET, POST } from '@/app/api/vdr/guest/nda/route'
import { getVdrGuestSessionCookieName } from '@/lib/auth/vdr-guest-session'
import { createVdrGuestServerProof } from '@/lib/auth/vdr-guest-server-proof'
const token = 'n'.repeat(64)
const request = (body?: unknown, origin = 'http://localhost:3000', cookie = true) =>
  new NextRequest('http://localhost:3000/api/vdr/guest/nda', {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: `${getVdrGuestSessionCookieName()}=${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
beforeEach(() => {
  vi.clearAllMocks()
})
it('requires the guest cookie and returns only the server-approved NDA', async () => {
  expect((await GET(request(undefined, 'http://localhost:3000', false))).status).toBe(401)
  expect(mutation).not.toHaveBeenCalled()
  const nda = {
    title: 'Test NDA',
    content: 'TEST ONLY',
    contentHash: 'a'.repeat(64),
    version: '1',
    locale: 'es',
  }
  mutation.mockResolvedValue(nda)
  const response = await GET(request())
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toContain('no-store')
  expect(await response.json()).toMatchObject({ nda })
})
it('binds acceptance to the guest session, exact hash and signatory name', async () => {
  const body = { contentHash: 'a'.repeat(64), signatoryName: 'Test Guest' }
  mutation.mockResolvedValue({ accepted: true })
  expect((await POST(request(body))).status).toBe(200)
  const args = mutation.mock.calls[0][1]
  expect(args).toEqual({
    sessionToken: token,
    ...body,
    ...createVdrGuestServerProof({
      operation: 'ACCEPT_NDA',
      bindingParts: [token, body.contentHash, body.signatoryName],
      issuedAt: args.serverIssuedAt,
    }),
  })
})
it('rejects cross-origin acceptance, extra text and missing server authorization', async () => {
  const body = { contentHash: 'a'.repeat(64), signatoryName: 'Test Guest' }
  expect((await POST(request(body, 'https://foreign.example'))).status).toBe(403)
  expect((await POST(request({ ...body, content: 'arbitrary text' }))).status).toBe(400)
  expect(mutation).not.toHaveBeenCalled()
  mutation.mockRejectedValue(new Error('NDA absent internal id'))
  const response = await POST(request(body))
  expect(response.status).toBe(403)
  expect(await response.text()).not.toContain('internal id')
})
