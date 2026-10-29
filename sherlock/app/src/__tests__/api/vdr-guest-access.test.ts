import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockMutation = vi.fn()
const mockGetUnauthenticatedConvex = vi.fn()
vi.mock('@/lib/convex-auth', () => ({
  getUnauthenticatedConvex: () => mockGetUnauthenticatedConvex(),
}))

const mockRateLimit = vi.fn()
vi.mock('@/lib/utils/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/rate-limit')>()
  return {
    ...actual,
    checkRateLimitDistributed: (...args: unknown[]) => mockRateLimit(...args),
  }
})

import { POST as requestOtp } from '@/app/api/vdr/guest/otp/request/route'
import { createVdrGuestServerProof } from '@/lib/auth/vdr-guest-server-proof'
import { POST as verifyOtp } from '@/app/api/vdr/guest/verify/route'
import { GET as getSession, POST as rotateSession } from '@/app/api/vdr/guest/session/route'
import { POST as logout } from '@/app/api/vdr/guest/logout/route'
import { RATE_LIMIT_PRESETS } from '@/lib/utils/rate-limit'
import {
  getVdrGuestSessionCookieName,
  vdrGuestSessionCookieOptions,
} from '@/lib/auth/vdr-guest-session'

const SESSION_TOKEN = 'a'.repeat(64)
const ROTATED_TOKEN = 'b'.repeat(64)

function jsonRequest(path: string, body: unknown, options?: { origin?: string; cookie?: string }) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: options?.origin ?? 'http://localhost:3000',
      ...(options?.cookie ? { Cookie: options.cookie } : {}),
      'x-vercel-forwarded-for': '203.0.113.9',
      'x-forwarded-for': '198.51.100.88, 10.0.0.2',
    },
    body: JSON.stringify(body),
  })
}

function sessionCookie(token = SESSION_TOKEN) {
  return `${getVdrGuestSessionCookieName()}=${token}`
}

describe('public VDR guest API boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUnauthenticatedConvex.mockReturnValue({ mutation: mockMutation })
    mockRateLimit.mockResolvedValue({
      success: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 60_000),
      retryAfterSec: 0,
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns 429 from every guest session route before parsing or calling Convex', async () => {
    mockRateLimit.mockResolvedValue({
      success: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
      retryAfterSec: 12,
    })

    const responses = await Promise.all([
      requestOtp(jsonRequest('/api/vdr/guest/otp/request', {})),
      verifyOtp(jsonRequest('/api/vdr/guest/verify', {})),
      getSession(
        new NextRequest('http://localhost:3000/api/vdr/guest/session', {
          headers: { Cookie: sessionCookie(), 'x-vercel-forwarded-for': '203.0.113.9' },
        })
      ),
      rotateSession(jsonRequest('/api/vdr/guest/session', {}, { cookie: sessionCookie() })),
      logout(jsonRequest('/api/vdr/guest/logout', {}, { cookie: sessionCookie() })),
    ])

    expect(responses.map((response) => response.status)).toEqual([429, 429, 429, 429, 429])
    expect(responses.every((response) => response.headers.get('retry-after') === '12')).toBe(true)
    expect(mockMutation).not.toHaveBeenCalled()
    expect(mockRateLimit.mock.calls).toEqual([
      ['vdr-guest-otp-request:203.0.113.9', RATE_LIMIT_PRESETS.auth],
      ['vdr-guest-otp-verify:203.0.113.9', RATE_LIMIT_PRESETS.auth],
      ['vdr-guest-session-read:203.0.113.9', RATE_LIMIT_PRESETS.api],
      ['vdr-guest-session-rotate:203.0.113.9', RATE_LIMIT_PRESETS.auth],
      ['vdr-guest-logout:203.0.113.9', RATE_LIMIT_PRESETS.auth],
    ])
  })

  it('requests an OTP with a generic no-store response and uses the trusted forwarding header', async () => {
    mockMutation.mockResolvedValue({
      accepted: true,
      challengeToken: 'e'.repeat(64),
      expiresInSeconds: 600,
    })
    const response = await requestOtp(
      jsonRequest('/api/vdr/guest/otp/request', {
        invitationHandle: 'c'.repeat(64),
        email: 'fixture-bff21e9f@example.com',
      })
    )
    const body = await response.json()

    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(body).toMatchObject({
      accepted: true,
      challengeToken: 'e'.repeat(64),
      expiresInSeconds: 600,
    })
    expect(JSON.stringify(body)).not.toContain('fixture-bff21e9f@example.com')
    expect(mockRateLimit).toHaveBeenCalledWith(
      'vdr-guest-otp-request:203.0.113.9',
      expect.any(Object)
    )
    expect(mockMutation).toHaveBeenCalledWith(expect.anything(), {
      invitationHandle: 'c'.repeat(64),
      email: 'fixture-bff21e9f@example.com',
      serverIssuedAt: expect.any(Number),
      serverProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
    const args = mockMutation.mock.calls[0]?.[1] as {
      serverIssuedAt: number
      serverProof: string
    }
    expect(args.serverProof).toBe(
      createVdrGuestServerProof({
        operation: 'REQUEST_OTP',
        bindingParts: ['c'.repeat(64), 'fixture-bff21e9f@example.com'],
        issuedAt: args.serverIssuedAt,
      }).serverProof
    )
    expect(args).not.toHaveProperty('challengeToken')
  })

  it('rejects a presented challenge token before calling Convex', async () => {
    mockMutation.mockResolvedValue({
      accepted: true,
      challengeToken: 'e'.repeat(64),
      expiresInSeconds: 600,
    })
    const response = await requestOtp(
      jsonRequest('/api/vdr/guest/otp/request', {
        invitationHandle: 'c'.repeat(64),
        email: 'fixture-bff21e9f@example.com',
        challengeToken: 'd'.repeat(64),
      })
    )

    expect(response.status).toBe(400)
    expect(mockMutation).not.toHaveBeenCalled()
  })

  it('verifies OTP into an HttpOnly same-site cookie without returning the session token', async () => {
    mockMutation.mockResolvedValue({
      verified: true,
      sessionToken: SESSION_TOKEN,
      expiresAt: Date.now() + 25 * 60_000,
      roomAccessGranted: false,
    })
    const response = await verifyOtp(
      jsonRequest('/api/vdr/guest/verify', {
        invitationHandle: 'c'.repeat(64),
        challengeToken: 'd'.repeat(64),
        code: '481516',
      })
    )
    const body = await response.json()
    const setCookie = response.headers.get('set-cookie') ?? ''

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ verified: true, roomAccessGranted: false })
    expect(JSON.stringify(body)).not.toContain(SESSION_TOKEN)
    expect(setCookie).toContain(`${getVdrGuestSessionCookieName()}=${SESSION_TOKEN}`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=lax')
    expect(setCookie).toContain('Path=/')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mockMutation).toHaveBeenCalledWith(expect.anything(), {
      invitationHandle: 'c'.repeat(64),
      challengeToken: 'd'.repeat(64),
      code: '481516',
      serverIssuedAt: expect.any(Number),
      serverProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
  })

  it('resolves, rotates, and revokes only the opaque cookie while exposing no VDR data', async () => {
    mockMutation
      .mockResolvedValueOnce({
        authenticated: true,
        guestInvitationId: 'guest_invitation_1',
        dealId: 'deal_1',
        guestId: 'guest_1',
        principalKey: 'GUEST:guest_1',
        expiresAt: Date.now() + 20 * 60_000,
        roomAccessGranted: false,
        requiredGates: [
          'MUTUAL_OPT_IN',
          'HUMAN_MATCH_APPROVAL',
          'NDA',
          'ROOM_GRANT',
        ],
      })
      .mockResolvedValueOnce({
        rotated: true,
        sessionToken: ROTATED_TOKEN,
        expiresAt: Date.now() + 30 * 60_000,
        roomAccessGranted: false,
      })
      .mockResolvedValueOnce({ revoked: true })

    const resolved = await getSession(
      new NextRequest('http://localhost:3000/api/vdr/guest/session', {
        headers: { Cookie: sessionCookie(), 'x-vercel-forwarded-for': '203.0.113.9' },
      })
    )
    const resolvedBody = await resolved.json()
    expect(resolvedBody).toMatchObject({
      authenticated: true,
      roomAccessGranted: false,
    })
    expect(resolvedBody).not.toHaveProperty('dealId')
    expect(resolvedBody).not.toHaveProperty('guestId')
    expect(resolvedBody).not.toHaveProperty('principalKey')
    expect(resolvedBody).not.toHaveProperty('documents')
    expect(mockMutation).toHaveBeenNthCalledWith(1, expect.anything(), {
      sessionToken: SESSION_TOKEN,
      serverIssuedAt: expect.any(Number),
      serverProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })

    const rotated = await rotateSession(
      jsonRequest('/api/vdr/guest/session', {}, { cookie: sessionCookie() })
    )
    expect(await rotated.json()).toMatchObject({ rotated: true, roomAccessGranted: false })
    expect(rotated.headers.get('set-cookie')).toContain(ROTATED_TOKEN)
    expect(mockMutation).toHaveBeenNthCalledWith(2, expect.anything(), {
      sessionToken: SESSION_TOKEN,
      serverIssuedAt: expect.any(Number),
      serverProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })

    const loggedOut = await logout(
      jsonRequest('/api/vdr/guest/logout', {}, { cookie: sessionCookie(ROTATED_TOKEN) })
    )
    expect(await loggedOut.json()).toMatchObject({ loggedOut: true })
    expect(loggedOut.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(mockMutation).toHaveBeenNthCalledWith(3, expect.anything(), {
      sessionToken: ROTATED_TOKEN,
      serverIssuedAt: expect.any(Number),
      serverProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
    expect(
      [resolved, rotated, loggedOut].every((item) =>
        item.headers.get('cache-control')?.includes('no-store')
      )
    ).toBe(true)
  })

  it('rejects cross-site mutations before Convex and keeps production cookies Secure', async () => {
    const response = await verifyOtp(
      jsonRequest(
        '/api/vdr/guest/verify',
        {
          invitationHandle: 'c'.repeat(64),
          challengeToken: 'd'.repeat(64),
          code: '481516',
        },
        { origin: 'https://attacker.example' }
      )
    )
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mockMutation).not.toHaveBeenCalled()

    expect(vdrGuestSessionCookieOptions('production')).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    })
  })

  it('bounds request bodies and fails closed when Convex is unavailable', async () => {
    const oversized = await requestOtp(
      jsonRequest('/api/vdr/guest/otp/request', {
        invitationHandle: 'c'.repeat(5_000),
        email: 'fixture-bff21e9f@example.com',
      })
    )
    expect(oversized.status).toBe(413)
    expect(mockMutation).not.toHaveBeenCalled()

    mockGetUnauthenticatedConvex.mockReturnValue(null)
    const unavailable = await verifyOtp(
      jsonRequest('/api/vdr/guest/verify', {
        invitationHandle: 'c'.repeat(64),
        challengeToken: 'd'.repeat(64),
        code: '481516',
      })
    )
    expect(unavailable.status).toBe(503)
    expect(unavailable.headers.get('cache-control')).toContain('no-store')
    expect(unavailable.headers.get('set-cookie')).toBeNull()
  })
})
