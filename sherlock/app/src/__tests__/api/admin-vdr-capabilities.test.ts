import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mockRequireAdminApiAuth = vi.fn()
vi.mock('@/lib/api/with-auth', () => ({
  requireAdminApiAuth: () => mockRequireAdminApiAuth(),
}))

const mockIssueAdminVdrCapability = vi.fn()
vi.mock('@/lib/auth/admin-vdr-capability-server', () => ({
  issueAdminVdrCapability: (...args: unknown[]) => mockIssueAdminVdrCapability(...args),
}))

const mockCheckRateLimitDistributed = vi.fn()
const mockCreateRateLimitResponse = vi.fn()
vi.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitDistributed: (...args: unknown[]) => mockCheckRateLimitDistributed(...args),
  createRateLimitResponse: (...args: unknown[]) => mockCreateRateLimitResponse(...args),
  RATE_LIMIT_PRESETS: { mutation: { maxRequests: 20, windowMs: 60_000 } },
}))

import { POST } from '@/app/api/admin/vdr-capabilities/route'

const ADMIN_USER = {
  id: 'workos_admin',
  profileId: 'profile_admin',
  role: 'ADMIN' as const,
  email: 'admin@example.com',
  name: null,
  sessionId: 'session_admin_001',
}
const VALID_BODY = {
  companyId: 'company_1',
  action: 'DOCUMENT_ARCHIVE',
  target: 'DOCUMENT:document_1',
  input: { documentId: 'document_1' },
}

function request(
  body: unknown,
  origin: string | null = 'http://localhost:3000',
  url = 'http://localhost:3000/api/admin/vdr-capabilities'
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-request-id': 'request-admin-vdr-test',
  }
  if (origin) headers.origin = origin

  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('POST /api/admin/vdr-capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    mockRequireAdminApiAuth.mockResolvedValue({ user: ADMIN_USER, error: null })
    mockCheckRateLimitDistributed.mockResolvedValue({
      success: true,
      remaining: 19,
      resetAt: new Date(),
      retryAfterSec: 0,
    })
    mockIssueAdminVdrCapability.mockResolvedValue({
      capability: `avc_${'a'.repeat(43)}`,
      expiresAt: Date.now() + 60_000,
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('emits one no-store same-origin capability only after the admin step-up boundary', async () => {
    const response = await POST(request(VALID_BODY))
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(body).toMatchObject({
      requestId: 'request-admin-vdr-test',
      capability: `avc_${'a'.repeat(43)}`,
      expiresAt: expect.any(Number),
    })
    expect(mockRequireAdminApiAuth).toHaveBeenCalledTimes(1)
    expect(mockIssueAdminVdrCapability).toHaveBeenCalledWith({
      user: ADMIN_USER,
      ...VALID_BODY,
    })
  })

  it('rejects cross-origin issuance before authentication or capability generation', async () => {
    const response = await POST(request(VALID_BODY, 'https://attacker.example'))

    expect(response.status).toBe(403)
    expect(mockRequireAdminApiAuth).not.toHaveBeenCalled()
    expect(mockIssueAdminVdrCapability).not.toHaveBeenCalled()
  })

  it.each(['http://localhost:3015', 'https://dev.sherlock.capital'])(
    'rejects another globally allowed origin %s because issuance is exact same-origin',
    async (origin) => {
      const response = await POST(request(VALID_BODY, origin))

      expect(response.status).toBe(403)
      expect(mockRequireAdminApiAuth).not.toHaveBeenCalled()
      expect(mockIssueAdminVdrCapability).not.toHaveBeenCalled()
    }
  )

  it('rejects requests without an Origin even when Referer and Fetch Metadata look same-site', async () => {
    const unsignedRequest = request(VALID_BODY, null)
    unsignedRequest.headers.set('referer', 'http://localhost:3000/admin')
    unsignedRequest.headers.set('sec-fetch-site', 'same-origin')

    const response = await POST(unsignedRequest)

    expect(response.status).toBe(403)
    expect(mockRequireAdminApiAuth).not.toHaveBeenCalled()
  })

  it('rejects a production alias when either the request host or browser origin is not canonical', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://sherlock.capital')

    const aliasHost = await POST(
      request(
        VALID_BODY,
        'https://sherlock.capital',
        'https://www.sherlock.capital/api/admin/vdr-capabilities'
      )
    )
    const aliasOrigin = await POST(
      request(
        VALID_BODY,
        'https://www.sherlock.capital',
        'https://sherlock.capital/api/admin/vdr-capabilities'
      )
    )

    expect(aliasHost.status).toBe(403)
    expect(aliasOrigin.status).toBe(403)
    expect(mockRequireAdminApiAuth).not.toHaveBeenCalled()
    expect(mockIssueAdminVdrCapability).not.toHaveBeenCalled()
  })

  it('fails closed in production without a configured canonical origin', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')

    const response = await POST(
      request(
        VALID_BODY,
        'https://sherlock.capital',
        'https://sherlock.capital/api/admin/vdr-capabilities'
      )
    )

    expect(response.status).toBe(403)
    expect(mockRequireAdminApiAuth).not.toHaveBeenCalled()
    expect(mockIssueAdminVdrCapability).not.toHaveBeenCalled()
  })

  it('does not trust a spoofed request host even when Origin and forwarded host agree', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://sherlock.capital')
    const spoofed = request(
      VALID_BODY,
      'https://attacker.example',
      'https://attacker.example/api/admin/vdr-capabilities'
    )
    spoofed.headers.set('host', 'attacker.example')
    spoofed.headers.set('x-forwarded-host', 'attacker.example')

    const response = await POST(spoofed)

    expect(response.status).toBe(403)
    expect(mockRequireAdminApiAuth).not.toHaveBeenCalled()
    expect(mockIssueAdminVdrCapability).not.toHaveBeenCalled()
  })

  it('propagates the step-up denial without capability generation', async () => {
    mockRequireAdminApiAuth.mockResolvedValue({
      user: null,
      error: NextResponse.json(
        { error: 'Re-autenticación requerida', code: 'ADMIN_STEP_UP_REQUIRED' },
        { status: 403 }
      ),
    })

    const response = await POST(request(VALID_BODY))

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'ADMIN_STEP_UP_REQUIRED' })
    expect(mockIssueAdminVdrCapability).not.toHaveBeenCalled()
  })

  it('fails closed when the current WorkOS subject or session binding is unavailable', async () => {
    mockRequireAdminApiAuth.mockResolvedValue({
      user: { ...ADMIN_USER, sessionId: null },
      error: null,
    })

    const response = await POST(request(VALID_BODY))

    expect(response.status).toBe(403)
    expect(mockIssueAdminVdrCapability).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown field', { ...VALID_BODY, privilege: 'ADMIN' }],
    ['unknown action', { ...VALID_BODY, action: 'DOCUMENT_DELETE_FOREVER' }],
    ['invalid target', { ...VALID_BODY, target: 'DOCUMENT document_1' }],
    ['array input', { ...VALID_BODY, input: ['document_1'] }],
    ['oversized canonical input', { ...VALID_BODY, input: { value: 'x'.repeat(17_000) } }],
  ])('rejects a strict body with %s', async (_label, invalidBody) => {
    const response = await POST(request(invalidBody))

    expect(response.status).toBe(400)
    expect(mockIssueAdminVdrCapability).not.toHaveBeenCalled()
  })

  it('collapses boundary failures into a generic response without token or input leakage', async () => {
    mockIssueAdminVdrCapability.mockRejectedValue(
      new Error('proof failed for document_1 using avc_sensitive')
    )

    const response = await POST(request(VALID_BODY))
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.error).toBe('No se pudo autorizar la operación VDR')
    expect(JSON.stringify(body)).not.toMatch(/document_1|avc_sensitive|proof failed/i)
  })
})
