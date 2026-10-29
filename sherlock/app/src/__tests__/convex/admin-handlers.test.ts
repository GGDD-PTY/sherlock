import { describe, expect, it } from 'vitest'

import {
  createMockCompany,
  getUserForImpersonation,
  listUsersForImpersonation,
} from '../../../convex/admin'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const ADMIN_IDENTITY = {
  issuer: 'https://api.workos.com/',
  subject: 'workos_admin',
  email: 'fixture-14e4636f@example.com',
}

function baseTables(overrides: Partial<Tables> = {}): Tables {
  return {
    users: [
      {
        _id: 'user_admin',
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'fixture-14e4636f@example.com',
        name: 'Admin',
      },
      {
        _id: 'user_owner',
        authProvider: 'workos',
        providerUserId: 'workos_owner',
        workosUserId: 'workos_owner',
        email: 'fixture-befbb74d@example.com',
        name: 'Owner',
      },
      {
        _id: 'user_investor',
        authProvider: 'workos',
        providerUserId: 'workos_investor',
        workosUserId: 'workos_investor',
        email: 'fixture-3a06353e@example.com',
        name: 'Ana',
      },
    ],
    profiles: [
      {
        _id: 'profile_admin',
        userId: 'user_admin',
        role: 'ADMIN',
        isActive: true,
        fullName: 'Admin Sherlock',
        isVerified: true,
      },
      {
        _id: 'profile_owner',
        userId: 'user_owner',
        role: 'COMPANY',
        isActive: true,
        fullName: 'Sample Hydro',
        isVerified: true,
      },
      {
        _id: 'profile_investor',
        userId: 'user_investor',
        role: 'COMPANY',
        isActive: true,
        fullName: 'Ana Fondo',
        isVerified: false,
      },
    ],
    companies: [
      {
        _id: 'company_sampleenergy',
        ownerId: 'profile_owner',
        name: 'Sample Hydro',
        country: 'PA',
        sector: 'financial_services',
        isPublic: false,
        _creationTime: 10,
      },
    ],
    adminAuditLogs: [],
    ...overrides,
  }
}

function adminCtx(tables: Tables) {
  return createConvexCtx(tables, { identity: ADMIN_IDENTITY })
}

describe('admin.listUsersForImpersonation', () => {
  it('returns a safe projection and records the unfiltered search', async () => {
    const tables = baseTables()
    const ctx = adminCtx(tables)

    const result = await runHandler<
      Record<string, unknown>,
      Array<{ id: string; email: string; role: string }>
    >(listUsersForImpersonation, ctx, { limit: 10 })

    expect(new Set(result.map((row) => row.id))).toEqual(
      new Set(['profile_admin', 'profile_investor', 'profile_owner'])
    )
    expect(result.find((row) => row.id === 'profile_owner')).toMatchObject({
      fullName: 'Sample Hydro',
      email: 'fixture-befbb74d@example.com',
      role: 'COMPANY',
      isVerified: true,
    })
    expect(tables.adminAuditLogs).toEqual([
      expect.objectContaining({
        action: 'IMPERSONATION_LIST_SEARCH',
        notes: expect.stringMatching(/sin filtro/),
      }),
    ])
  })

  it('filters by name or email after the 100-character cap', async () => {
    const tables = baseTables()
    const ctx = adminCtx(tables)

    const byName = await runHandler<Record<string, unknown>, Array<{ id: string }>>(
      listUsersForImpersonation,
      ctx,
      { search: 'ana' }
    )
    const byEmail = await runHandler<Record<string, unknown>, Array<{ id: string }>>(
      listUsersForImpersonation,
      ctx,
      { search: 'fixture-befbb74d' }
    )
    const capped = await runHandler<Record<string, unknown>, Array<{ id: string }>>(
      listUsersForImpersonation,
      ctx,
      { search: `${'z'.repeat(120)}ana` }
    )

    expect(byName.map((row) => row.id)).toEqual(['profile_investor'])
    expect(byEmail.map((row) => row.id)).toEqual(['profile_owner'])
    expect(capped).toEqual([])
  })
})

describe('admin.getUserForImpersonation', () => {
  it('returns company extras for a COMPANY profile', async () => {
    const tables = baseTables()
    const ctx = adminCtx(tables)

    const result = await runHandler(getUserForImpersonation, ctx, {
      userId: 'profile_owner',
    })

    expect(result).toMatchObject({
      id: 'profile_owner',
      email: 'fixture-befbb74d@example.com',
      role: 'COMPANY',
      companyName: 'Sample Hydro',
    })
    expect(tables.adminAuditLogs).toEqual([
      expect.objectContaining({
        action: 'IMPERSONATION_USER_ACCESS',
        targetId: 'profile_owner',
      }),
    ])
  })

  it('returns null for a profile that does not exist', async () => {
    const tables = baseTables()
    const ctx = adminCtx(tables)

    const missing = await runHandler(getUserForImpersonation, ctx, {
      userId: 'profile_missing',
    })

    expect(missing).toBeNull()
  })
})

describe('admin.createMockCompany', () => {
  it('rejects a missing owner and inserts a completed company otherwise', async () => {
    const tables = baseTables()
    const ctx = createConvexCtx(tables)

    await expect(
      runHandler(createMockCompany, ctx, {
        ownerId: 'profile_missing',
        name: 'Demo SA',
        country: 'PA',
      })
    ).rejects.toThrow(/no encontrado/)

    const created = await runHandler<
      Record<string, unknown>,
      { companyId: string; message: string }
    >(createMockCompany, ctx, {
      ownerId: 'profile_owner',
      name: 'Demo SA',
      country: 'CR',
      sector: 'technology',
      industry: 'fintech',
      businessModel: 'SAAS',
      stage: 'SEED',
    })

    expect(created.message).toContain('Demo SA')
    expect(tables.companies.at(-1)).toMatchObject({
      _id: created.companyId,
      ownerId: 'profile_owner',
      name: 'Demo SA',
      country: 'CR',
      currency: 'USD',
      isPublic: true,
      onboardingStep: 6,
    })
  })
})
