import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { Effect } from 'effect'

const mockGetAuthenticatedConvex = vi.fn()
const mockRateLimit = vi.fn()

vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () => mockGetAuthenticatedConvex(),
}))
vi.mock('@/lib/utils/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/rate-limit')>()
  return {
    ...actual,
    checkRateLimitDistributedEffect: (...args: unknown[]) =>
      Effect.promise(() => mockRateLimit(...args)),
  }
})

import { GET } from '@/app/api/intake/destination/route'

function destinationRequest(origin = 'http://localhost:3000') {
  return new NextRequest('http://localhost:3000/api/intake/destination', {
    method: 'GET',
    headers: {
      Origin: origin,
    },
  })
}

describe('GET /api/intake/destination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRateLimit.mockResolvedValue({
      success: true,
      remaining: 20,
      resetAt: new Date(Date.now() + 60_000),
      retryAfterSec: 0,
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not depend on the temporary-intake demo flag', async () => {
    vi.stubEnv('INTAKE_DEMO_MODE', 'false')
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: {
        query: vi.fn().mockResolvedValue({
          access: 'MANAGE',
          company: { name: 'Sample Foods, S.A.' },
        }),
      },
      token: 'token',
      isAuthenticated: true,
    })

    const response = await GET(destinationRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.companyName).toBe('Sample Foods, S.A.')
  })

  it('returns the owned Data Room name only for MANAGE access', async () => {
    const query = vi.fn().mockResolvedValue({
      access: 'READ_ONLY',
      company: { name: 'Sample Foods, S.A.' },
    })
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: { query },
      token: 'token',
      isAuthenticated: true,
    })

    const response = await GET(destinationRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.companyName).toBeNull()
  })

  it('rejects a foreign origin before authentication or workspace lookup', async () => {
    const response = await GET(destinationRequest('https://foreign.example'))

    expect(response.status).toBe(403)
    expect(mockGetAuthenticatedConvex).not.toHaveBeenCalled()
    expect(mockRateLimit).not.toHaveBeenCalled()
  })

  it('returns 429 without querying the workspace when rate limited', async () => {
    mockRateLimit.mockResolvedValue({
      success: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
      retryAfterSec: 60,
    })
    const response = await GET(destinationRequest())

    expect(response.status).toBe(429)
    expect(mockGetAuthenticatedConvex).not.toHaveBeenCalled()
  })

  it('returns unavailable rather than no destination when the workspace query fails', async () => {
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: { query: vi.fn().mockRejectedValue(new Error('Convex unavailable')) },
      token: 'token',
      isAuthenticated: true,
    })
    const response = await GET(destinationRequest())

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.text()).not.toContain('Convex unavailable')
  })

  it('rejects an unauthenticated caller without querying Convex', async () => {
    mockGetAuthenticatedConvex.mockResolvedValue(null)

    const response = await GET(destinationRequest())

    expect(response.status).toBe(403)
    expect(mockGetAuthenticatedConvex).toHaveBeenCalledTimes(1)
  })
})
