import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SUPPORT_MESSAGE_MAX_LENGTH,
  companySupportScope,
  intakeSupportScope,
  normalizeSupportMessage,
} from '../../../convex/_support/model'
import {
  getAdminThread,
  getCompanyThread,
  listAdminIntakeQueue,
  listAdminMessages,
  seedForDev,
  sendAdminMessage,
  sendCompanyMessage,
} from '../../../convex/support'
import { getCompanyChecklist, type CompanyChecklistView } from '../../../convex/companyChecklist'
import { createConvexCtx, runHandler, type Row, type Tables } from './nda-convex-harness'

const NOW = 1_900_000_000_000
const WORKOS_ISSUER = 'https://api.workos.com/'

function row(overrides: Partial<Row> & Pick<Row, '_id'>): Row {
  return { _creationTime: NOW - 10_000, ...overrides }
}

function baseTables(): Tables {
  return {
    users: [],
    profiles: [],
    companies: [],
    organizationMemberships: [],
    companyOrganizationBindings: [],
    companyAuthorizationControls: [],
    workosDirectoryUsers: [],
    workosDirectories: [],
    workosDirectoryGroupMemberships: [],
    supportThreads: [],
    supportMessages: [],
    rateLimits: [],
    adminAuditLogs: [],
    deliverables: [],
    documents: [],
    intakeSessions: [],
    intakeAssessments: [],
  }
}

function ownerTables(): Tables {
  const tables = baseTables()
  tables.users.push(
    row({
      _id: 'user_owner',
      authProvider: 'workos',
      providerUserId: 'workos_owner',
      workosUserId: 'workos_owner',
      email: 'owner@example.com',
      role: 'COMPANY',
    })
  )
  tables.profiles.push(
    row({
      _id: 'profile_owner',
      userId: 'user_owner',
      role: 'COMPANY',
      isActive: true,
    })
  )
  tables.organizationMemberships.push(
    row({
      _id: 'membership_owner',
      userId: 'user_owner',
      profileId: 'profile_owner',
      authProvider: 'workos',
      providerOrgId: 'org_company',
      workosOrgId: 'org_company',
      betaRole: 'COMPANY_OWNER',
      profileRole: 'COMPANY',
      status: 'ACTIVE',
      createdAt: NOW - 20_000,
    })
  )
  tables.companies.push(
    row({
      _id: 'company_one',
      ownerId: 'profile_owner',
      name: 'Compañía Uno',
      country: 'PA',
    }),
    row({
      _id: 'company_other',
      ownerId: 'profile_other',
      name: 'Otra empresa',
      country: 'PA',
    })
  )
  tables.companyOrganizationBindings.push(
    row({
      _id: 'binding_company',
      companyId: 'company_one',
      ownerProfileId: 'profile_owner',
      authProvider: 'workos',
      providerOrgId: 'org_company',
      createdAt: NOW - 20_000,
    })
  )
  return tables
}

function ownerIdentity() {
  return { subject: 'workos_owner', issuer: WORKOS_ISSUER, email: 'owner@example.com' }
}

function adminTables(): Tables {
  const tables = baseTables()
  tables.users.push(
    row({
      _id: 'user_admin',
      authProvider: 'workos',
      providerUserId: 'workos_admin',
      workosUserId: 'workos_admin',
      email: 'maintainer@example.com',
      role: 'ADMIN',
    })
  )
  tables.profiles.push(
    row({
      _id: 'profile_admin',
      userId: 'user_admin',
      role: 'ADMIN',
      isActive: true,
    })
  )
  tables.companies.push(
    row({
      _id: 'company_one',
      ownerId: 'profile_owner',
      name: 'Compañía Uno',
      country: 'PA',
    })
  )
  return tables
}

function adminIdentity() {
  return { subject: 'workos_admin', issuer: WORKOS_ISSUER, email: 'maintainer@example.com' }
}

type SupportMessagePage = {
  page: Array<{ sequence: number }>
  isDone: boolean
  continueCursor: string
}

describe('support model', () => {
  it('creates mutually exclusive scope values', () => {
    expect(companySupportScope('company_one' as never)).toEqual({
      kind: 'COMPANY',
      companyId: 'company_one',
    })
    expect(intakeSupportScope('intake_one' as never)).toEqual({
      kind: 'INTAKE',
      intakeSessionId: 'intake_one',
    })
  })

  it('keeps markup as bounded plain text and rejects unsafe control input', () => {
    expect(normalizeSupportMessage('  <script>alert("x")</script>  ')).toBe(
      '<script>alert("x")</script>'
    )
    expect(() => normalizeSupportMessage('x'.repeat(SUPPORT_MESSAGE_MAX_LENGTH + 1))).toThrow()
    expect(() => normalizeSupportMessage('hola\u0000equipo')).toThrow()
  })
})

describe('support Convex boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lets a centrally authorized owner create one company thread with unread admin state', async () => {
    const ctx = createConvexCtx(ownerTables(), { identity: ownerIdentity() })

    const result = await runHandler<
      { companyId: string; body: string },
      { threadId: string; messageId: string; sequence: number }
    >(sendCompanyMessage, ctx, {
      companyId: 'company_one',
      body: '<script>alert("still text")</script>',
    })

    expect(result.sequence).toBe(1)
    expect(ctx.tables.supportThreads).toHaveLength(1)
    expect(ctx.tables.supportThreads[0]).toMatchObject({
      scope: { kind: 'COMPANY', companyId: 'company_one' },
      scopeKey: 'company:company_one',
      lastSequence: 1,
      adminUnread: true,
      adminUnreadCount: 1,
      clientUnread: false,
    })
    expect(ctx.tables.supportMessages[0]).toMatchObject({
      threadId: result.threadId,
      sequence: 1,
      author: { kind: 'COMPANY', profileId: 'profile_owner' },
      body: '<script>alert("still text")</script>',
    })
  })

  it('lets a company member read but never send through the read-only lane', async () => {
    const tables = ownerTables()
    tables.users.push(
      row({
        _id: 'user_member',
        authProvider: 'workos',
        providerUserId: 'workos_member',
        workosUserId: 'workos_member',
        email: 'member@example.com',
        role: 'COMPANY',
      })
    )
    tables.profiles.push(
      row({
        _id: 'profile_member',
        userId: 'user_member',
        role: 'COMPANY',
        isActive: true,
      })
    )
    tables.organizationMemberships.push(
      row({
        _id: 'membership_member',
        userId: 'user_member',
        profileId: 'profile_member',
        authProvider: 'workos',
        providerOrgId: 'org_company',
        workosOrgId: 'org_company',
        betaRole: 'COMPANY_MEMBER',
        profileRole: 'COMPANY',
        status: 'ACTIVE',
        createdAt: NOW - 10_000,
      })
    )
    const ctx = createConvexCtx(tables, {
      identity: { subject: 'workos_member', issuer: WORKOS_ISSUER, email: 'member@example.com' },
    })

    await expect(
      runHandler(getCompanyThread, ctx, { companyId: 'company_one' })
    ).resolves.toMatchObject({ canSend: false })
    await expect(
      runHandler(sendCompanyMessage, ctx, { companyId: 'company_one', body: 'Necesito ayuda.' })
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })
  })

  it('fails closed when a company caller names another company', async () => {
    const ctx = createConvexCtx(ownerTables(), { identity: ownerIdentity() })

    await expect(
      runHandler(sendCompanyMessage, ctx, { companyId: 'company_other', body: 'No debe entrar.' })
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })
    expect(ctx.tables.supportThreads).toHaveLength(0)
    expect(ctx.tables.supportMessages).toHaveLength(0)
  })

  it('returns the stable rate-limit code before a thirteenth company message', async () => {
    const ctx = createConvexCtx(ownerTables(), { identity: ownerIdentity() })

    for (let index = 0; index < 12; index += 1) {
      await runHandler(sendCompanyMessage, ctx, {
        companyId: 'company_one',
        body: `Mensaje ${index + 1}`,
      })
    }

    await expect(
      runHandler(sendCompanyMessage, ctx, {
        companyId: 'company_one',
        body: 'Mensaje bloqueado',
      })
    ).rejects.toMatchObject({ data: { code: 'RATE_LIMIT_EXCEEDED' } })
    expect(ctx.tables.supportMessages).toHaveLength(12)
  })

  it('audits an admin reply without copying body or plaintext email into audit evidence', async () => {
    const ctx = createConvexCtx(adminTables(), { identity: adminIdentity() })

    await runHandler(sendAdminMessage, ctx, {
      companyId: 'company_one',
      body: '¿Puedes compartir el detalle faltante?',
    })

    expect(ctx.tables.supportMessages[0]).toMatchObject({
      author: { kind: 'ADMIN', profileId: 'profile_admin' },
    })
    expect(ctx.tables.adminAuditLogs).toHaveLength(1)
    expect(ctx.tables.adminAuditLogs[0]).toMatchObject({
      adminProfileId: 'profile_admin',
      adminEmail: '[redacted]',
      action: 'SUPPORT_MESSAGE_SEND',
      targetType: 'SUPPORT_THREAD',
      targetId: ctx.tables.supportThreads[0]._id,
      newValue: { operation: 'SUPPORT_MESSAGE_SEND' },
    })
    expect(JSON.stringify(ctx.tables.adminAuditLogs[0])).not.toContain('detalle faltante')
    expect(JSON.stringify(ctx.tables.adminAuditLogs[0])).not.toContain('maintainer@example.com')
  })

  it('audits every admin message page before returning bodies and keeps newest-first pagination', async () => {
    const tables = adminTables()
    tables.supportThreads.push(
      row({
        _id: 'support_thread_one',
        scope: { kind: 'COMPANY', companyId: 'company_one' },
        scopeKey: 'company:company_one',
        lastSequence: 3,
        adminReadThroughSequence: 0,
        clientReadThroughSequence: 3,
        adminUnreadCount: 3,
        clientUnreadCount: 0,
        adminUnread: true,
        clientUnread: false,
        createdAt: NOW - 3_000,
        updatedAt: NOW - 1_000,
        lastMessageAt: NOW - 1_000,
      })
    )
    tables.supportMessages.push(
      row({
        _id: 'support_message_one',
        threadId: 'support_thread_one',
        sequence: 1,
        author: { kind: 'COMPANY', profileId: 'profile_owner' },
        body: 'Primer mensaje privado',
        createdAt: NOW - 3_000,
      }),
      row({
        _id: 'support_message_two',
        threadId: 'support_thread_one',
        sequence: 2,
        author: { kind: 'ADMIN', profileId: 'profile_admin' },
        body: 'Segundo mensaje privado',
        createdAt: NOW - 2_000,
      }),
      row({
        _id: 'support_message_three',
        threadId: 'support_thread_one',
        sequence: 3,
        author: { kind: 'COMPANY', profileId: 'profile_owner' },
        body: 'Tercer mensaje privado',
        createdAt: NOW - 1_000,
      })
    )
    const ctx = createConvexCtx(tables, { identity: adminIdentity() })

    const firstPage = await runHandler<
      { threadId: string; paginationOpts: { cursor: string | null; numItems: number } },
      SupportMessagePage
    >(listAdminMessages, ctx, {
      threadId: 'support_thread_one',
      paginationOpts: { cursor: null, numItems: 2 },
    })

    expect(firstPage.page.map((message) => message.sequence)).toEqual([3, 2])
    expect(firstPage.isDone).toBe(false)
    expect(ctx.tables.adminAuditLogs).toHaveLength(1)
    expect(ctx.tables.adminAuditLogs[0]).toMatchObject({
      action: 'SUPPORT_THREAD_READ',
      targetType: 'SUPPORT_THREAD',
      targetId: 'support_thread_one',
      newValue: {
        operation: 'SUPPORT_MESSAGES_READ',
        supportThreadId: 'support_thread_one',
        messageCount: 2,
        continueCursor: '2',
      },
    })
    expect(JSON.stringify(ctx.tables.adminAuditLogs[0])).not.toContain('mensaje privado')

    const secondPage = await runHandler<
      { threadId: string; paginationOpts: { cursor: string | null; numItems: number } },
      SupportMessagePage
    >(listAdminMessages, ctx, {
      threadId: 'support_thread_one',
      paginationOpts: { cursor: firstPage.continueCursor, numItems: 2 },
    })

    expect(secondPage.page.map((message) => message.sequence)).toEqual([1])
    expect(secondPage.isDone).toBe(true)
    expect(ctx.tables.adminAuditLogs).toHaveLength(2)
    expect(ctx.tables.adminAuditLogs[1]).toMatchObject({
      action: 'SUPPORT_THREAD_READ',
      newValue: {
        operation: 'SUPPORT_MESSAGES_READ',
        supportThreadId: 'support_thread_one',
        messageCount: 1,
        continueCursor: '3',
      },
    })
  })

  it('resolves an active intake room by exact session and lets the admin reply', async () => {
    const tables = adminTables()
    tables.intakeSessions.push(
      row({
        _id: 'intake_session_one',
        status: 'ACTIVE',
        accessExpiresAt: NOW + 60_000,
      }),
      row({
        _id: 'intake_session_other',
        status: 'ACTIVE',
        accessExpiresAt: NOW + 60_000,
      })
    )
    const ctx = createConvexCtx(tables, { identity: adminIdentity() })

    await expect(
      runHandler(getAdminThread, ctx, { intakeSessionId: 'intake_session_one' })
    ).resolves.toMatchObject({
      scopeKind: 'INTAKE',
      intakeSessionId: 'intake_session_one',
      canSend: true,
    })

    const sent = await runHandler<
      { intakeSessionId: string; body: string },
      { threadId: string; messageId: string; sequence: number }
    >(sendAdminMessage, ctx, {
      intakeSessionId: 'intake_session_one',
      body: 'Te ayudamos a revisar la información faltante.',
    })

    expect(sent).toMatchObject({ sequence: 1 })
    expect(ctx.tables.supportThreads).toHaveLength(1)
    expect(ctx.tables.supportThreads[0]).toMatchObject({
      scope: { kind: 'INTAKE', intakeSessionId: 'intake_session_one' },
      scopeKey: 'intake:intake_session_one',
    })
    expect(ctx.tables.supportMessages[0]).toMatchObject({
      threadId: sent.threadId,
      author: { kind: 'ADMIN', profileId: 'profile_admin' },
      body: 'Te ayudamos a revisar la información faltante.',
    })
  })

  it('rejects a mixed thread and intake selection instead of crossing session scope', async () => {
    const tables = adminTables()
    tables.intakeSessions.push(
      row({
        _id: 'intake_session_one',
        status: 'ACTIVE',
        accessExpiresAt: NOW + 60_000,
      }),
      row({
        _id: 'intake_session_other',
        status: 'ACTIVE',
        accessExpiresAt: NOW + 60_000,
      })
    )
    tables.supportThreads.push(
      row({
        _id: 'support_thread_other',
        scope: { kind: 'INTAKE', intakeSessionId: 'intake_session_other' },
        scopeKey: 'intake:intake_session_other',
        lastSequence: 0,
        adminReadThroughSequence: 0,
        clientReadThroughSequence: 0,
        adminUnreadCount: 0,
        clientUnreadCount: 0,
        adminUnread: false,
        clientUnread: false,
        createdAt: NOW,
        updatedAt: NOW,
        lastMessageAt: NOW,
      })
    )
    const ctx = createConvexCtx(tables, { identity: adminIdentity() })

    await expect(
      runHandler(sendAdminMessage, ctx, {
        threadId: 'support_thread_other',
        intakeSessionId: 'intake_session_one',
        body: 'No debe cruzar de sala.',
      })
    ).rejects.toMatchObject({ data: { code: 'VALIDATION_FAILED' } })
    expect(ctx.tables.supportMessages).toHaveLength(0)
  })

  it('uses the same two-of-seven checklist as the room and counts missing deliverable evidence separately', async () => {
    const tables = ownerTables()
    const admin = adminTables()
    tables.users.push(...admin.users)
    tables.profiles.push(...admin.profiles)
    tables.companyChecklist = [
      row({
        _id: 'checklist_one',
        companyId: 'company_one',
        nameConfirmedAt: NOW - 1000,
      }),
    ]
    tables.documents.push(
      row({
        _id: 'financial_one',
        companyId: 'company_one',
        folder: 'room_financial',
        lifecycleStatus: 'ACTIVE',
      })
    )
    const room = await runHandler<{ companyId: string }, CompanyChecklistView>(
      getCompanyChecklist,
      createConvexCtx(tables, { identity: ownerIdentity() }),
      { companyId: 'company_one' }
    )
    const ctx = createConvexCtx(tables, { identity: adminIdentity() })
    type Queue = {
      items: Array<{
        companyId: string
        readiness: { completedCount: number; totalCount: number; missingCount: number }
        missingEvidence: { count: number }
      }>
    }
    const before = await runHandler<{ limit: number }, Queue>(listAdminIntakeQueue, ctx, {
      limit: 20,
    })
    const companyBefore = before.items.find((item) => item.companyId === 'company_one')
    expect(room.completedCount).toBe(2)
    expect(companyBefore?.readiness).toEqual({
      available: true,
      completedCount: room.completedCount,
      totalCount: Object.keys(room.items).length,
      missingCount: 5,
    })
    tables.deliverables.push(
      row({
        _id: 'needs_input_one',
        companyId: 'company_one',
        kind: 'MODEL',
        status: 'NEEDS_INPUT',
        updatedAt: NOW,
      })
    )
    const after = await runHandler<{ limit: number }, Queue>(listAdminIntakeQueue, ctx, {
      limit: 20,
    })
    const companyAfter = after.items.find((item) => item.companyId === 'company_one')
    expect(companyAfter?.readiness).toEqual(companyBefore?.readiness)
    expect(companyBefore?.missingEvidence.count).toBe(0)
    expect(companyAfter?.missingEvidence.count).toBe(1)

    tables.profiles.find((profile) => profile._id === 'profile_owner')!.phone = '+50760000000'
    tables.companyChecklist[0].financialsDepthConfirmedAt = NOW
    tables.companyChecklist[0].kickoffCallAt = NOW
    for (const folder of ['room_legal', 'room_corporate']) {
      tables.documents.push(
        row({
          _id: folder,
          companyId: 'company_one',
          folder,
          lifecycleStatus: 'ACTIVE',
        })
      )
    }
    const completed = await runHandler<{ limit: number }, Queue>(listAdminIntakeQueue, ctx, {
      limit: 20,
    })
    const completeCompany = completed.items.find((item) => item.companyId === 'company_one')
    expect(completeCompany?.readiness).toEqual({
      available: true,
      completedCount: 7,
      totalCount: 7,
      missingCount: 0,
    })
    expect(completeCompany?.missingEvidence.count).toBe(1)
  })

  it('projects only actionable queue metadata and never document names or support bodies', async () => {
    const tables = adminTables()
    tables.documents.push(
      row({
        _id: 'document_secret',
        companyId: 'company_one',
        name: 'Nombre confidencial del documento.pdf',
        folder: 'Financial Statements',
        lifecycleStatus: 'ACTIVE',
      })
    )
    tables.deliverables.push(
      row({
        _id: 'deliverable_draft',
        companyId: 'company_one',
        kind: 'CIM',
        status: 'DRAFT_READY',
        updatedAt: NOW - 500,
      })
    )
    tables.supportThreads.push(
      row({
        _id: 'support_thread_one',
        scope: { kind: 'COMPANY', companyId: 'company_one' },
        scopeKey: 'company:company_one',
        lastSequence: 1,
        adminReadThroughSequence: 0,
        clientReadThroughSequence: 1,
        adminUnreadCount: 1,
        clientUnreadCount: 0,
        adminUnread: true,
        clientUnread: false,
        createdAt: NOW - 2_000,
        updatedAt: NOW - 1_000,
        lastMessageAt: NOW - 1_000,
      })
    )
    tables.supportMessages.push(
      row({
        _id: 'support_message_secret',
        threadId: 'support_thread_one',
        sequence: 1,
        author: { kind: 'COMPANY', profileId: 'profile_owner' },
        body: 'Texto privado del cliente',
        createdAt: NOW - 1_000,
      })
    )
    const ctx = createConvexCtx(tables, { identity: adminIdentity() })

    const result = await runHandler<{ limit: number }, { items: unknown[] }>(
      listAdminIntakeQueue,
      ctx,
      { limit: 20 }
    )
    const serialized = JSON.stringify(result)

    expect(result.items).toHaveLength(1)
    expect(serialized).toContain('deliverable_draft')
    expect(serialized).toContain('support_thread_one')
    expect(serialized).not.toContain('Nombre confidencial')
    expect(serialized).not.toContain('Texto privado')
    expect(serialized).not.toContain('@example.com')
  })

  it('drops a historical needs-review signal after a newer team assessment is ready', async () => {
    const tables = adminTables()
    tables.intakeSessions.push(
      row({
        _id: 'intake_session_reviewed',
        status: 'ACTIVE',
        accessExpiresAt: NOW + 60_000,
      })
    )
    tables.intakeAssessments.push(
      row({
        _id: 'assessment_old',
        _creationTime: NOW - 2_000,
        intakeSessionId: 'intake_session_reviewed',
        status: 'NEEDS_REVIEW',
        source: 'EXTERNAL',
        findings: [],
        createdAt: NOW - 2_000,
        updatedAt: NOW - 2_000,
      }),
      row({
        _id: 'assessment_latest',
        _creationTime: NOW - 1_000,
        intakeSessionId: 'intake_session_reviewed',
        status: 'READY',
        source: 'TEAM',
        findings: [],
        createdAt: NOW - 1_000,
        updatedAt: NOW - 1_000,
      })
    )
    const ctx = createConvexCtx(tables, { identity: adminIdentity() })

    const result = await runHandler<{ limit: number }, { items: unknown[] }>(
      listAdminIntakeQueue,
      ctx,
      { limit: 20 }
    )

    expect(result.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          intakeSessionId: 'intake_session_reviewed',
          assessmentReview: expect.objectContaining({ count: 1 }),
        }),
      ])
    )
  })
})

describe('support.seedForDev', () => {
  const previousBypass = process.env.BYPASS_AUTH
  const previousConvexEnv = process.env.CONVEX_ENV

  afterEach(() => {
    if (previousBypass === undefined) delete process.env.BYPASS_AUTH
    else process.env.BYPASS_AUTH = previousBypass
    if (previousConvexEnv === undefined) delete process.env.CONVEX_ENV
    else process.env.CONVEX_ENV = previousConvexEnv
  })

  it('fails closed outside a local deployment', async () => {
    delete process.env.BYPASS_AUTH
    delete process.env.CONVEX_ENV
    const ctx = createConvexCtx(baseTables())
    await expect(runHandler(seedForDev, ctx, { count: 2 })).rejects.toThrow(/BYPASS_AUTH/)
  })

  it('leaves exactly count measurement threads and removes the extras', async () => {
    process.env.BYPASS_AUTH = 'true'
    process.env.CONVEX_ENV = 'dev'
    const ctx = createConvexCtx(baseTables())

    const first = await runHandler<
      { count: number },
      { created: number; removed: number; count: number }
    >(seedForDev, ctx, { count: 3 })
    expect(first).toEqual({ created: 3, removed: 0, count: 3 })
    expect(ctx.tables.supportThreads).toHaveLength(3)
    expect(ctx.tables.supportMessages).toHaveLength(3)

    const second = await runHandler<
      { count: number },
      { created: number; removed: number; count: number }
    >(seedForDev, ctx, { count: 2 })
    expect(second).toEqual({ created: 0, removed: 1, count: 2 })
    expect(ctx.tables.supportThreads).toHaveLength(2)
    expect(
      ctx.tables.users.filter((user) => String(user.email).startsWith('hilo-medicion-'))
    ).toHaveLength(2)
  })

  it('deletes every message of a retired slot even past one page', async () => {
    process.env.BYPASS_AUTH = 'true'
    process.env.CONVEX_ENV = 'dev'
    const ctx = createConvexCtx(baseTables())

    await runHandler<{ count: number }, { created: number; removed: number; count: number }>(
      seedForDev,
      ctx,
      { count: 3 }
    )

    const retiredUser = ctx.tables.users.find((user) => user.email === 'hilo-medicion-03@dev.local')
    expect(retiredUser).toBeDefined()
    const retiredProfile = ctx.tables.profiles.find(
      (profile) => profile.userId === retiredUser?._id
    )
    const retiredCompany = ctx.tables.companies.find(
      (company) => company.ownerId === retiredProfile?._id
    )
    const retiredThread = ctx.tables.supportThreads.find(
      (thread) => thread.scopeKey === `company:${retiredCompany?._id}`
    )
    expect(retiredThread).toBeDefined()
    const retiredThreadId = retiredThread?._id
    const seedMessage = ctx.tables.supportMessages.find(
      (message) => message.threadId === retiredThreadId
    )
    expect(seedMessage).toBeDefined()

    for (let sequence = 2; sequence <= 120; sequence += 1) {
      ctx.tables.supportMessages.push(
        row({
          _id: `support_message_seed_${sequence}`,
          threadId: retiredThreadId,
          sequence,
          author: seedMessage?.author,
          body: `Mensaje extra ${sequence}`,
          createdAt: NOW + sequence,
        })
      )
    }
    expect(
      ctx.tables.supportMessages.filter((message) => message.threadId === retiredThreadId)
    ).toHaveLength(120)

    const second = await runHandler<
      { count: number },
      { created: number; removed: number; count: number }
    >(seedForDev, ctx, { count: 2 })
    expect(second).toEqual({ created: 0, removed: 1, count: 2 })
    expect(
      ctx.tables.supportMessages.filter((message) => message.threadId === retiredThreadId)
    ).toHaveLength(0)
    expect(ctx.tables.supportThreads).toHaveLength(2)
    expect(ctx.tables.supportMessages).toHaveLength(2)
  })
})
