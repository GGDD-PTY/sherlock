// ============================================================================
// GDPR ART. 17 — CASCADA DE BORRADO (convex/gdpr.ts:processAccountDeletion)
// ============================================================================
// Convex no aplica integridad referencial: si la cascada olvida una tabla, las
// filas sobreviven apuntando a un id inexistente. Estos tests corren el handler
// real contra una base en memoria y verifican que NO queda ninguna fila colgada.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../convex/_helpers/auth', () => ({
  requireAuth: vi.fn(),
}))

// `createSnapshot` se mockea con la implementación real (proyectar campos) en vez
// de con un stub: es lo que produce el `previousValue` de la auditoría, y un stub
// dejaría pasar una entrada sin evidencia de QUÉ se borró.
vi.mock('../../../convex/_helpers/auditLog', () => ({
  logAdminAction: vi.fn().mockResolvedValue('adminAuditLogs_audit'),
  createSnapshot: vi.fn((doc: Record<string, unknown>, fields: string[]) =>
    Object.fromEntries(fields.map((f) => [f, doc[f]]))
  ),
}))

import { processAccountDeletion } from '../../../convex/gdpr'
import { requireAuth } from '../../../convex/_helpers/auth'
import { logAdminAction } from '../../../convex/_helpers/auditLog'

const mockRequireAuth = vi.mocked(requireAuth)
const mockLogAdminAction = vi.mocked(logAdminAction)

// ============================================================================
// FAKE CONVEX DB (in-memory, con semántica de Convex)
// ============================================================================

type Row = Record<string, unknown> & { _id: string }

interface IndexConstraint {
  field: string
  value: unknown
}

function createFakeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {}
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((row) => ({ ...row }))
  }

  const locate = (id: string) => {
    for (const [name, rows] of Object.entries(tables)) {
      const index = rows.findIndex((row) => row._id === id)
      if (index !== -1) return { name, index }
    }
    return null
  }

  const db = {
    query(table: string) {
      const rows = tables[table] ?? []
      const constraints: IndexConstraint[] = []

      const builder = {
        withIndex(_name: string, fn?: (q: { eq: (f: string, v: unknown) => unknown }) => unknown) {
          const q = {
            eq(field: string, value: unknown) {
              constraints.push({ field, value })
              return q
            },
          }
          fn?.(q)
          return builder
        },
        filter() {
          return builder
        },
        order() {
          return builder
        },
        matches() {
          return rows.filter((row) => constraints.every((c) => row[c.field] === c.value))
        },
        async collect() {
          return builder.matches().map((row) => ({ ...row }))
        },
        async first() {
          const [head] = builder.matches()
          return head ? { ...head } : null
        },
      }

      return builder
    },
    async get(id: string) {
      const found = locate(id)
      if (!found) return null
      return { ...tables[found.name][found.index] }
    },
    insert: vi.fn(async (table: string, doc: Record<string, unknown>) => {
      const id = `${table}_${(tables[table]?.length ?? 0) + 1}_new`
      tables[table] = tables[table] ?? []
      tables[table].push({ ...doc, _id: id })
      return id
    }),
    async patch(id: string, updates: Record<string, unknown>) {
      const found = locate(id)
      if (!found) throw new Error(`patch on missing row ${id}`)
      const row = tables[found.name][found.index]
      for (const [key, value] of Object.entries(updates)) {
        // Convex borra el campo cuando el valor es undefined.
        if (value === undefined) delete row[key]
        else row[key] = value
      }
    },
    async delete(id: string) {
      const found = locate(id)
      // Un doble borrado en la cascada explotaría en producción: lo replicamos.
      if (!found) throw new Error(`delete on missing row ${id}`)
      tables[found.name].splice(found.index, 1)
    },
  }

  return { db, tables }
}

function createCtx(seed: Record<string, Row[]>) {
  const { db, tables } = createFakeDb(seed)
  const deletedBlobs: string[] = []

  const ctx = {
    db,
    storage: {
      delete: vi.fn(async (storageId: string) => {
        deletedBlobs.push(storageId)
      }),
      getUrl: vi.fn(async () => 'https://storage.test/file'),
    },
    auth: { getUserIdentity: vi.fn() },
    scheduler: { runAfter: vi.fn(), runAt: vi.fn() },
  }

  return { ctx, tables, deletedBlobs }
}

const runProcessAccountDeletion = (ctx: unknown, args: { requestId: string }) =>
  (
    processAccountDeletion as unknown as {
      _handler: (ctx: unknown, args: { requestId: string }) => Promise<unknown>
    }
  )._handler(ctx, args)

// ============================================================================
// FIXTURE
// ============================================================================

const ADMIN_PROFILE = { _id: 'profiles_admin', role: 'ADMIN', userId: 'users_admin' }
const ADMIN_USER = { _id: 'users_admin', email: 'admin@dev.local' }

/**
 * Base de datos con una empresa completa (VDR, intake, soporte) más filas
 * "supervivientes" de OTRA empresa que jamás deben tocarse.
 */
function companySeed(): Record<string, Row[]> {
  return {
    users: [
      { _id: 'users_target', email: 'fixture-825d662c@example.com' },
      { _id: 'users_other', email: 'fixture-36877d00@example.com' },
      { ...ADMIN_USER },
    ],
    profiles: [
      { _id: 'profiles_target', userId: 'users_target', role: 'COMPANY' },
      { _id: 'profiles_other', userId: 'users_other', role: 'COMPANY' },
      { _id: 'profiles_admin', userId: 'users_admin', role: 'ADMIN' },
    ],
    companies: [
      { _id: 'companies_target', ownerId: 'profiles_target' },
      { _id: 'companies_other', ownerId: 'profiles_other' },
    ],



    documents: [
      {
        _id: 'documents_room',
        companyId: 'companies_target',
        storageId: 'storage_room',
      },
      // Estado legacy alcanzable: createDocument aceptaba un storageId del
      // cliente, así que dos empresas podían terminar apuntando al mismo blob.
      { _id: 'documents_company', companyId: 'companies_target', storageId: 'storage_shared' },
      { _id: 'documents_survivor', companyId: 'companies_other', storageId: 'storage_shared' },
    ],
    documentAccessLogs: [
      { _id: 'documentAccessLogs_1', documentId: 'documents_room', accessedById: 'profiles_other' },
      {
        _id: 'documentAccessLogs_survivor',
        documentId: 'documents_survivor',
        accessedById: 'profiles_other',
      },
    ],
    documentAccessGrants: [
      {
        _id: 'documentAccessGrants_doc',
        documentId: 'documents_company',
        profileId: 'profiles_other',
      },
      {
        _id: 'documentAccessGrants_byTarget',
        documentId: 'documents_survivor',
        profileId: 'profiles_target',
      },
    ],





    notifications: [{ _id: 'notifications_1', userId: 'profiles_target' }],
    consents: [{ _id: 'consents_1', profileId: 'profiles_target' }],
    notificationPreferences: [{ _id: 'notificationPreferences_1', userId: 'profiles_target' }],
    subscriptions: [{ _id: 'subscriptions_1', userId: 'profiles_target' }],
    organizationMemberships: [
      {
        _id: 'organizationMemberships_1',
        userId: 'users_target',
        profileId: 'profiles_target',
      },
      {
        _id: 'organizationMemberships_survivor',
        userId: 'users_other',
        profileId: 'profiles_other',
      },
    ],
    activityLogs: [
      {
        _id: 'activityLogs_1',
        userId: 'profiles_target',
        action: 'LOGIN',
        ipAddress: '10.0.0.1',
        userAgent: 'Firefox',
      },
    ],
    adminAuditLogs: [
      {
        _id: 'adminAuditLogs_1',
        adminProfileId: 'profiles_target',
        adminEmail: 'fixture-825d662c@example.com',
        ipAddress: '10.0.0.1',
        userAgent: 'Firefox',
      },
    ],
    securityEvents: [
      {
        _id: 'securityEvents_1',
        userId: 'users_target',
        userEmail: 'fixture-825d662c@example.com',
        ipAddress: '10.0.0.1',
        userAgent: 'Firefox',
      },
    ],
    deletionRequests: [
      {
        _id: 'deletionRequests_1',
        profileId: 'profiles_target',
        email: 'fixture-825d662c@example.com',
        status: 'PENDING',
        requestedAt: 1,
      },
    ],
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe('convex/gdpr.ts processAccountDeletion — cascada Art. 17', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireAuth.mockResolvedValue({
      identity: { subject: 'workos_admin', email: ADMIN_USER.email },
      user: ADMIN_USER,
      profile: ADMIN_PROFILE,
    } as unknown as Awaited<ReturnType<typeof requireAuth>>)
  })

  it('barre las tablas borrables y conserva intactas las cuatro de retención', async () => {
    const { ctx, tables, deletedBlobs } = createCtx(companySeed())

    const result = await runProcessAccountDeletion(ctx, { requestId: 'deletionRequests_1' })

    expect(result).toEqual({ deleted: true, userDeleted: true })

    // ===== Entidades raíz =====
    expect(tables.profiles.map((r) => r._id)).not.toContain('profiles_target')
    expect(tables.users.map((r) => r._id)).not.toContain('users_target')
    expect(tables.companies.map((r) => r._id)).not.toContain('companies_target')

    // ===== VDR: la fila Y el blob se van =====
    expect(tables.documents.map((r) => r._id)).toEqual(['documents_survivor'])
    expect(deletedBlobs).toEqual(['storage_room'])
    expect(tables.documents[0]?.storageId).toBe('storage_shared')
    // RETENCIÓN: el log de acceso sobrevive al borrado de su documento. Es el
    // rastro de cumplimiento de QUIÉN accedió (`profiles_other`, un tercero), no
    // del titular que se va. Queda con `documentId` colgando hasta el PR de
    // anonimización — a propósito, no por descuido.
    expect(tables.documentAccessLogs.map((r) => r._id)).toEqual([
      'documentAccessLogs_1',
      'documentAccessLogs_survivor',
    ])
    expect(tables.documentAccessGrants).toHaveLength(0)

    // ===== Colgados directos del profile =====
    expect(tables.notifications).toHaveLength(0)
    expect(tables.consents).toHaveLength(0)
    expect(tables.notificationPreferences).toHaveLength(0)
    // RETENCIÓN: registro fiscal, se conserva.
    expect(tables.subscriptions.map((r) => r._id)).toEqual(['subscriptions_1'])
    expect(tables.organizationMemberships.map((r) => r._id)).toEqual([
      'organizationMemberships_survivor',
    ])
  })

  it('anonimiza (no borra) los rastros de auditoría y redacta la PII textual', async () => {
    const { ctx, tables } = createCtx(companySeed())

    await runProcessAccountDeletion(ctx, { requestId: 'deletionRequests_1' })

    const activity = tables.activityLogs[0]
    expect(activity).toBeDefined()
    expect(activity.userId).toBeUndefined()
    expect(activity.ipAddress).toBe('ANONYMIZED')
    expect(activity.userAgent).toBe('ANONYMIZED')

    // adminProfileId no es opcional: el registro del acto administrativo se conserva
    // y sólo se redacta la PII textual.
    const adminLog = tables.adminAuditLogs.find((r) => r._id === 'adminAuditLogs_1')
    expect(adminLog?.adminProfileId).toBe('profiles_target')
    expect(adminLog?.adminEmail).toBe('fixture-c5f01650@example.com')
    expect(adminLog?.ipAddress).toBe('ANONYMIZED')

    const securityEvent = tables.securityEvents[0]
    expect(securityEvent.userId).toBeUndefined()
    expect(securityEvent.userEmail).toBe('fixture-c5f01650@example.com')

    const request = tables.deletionRequests[0]
    expect(request.status).toBe('COMPLETED')
    expect(request.processedBy).toBe('profiles_admin')
    expect(request.email).toBe('fixture-c5f01650@example.com')
  })

  it('registra la acción administrativa antes de tocar los datos', async () => {
    const { ctx } = createCtx(companySeed())

    await runProcessAccountDeletion(ctx, { requestId: 'deletionRequests_1' })

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1)
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'USER_DELETE',
        targetType: 'PROFILE',
        targetId: 'profiles_target',
        adminProfileId: 'profiles_admin',
      })
    )
  })

  it('conserva la identidad de auth si otro profile todavía apunta al mismo user', async () => {
    const seed: Record<string, Row[]> = {
      users: [{ _id: 'users_target', email: 'fixture-933b7f99@example.com' }],
      profiles: [
        { _id: 'profiles_target', userId: 'users_target', role: 'COMPANY' },
        { _id: 'profiles_sibling', userId: 'users_target', role: 'COMPANY' },
      ],
      deletionRequests: [
        {
          _id: 'deletionRequests_1',
          profileId: 'profiles_target',
          email: 'fixture-933b7f99@example.com',
          status: 'PENDING',
          requestedAt: 1,
        },
      ],
    }

    const { ctx, tables } = createCtx(seed)

    const result = await runProcessAccountDeletion(ctx, { requestId: 'deletionRequests_1' })

    expect(result).toEqual({ deleted: true, userDeleted: false })
    expect(tables.users.map((r) => r._id)).toEqual(['users_target'])
    expect(tables.profiles.map((r) => r._id)).toEqual(['profiles_sibling'])
  })

  it('rechaza a un no-admin sin borrar nada', async () => {
    mockRequireAuth.mockResolvedValue({
      identity: { subject: 'workos_investor' },
      user: { _id: 'users_other', email: 'fixture-36877d00@example.com' },
      profile: { _id: 'profiles_other', role: 'COMPANY', userId: 'users_other' },
    } as unknown as Awaited<ReturnType<typeof requireAuth>>)

    const { ctx, tables } = createCtx(companySeed())

    await expect(
      runProcessAccountDeletion(ctx, { requestId: 'deletionRequests_1' })
    ).rejects.toThrow(/administradores/i)

    expect(tables.profiles.map((r) => r._id)).toContain('profiles_target')
    expect(tables.documents).toHaveLength(3)
    expect(mockLogAdminAction).not.toHaveBeenCalled()
  })

  it('borra la sala de intake reclamada y no toca blobs que otra empresa todavía posee', async () => {
    const seed = companySeed()
    seed.intakeSessions = [
      {
        _id: 'intakeSessions_claimed',
        claimedProfileId: 'profiles_target',
        status: 'CLAIMED',
      },
      {
        _id: 'intakeSessions_other',
        claimedProfileId: 'profiles_other',
        status: 'CLAIMED',
      },
    ]
    seed.intakeDocuments = [
      {
        _id: 'intakeDocuments_staged',
        intakeSessionId: 'intakeSessions_claimed',
        storageId: 'storage_intake_only',
        storageState: 'STAGED_INTAKE',
      },
      {
        _id: 'intakeDocuments_owned',
        intakeSessionId: 'intakeSessions_claimed',
        storageId: 'storage_shared',
        storageState: 'OWNED_BY_COMPANY',
      },
    ]
    seed.intakeUploadIntents = []
    seed.intakeAssessments = []
    seed.intakeEvents = []
    seed.intakeProofNonces = []
    seed.supportThreads = []
    seed.supportMessages = []
    seed.documentVersions = []
    seed.vdrUploadIntents = []
    seed.assetUploadIntents = []

    const { ctx, tables, deletedBlobs } = createCtx(seed)

    await runProcessAccountDeletion(ctx, { requestId: 'deletionRequests_1' })

    expect(tables.intakeSessions.map((r) => r._id)).toEqual(['intakeSessions_other'])
    expect(tables.intakeDocuments).toHaveLength(0)
    expect(deletedBlobs).toEqual(['storage_room', 'storage_intake_only'])
    expect(tables.documents.map((r) => r._id)).toEqual(['documents_survivor'])
    expect(tables.documents[0]?.storageId).toBe('storage_shared')
  })

  it('borra el texto extraído del documento, no solo la fila y el blob', async () => {
    // H1 (cobertura 2026-09-11): la cascada tenía su propia copia de la purga y
    // olvidaba `documentTextIndex` (hasta 400k chars por versión). Ahora
    // comparte el plan de `_documents/purge.ts`, que es el único lugar que
    // decide qué muere con un documento.
    const seed = companySeed()
    seed.documentVersions = [
      {
        _id: 'documentVersions_company',
        documentId: 'documents_company',
        storageId: 'storage_company_v1',
        versionNumber: 1,
      },
      {
        _id: 'documentVersions_survivor',
        documentId: 'documents_survivor',
        storageId: 'storage_shared',
        versionNumber: 1,
      },
    ]
    seed.documentTextIndex = [
      {
        _id: 'documentTextIndex_company',
        documentId: 'documents_company',
        documentVersionId: 'documentVersions_company',
        text: 'balance general 2024',
      },
      {
        _id: 'documentTextIndex_survivor',
        documentId: 'documents_survivor',
        documentVersionId: 'documentVersions_survivor',
        text: 'otro emisor',
      },
    ]
    // Sol en el PR #589: el intento de subida consumido conserva `storageId` y
    // el plan lo tomaba por dueño vivo, así que el blob sobrevivía al documento.
    seed.vdrUploadIntents = [
      {
        _id: 'vdrUploadIntents_consumed',
        status: 'CONSUMED',
        storageId: 'storage_company_v1',
        documentId: 'documents_company',
        documentVersionId: 'documentVersions_company',
      },
    ]

    const { ctx, tables, deletedBlobs } = createCtx(seed)

    await runProcessAccountDeletion(ctx, { requestId: 'deletionRequests_1' })

    expect(tables.documents.map((r) => r._id)).toEqual(['documents_survivor'])
    expect(tables.documentVersions.map((r) => r._id)).toEqual(['documentVersions_survivor'])
    expect(tables.documentTextIndex.map((r) => r._id)).toEqual(['documentTextIndex_survivor'])
    // El blob compartido con la otra empresa sobrevive; el de la versión del
    // titular se va exactamente una vez.
    expect(deletedBlobs).toEqual(['storage_room', 'storage_company_v1'])
  })
})
