// ============================================================================
// GDPR DELETION SECURITY
// ============================================================================
// `convex/gdpr.ts` concentra el borrado en cascada más destructivo del backend
// y hasta ahora ningún test ejecutaba sus handlers (la suite existente sólo
// leía el archivo como texto). Estas pruebas invocan los handlers reales:
// afirman la guarda admin-only, que un rechazo no borre NADA, y que la
// eliminación quede registrada en `adminAuditLogs`.
// ============================================================================

import { describe, expect, it, vi } from 'vitest'

import {
  cancelDeletionRequest,
  processAccountDeletion,
  requestAccountDeletion,
} from '../../../convex/gdpr'
import { convexArgsValidator } from '../utils/convex-test-utils'

type Row = Record<string, unknown> & { _id: string }
type Tables = Record<string, Row[]>
type Filter = { field: string; value: unknown }

function createQueryBuilder(rows: Row[]) {
  let filters: Filter[] = []

  const matches = () => rows.filter((row) => filters.every((f) => row[f.field] === f.value))

  const builder = {
    withIndex: vi.fn(
      (
        _index: string,
        callback?: (q: { eq: (field: string, value: unknown) => unknown }) => unknown
      ) => {
        filters = []
        const eq = (field: string, value: unknown) => {
          filters.push({ field, value })
          return { eq }
        }
        callback?.({ eq })
        return builder
      }
    ),
    filter: vi.fn(() => builder),
    order: vi.fn(() => builder),
    first: vi.fn(async () => matches()[0] ?? null),
    unique: vi.fn(async () => matches()[0] ?? null),
    collect: vi.fn(async () => matches()),
    take: vi.fn(async () => matches()),
  }

  return builder
}

function createCtx(seed: Tables, subject: string) {
  const tables: Tables = Object.fromEntries(
    Object.entries(seed).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))])
  )
  const inserted: Array<{ table: string; row: Row }> = []
  const patched: Array<{ id: string; patch: Record<string, unknown> }> = []
  const deleted: string[] = []

  return {
    inserted,
    patched,
    deleted,
    auth: {
      getUserIdentity: vi.fn(async () => ({
        issuer: 'https://api.workos.com/',
        subject,
        email: `${subject}@example.com`,
      })),
    },
    db: {
      query: vi.fn((table: string) => createQueryBuilder(tables[table] ?? [])),
      get: vi.fn(async (id: string) => {
        for (const rows of Object.values(tables)) {
          const row = rows.find((candidate) => candidate._id === id)
          if (row) return row
        }
        return null
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        patched.push({ id, patch })
      }),
      insert: vi.fn(async (table: string, row: Row) => {
        inserted.push({ table, row })
        return `${table}_new`
      }),
      delete: vi.fn(async (id: string) => {
        deleted.push(id)
        // La fila desaparece de verdad: si el fake sólo anotara el borrado, una
        // query posterior seguiría viéndola y afirmaciones como `userDeleted`
        // (¿queda algún profile apuntando a este user?) darían el resultado
        // contrario al real.
        for (const rows of Object.values(tables)) {
          const index = rows.findIndex((candidate) => candidate._id === id)
          if (index !== -1) {
            rows.splice(index, 1)
            break
          }
        }
      }),
    },
  }
}

const handlerOf = <Args, Result>(fn: unknown) =>
  (fn as { _handler: (ctx: unknown, args: Args) => Promise<Result> })._handler

const runProcessDeletion = handlerOf<
  { requestId: string },
  { deleted: boolean; profileAlreadyGone?: boolean }
>(processAccountDeletion)
const runRequestDeletion = handlerOf<{ profileId: string; reason?: string }, string>(
  requestAccountDeletion
)
const runCancelDeletion = handlerOf<{ requestId: string; profileId: string }, void>(
  cancelDeletionRequest
)

// ===== FIXTURES =====

const USERS: Row[] = [
  {
    _id: 'user_admin',
    authProvider: 'workos',
    providerUserId: 'workos_admin',
    workosUserId: 'workos_admin',
    email: 'fixture-14e4636f@example.com',
  },
  {
    _id: 'user_investor',
    authProvider: 'workos',
    providerUserId: 'workos_investor',
    workosUserId: 'workos_investor',
    email: 'investor@example.com',
  },
  {
    _id: 'user_target',
    authProvider: 'workos',
    providerUserId: 'workos_target',
    workosUserId: 'workos_target',
    email: 'target@example.com',
  },
]

const PROFILES: Row[] = [
  { _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true },
  { _id: 'profile_investor', userId: 'user_investor', role: 'COMPANY', isActive: true },
  {
    _id: 'profile_target',
    userId: 'user_target',
    role: 'COMPANY',
    isActive: true,
    kycStatus: 'VERIFIED',
  },
]

function seed(overrides: Partial<Tables> = {}): Tables {
  return {
    users: USERS,
    profiles: PROFILES,
    deletionRequests: [
      {
        _id: 'request_1',
        profileId: 'profile_target',
        email: 'target@example.com',
        status: 'PENDING',
        requestedAt: 1_000,
      },
    ],
    notifications: [],
    consents: [],
    companies: [],
    investors: [],
    connections: [],
    messages: [],
    ...overrides,
  }
}

describe('processAccountDeletion — guarda admin-only', () => {
  it('rechaza a un no-admin y NO borra nada', async () => {
    const ctx = createCtx(seed(), 'workos_investor')

    await expect(runProcessDeletion(ctx, { requestId: 'request_1' })).rejects.toThrow(
      /Solo administradores/
    )

    expect(ctx.db.delete).not.toHaveBeenCalled()
    expect(ctx.db.patch).not.toHaveBeenCalled()
    expect(ctx.deleted).toEqual([])
  })

  it('rechaza una solicitud ya procesada sin borrar nada', async () => {
    const ctx = createCtx(
      seed({
        deletionRequests: [
          {
            _id: 'request_1',
            profileId: 'profile_target',
            email: 'target@example.com',
            status: 'COMPLETED',
            requestedAt: 1_000,
          },
        ],
      }),
      'workos_admin'
    )

    await expect(runProcessDeletion(ctx, { requestId: 'request_1' })).rejects.toMatchObject({
      data: { code: 'BUSINESS_INVALID_STATE', details: { currentState: 'COMPLETED' } },
    })
    expect(ctx.db.delete).not.toHaveBeenCalled()
  })

  it('cierra la solicitud cuando el profile ya no existe', async () => {
    const ctx = createCtx(
      seed({
        deletionRequests: [
          {
            _id: 'request_1',
            profileId: 'profile_gone',
            email: 'gone@example.com',
            status: 'PENDING',
            requestedAt: 1_000,
          },
        ],
      }),
      'workos_admin'
    )

    await expect(runProcessDeletion(ctx, { requestId: 'request_1' })).resolves.toEqual({
      deleted: true,
      profileAlreadyGone: true,
    })

    expect(ctx.patched).toContainEqual({ id: 'request_1', patch: { status: 'COMPLETED' } })
    expect(ctx.deleted).toEqual([])
  })
})

describe('processAccountDeletion — cascada y auditoría', () => {
  const populated = () =>
    seed({
      notifications: [{ _id: 'notification_1', userId: 'profile_target' }],
      consents: [{ _id: 'consent_1', profileId: 'profile_target' }],
      companies: [{ _id: 'company_1', ownerId: 'profile_target', name: 'Acme' }],
    })

  it('borra en cascada notificaciones, consentimientos y empresa', async () => {
    const ctx = createCtx(populated(), 'workos_admin')

    // `userDeleted` distingue borrar el profile de borrar la identidad de auth:
    // sólo se elimina el user cuando ya no queda ningún profile apuntándole.
    await expect(runProcessDeletion(ctx, { requestId: 'request_1' })).resolves.toEqual({
      deleted: true,
      userDeleted: true,
    })

    // El orden importa y es el de la cascada: hijos antes que padres
    // (documentos → empresa), luego los rastros del profile, y al final la
    // identidad de auth — que sólo cae porque ya no queda ningún profile
    // apuntándole.
    expect(ctx.deleted).toEqual([
      'company_1',
      'notification_1',
      'consent_1',
      'profile_target',
      'user_target',
    ])
  })

  it('registra la eliminación en adminAuditLogs con el admin que la ejecutó', async () => {
    const ctx = createCtx(populated(), 'workos_admin')

    await runProcessDeletion(ctx, { requestId: 'request_1' })

    const auditLog = ctx.inserted.find((entry) => entry.table === 'adminAuditLogs')?.row
    expect(auditLog).toMatchObject({
      adminProfileId: 'profile_admin',
      adminEmail: 'fixture-14e4636f@example.com',
      action: 'USER_DELETE',
      targetType: 'PROFILE',
      targetId: 'profile_target',
    })
    expect(auditLog?.previousValue).toMatchObject({ role: 'COMPANY', kycStatus: 'VERIFIED' })
  })

  it('marca la solicitud como COMPLETED con el admin que la procesó', async () => {
    const ctx = createCtx(populated(), 'workos_admin')

    await runProcessDeletion(ctx, { requestId: 'request_1' })

    // La solicitud recibe DOS patches: primero la redacción de su email (barrido
    // de PII sobre todas las solicitudes del profile) y luego el cierre. Se afirma
    // el efecto combinado para no depender del orden.
    const requestPatches = ctx.patched.filter((entry) => entry.id === 'request_1')
    expect(requestPatches.length).toBeGreaterThan(0)
    const merged = Object.assign({}, ...requestPatches.map((entry) => entry.patch))
    expect(merged).toMatchObject({
      status: 'COMPLETED',
      processedBy: 'profile_admin',
      email: 'fixture-c5f01650@example.com',
    })
  })
})

describe('requestAccountDeletion / cancelDeletionRequest — ownership', () => {
  it('rechaza a un tercero que no es dueño ni admin', async () => {
    const ctx = createCtx(seed(), 'workos_investor')

    await expect(runRequestDeletion(ctx, { profileId: 'profile_target' })).rejects.toMatchObject({
      data: { code: 'AUTHZ_UNAUTHORIZED' },
    })
    expect(ctx.inserted).toHaveLength(0)
  })

  it('el dueño puede solicitar su eliminación y recibe notificación', async () => {
    // Sin una PENDING previa: con ella la mutation devuelve la existente (H12).
    const ctx = createCtx(seed({ deletionRequests: [] }), 'workos_target')

    await expect(runRequestDeletion(ctx, { profileId: 'profile_target' })).resolves.toBe(
      'deletionRequests_new'
    )

    const request = ctx.inserted.find((entry) => entry.table === 'deletionRequests')?.row
    expect(request).toMatchObject({
      profileId: 'profile_target',
      email: 'target@example.com',
      status: 'PENDING',
    })
    expect(ctx.inserted.some((entry) => entry.table === 'notifications')).toBe(true)
  })

  it('rechaza cancelar la solicitud de otro usuario', async () => {
    const ctx = createCtx(seed(), 'workos_investor')

    await expect(
      runCancelDeletion(ctx, { requestId: 'request_1', profileId: 'profile_target' })
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })
    expect(ctx.patched).toHaveLength(0)
  })

  it('el dueño puede cancelar su propia solicitud pendiente', async () => {
    const ctx = createCtx(seed(), 'workos_target')

    await runCancelDeletion(ctx, { requestId: 'request_1', profileId: 'profile_target' })

    expect(ctx.patched).toContainEqual({ id: 'request_1', patch: { status: 'CANCELLED' } })
  })
})

describe('requestAccountDeletion — una PENDING previa se devuelve, no se duplica', () => {
  it('devuelve la solicitud pendiente existente sin insertar otra ni avisar de nuevo', async () => {
    // H12 del informe A2: la guarda vivía solo en la página; la mutation es la
    // frontera.
    const ctx = createCtx(seed(), 'workos_target')

    const requestId = await runRequestDeletion(ctx, { profileId: 'profile_target' })

    expect(requestId).toBe('request_1')
    expect(ctx.inserted).toEqual([])
  })

  it('sin una PENDING previa crea la solicitud y el aviso', async () => {
    const ctx = createCtx(seed({ deletionRequests: [] }), 'workos_target')

    const requestId = await runRequestDeletion(ctx, { profileId: 'profile_target' })

    expect(requestId).toBe('deletionRequests_new')
    expect(ctx.inserted.map((entry) => entry.table)).toEqual(['deletionRequests', 'notifications'])
  })
})

describe('processAccountDeletion — contrato de args en la frontera de Convex', () => {
  it('solo declara requestId', () => {
    const validator = convexArgsValidator(processAccountDeletion)
    expect(Object.keys(validator.value as Record<string, unknown>)).toEqual(['requestId'])
  })
})
