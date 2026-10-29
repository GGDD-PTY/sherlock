import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  COMPANY_PURGE_TABLE_PLAN,
  SEED_OWNER_EMAIL_DOMAINS,
  deactivateSeedUsers,
  isSeedOwnerEmail,
  listSeedSweepCandidates,
  purgeCompany,
  purgeOrphanUser,
} from '../../../convex/operatorPurge'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

// Los handlers Convex leen `Date.now()`; un seed con offsets relativos y reloj
// real cruza a rojo a medianoche UTC (CLAUDE.md, «dos rojos que no son
// producto»). El reloj queda fijo.
const NOW = 1_756_800_000_000

const SEED_COMPANY = 'company_seed'
const SEED_COMPANY_NAME = 'Global Nike Inc'
const REAL_COMPANY = 'company_samplelogistics'
const REAL_COMPANY_NAME = 'SAMPLE_LOGISTICS'
const ADMIN_PROFILE = 'profile_admin'

// `runHandler` devuelve `unknown` a propósito (el harness salta el wrapper de
// Convex). Estas formas son el contrato que este test pinnea.
type SweepCandidate = {
  companyId: string
  name: string
  demo: boolean
  ownerEmail: string | null
  memberEmails: string[]
  operatorEmails: string[]
  blockedBy: string[]
  selectable: boolean
}
type SweepReport = { companies: SweepCandidate[]; seedDomains: string[] }
type PurgeResult = {
  execute: boolean
  company: string | null
  alreadyPurged: boolean
  status: string
  deleted: number
  marked: number
  blobsDeleted: number
  tables: Array<{ table: string; decision: string; rows: number }>
  workos: { userIds: string[]; organizationId?: string }
  passes: number
}
type DeactivateResult = {
  execute: boolean
  users: Array<{ email: string; action: string; workosUserId?: string }>
}
type PurgeOrphanResult = {
  execute: boolean
  email: string
  action: 'NOT_FOUND' | 'REFUSED' | 'WOULD_DELETE' | 'DELETED'
  blockers: string[]
  workosUserId?: string | null
  tables: Array<{ table: string; rows: number; decision: 'DELETE' | 'KEEP' }>
}

const ORPHAN_EMAIL = 'orphan.guest@example.test'
const ORPHAN_WORKOS = 'user_01AAAAAAAAAAAAAAAAAAAAAAAA'

/** Tablas por usuario que `seedOrphanUser` siembra con UNA fila cada una. Si el
 *  handler deja de barrer alguna, la fila sobrevive al `--execute`. */
const PER_USER_TABLES = [
  'notificationPreferences',
  'deletionRequests',
  'adminVdrCapabilities',
  'organizationMemberships',
]

function seedOrphanUser(tables: Tables) {
  tables.users.push({
    _id: 'user_orphan',
    email: ORPHAN_EMAIL,
    workosUserId: ORPHAN_WORKOS,
  })
  tables.profiles.push({
    _id: 'profile_orphan',
    userId: 'user_orphan',
    role: 'COMPANY',
    isActive: true,
  })
  tables.notifications.push({
    _id: 'notif_orphan',
    userId: 'profile_orphan',
    type: 'system',
  })
  tables.notificationPreferences = [
    { _id: 'notifpref_orphan', userId: 'profile_orphan', emailWeeklyDigest: false },
  ]
  tables.consents = [{ _id: 'consent_orphan', profileId: 'profile_orphan' }]
  tables.deletionRequests = [
    {
      _id: 'deletion_orphan',
      profileId: 'profile_orphan',
      email: ORPHAN_EMAIL,
      status: 'PENDING',
      requestedAt: NOW - 86_400_000,
    },
  ]
  tables.documentAccessGrants.push({
    _id: 'grant_orphan',
    documentId: 'doc_a',
    companyId: SEED_COMPANY,
    profileId: 'profile_orphan',
  })
  tables.adminVdrCapabilities = [
    {
      _id: 'capability_orphan',
      tokenHash: 'hash_orphan',
      profileId: 'profile_orphan',
      identityBindingDigest: 'digest_orphan',
      companyId: SEED_COMPANY,
      action: 'DOWNLOAD',
      target: 'doc_a',
      inputDigest: 'input_orphan',
      issuedAt: NOW - 60_000,
      expiresAt: NOW + 60_000,
    },
  ]
  tables.organizationMemberships = [
    {
      _id: 'membership_orphan',
      userId: 'user_orphan',
      profileId: 'profile_orphan',
      authProvider: 'workos',
      providerOrgId: 'org_01SEED',
      betaRole: 'COMPANY_MEMBER',
      profileRole: 'COMPANY',
      createdAt: NOW - 90_000,
    },
  ]
  tables.activityLogs = [{ _id: 'activity_orphan', userId: 'profile_orphan', action: 'LOGIN' }]
  tables.securityEvents = [{ _id: 'security_orphan', userId: 'user_orphan', event: 'AUTH_FAILURE' }]
}

const operatorConfirmation = {
  operatorProfileId: ADMIN_PROFILE,
  reason: 'Purga de empresa de prueba aprobada por el equipo.',
}

function ctxWithStorage(tables: Tables) {
  const base = createConvexCtx(tables)
  const deleted: string[] = []
  return {
    ctx: {
      ...base,
      storage: {
        delete: vi.fn(async (id: string) => {
          deleted.push(id)
          tables._storage = (tables._storage ?? []).filter((row) => row._id !== id)
        }),
      },
    },
    deletedBlobs: deleted,
  }
}

/** Empresa seed completa: dueño seed, dos salas, tres documentos, un grant y
 *  una corrida de modelo. Es el escenario del brief (entregable 4). */
function seedTables(overrides: Partial<Tables> = {}): Tables {
  return {
    companies: [
      { _id: SEED_COMPANY, name: SEED_COMPANY_NAME, ownerId: 'profile_seed_owner', demo: true },
      { _id: REAL_COMPANY, name: REAL_COMPANY_NAME, ownerId: 'profile_real_owner' },
    ],
    profiles: [
      { _id: 'profile_seed_owner', userId: 'user_seed_owner', role: 'COMPANY', isActive: true },
      { _id: 'profile_real_owner', userId: 'user_real_owner', role: 'COMPANY', isActive: true },
      { _id: ADMIN_PROFILE, userId: 'user_admin', role: 'ADMIN', isActive: true },
    ],
    users: [
      { _id: 'user_seed_owner', email: 'owner@seed.local', workosUserId: 'user_01SEED' },
      { _id: 'user_real_owner', email: 'fixture-8b8414fc@example.com', workosUserId: 'user_01REAL' },
      { _id: 'user_admin', email: 'fixture-4622a879@example.com' },
    ],
    documents: [
      { _id: 'doc_a', companyId: SEED_COMPANY, name: 'INA 2024', storageId: 'blob_a' },
      { _id: 'doc_b', companyId: SEED_COMPANY, name: 'INA 2025', storageId: 'blob_b' },
      { _id: 'doc_c', companyId: SEED_COMPANY, name: 'INT 2026 Q1', storageId: 'blob_c' },
      { _id: 'doc_real', companyId: REAL_COMPANY, name: 'INA SAMPLE_LOGISTICS', storageId: 'blob_real' },
    ],
    documentVersions: [
      {
        _id: 'ver_a',
        documentId: 'doc_a',
        companyId: SEED_COMPANY,
        versionNumber: 1,
        storageId: 'blob_a',
        createdAt: NOW - 1000,
        createdByProfileId: 'profile_seed_owner',
      },
      {
        _id: 'ver_real',
        documentId: 'doc_real',
        companyId: REAL_COMPANY,
        versionNumber: 1,
        storageId: 'blob_real',
        createdAt: NOW - 1000,
        createdByProfileId: 'profile_real_owner',
      },
    ],
    documentAccessGrants: [{ _id: 'grant_a', documentId: 'doc_a', companyId: SEED_COMPANY }],
    documentTextIndex: [{ _id: 'text_a', documentId: 'doc_a', companyId: SEED_COMPANY }],
    documentLegalHolds: [],
    documentAccessLogs: [{ _id: 'access_seed', companyId: SEED_COMPANY, documentId: 'doc_a' }],
    vdrReadAudits: [{ _id: 'read_seed', companyId: SEED_COMPANY, documentId: 'doc_a' }],
    companyOrganizationBindings: [
      {
        _id: 'binding_seed',
        companyId: SEED_COMPANY,
        ownerProfileId: 'profile_seed_owner',
        createdByProfileId: 'profile_seed_owner',
        authProvider: 'workos',
        providerOrgId: 'org_01SEED',
      },
    ],
    companyChecklist: [{ _id: 'checklist_seed', companyId: SEED_COMPANY }],
    teamAlerts: [
      {
        _id: 'alert_seed',
        companyId: SEED_COMPANY,
        companyName: SEED_COMPANY_NAME,
        notificationIds: ['notif_seed'],
      },
    ],
    notifications: [{ _id: 'notif_seed', userId: ADMIN_PROFILE, type: 'system' }],
    deliverables: [],
    intakeDocuments: [],
    intakeUploadIntents: [],
    vdrUploadIntents: [],
    assetUploadIntents: [],
    // Bitácora que el purge CONSERVA: una fila previa de la empresa purgada.
    adminAuditLogs: [
      {
        _id: 'audit_previo',
        adminProfileId: ADMIN_PROFILE,
        adminEmail: 'fixture-4622a879@example.com',
        action: 'COMPANY_ROOM_ACTIVATION',
        targetType: 'COMPANY',
        targetId: SEED_COMPANY,
      },
    ],
    webhookEvents: [{ _id: 'webhook_1', provider: 'workos', eventId: 'evt_1' }],
    _storage: [
      { _id: 'blob_a', size: 10 },
      { _id: 'blob_b', size: 20 },
      { _id: 'blob_c', size: 30 },
      { _id: 'blob_real', size: 40 },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})

describe('isSeedOwnerEmail', () => {
  it('acepta exactamente los tres dominios de seed', () => {
    expect(SEED_OWNER_EMAIL_DOMAINS).toEqual(['seed.local', 'dev.local', 'retired.local'])
    expect(isSeedOwnerEmail('owner@seed.local')).toBe(true)
    expect(isSeedOwnerEmail('admin@dev.local')).toBe(true)
    expect(isSeedOwnerEmail('legacy+sample@retired.local')).toBe(true)
    expect(isSeedOwnerEmail('OWNER@SEED.LOCAL')).toBe(true)
  })

  it('rechaza todo lo demás, incluidos los correos reales y los parecidos', () => {
    for (const email of [
      'fixture-8b8414fc@example.com',
      'fixture-4622a879@example.com',
      'todd@example.com',
      'fixture-c66e0b70@example.com',
      // Sufijo que TERMINA en un dominio seed pero no lo ES.
      'owner@notseed.local',
      'owner@seed.local.example.com',
      '',
    ]) {
      expect(isSeedOwnerEmail(email)).toBe(false)
    }
    expect(isSeedOwnerEmail(undefined)).toBe(false)
  })
})

describe('operatorPurge.listSeedSweepCandidates', () => {
  it('selecciona la empresa con dueño seed y NUNCA la de dueño real', async () => {
    const tables = seedTables()
    const { ctx } = ctxWithStorage(tables)

    const report = await runHandler<Record<string, never>, SweepReport>(
      listSeedSweepCandidates,
      ctx,
      {}
    )
    const bySeed = report.companies.find((row) => row.companyId === SEED_COMPANY)
    const byReal = report.companies.find((row) => row.companyId === REAL_COMPANY)

    expect(bySeed).toMatchObject({
      name: SEED_COMPANY_NAME,
      ownerEmail: 'owner@seed.local',
      selectable: true,
      blockedBy: [],
    })
    expect(byReal).toMatchObject({
      name: REAL_COMPANY_NAME,
      ownerEmail: 'fixture-8b8414fc@example.com',
      selectable: false,
    })
    expect(byReal?.blockedBy).toContain('fixture-8b8414fc@example.com')
  })

  it.each([
    ['gmail', 'fixture-0c8809e6@example.com'],
    ['sherlock.capital', 'fixture-cffeaf6c@example.com'],
    ['dominio desconocido', 'todd@example.com'],
  ])('protege la empresa cuyo MIEMBRO usa %s aunque el dueño sea seed', async (_, email) => {
    const tables = seedTables()
    tables.profiles.push({
      _id: 'profile_member',
      userId: 'user_member',
      role: 'COMPANY',
      isActive: true,
    })
    tables.users.push({ _id: 'user_member', email })
    tables.documentVersions.push({
      _id: 'ver_member',
      documentId: 'doc_b',
      companyId: SEED_COMPANY,
      versionNumber: 1,
      storageId: 'blob_b',
      createdAt: NOW - 900,
      createdByProfileId: 'profile_member',
    })
    const { ctx } = ctxWithStorage(tables)

    const report = await runHandler<Record<string, never>, SweepReport>(
      listSeedSweepCandidates,
      ctx,
      {}
    )
    const row = report.companies.find((entry) => entry.companyId === SEED_COMPANY)

    expect(row?.selectable).toBe(false)
    expect(row?.blockedBy).toContain(email)
  })


  it('nunca selecciona una empresa cuyo dueño no existe o no tiene correo', async () => {
    const tables = seedTables()
    tables.companies.push({
      _id: 'company_huerfana',
      name: 'Huérfana',
      ownerId: 'profile_fantasma',
    })
    const { ctx } = ctxWithStorage(tables)

    const report = await runHandler<Record<string, never>, SweepReport>(
      listSeedSweepCandidates,
      ctx,
      {}
    )
    const row = report.companies.find((entry) => entry.companyId === 'company_huerfana')

    expect(row?.selectable).toBe(false)
  })
})

describe('operatorPurge.purgeCompany', () => {
  it('el plan cubre TODAS las tablas con companyId del schema', () => {
    const decided = new Set<string>(COMPANY_PURGE_TABLE_PLAN.map((entry) => entry.table))
    // Lista congelada del inventario del brief + las dos tablas nuevas
    // (`teamAlerts`, `companyChecklist`). Si el schema gana una tabla con
    // `companyId`, este test la reclama antes de que el purge la olvide.
    for (const table of [
      'companyOrganizationBindings',
      'companyAuthorizationInventoryRows',
      'guestInvitations',
      'documents',
      'vdrUploadIntents',
      'documentVersions',
      'documentLegalHolds',
      'documentAccessLogs',
      'vdrReadAudits',
      'documentTextIndex',
      'companyInferenceCredentials',
      'documentAccessGrants',
      'deliverables',
      'adminVdrCapabilities',
      'teamAlerts',
      'companyChecklist',
    ]) {
      expect(decided.has(table)).toBe(true)
    }
  })

  it('sin execute inventaría por tabla y no borra nada', async () => {
    const tables = seedTables()
    const before = structuredClone(tables)
    const { ctx, deletedBlobs } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, PurgeResult>(purgeCompany, ctx, {
      ...operatorConfirmation,
      companyId: SEED_COMPANY,
      confirmName: SEED_COMPANY_NAME,
    })

    expect(result.execute).toBe(false)
    expect(result.company).toBe(SEED_COMPANY_NAME)
    const rowsByTable = Object.fromEntries(
      result.tables.map((entry) => [entry.table, entry.rows] as const)
    )
    expect(rowsByTable.documents).toBe(3)
    expect(rowsByTable.documentAccessGrants).toBe(1)
    expect(result.workos).toMatchObject({
      userIds: ['user_01SEED'],
      organizationId: 'org_01SEED',
    })
    // El harness materializa `tables[t] ??= []` en cada `db.query(t)`, así que
    // se comparan las FILAS sembradas, no el juego de claves del objeto.
    for (const [table, rows] of Object.entries(before)) {
      expect({ [table]: tables[table] }).toEqual({ [table]: rows })
    }
    expect(deletedBlobs).toEqual([])
  })

  it('borra la cascada, los blobs y la empresa, y conserva la bitácora', async () => {
    const tables = seedTables()
    const { ctx, deletedBlobs } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, PurgeResult>(purgeCompany, ctx, {
      ...operatorConfirmation,
      companyId: SEED_COMPANY,
      confirmName: SEED_COMPANY_NAME,
      execute: true,
    })

    expect(result.status).toBe('COMPLETED')
    expect(tables.companies.map((row) => row._id)).toEqual([REAL_COMPANY])
    expect(tables.documents.map((row) => row._id)).toEqual(['doc_real'])
    expect(tables.documentVersions.map((row) => row._id)).toEqual(['ver_real'])
    expect(tables.documentAccessGrants).toEqual([])
    expect(tables.documentTextIndex).toEqual([])
    expect(tables.documentAccessLogs).toEqual([])
    expect(tables.vdrReadAudits).toEqual([])
    expect(tables.companyOrganizationBindings).toEqual([])
    expect(tables.companyChecklist).toEqual([])
    expect(tables.teamAlerts).toEqual([])
    expect(tables.notifications).toEqual([])
    expect(deletedBlobs.sort()).toEqual(['blob_a', 'blob_b', 'blob_c'])
    expect(tables._storage).toEqual([{ _id: 'blob_real', size: 40 }])
  })

  it('conserva la bitácora previa y agrega UNA fila COMPANY_PURGE honesta', async () => {
    const tables = seedTables()
    const { ctx } = ctxWithStorage(tables)

    await runHandler(purgeCompany, ctx, {
      ...operatorConfirmation,
      companyId: SEED_COMPANY,
      confirmName: SEED_COMPANY_NAME,
      execute: true,
    })

    expect(tables.adminAuditLogs).toHaveLength(2)
    expect(tables.adminAuditLogs[0]?._id).toBe('audit_previo')
    expect(tables.adminAuditLogs[1]).toMatchObject({
      adminProfileId: ADMIN_PROFILE,
      adminEmail: 'fixture-4622a879@example.com',
      action: 'COMPANY_PURGE',
      targetType: 'COMPANY',
      targetId: SEED_COMPANY,
      notes: operatorConfirmation.reason,
    })
    expect(tables.webhookEvents).toHaveLength(1)
  })

  it('la segunda corrida sobre la misma empresa responde deleted 0', async () => {
    const tables = seedTables()
    const { ctx, deletedBlobs } = ctxWithStorage(tables)
    const args = {
      ...operatorConfirmation,
      companyId: SEED_COMPANY,
      confirmName: SEED_COMPANY_NAME,
      execute: true,
    }

    await runHandler(purgeCompany, ctx, args)
    const blobsAfterFirst = [...deletedBlobs]
    const second = await runHandler<Record<string, unknown>, PurgeResult>(purgeCompany, ctx, args)

    expect(second).toMatchObject({ alreadyPurged: true, deleted: 0 })
    expect(deletedBlobs).toEqual(blobsAfterFirst)
    expect(tables.adminAuditLogs).toHaveLength(2)
  })

  it('un id que nunca existió responde alreadyPurged sin exigir confirmName ni borrar', async () => {
    const tables = seedTables()
    const before = structuredClone(tables)
    const { ctx, deletedBlobs } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, PurgeResult>(purgeCompany, ctx, {
      ...operatorConfirmation,
      companyId: 'company_never_existed',
      confirmName: 'Nombre inventado',
      execute: true,
    })

    expect(result).toMatchObject({
      alreadyPurged: true,
      company: null,
      deleted: 0,
      marked: 0,
      blobsDeleted: 0,
      status: 'COMPLETED',
    })
    expect(tables).toEqual(before)
    expect(deletedBlobs).toEqual([])
    expect(tables.companies.map((row) => row._id).sort()).toEqual(
      [REAL_COMPANY, SEED_COMPANY].sort()
    )
    expect(tables.adminAuditLogs).toHaveLength(1)
  })

  it('rechaza un confirmName que no coincide, sin borrar ni marcar nada', async () => {
    const tables = seedTables()
    const before = structuredClone(tables)
    const { ctx, deletedBlobs } = ctxWithStorage(tables)

    await expect(
      runHandler(purgeCompany, ctx, {
        ...operatorConfirmation,
        companyId: SEED_COMPANY,
        confirmName: 'Global Nike',
        execute: true,
      })
    ).rejects.toThrow(/no coincide/)

    expect(tables).toEqual(before)
    expect(deletedBlobs).toEqual([])
  })

  it.each([
    ['perfil inexistente', 'profile_missing', /ADMIN/i],
    ['perfil COMPANY', 'profile_seed_owner', /ADMIN/i],
    ['razón vacía', ADMIN_PROFILE, /razón/i],
  ])('rechaza %s antes de tocar la empresa', async (label, operatorProfileId, expected) => {
    const tables = seedTables()
    const before = structuredClone(tables)
    const { ctx } = ctxWithStorage(tables)

    await expect(
      runHandler(purgeCompany, ctx, {
        operatorProfileId,
        reason: label === 'razón vacía' ? '   ' : operatorConfirmation.reason,
        companyId: SEED_COMPANY,
        confirmName: SEED_COMPANY_NAME,
        execute: true,
      })
    ).rejects.toThrow(expected)

    expect(tables).toEqual(before)
  })

  it('en lotes: reagenda con el scheduler y termina reanudando hasta vaciar', async () => {
    const tables = seedTables()
    const { ctx, deletedBlobs } = ctxWithStorage(tables)
    const args = {
      ...operatorConfirmation,
      companyId: SEED_COMPANY,
      confirmName: SEED_COMPANY_NAME,
      execute: true,
      batchSize: 1,
    }

    const first = await runHandler<Record<string, unknown>, PurgeResult>(purgeCompany, ctx, args)

    expect(first.status).toBe('SCHEDULED')
    expect(tables.companies.map((row) => row._id)).toContain(SEED_COMPANY)
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1)
    expect(ctx.scheduler.runAfter.mock.calls[0]?.[2]).toMatchObject({
      companyId: SEED_COMPANY,
      confirmName: SEED_COMPANY_NAME,
      execute: true,
      batchSize: 1,
    })
    expect(tables.companyPurgeRuns).toHaveLength(1)
    expect(tables.companyPurgeRuns[0]).toMatchObject({
      companyId: SEED_COMPANY,
      companyName: SEED_COMPANY_NAME,
      status: 'RUNNING',
    })

    let last = first
    for (let pass = 0; pass < 200 && last.status === 'SCHEDULED'; pass += 1) {
      last = await runHandler<Record<string, unknown>, PurgeResult>(purgeCompany, ctx, args)
    }

    expect(last.status).toBe('COMPLETED')
    expect(tables.companies.map((row) => row._id)).toEqual([REAL_COMPANY])
    expect(deletedBlobs.sort()).toEqual(['blob_a', 'blob_b', 'blob_c'])
    expect(tables.companyPurgeRuns[0]).toMatchObject({ status: 'COMPLETED' })
    // Una sola bitácora por purga, no una por lote.
    expect(tables.adminAuditLogs.filter((row) => row.action === 'COMPANY_PURGE')).toHaveLength(1)
  })

  it('no toca ninguna fila de la empresa real vecina', async () => {
    const tables = seedTables()
    const { ctx } = ctxWithStorage(tables)

    await runHandler(purgeCompany, ctx, {
      ...operatorConfirmation,
      companyId: SEED_COMPANY,
      confirmName: SEED_COMPANY_NAME,
      execute: true,
    })

    expect(tables.companies).toEqual([
      { _id: REAL_COMPANY, name: REAL_COMPANY_NAME, ownerId: 'profile_real_owner' },
    ])
    expect(tables.profiles.map((row) => row._id).sort()).toEqual([
      ADMIN_PROFILE,
      'profile_real_owner',
    ])
    expect(tables.users.map((row) => row._id).sort()).toEqual(['user_admin', 'user_real_owner'])
  })

  it('nunca borra ni desactiva al propio operador aunque sea el dueño', async () => {
    // Dev encontró el caso: `admin@dev.local` es ADMIN y dueño de una sala
    // sembrada. Purgar su sala no puede dejar sin operador a la corrida.
    const tables = seedTables()
    tables.companies.push({
      _id: 'company_del_admin',
      name: 'Demo Company LATAM',
      ownerId: ADMIN_PROFILE,
    })
    const { ctx } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, PurgeResult>(purgeCompany, ctx, {
      ...operatorConfirmation,
      companyId: 'company_del_admin',
      confirmName: 'Demo Company LATAM',
      execute: true,
    })

    expect(result.status).toBe('COMPLETED')
    expect(tables.companies.map((row) => row._id)).not.toContain('company_del_admin')
    expect(tables.profiles.find((row) => row._id === ADMIN_PROFILE)).toMatchObject({
      role: 'ADMIN',
      isActive: true,
    })
    expect(tables.users.map((row) => row._id)).toContain('user_admin')
    expect(result.workos.userIds).toEqual([])
  })

  it('conserva el perfil dueño cuando todavía tiene otra empresa viva', async () => {
    const tables = seedTables()
    tables.companies.push({
      _id: 'company_seed_2',
      name: 'Global Adidas',
      ownerId: 'profile_seed_owner',
    })
    const { ctx } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, PurgeResult>(purgeCompany, ctx, {
      ...operatorConfirmation,
      companyId: SEED_COMPANY,
      confirmName: SEED_COMPANY_NAME,
      execute: true,
    })

    expect(tables.profiles.map((row) => row._id)).toContain('profile_seed_owner')
    expect(result.workos.userIds).toEqual([])
  })
})

describe('operatorPurge.deactivateSeedUsers', () => {
  it('desactiva los dos usuarios seed nombrados y no los borra', async () => {
    const tables = seedTables()
    tables.users.push(
      { _id: 'user_research', email: 'research@seed.local' },
      { _id: 'user_devadmin', email: 'admin@dev.local' }
    )
    tables.profiles.push(
      { _id: 'profile_research', userId: 'user_research', role: 'COMPANY', isActive: true },
      { _id: 'profile_devadmin', userId: 'user_devadmin', role: 'COMPANY', isActive: true }
    )
    const { ctx } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, DeactivateResult>(
      deactivateSeedUsers,
      ctx,
      {
        ...operatorConfirmation,
        emails: ['research@seed.local', 'admin@dev.local'],
        execute: true,
      }
    )

    expect(result.users.map((row) => row.action)).toEqual(['DEACTIVATED', 'DEACTIVATED'])
    expect(tables.users.map((row) => row._id)).toContain('user_research')
    expect(tables.profiles.find((row) => row._id === 'profile_research')).toMatchObject({
      isActive: false,
      deactivatedBy: 'ADMIN',
    })
    expect(tables.profiles.find((row) => row._id === 'profile_devadmin')).toMatchObject({
      isActive: false,
    })
    expect(tables.adminAuditLogs.filter((row) => row.action === 'USER_STATUS_CHANGE')).toHaveLength(
      2
    )
  })

  it('se niega a desactivar al propio operador', async () => {
    const tables = seedTables()
    tables.users.find((row) => row._id === 'user_admin')!.email = 'admin@dev.local'
    const { ctx } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, DeactivateResult>(
      deactivateSeedUsers,
      ctx,
      { ...operatorConfirmation, emails: ['admin@dev.local'], execute: true }
    )

    expect(result.users[0]?.action).toBe('SKIPPED_OPERATOR')
    expect(tables.profiles.find((row) => row._id === ADMIN_PROFILE)).toMatchObject({
      isActive: true,
    })
  })

  it('se niega a tocar un correo que no es de dominio seed', async () => {
    const tables = seedTables()
    const { ctx } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, DeactivateResult>(
      deactivateSeedUsers,
      ctx,
      {
        ...operatorConfirmation,
        emails: ['fixture-8b8414fc@example.com'],
        execute: true,
      }
    )

    expect(result.users[0]).toMatchObject({
      email: 'fixture-8b8414fc@example.com',
      action: 'SKIPPED_NOT_SEED',
    })
    expect(tables.profiles.find((row) => row._id === 'profile_real_owner')).toMatchObject({
      isActive: true,
    })
  })

  it('sin execute solo reporta', async () => {
    const tables = seedTables()
    tables.users.push({ _id: 'user_research', email: 'research@seed.local' })
    tables.profiles.push({
      _id: 'profile_research',
      userId: 'user_research',
      role: 'COMPANY',
      isActive: true,
    })
    const { ctx } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, DeactivateResult>(
      deactivateSeedUsers,
      ctx,
      {
        ...operatorConfirmation,
        emails: ['research@seed.local'],
      }
    )

    expect(result.users[0]?.action).toBe('DEACTIVATED')
    expect(tables.profiles.find((row) => row._id === 'profile_research')).toMatchObject({
      isActive: true,
    })
    expect(tables.adminAuditLogs).toHaveLength(1)
  })
})

describe('operatorPurge.purgeOrphanUser', () => {
  const args = {
    ...operatorConfirmation,
    email: ORPHAN_EMAIL,
  }

  it('sin execute inventaría y no borra nada', async () => {
    const tables = seedTables()
    seedOrphanUser(tables)
    const { ctx } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, PurgeOrphanResult>(
      purgeOrphanUser,
      ctx,
      args
    )

    expect(result).toMatchObject({
      execute: false,
      email: ORPHAN_EMAIL,
      action: 'WOULD_DELETE',
      blockers: [],
      workosUserId: ORPHAN_WORKOS,
    })
    // El inventario es la lista COMPLETA y en orden: quitar una barrida del
    // handler tiene que ponerse rojo aquí, no pasar por debajo de un
    // `arrayContaining`. La membresía aparece dos veces porque el dry-run no
    // borra nada: la barrida por userId vuelve a contar la misma fila que ya
    // contó la barrida por profileId (con `execute` ya está borrada y da 0).
    expect(result.tables).toEqual([
      { table: 'notifications', rows: 1, decision: 'DELETE' },
      { table: 'notificationPreferences', rows: 1, decision: 'DELETE' },
      { table: 'consents', rows: 1, decision: 'DELETE' },
      { table: 'deletionRequests', rows: 1, decision: 'DELETE' },
      { table: 'documentAccessGrants', rows: 1, decision: 'DELETE' },
      { table: 'adminVdrCapabilities', rows: 1, decision: 'DELETE' },
      { table: 'organizationMemberships', rows: 1, decision: 'DELETE' },
      { table: 'activityLogs', rows: 1, decision: 'KEEP' },
      { table: 'organizationMemberships(userId)', rows: 1, decision: 'DELETE' },
      { table: 'securityEvents', rows: 1, decision: 'KEEP' },
      { table: 'profiles', rows: 1, decision: 'DELETE' },
      { table: 'users', rows: 1, decision: 'DELETE' },
    ])
    expect(tables.profiles.map((row) => row._id)).toContain('profile_orphan')
    expect(tables.users.map((row) => row._id)).toContain('user_orphan')
    expect(tables.notifications.map((row) => row._id)).toContain('notif_orphan')
    for (const table of PER_USER_TABLES) {
      expect(tables[table]).toHaveLength(1)
    }
    expect(tables.adminAuditLogs).toHaveLength(1)
  })

  it('con execute borra el perfil y conserva bitácora y securityEvents', async () => {
    const tables = seedTables()
    seedOrphanUser(tables)
    const { ctx } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, PurgeOrphanResult>(
      purgeOrphanUser,
      ctx,
      { ...args, execute: true }
    )

    expect(result.action).toBe('DELETED')
    // El inventario de `users`/`profiles` es un `1` fijo en el handler, así que
    // un `collect()` + borrado de la tabla entera reportaría lo mismo: lo que
    // separa la purga de un vaciado es el SET que queda.
    expect(tables.profiles.map((row) => row._id).sort()).toEqual([
      ADMIN_PROFILE,
      'profile_real_owner',
      'profile_seed_owner',
    ])
    expect(tables.users.map((row) => row._id).sort()).toEqual([
      'user_admin',
      'user_real_owner',
      'user_seed_owner',
    ])
    expect(tables.notifications.map((row) => row._id)).toEqual(['notif_seed'])
    expect(tables.consents).toEqual([])
    for (const table of PER_USER_TABLES) {
      expect(tables[table]).toEqual([])
    }
    expect(tables.documentAccessGrants.map((row) => row._id)).toEqual(['grant_a'])
    expect(tables.activityLogs).toEqual([
      { _id: 'activity_orphan', userId: 'profile_orphan', action: 'LOGIN' },
    ])
    expect(tables.securityEvents).toEqual([
      { _id: 'security_orphan', userId: 'user_orphan', event: 'AUTH_FAILURE' },
    ])
    expect(tables.adminAuditLogs).toHaveLength(2)
    expect(tables.adminAuditLogs[1]).toMatchObject({
      adminProfileId: ADMIN_PROFILE,
      action: 'USER_DELETE',
      targetType: 'PROFILE',
      targetId: 'profile_orphan',
      previousValue: {
        email: ORPHAN_EMAIL,
        role: 'COMPANY',
        workosUserId: ORPHAN_WORKOS,
      },
    })
  })

  it('un correo desconocido es NOT_FOUND y no escribe', async () => {
    const tables = seedTables()
    const before = structuredClone(tables)
    const { ctx } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, PurgeOrphanResult>(
      purgeOrphanUser,
      ctx,
      { ...args, email: 'nobody@example.test', execute: true }
    )

    expect(result).toMatchObject({
      execute: true,
      action: 'NOT_FOUND',
      blockers: [],
      tables: [],
    })
    expect(tables).toEqual(before)
  })

  it('recorte de espacios encuentra el mismo correo', async () => {
    const tables = seedTables()
    seedOrphanUser(tables)
    const { ctx } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, PurgeOrphanResult>(
      purgeOrphanUser,
      ctx,
      { ...args, email: `  ${ORPHAN_EMAIL}  ` }
    )

    expect(result).toMatchObject({ email: ORPHAN_EMAIL, action: 'WOULD_DELETE' })
  })

  it('se niega si el correo es de OTRO ADMIN, no del operador', async () => {
    // El segundo ADMIN es el caso que el guard de identidad NO cubre: si
    // `es ADMIN` desapareciera y sólo quedara `profile._id === operator._id`,
    // el compañero de equipo se borraría. Por eso el correo purgado aquí no es
    // el del operador.
    const tables = seedTables()
    tables.profiles.push({
      _id: 'profile_admin_reviewer',
      userId: 'user_admin_reviewer',
      role: 'ADMIN',
      isActive: true,
    })
    tables.users.push({ _id: 'user_admin_reviewer', email: 'fixture-cffeaf6c@example.com' })
    const { ctx } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, PurgeOrphanResult>(
      purgeOrphanUser,
      ctx,
      { ...args, email: 'fixture-cffeaf6c@example.com', execute: true }
    )

    expect(result.action).toBe('REFUSED')
    expect(result.blockers).toEqual(['es ADMIN'])
    expect(tables.profiles.map((row) => row._id).sort()).toEqual([
      ADMIN_PROFILE,
      'profile_admin_reviewer',
      'profile_real_owner',
      'profile_seed_owner',
    ])
    expect(tables.users.map((row) => row._id).sort()).toEqual([
      'user_admin',
      'user_admin_reviewer',
      'user_real_owner',
      'user_seed_owner',
    ])
    expect(tables.adminAuditLogs).toHaveLength(1)
  })

  it('se niega si el correo es el propio operador, y lo dice por identidad', async () => {
    const tables = seedTables()
    tables.users.find((row) => row._id === 'user_admin')!.email = 'admin@dev.local'
    const { ctx } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, PurgeOrphanResult>(
      purgeOrphanUser,
      ctx,
      { ...args, email: 'admin@dev.local', execute: true }
    )

    expect(result.action).toBe('REFUSED')
    // Dos razones distintas y en este orden: la identidad primero, el rol
    // después. Purgarse a sí mismo se rechaza aunque el rol dejara de bloquear.
    expect(result.blockers).toEqual(['es el operador', 'es ADMIN'])
    expect(tables.profiles.find((row) => row._id === ADMIN_PROFILE)).toMatchObject({
      isActive: true,
    })
    expect(tables.users.map((row) => row._id).sort()).toEqual([
      'user_admin',
      'user_real_owner',
      'user_seed_owner',
    ])
  })

  it('se niega si el correo es dueño de una empresa', async () => {
    const tables = seedTables()
    const { ctx } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, PurgeOrphanResult>(
      purgeOrphanUser,
      ctx,
      { ...args, email: 'fixture-8b8414fc@example.com', execute: true }
    )

    expect(result.action).toBe('REFUSED')
    expect(result.blockers.some((blocker) => /dueño de 1 empresa/.test(blocker))).toBe(true)
    expect(tables.companies.map((row) => row._id)).toContain(REAL_COMPANY)
    expect(tables.profiles.map((row) => row._id)).toContain('profile_real_owner')
  })

  it('un usuario sin perfil se borra igual: no hay dueño que proteger', async () => {
    const tables = seedTables()
    tables.users.push({
      _id: 'user_ghost',
      email: 'ghost.profile@example.test',
      workosUserId: 'user_01AAAAAAAAAAAAAAAAAAAAAAAA',
    })
    // Membresía que apunta a un perfil ya borrado: sin perfil vivo, la única
    // barrida que puede alcanzarla es la de `userId`.
    tables.organizationMemberships = [
      {
        _id: 'membership_ghost',
        userId: 'user_ghost',
        profileId: 'profile_ghost_gone',
        authProvider: 'workos',
        providerOrgId: 'org_01GHOST',
        betaRole: 'COMPANY_MEMBER',
        profileRole: 'COMPANY',
        createdAt: NOW - 120_000,
      },
    ]
    const { ctx } = ctxWithStorage(tables)

    const result = await runHandler<Record<string, unknown>, PurgeOrphanResult>(
      purgeOrphanUser,
      ctx,
      { ...args, email: 'ghost.profile@example.test', execute: true }
    )

    expect(result).toMatchObject({
      action: 'DELETED',
      blockers: [],
      workosUserId: 'user_01AAAAAAAAAAAAAAAAAAAAAAAA',
    })
    expect(result.tables).toEqual([
      { table: 'organizationMemberships(userId)', rows: 1, decision: 'DELETE' },
      { table: 'securityEvents', rows: 0, decision: 'KEEP' },
      { table: 'profiles', rows: 0, decision: 'DELETE' },
      { table: 'users', rows: 1, decision: 'DELETE' },
    ])
    expect(tables.users.map((row) => row._id)).not.toContain('user_ghost')
    expect(tables.organizationMemberships).toEqual([])
    expect(tables.adminAuditLogs[1]).toMatchObject({
      action: 'USER_DELETE',
      targetId: 'user_ghost',
      previousValue: { email: 'ghost.profile@example.test', role: null },
    })
  })

  it('rechaza una razón vacía antes de mirar el correo', async () => {
    const tables = seedTables()
    seedOrphanUser(tables)
    const before = structuredClone(tables)
    const { ctx } = ctxWithStorage(tables)

    await expect(
      runHandler(purgeOrphanUser, ctx, { ...args, reason: '   ', execute: true })
    ).rejects.toThrow(/razón/i)
    expect(tables).toEqual(before)
  })
})
