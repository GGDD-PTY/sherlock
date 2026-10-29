import { NextRequest, NextResponse } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequireApiAuthWithRole = vi.fn()
const mockRateLimit = vi.fn()
const mockScheduleRoomJourneyEvent = vi.fn()

vi.mock('@/lib/api/with-auth', () => ({
  requireApiAuthWithRole: (...args: unknown[]) => mockRequireApiAuthWithRole(...args),
}))
vi.mock('@/lib/utils/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/rate-limit')>()
  return {
    ...actual,
    checkRateLimitDistributed: (...args: unknown[]) => mockRateLimit(...args),
  }
})
vi.mock('@/lib/analytics/room-journey-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/analytics/room-journey-server')>()
  return {
    ...actual,
    scheduleRoomJourneyEvent: (...args: unknown[]) => mockScheduleRoomJourneyEvent(...args),
  }
})

import { POST } from '@/app/api/analytics/journey/route'

function journeyRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/analytics/journey', {
    method: 'POST',
    headers: {
      origin: 'http://localhost:3000',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe('authenticated room journey API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test_project_key')
    vi.stubEnv('POSTHOG_INGEST_HOST', 'https://eu.i.posthog.com')
    mockRequireApiAuthWithRole.mockResolvedValue({
      user: {
        id: 'workos_random_user_123',
        email: 'private@example.com',
        role: 'COMPANY',
        profileId: 'profile_123',
        sessionId: 'session_123',
      },
      error: null,
    })
    mockRateLimit.mockResolvedValue({
      success: true,
      remaining: 29,
      resetAt: new Date(Date.now() + 60_000),
      retryAfterSec: 0,
    })
    mockScheduleRoomJourneyEvent.mockReturnValue(true)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('authenticates COMPANY or ADMIN and queues only the parsed event', async () => {
    const response = await POST(
      journeyRequest({ event: 'document_opened', properties: { documentKind: 'pdf' } })
    )

    expect(response.status).toBe(202)
    expect(mockRequireApiAuthWithRole).toHaveBeenCalledWith(['COMPANY', 'ADMIN'])
    expect(mockRateLimit).toHaveBeenCalledWith(
      expect.stringMatching(/^room-journey:[a-f0-9]{64}$/),
      expect.objectContaining({ limit: 30, windowSec: 60 })
    )
    expect(mockScheduleRoomJourneyEvent).toHaveBeenCalledWith({
      actorId: 'workos_random_user_123',
      actorRole: 'COMPANY',
      journeyEvent: { event: 'document_opened', properties: { documentKind: 'pdf' } },
      requestHeaders: expect.any(Headers),
    })
    expect(await response.json()).toMatchObject({ scheduled: true })
  })

  it('fails closed for auth, origin, and properties outside the schema', async () => {
    mockRequireApiAuthWithRole.mockResolvedValueOnce({
      user: null,
      error: NextResponse.json({ error: 'No autorizado' }, { status: 401 }),
    })
    const unauthenticated = await POST(journeyRequest({ event: 'room_entered', properties: {} }))
    const crossOrigin = await POST(
      journeyRequest(
        { event: 'room_entered', properties: {} },
        { origin: 'https://attacker.example' }
      )
    )
    const widened = await POST(
      journeyRequest({
        event: 'room_entered',
        properties: { companyId: 'company_private' },
      })
    )

    expect(unauthenticated.status).toBe(401)
    expect(crossOrigin.status).toBe(403)
    expect(widened.status).toBe(400)
    expect(mockScheduleRoomJourneyEvent).not.toHaveBeenCalled()
  })

  it('does not schedule analytics when browser privacy signals opt out', async () => {
    const response = await POST(
      journeyRequest({ event: 'assistant_opened', properties: {} }, { 'sec-gpc': '1' })
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ scheduled: false })
    expect(mockRateLimit).not.toHaveBeenCalled()
    expect(mockScheduleRoomJourneyEvent).not.toHaveBeenCalled()
  })

  it('does not touch the distributed limiter when analytics is disabled locally', async () => {
    vi.stubEnv('NODE_ENV', 'development')

    const response = await POST(journeyRequest({ event: 'room_entered', properties: {} }))

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ scheduled: false })
    expect(mockRateLimit).not.toHaveBeenCalled()
    expect(mockScheduleRoomJourneyEvent).not.toHaveBeenCalled()
  })

  it('returns an enveloped 429 without scheduling the event', async () => {
    mockRateLimit.mockResolvedValue({
      success: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 30_000),
      retryAfterSec: 30,
    })

    const response = await POST(journeyRequest({ event: 'dashboard_opened', properties: {} }))

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMITED', retryAfter: 30 })
    expect(mockScheduleRoomJourneyEvent).not.toHaveBeenCalled()
  })
})
