import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { issue } from '../../../convex/adminVdrCapabilities'
import { remove } from '../../../convex/_documents/mutations'
import { createConvexCtx, runHandler, type Tables } from '../convex/nda-convex-harness'

const NOW = new Date('2026-08-03T16:00:00.000-05:00').getTime()
const SECRET = 'integration-admin-vdr-capability-secret-with-strong-entropy'
const SESSION_ID = 'session_admin_integration_001'
const ADMIN_IDENTITY = {
  subject: 'workos_admin',
  sid: SESSION_ID,
  issuer: 'https://api.workos.com/',
  email: 'admin@example.com',
}
const ADMIN_USER = {
  id: 'workos_admin',
  profileId: 'profile_admin',
  role: 'ADMIN' as const,
  email: 'admin@example.com',
  name: null,
  sessionId: SESSION_ID,
}

const mockRequireAdminApiAuth = vi.fn()
vi.mock('@/lib/api/with-auth', () => ({
  requireAdminApiAuth: () => mockRequireAdminApiAuth(),
}))

const mockConvexIssueMutation = vi.fn()
vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () =>
    Promise.resolve({
      client: { mutation: (...args: unknown[]) => mockConvexIssueMutation(...args) },
      isAuthenticated: true,
    }),
}))

vi.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitDistributed: vi.fn().mockResolvedValue({
    success: true,
    remaining: 19,
    resetAt: new Date(),
    retryAfterSec: 0,
  }),
  createRateLimitResponse: vi.fn(),
  RATE_LIMIT_PRESETS: { mutation: { maxRequests: 20, windowMs: 60_000 } },
}))

import { POST } from '@/app/api/admin/vdr-capabilities/route'

function journeyTables(): Tables {
  return {
    users: [
      {
        _id: 'user_admin',
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'admin@example.com',
        role: 'ADMIN',
      },
    ],
    profiles: [{ _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true }],
    companies: [{ _id: 'company_1', ownerId: 'profile_issuer', name: 'Issuer' }],
    documents: [
      {
        _id: 'document_1',
        companyId: 'company_1',
        dealId: 'deal_1',
        name: 'Financials.pdf',
        lifecycleStatus: 'ACTIVE',
      },
    ],
    documentAccessGrants: [],
    adminVdrCapabilities: [],
    adminAuditLogs: [],
    activityLogs: [],
    rateLimits: [],
  }
}

describe('admin VDR delegated-capability integration journey', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_APP_URL: 'https://sherlock.capital',
      ADMIN_VDR_CAPABILITY_SECRET: SECRET,
      WORKOS_CLIENT_ID: 'client_admin_vdr_integration',
    }
    mockRequireAdminApiAuth.mockResolvedValue({ user: ADMIN_USER, error: null })
  })

  afterEach(() => {
    vi.useRealTimers()
    process.env = originalEnv
  })

  it('crosses exact-origin step-up, real HMAC issuance, one business write, and one-use consume', async () => {
    const tables = journeyTables()
    const convexCtx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    mockConvexIssueMutation.mockImplementation(async (_reference, args) => {
      return await runHandler(issue, convexCtx, args)
    })
    const request = new NextRequest('https://sherlock.capital/api/admin/vdr-capabilities', {
      method: 'POST',
      headers: {
        origin: 'https://sherlock.capital',
        'content-type': 'application/json',
        'x-request-id': 'request-admin-vdr-integration',
      },
      body: JSON.stringify({
        companyId: 'company_1',
        action: 'DOCUMENT_ARCHIVE',
        target: 'DOCUMENT:document_1',
        input: { documentId: 'document_1' },
      }),
    })

    const issuanceResponse = await POST(request)
    const payload = (await issuanceResponse.json()) as { capability: string; expiresAt: number }

    expect(issuanceResponse.status).toBe(201)
    expect(mockRequireAdminApiAuth).toHaveBeenCalledTimes(1)
    expect(payload.capability).toMatch(/^avc_[A-Za-z0-9_-]{43}$/)
    expect(payload.expiresAt).toBe(NOW + 60_000)
    expect(tables.adminVdrCapabilities).toHaveLength(1)
    expect(JSON.stringify(tables.adminVdrCapabilities[0])).not.toContain('workos_admin')
    expect(JSON.stringify(tables.adminVdrCapabilities[0])).not.toContain(SESSION_ID)

    await expect(
      runHandler(remove, convexCtx, {
        documentId: 'document_1',
        adminCapability: payload.capability,
      })
    ).resolves.toEqual({ archived: true })
    expect(tables.documents[0]).toMatchObject({ lifecycleStatus: 'ARCHIVED' })
    expect(tables.adminAuditLogs.map((row) => row.action)).toEqual([
      'VDR_ADMIN_CAPABILITY_ISSUE',
      'VDR_ADMIN_CAPABILITY_CONSUME',
      'DOCUMENT_ARCHIVE',
    ])
    expect(JSON.stringify(tables.adminAuditLogs)).not.toContain(payload.capability)

    await expect(
      runHandler(remove, convexCtx, {
        documentId: 'document_1',
        adminCapability: payload.capability,
      })
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })
    expect(tables.activityLogs).toHaveLength(1)
    expect(tables.adminAuditLogs).toHaveLength(3)
  })
})
