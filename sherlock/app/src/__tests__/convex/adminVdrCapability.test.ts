import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requireAdminVdrCapability } from '../../../convex/_adminVdr/capability'
import { ADMIN_VDR_CAPABILITY_TTL_MS } from '../../../convex/_adminVdr/capabilityFormat'
import { requireAuth } from '../../../convex/_helpers/auth'
import { createConvexCtx, type Tables } from './nda-convex-harness'
import { mintAdminVdrCapability, TEST_ADMIN_SESSION_ID } from './admin-vdr-capability-test-helper'

const NOW = new Date('2026-08-03T16:00:00.000-05:00').getTime()
const ADMIN_IDENTITY = {
  subject: 'workos_admin',
  sid: TEST_ADMIN_SESSION_ID,
  issuer: 'https://api.workos.com/',
  email: 'admin@example.com',
}
const ISSUER_IDENTITY = {
  subject: 'workos_issuer',
  sid: 'session_issuer_test_001',
  issuer: 'https://api.workos.com/',
  email: 'issuer@example.com',
}
const INPUT = { documentId: 'document_1' }
type DenialOverride = {
  issuedAt?: number
  companyId?: string
  action?: 'DOCUMENT_ARCHIVE' | 'DOCUMENT_UPDATE'
  target?: string
  input?: Record<string, unknown>
  identity?: Record<string, unknown>
}
const DENIAL_CASES: Array<readonly [string, DenialOverride]> = [
  ['expired', { issuedAt: NOW - ADMIN_VDR_CAPABILITY_TTL_MS }],
  ['cross-company', { companyId: 'company_2' }],
  ['wrong action', { action: 'DOCUMENT_UPDATE' as const }],
  ['wrong target', { target: 'DOCUMENT:document_2' }],
  ['different canonical input', { input: { documentId: 'document_2' } }],
  ['different WorkOS session', { identity: { ...ADMIN_IDENTITY, sid: 'session_admin_other_002' } }],
]

function capabilityTables(): Tables {
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
      {
        _id: 'user_issuer',
        authProvider: 'workos',
        providerUserId: 'workos_issuer',
        workosUserId: 'workos_issuer',
        email: 'issuer@example.com',
        role: 'COMPANY',
      },
    ],
    profiles: [
      { _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true },
      { _id: 'profile_issuer', userId: 'user_issuer', role: 'COMPANY', isActive: true },
    ],
    companies: [
      { _id: 'company_1', ownerId: 'profile_issuer', name: 'Issuer One' },
      { _id: 'company_2', ownerId: 'profile_issuer', name: 'Issuer Two' },
    ],
    adminVdrCapabilities: [],
    adminAuditLogs: [],
  }
}

async function authorize(args: {
  tables: Tables
  capability?: string
  identity?: Record<string, unknown>
  companyId?: string
  action?: 'DOCUMENT_ARCHIVE' | 'DOCUMENT_UPDATE'
  target?: string
  input?: Record<string, unknown>
}) {
  const ctx = createConvexCtx(args.tables, { identity: args.identity ?? ADMIN_IDENTITY })
  const auth = await requireAuth(ctx as never)
  const company = args.tables.companies.find(
    (candidate) => candidate._id === (args.companyId ?? 'company_1')
  )
  if (!company) throw new Error('Missing test company')

  await requireAdminVdrCapability({
    ctx: ctx as never,
    auth,
    capability: args.capability,
    company: company as never,
    action: args.action ?? 'DOCUMENT_ARCHIVE',
    target: args.target ?? 'DOCUMENT:document_1',
    input: args.input ?? INPUT,
  })
}

async function mint(tables: Tables, issuedAt = NOW) {
  const prepared = await mintAdminVdrCapability({
    tables,
    input: INPUT,
    companyId: 'company_1',
    action: 'DOCUMENT_ARCHIVE',
    target: 'DOCUMENT:document_1',
    issuedAt,
  })
  return prepared.adminCapability
}

describe('delegated admin VDR capability', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  it('consumes one valid opaque capability exactly once and emits bounded audit evidence', async () => {
    const tables = capabilityTables()
    const capability = await mint(tables)

    await authorize({ tables, capability })

    expect(tables.adminVdrCapabilities[0]).toMatchObject({ consumedAt: NOW })
    expect(tables.adminAuditLogs).toEqual([
      expect.objectContaining({
        action: 'VDR_ADMIN_CAPABILITY_CONSUME',
        targetType: 'COMPANY',
        targetId: 'company_1',
        newValue: expect.objectContaining({
          action: 'DOCUMENT_ARCHIVE',
          target: 'DOCUMENT:document_1',
          inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          sessionBound: true,
        }),
      }),
    ])
    expect(JSON.stringify(tables)).not.toContain(capability)

    await expect(authorize({ tables, capability })).rejects.toMatchObject({
      data: { code: 'AUTHZ_UNAUTHORIZED' },
    })
    expect(tables.adminAuditLogs).toHaveLength(1)
  })

  it.each(DENIAL_CASES)(
    'denies %s binding mismatch without audit consumption',
    async (_label, override) => {
      const tables = capabilityTables()
      const capability = await mint(tables, override.issuedAt ?? NOW)

      await expect(authorize({ tables, capability, ...override })).rejects.toMatchObject({
        data: { code: 'AUTHZ_UNAUTHORIZED' },
      })
      expect(tables.adminVdrCapabilities[0]).not.toHaveProperty('consumedAt')
      expect(tables.adminAuditLogs).toHaveLength(0)
    }
  )

  it('denies a generic administrator without a delegated capability', async () => {
    const tables = capabilityTables()

    await expect(authorize({ tables })).rejects.toMatchObject({
      data: { code: 'AUTHZ_UNAUTHORIZED' },
    })
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  it('keeps the issuer-owner path unchanged and rejects injected admin bearer material', async () => {
    const tables = capabilityTables()

    await expect(authorize({ tables, identity: ISSUER_IDENTITY })).resolves.toBeUndefined()
    await expect(
      authorize({
        tables,
        identity: ISSUER_IDENTITY,
        capability: `avc_${'a'.repeat(43)}`,
      })
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })
    expect(tables.adminAuditLogs).toHaveLength(0)
  })
})
