import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mockCheckRateLimit = vi.fn()

vi.mock('@/lib/utils/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/rate-limit')>()
  return {
    ...actual,
    checkRateLimitDistributed: (...args: unknown[]) => mockCheckRateLimit(...args),
  }
})

import { REQUEST_ID_HEADER } from '@/lib/api/response'
import {
  invalidGuestRequest,
  rejectGuestCsrf,
  rejectGuestRateLimit,
  secureGuestResponse,
  vdrGuestRequestId,
} from '@/lib/auth/vdr-guest-api'
import { RATE_LIMIT_PRESETS } from '@/lib/utils/rate-limit'

const REQUEST_ID = 'req_guest_api'
const CLIENT_IP = '203.0.113.9'

function guestRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/api/vdr/guest/otp/request', {
    method: 'POST',
    headers: {
      origin: 'http://localhost:3000',
      [REQUEST_ID_HEADER]: REQUEST_ID,
      'x-vercel-forwarded-for': CLIENT_IP,
      ...headers,
    },
  })
}

describe('vdr guest API perimeter helpers', () => {
  beforeEach(() => {
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      remaining: 4,
      resetAt: new Date('2026-08-18T10:01:00.000Z'),
      retryAfterSec: 0,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('reads the incoming request id', () => {
    expect(vdrGuestRequestId(guestRequest())).toBe(REQUEST_ID)
  })

  it('rejects a cross-site origin and stamps the request id', async () => {
    const rejected = rejectGuestCsrf(guestRequest({ origin: 'https://evil.example' }), REQUEST_ID)

    expect(rejected).not.toBeNull()
    expect(rejected?.status).toBe(403)
    expect(rejected?.headers.get(REQUEST_ID_HEADER)).toBe(REQUEST_ID)
    await expect(rejected!.json()).resolves.toMatchObject({ error: 'Origen no permitido' })
  })

  it('accepts a same-origin guest mutation', () => {
    expect(rejectGuestCsrf(guestRequest(), REQUEST_ID)).toBeNull()
  })

  it.each(['otp-request', 'otp-verify', 'session-rotate', 'logout'] as const)(
    'throttles %s with the auth preset',
    async (operation) => {
      await expect(rejectGuestRateLimit(guestRequest(), REQUEST_ID, operation)).resolves.toBeNull()

      expect(mockCheckRateLimit).toHaveBeenCalledWith(
        `vdr-guest-${operation}:${CLIENT_IP}`,
        RATE_LIMIT_PRESETS.auth
      )
    }
  )

  it.each(['session-read', 'room-read'] as const)(
    'throttles %s with the looser api preset',
    async (operation) => {
      await expect(rejectGuestRateLimit(guestRequest(), REQUEST_ID, operation)).resolves.toBeNull()

      expect(mockCheckRateLimit).toHaveBeenCalledWith(
        `vdr-guest-${operation}:${CLIENT_IP}`,
        RATE_LIMIT_PRESETS.api
      )
    }
  )

  it('returns a stamped 429 when the guest bucket is exhausted', async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      remaining: 0,
      resetAt: new Date('2026-08-18T10:02:00.000Z'),
      retryAfterSec: 12,
    })

    const rejected = await rejectGuestRateLimit(guestRequest(), REQUEST_ID, 'otp-verify')

    expect(rejected).not.toBeNull()
    expect(rejected?.status).toBe(429)
    expect(rejected?.headers.get(REQUEST_ID_HEADER)).toBe(REQUEST_ID)
    expect(rejected?.headers.get('retry-after')).toBe('12')
    await expect(rejected!.json()).resolves.toMatchObject({
      error: 'Demasiadas solicitudes',
      retryAfter: 12,
    })
  })

  it('wraps invalid guest bodies as generic client errors', async () => {
    const response = invalidGuestRequest(REQUEST_ID, 413, 'BODY_TOO_LARGE')

    expect(response.status).toBe(413)
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(REQUEST_ID)
    await expect(response.json()).resolves.toMatchObject({
      requestId: REQUEST_ID,
      error: 'Solicitud inválida',
      code: 'BODY_TOO_LARGE',
    })
  })

  it('stamps security headers on an already-built guest response', () => {
    const response = secureGuestResponse(new NextResponse(null, { status: 204 }), REQUEST_ID)

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(REQUEST_ID)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })
})
