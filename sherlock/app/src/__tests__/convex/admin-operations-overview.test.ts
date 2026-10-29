import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getOperationsOverview } from '../../../convex/_analytics/admin'
import { createConvexCtx, runHandler, type Row, type Tables } from './nda-convex-harness'

const NOW = Date.UTC(2026, 7, 29)
const DAY = 24 * 60 * 60 * 1000

function identity(subject: string) {
  return { issuer: 'https://api.workos.com/', subject, email: `${subject}@example.com` }
}

function seed(): Tables {
  return {
    users: [
      {
        _id: 'user_admin',
        _creationTime: 1,
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'admin@example.com',
      },
      {
        _id: 'user_company',
        _creationTime: 2,
        authProvider: 'workos',
        providerUserId: 'workos_company',
        workosUserId: 'workos_company',
        email: 'company@example.com',
      },
    ],
    profiles: [
      {
        _id: 'profile_admin',
        _creationTime: 3,
        userId: 'user_admin',
        role: 'ADMIN',
        isActive: true,
      },
      {
        _id: 'profile_company',
        _creationTime: 4,
        userId: 'user_company',
        role: 'COMPANY',
        isActive: true,
      },
    ],
    companies: [
      { _id: 'company_1', _creationTime: NOW - DAY, ownerId: 'profile_company', name: 'A' },
      { _id: 'company_2', _creationTime: NOW - 45 * DAY, ownerId: 'profile_company', name: 'B' },
    ],
    intakeSessions: [
      { _id: 'intake_1', _creationTime: 10, status: 'ACTIVE', documentCount: 3 },
      { _id: 'intake_2', _creationTime: 11, status: 'CLAIMED', documentCount: 2 },
      { _id: 'intake_3', _creationTime: 12, status: 'EXPIRED', documentCount: 9 },
    ],
    documents: [
      { _id: 'doc_1', _creationTime: 20, companyId: 'company_1', lifecycleStatus: 'ACTIVE' },
      { _id: 'doc_2', _creationTime: 21, companyId: 'company_1', lifecycleStatus: 'QUARANTINED' },
      { _id: 'doc_3', _creationTime: 22, companyId: 'company_1', lifecycleStatus: 'ARCHIVED' },
      { _id: 'doc_4', _creationTime: 23, companyId: 'company_2' },
    ],
    deliverables: [
      { _id: 'deliverable_1', _creationTime: 30, status: 'DRAFT_READY' },
      { _id: 'deliverable_2', _creationTime: 31, status: 'IN_REVIEW' },
      { _id: 'deliverable_3', _creationTime: 32, status: 'DELIVERED' },
      { _id: 'deliverable_4', _creationTime: 33, status: 'IN_PROGRESS' },
      { _id: 'deliverable_5', _creationTime: 34, status: 'APPROVED' },
    ],
    guestInvitations: [
      { _id: 'guest_1', _creationTime: 50, status: 'PENDING' },
      { _id: 'guest_2', _creationTime: 51, status: 'VERIFIED' },
      { _id: 'guest_3', _creationTime: 52, status: 'EXPIRED' },
    ],

    supportThreads: [
      { _id: 'support_1', _creationTime: 80, adminUnreadCount: 2 },
      { _id: 'support_2', _creationTime: 81, adminUnreadCount: 1 },
    ],
  }
}

type OperationsOverview = {
  companies: { total: number; newThisMonth: number }
  intake: { active: number; claimed: number; stagedDocuments: number }
  documents: { active: number; quarantined: number; archived: number }
  deliverables: { open: number; reviewQueue: number; approved: number; delivered: number }
  guests: { pending: number; verified: number }
  support: { unread: number }
  companyDocuments: {
    companyCap: number
    companies: Array<{
      companyId: string
      companyName: string
      truncated: boolean
      active: number
      quarantined: number
      archived: number
    }>
  }
  coverage: { truncated: boolean; scanCap: number }
  generatedAt: number
}

function run(tables: Tables, subject = 'workos_admin') {
  return runHandler<Record<string, never>, OperationsOverview>(
    getOperationsOverview,
    createConvexCtx(tables, { identity: identity(subject) }),
    {}
  )
}

describe('analytics.getOperationsOverview', () => {
  // El handler lee Date.now(): sin reloj fijo, `slaDueAt: NOW + DAY` cruza a
  // "overdue" un día después de escribir el seed.
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns only live readiness and VDR operations metrics', async () => {
    const result = await run(seed())

    expect(result).toMatchObject({
      companies: { total: 2, newThisMonth: 1 },
      intake: { active: 1, claimed: 1, stagedDocuments: 5 },
      documents: { active: 2, quarantined: 1, archived: 1 },
      deliverables: { open: 3, reviewQueue: 2, approved: 1, delivered: 1 },
      guests: { pending: 1, verified: 1 },
      support: { unread: 3 },
      coverage: { truncated: false },
    })
    expect(JSON.stringify(result)).not.toMatch(/investor|interest|match|volume|message/i)
  })

  it('keeps approved deliverables out of open work', async () => {
    const result = await run(seed())

    expect(result.deliverables).toMatchObject({ open: 3, approved: 1, delivered: 1 })
  })

  it('reports exact document lifecycle counts for the 20 newest companies through the company index', async () => {
    const tables = seed()
    tables.companies = Array.from({ length: 21 }, (_, index) => ({
      _id: `company_${index}`,
      _creationTime: index,
      ownerId: 'profile_company',
      name: `Company ${index}`,
    }))
    tables.documents = [
      {
        _id: 'doc_new_active',
        _creationTime: 50,
        companyId: 'company_20',
        lifecycleStatus: 'ACTIVE',
      },
      {
        _id: 'doc_new_quarantined',
        _creationTime: 51,
        companyId: 'company_20',
        lifecycleStatus: 'QUARANTINED',
      },
      {
        _id: 'doc_new_archived',
        _creationTime: 52,
        companyId: 'company_20',
        lifecycleStatus: 'ARCHIVED',
      },
      {
        _id: 'doc_old_archived',
        _creationTime: 53,
        companyId: 'company_0',
        lifecycleStatus: 'ARCHIVED',
      },
    ]
    const ctx = createConvexCtx(tables, { identity: identity('workos_admin') })

    const result = await runHandler<Record<string, never>, OperationsOverview>(
      getOperationsOverview,
      ctx,
      {}
    )

    expect(result.companyDocuments.companyCap).toBe(20)
    expect(result.companyDocuments.companies).toHaveLength(20)
    expect(result.companyDocuments.companies).toContainEqual({
      companyId: 'company_20',
      companyName: 'Company 20',
      truncated: false,
      active: 1,
      quarantined: 1,
      archived: 1,
    })
    expect(result.companyDocuments.companies.map((company) => company.companyId)).not.toContain(
      'company_0'
    )

    const documentQueries = vi
      .mocked(ctx.db.query)
      .mock.results.filter(
        (_, index) => vi.mocked(ctx.db.query).mock.calls[index]?.[0] === 'documents'
      )
      .map((result) => result.value as { withIndex: ReturnType<typeof vi.fn> })
    expect(
      documentQueries.some((query) =>
        query.withIndex.mock.calls.some(([index]) => index === 'by_companyId')
      )
    ).toBe(true)
  })

  it('bounds each company document read at the advertised scan cap', async () => {
    const tables = seed()
    tables.documents = Array.from({ length: 501 }, (_, index) => ({
      _id: `document_${index}`,
      _creationTime: index,
      companyId: 'company_1',
      lifecycleStatus: 'ACTIVE',
    }))

    const result = await run(tables)

    expect(result.companyDocuments.companies[0]).toMatchObject({
      companyId: 'company_1',
      active: 500,
      quarantined: 0,
      archived: 0,
    })
    expect(result.coverage).toMatchObject({ truncated: true, scanCap: 500 })
  })

  it('rejects a company before reading operational tables', async () => {
    await expect(run(seed(), 'workos_company')).rejects.toMatchObject({
      data: { code: 'AUTHZ_ADMIN_REQUIRED' },
    })
  })

  it('rejects an unauthenticated caller', async () => {
    await expect(
      runHandler<Record<string, never>, OperationsOverview>(
        getOperationsOverview,
        createConvexCtx(seed(), { identity: null }),
        {}
      )
    ).rejects.toBeInstanceOf(Error)
  })

  const SCANNED_TABLES = [
    'companies',
    'intakeSessions',
    'documents',
    'deliverables',
    'guestInvitations',
    'supportThreads',
  ] as const

  function inflate(table: (typeof SCANNED_TABLES)[number], length: number): Tables {
    const tables = seed()
    tables[table] = Array.from({ length }, (_, index) => ({
      _id: `${table}_${index}`,
      _creationTime: NOW - index,
    })) as Row[]
    return tables
  }

  it.each(SCANNED_TABLES)('caps the %s scan and marks the overview as truncated', async (table) => {
    const result = await run(inflate(table, 501))

    expect(result.coverage).toMatchObject({ truncated: true, scanCap: 500 })
  })

  it('does not mark the overview as truncated at exactly the cap', async () => {
    const result = await run(inflate('companies', 500))

    expect(result.companies.total).toBe(500)
    expect(result.coverage).toMatchObject({ truncated: false, scanCap: 500 })
  })
})
