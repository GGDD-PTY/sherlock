import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockGetAuthenticatedConvex = vi.fn()
const mockProvisionAndClaim = vi.fn()
const mockRateLimit = vi.fn()
const mockScheduleClaimConversion = vi.fn()

vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () => mockGetAuthenticatedConvex(),
}))
vi.mock('@/lib/intake/claim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/intake/claim')>()
  return {
    ...actual,
    provisionAndClaimIntake: (...args: unknown[]) => mockProvisionAndClaim(...args),
  }
})
vi.mock('@/lib/utils/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/rate-limit')>()
  return {
    ...actual,
    checkRateLimitDistributed: (...args: unknown[]) => mockRateLimit(...args),
  }
})
vi.mock('@/lib/analytics/server', () => ({
  scheduleIntakeClaimConversion: (...args: unknown[]) => mockScheduleClaimConversion(...args),
}))

import { POST } from '@/app/api/intake/claim/route'
import { createIntakeCsrfToken, getIntakeCsrfCookieName } from '@/lib/intake/csrf'
import { INTAKE_CSRF_HEADER } from '@/lib/intake/config'
import { getIntakeSessionCookieName } from '@/lib/intake/session'

const SECRET = 'intake-claim-api-secret-for-tests-1234567890' // gitleaks:allow -- deterministic test fixture, not a provider credential
const AUDIENCE = 'sherlock-test:intake-claim-api'
const SESSION_TOKEN = 's'.repeat(43)
const SUBJECT = 'workos_claim_owner'

function accessToken(subject = SUBJECT): string {
  const claims = Buffer.from(JSON.stringify({ sub: subject, sid: 'session_claim' })).toString(
    'base64url'
  )
  return `header.${claims}.signature`
}

function claimRequest(
  options: {
    origin?: string
    csrfToken?: string
    sessionToken?: string
    body?: unknown
  } = {}
) {
  const csrfToken = options.csrfToken
  const sessionToken = options.sessionToken ?? SESSION_TOKEN
  return new NextRequest('http://localhost:3000/api/intake/claim', {
    method: 'POST',
    headers: {
      Origin: options.origin ?? 'http://localhost:3000',
      'Content-Type': 'application/json',
      Cookie: [
        `${getIntakeSessionCookieName()}=${sessionToken}`,
        csrfToken ? `${getIntakeCsrfCookieName()}=${csrfToken}` : undefined,
      ]
        .filter(Boolean)
        .join('; '),
      ...(csrfToken ? { [INTAKE_CSRF_HEADER]: csrfToken } : {}),
      'x-vercel-forwarded-for': '203.0.113.20',
    },
    body: JSON.stringify(options.body ?? {}),
  })
}

describe('authenticated intake claim API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('INTAKE_DEMO_MODE', 'true')
    vi.stubEnv('INTAKE_SERVER_SECRET', SECRET)
    vi.stubEnv('INTAKE_SERVER_AUDIENCE', AUDIENCE)
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: { mutation: vi.fn() },
      token: accessToken(),
      isAuthenticated: true,
    })
    mockProvisionAndClaim.mockResolvedValue({
      status: 'SUCCEEDED',
      claimDigest: 'd'.repeat(64),
      companyId: 'company_owner',
      documentIds: ['document_1'],
      claimedDocumentCount: 1,
      skippedDocumentCount: 0,
      completedAt: 1_750_000_000_000,
    })
    mockScheduleClaimConversion.mockReturnValue(undefined)
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

  it.each([
    {
      lane: 'local',
      nodeEnv: 'development',
      convexUrl: 'http://127.0.0.1:3540',
      enabled: 'true',
      status: 200,
      calls: 1,
    },
    {
      lane: 'disabled',
      nodeEnv: 'development',
      convexUrl: 'http://127.0.0.1:3540',
      enabled: 'false',
      status: 403,
      calls: 0,
    },
    {
      lane: 'production',
      nodeEnv: 'production',
      convexUrl: 'http://127.0.0.1:3540',
      enabled: 'true',
      status: 403,
      calls: 0,
    },
    {
      lane: 'cloud',
      nodeEnv: 'development',
      convexUrl: 'https://example.convex.cloud',
      enabled: 'true',
      status: 403,
      calls: 0,
    },
  ])(
    'uses the authenticated local identity only in the $lane lane',
    async ({ nodeEnv, convexUrl, enabled, status, calls }) => {
      vi.stubEnv('NODE_ENV', nodeEnv)
      vi.stubEnv('NEXT_PUBLIC_DEV_AUTH_ENABLED', enabled)
      vi.stubEnv('NEXT_PUBLIC_BYPASS_AUTH', enabled)
      vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', convexUrl)
      vi.stubEnv('NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY', 'local-test-key')
      mockGetAuthenticatedConvex.mockResolvedValue({
        client: { mutation: vi.fn() },
        token: null,
        localSubject: 'dev_intake-repro-dev-local_workos',
        isAuthenticated: true,
      })
      const csrfToken = createIntakeCsrfToken({ binding: SESSION_TOKEN })
      const response = await POST(claimRequest({ csrfToken }))
      expect(response.status).toBe(status)
      expect(mockProvisionAndClaim).toHaveBeenCalledTimes(calls)
      expect(mockProvisionAndClaim.mock.calls.map(([args]) => args)).toEqual(
        Array.from({ length: calls }, () =>
          expect.objectContaining({
            workosSubject: 'dev_intake-repro-dev-local_workos',
            sessionToken: SESSION_TOKEN,
          })
        )
      )
    }
  )

  it('keeps the claim route default-off', async () => {
    vi.stubEnv('INTAKE_DEMO_MODE', 'false')

    const response = await POST(claimRequest())

    expect(response.status).toBe(404)
    expect(mockGetAuthenticatedConvex).not.toHaveBeenCalled()
    expect(mockProvisionAndClaim).not.toHaveBeenCalled()
  })

  it('requires same-origin session-bound CSRF before authenticated effects', async () => {
    const csrfToken = createIntakeCsrfToken({ binding: SESSION_TOKEN })

    const missing = await POST(claimRequest())
    const crossOrigin = await POST(
      claimRequest({
        csrfToken,
        origin: 'https://attacker.example',
        body: { companyId: 'company_2' },
      })
    )

    expect(missing.status).toBe(403)
    expect(crossOrigin.status).toBe(403)
    expect(mockProvisionAndClaim).not.toHaveBeenCalled()
  })

  it('derives the subject from authenticated WorkOS authority and accepts no company scope', async () => {
    const csrfToken = createIntakeCsrfToken({ binding: SESSION_TOKEN })

    const response = await POST(
      claimRequest({
        csrfToken,
        body: { companyId: 'company_attacker', profileId: 'profile_attacker' },
      })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      status: 'SUCCEEDED',
      claimDigest: 'd'.repeat(64),
      companyId: 'company_owner',
      documentIds: ['document_1'],
    })
    expect(mockProvisionAndClaim).toHaveBeenCalledWith({
      client: expect.anything(),
      sessionToken: SESSION_TOKEN,
      workosSubject: SUBJECT,
    })
    expect(JSON.stringify(mockProvisionAndClaim.mock.calls)).not.toContain('company_attacker')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(JSON.stringify(body)).not.toContain(SESSION_TOKEN)
    expect(mockScheduleClaimConversion).toHaveBeenCalledWith({
      claimDigest: 'd'.repeat(64),
      claimedDocumentCount: 1,
      locale: 'es',
      requestHeaders: expect.any(Headers),
    })
  })

  it('fails closed without an authenticated Convex token and retains temporary authority', async () => {
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: { mutation: vi.fn() },
      token: null,
      isAuthenticated: false,
    })
    const csrfToken = createIntakeCsrfToken({ binding: SESSION_TOKEN })

    const response = await POST(claimRequest({ csrfToken }))

    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(mockProvisionAndClaim).not.toHaveBeenCalled()
  })

  it('returns a generic recoverable error without clearing authority when reconciliation fails', async () => {
    mockProvisionAndClaim.mockRejectedValue(new Error('sensitive convex detail'))
    const csrfToken = createIntakeCsrfToken({ binding: SESSION_TOKEN })

    const response = await POST(claimRequest({ csrfToken }))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ error: 'Acceso temporalmente no disponible' })
    expect(JSON.stringify(body)).not.toContain('sensitive convex detail')
    expect(response.headers.get('set-cookie')).toBeNull()
  })
})
