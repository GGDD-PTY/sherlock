import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  getAuthenticatedConvex: vi.fn(),
  convexQuery: vi.fn(),
  generateLink: vi.fn(),
  adminStepUpFresh: true,
}))

vi.mock('@/lib/api/with-auth', () => ({
  requireApiAuth: () => mocks.requireApiAuth(),
  hasRecentAdminApiStepUp: async () => mocks.adminStepUpFresh,
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () => mocks.getAuthenticatedConvex(),
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    workos: {
      getMyMembershipForOrg: 'workos.getMyMembershipForOrg',
    },
  },
}))

vi.mock('@workos-inc/node', () => ({
  WorkOS: class MockWorkOS {
    adminPortal = {
      generateLink: mocks.generateLink,
    }
  },
}))

import { POST } from '@/app/api/workos/admin-portal/route'

function createRequest(body: object): NextRequest {
  return new NextRequest('http://localhost:3000/api/workos/admin-portal', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('POST /api/workos/admin-portal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.adminStepUpFresh = true
    process.env.WORKOS_API_KEY = 'workos_api_key_for_tests'
    mocks.requireApiAuth.mockResolvedValue({
      user: {
        id: 'user_workos_admin',
        email: 'admin@example.com',
        role: 'ADMIN',
        profileId: 'profile_admin',
      },
      error: null,
    })
    mocks.generateLink.mockResolvedValue({
      link: 'https://portal.workos.com/admin_portal/session_123',
    })
    mocks.convexQuery.mockResolvedValue(null)
    mocks.getAuthenticatedConvex.mockResolvedValue({
      client: { query: (...args: unknown[]) => mocks.convexQuery(...args) },
      isAuthenticated: true,
    })
  })

  it('rejects unauthenticated requests before calling WorkOS', async () => {
    const authError = Response.json({ error: 'No autorizado' }, { status: 401 })
    mocks.requireApiAuth.mockResolvedValue({ user: null, error: authError })

    const response = await POST(createRequest({ organizationId: 'org_123', intent: 'sso' }))
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body.error).toBe('No autorizado')
    expect(mocks.generateLink).not.toHaveBeenCalled()
  })

  it('rejects non-admin users before calling WorkOS', async () => {
    mocks.requireApiAuth.mockResolvedValue({
      user: {
        id: 'user_workos_investor',
        email: 'investor@example.com',
        role: 'COMPANY',
        profileId: 'profile_investor',
      },
      error: null,
    })

    const response = await POST(createRequest({ organizationId: 'org_123', intent: 'sso' }))
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.error).toBe('No tienes permisos para administrar WorkOS')
    expect(mocks.generateLink).not.toHaveBeenCalled()
  })

  it('generates a WorkOS Admin Portal link for active organization owners', async () => {
    mocks.requireApiAuth.mockResolvedValue({
      user: {
        id: 'user_workos_company',
        email: 'issuer@example.com',
        role: 'COMPANY',
        profileId: 'profile_company',
      },
      error: null,
    })
    mocks.convexQuery.mockResolvedValue({
      betaRole: 'COMPANY_OWNER',
      status: 'ACTIVE',
    })

    const response = await POST(createRequest({ organizationId: 'org_123', intent: 'sso' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.link).toBe('https://portal.workos.com/admin_portal/session_123')
    expect(mocks.convexQuery).toHaveBeenCalledWith('workos.getMyMembershipForOrg', {
      workosOrgId: 'org_123',
    })
    expect(mocks.generateLink).toHaveBeenCalledWith({
      organization: 'org_123',
      intent: 'sso',
      adminEmails: ['issuer@example.com'],
    })
  })

  it('drops the platform-admin shortcut when the step-up re-authentication expired', async () => {
    mocks.adminStepUpFresh = false
    mocks.convexQuery.mockResolvedValue(null)

    const response = await POST(createRequest({ organizationId: 'org_123', intent: 'sso' }))
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.error).toBe('No tienes permisos para administrar WorkOS')
    expect(mocks.generateLink).not.toHaveBeenCalled()
  })

  it('rejects unsupported admin portal intents', async () => {
    const response = await POST(createRequest({ organizationId: 'org_123', intent: 'audit_logs' }))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error).toBe('Intent inválido')
    expect(mocks.generateLink).not.toHaveBeenCalled()
  })

  it('generates a WorkOS Admin Portal link for Sherlock admins', async () => {
    const response = await POST(
      createRequest({
        organizationId: 'org_123',
        intent: 'domain_verification',
      })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      link: 'https://portal.workos.com/admin_portal/session_123',
      intent: 'domain_verification',
      organizationId: 'org_123',
      requestId: expect.any(String),
    })
    expect(mocks.generateLink).toHaveBeenCalledWith({
      organization: 'org_123',
      intent: 'domain_verification',
      adminEmails: ['admin@example.com'],
    })
  })
})
