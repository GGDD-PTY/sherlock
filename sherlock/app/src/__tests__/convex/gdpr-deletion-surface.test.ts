// ============================================================================
// GDPR — la cola de eliminación por fin tiene superficie
// ============================================================================
// `requestAccountDeletion` tenía UI viva y `processAccountDeletion` existía,
// estaba probado y NADIE lo llamaba: toda solicitud quedaba PENDING para
// siempre (riesgo legal Art. 17, no deuda técnica). Estas pruebas fijan la
// pieza que faltaba: una query admin-only que lista la cola, para que la
// página de admin pueda mostrarla y procesarla.
// ============================================================================

import { describe, expect, it, vi } from 'vitest'

import { getPendingDeletionRequest, listDeletionRequests } from '../../../convex/gdpr'

type Row = Record<string, unknown> & { _id: string }
type Tables = Record<string, Row[]>
type Filter = { field: string; value: unknown }
type FieldRef = { __field: string }
type FilterApi = {
  field: (name: string) => FieldRef
  eq: (left: FieldRef | unknown, right: unknown) => boolean
}

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
    // `filter` no puede ser un no-op: `getPendingDeletionRequest` filtra por
    // status ahí, y un stub que lo ignora daría verde sobre un filtro roto.
    filter: vi.fn((callback?: (q: FilterApi) => unknown) => {
      callback?.({
        field: (name: string) => ({ __field: name }),
        eq: (left: FieldRef | unknown, right: unknown) => {
          if (typeof left === 'object' && left !== null && '__field' in left) {
            filters.push({ field: (left as FieldRef).__field, value: right })
          }
          return true
        },
      })
      return builder
    }),
    order: vi.fn(() => builder),
    first: vi.fn(async () => matches()[0] ?? null),
    unique: vi.fn(async () => matches()[0] ?? null),
    collect: vi.fn(async () => matches()),
    take: vi.fn(async (n: number) => matches().slice(0, n)),
  }

  return builder
}

function createCtx(seed: Tables, subject: string) {
  const tables: Tables = Object.fromEntries(
    Object.entries(seed).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))])
  )

  return {
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
    },
  }
}

type Ctx = ReturnType<typeof createCtx>

const runList = (
  listDeletionRequests as unknown as {
    _handler: (ctx: Ctx, args: { status?: string }) => Promise<Array<Record<string, unknown>>>
  }
)._handler

const runPending = (
  getPendingDeletionRequest as unknown as {
    _handler: (ctx: Ctx, args: { profileId: string }) => Promise<Record<string, unknown> | null>
  }
)._handler

function seed(): Tables {
  return {
    users: [
      {
        _id: 'user_admin',
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'admin@example.com',
      },
      {
        _id: 'user_investor',
        authProvider: 'workos',
        providerUserId: 'workos_investor',
        workosUserId: 'workos_investor',
        email: 'investor@example.com',
      },
    ],
    profiles: [
      {
        _id: 'profile_admin',
        userId: 'user_admin',
        role: 'ADMIN',
        isActive: true,
        isVerified: true,
        kycStatus: 'VERIFIED',
      },
      {
        _id: 'profile_investor',
        userId: 'user_investor',
        role: 'COMPANY',
        isActive: true,
        isVerified: true,
        kycStatus: 'VERIFIED',
      },
    ],
    deletionRequests: [
      {
        _id: 'request_pending',
        profileId: 'profile_investor',
        email: 'investor@example.com',
        status: 'PENDING',
        requestedAt: 1_700_000_000_000,
      },
      {
        _id: 'request_done',
        profileId: 'profile_investor',
        email: '[REDACTED]',
        status: 'COMPLETED',
        requestedAt: 1_600_000_000_000,
        processedAt: 1_600_100_000_000,
      },
    ],
  }
}

describe('listDeletionRequests — la cola GDPR es admin-only', () => {
  it('el admin ve la cola completa', async () => {
    const ctx = createCtx(seed(), 'workos_admin')

    const requests = await runList(ctx, {})

    expect(requests).toHaveLength(2)
    expect(requests.map((r) => r._id)).toContain('request_pending')
  })

  it('filtra por status cuando se pide', async () => {
    const ctx = createCtx(seed(), 'workos_admin')

    const pending = await runList(ctx, { status: 'PENDING' })

    expect(pending).toHaveLength(1)
    expect(pending[0]._id).toBe('request_pending')
  })

  it('cualquier rol no-admin recibe unauthorized', async () => {
    const ctx = createCtx(seed(), 'workos_investor')

    await expect(runList(ctx, {})).rejects.toThrow()
  })
})

describe('getPendingDeletionRequest — la página de privacidad sabe que ya pediste el borrado', () => {
  it('devuelve la solicitud PENDING del propio perfil, no la ya procesada', async () => {
    const ctx = createCtx(seed(), 'workos_investor')

    const pending = await runPending(ctx, { profileId: 'profile_investor' })

    expect(pending?._id).toBe('request_pending')
  })

  it('devuelve null cuando el perfil no tiene ninguna pendiente', async () => {
    const rows = seed()
    rows.deletionRequests = rows.deletionRequests.filter((row) => row.status !== 'PENDING')
    const ctx = createCtx(rows, 'workos_investor')

    await expect(runPending(ctx, { profileId: 'profile_investor' })).resolves.toBeNull()
  })

  it('no deja leer la solicitud de otro perfil', async () => {
    const ctx = createCtx(seed(), 'workos_investor')

    await expect(runPending(ctx, { profileId: 'profile_admin' })).rejects.toThrow()
  })
})
