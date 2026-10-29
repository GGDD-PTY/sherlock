// ============================================================================
// ADMIN AUDIT LOGS — getStats NO debe escanear la tabla completa
// ============================================================================
// ES: `getStats` hacía `ctx.db.query('adminAuditLogs').collect()` para
//     computar `totalLogs` — un full-table scan de una tabla que SOLO crece
//     (los audit logs nunca se borran). Esta suite prueba que el conteo
//     histórico queda acotado (cota explícita honesta expuesta en el shape
//     de retorno) en vez de traer la tabla entera a memoria.
// EN: `getStats` used to `.collect()` the entire adminAuditLogs table to
//     compute `totalLogs` — unbounded and ever-growing. This suite asserts
//     the historical count is now bounded, with the cap honestly exposed on
//     the return shape instead of silently under-counting.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getStats } from '../../../convex/adminAuditLogs'
import {
  createMockConvexCtx,
  createMockUserIdentity,
  type MockConvexCtx,
} from '../utils/convex-test-utils'
import { createMockProfile, createMockUser, mockId, resetIdCounter } from '../utils/test-factories'

type QueryWithHandler<Args, Result> = {
  _handler: (ctx: MockConvexCtx, args: Args) => Promise<Result>
}

type StatsResult = {
  totalLogs: number
  totalLogsCapped: boolean
  recentLogs: number
  byCategory: {
    user: number
    deal: number
    kyc: number
    nda: number
    other: number
  }
  topAdmins: Array<{ email: string; count: number }>
}

const getStatsHandler = (
  getStats as unknown as QueryWithHandler<Record<string, never>, StatsResult>
)._handler

const ADMIN_USER_ID = mockId('users')
const ADMIN_PROFILE_ID = mockId('profiles')

/**
 * Construye filas de adminAuditLogs con _creationTime crecientes, simulando
 * la tabla append-only real (los logs solo crecen y nunca se borran).
 */
function buildLogRows(count: number, startTime: number) {
  return Array.from({ length: count }, (_, i) => ({
    _id: `log_${i}`,
    _creationTime: startTime + i,
    adminProfileId: ADMIN_PROFILE_ID,
    adminEmail: 'admin@example.com',
    action: 'USER_ROLE_CHANGE',
    targetType: 'USER',
  }))
}

function seedCtx(rows: ReturnType<typeof buildLogRows>) {
  const ctx = createMockConvexCtx()

  // Mock user que superviva requireAuthAdmin
  ctx.auth.getUserIdentity = vi
    .fn()
    .mockResolvedValue(createMockUserIdentity({ subject: 'workos_admin' }))

  const user = createMockUser({ _id: ADMIN_USER_ID, clerkId: 'workos_admin' })
  const profile = createMockProfile({
    _id: ADMIN_PROFILE_ID,
    userId: ADMIN_USER_ID,
    role: 'ADMIN',
    isActive: true,
  })

  ctx.db.get = vi.fn(async (id: unknown) => {
    if (id === ADMIN_USER_ID) return user
    if (id === ADMIN_PROFILE_ID) return profile
    return null
  })

  // withIndex('by_userId'|'by_userId_and_role', ...).unique()/.first() para
  // requireAuthAdmin resolver el perfil desde el usuario autenticado.
  const profileQueryBuilder = {
    withIndex: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    unique: vi.fn().mockResolvedValue(profile),
    first: vi.fn().mockResolvedValue(profile),
    collect: vi.fn().mockResolvedValue([profile]),
    take: vi.fn().mockResolvedValue([profile]),
  }

  const userQueryBuilder = {
    withIndex: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    unique: vi.fn().mockResolvedValue(user),
    first: vi.fn().mockResolvedValue(user),
    collect: vi.fn().mockResolvedValue([user]),
    take: vi.fn().mockResolvedValue([user]),
  }

  // adminAuditLogs query builder: ordena desc y respeta .take(cap); .collect()
  // NUNCA debe invocarse sin un take/límite previo para esta tabla. La ventana
  // de recentLogs va por withIndex('by_creation_time', gte) — el mock captura
  // la cota del rango y collect() la aplica, simulando el índice real.
  const auditLogsCollectSpy = vi.fn()
  let creationTimeBound: number | null = null
  const auditLogsQueryBuilder = {
    withIndex: vi.fn(
      (indexName: string, range?: (q: { gte: (f: string, v: number) => unknown }) => unknown) => {
        if (indexName === 'by_creation_time' && range) {
          range({
            gte: (field: string, value: number) => {
              // Solo captura la cota si el rango se arma sobre _creationTime:
              // si producción llama gte() sobre otro campo, la cota queda null,
              // collect() devuelve la tabla completa y el assert de recentLogs
              // (conteo de la ventana) falla.
              if (field === '_creationTime') {
                creationTimeBound = value
              }
              return {}
            },
          })
        }
        return auditLogsQueryBuilder
      }
    ),
    filter: vi.fn(
      (
        predicate: (q: {
          gte: (a: unknown, b: unknown) => boolean
          field: (f: string) => string
        }) => boolean
      ) => {
        // Simula el filtro post-hoc (el patrón viejo). No filtra de verdad:
        // si la producción regresa a .filter().collect(), el conteo de la
        // ventana sale mal y el test de comportamiento lo detecta.
        const q = {
          gte: (a: unknown, b: unknown) => (a as number) >= (b as number),
          field: (f: string) => f,
        }
        void predicate(q)
        return auditLogsQueryBuilder
      }
    ),
    order: vi.fn().mockReturnThis(),
    unique: vi.fn().mockResolvedValue(null),
    first: vi.fn().mockResolvedValue(null),
    collect: vi.fn(async () => {
      auditLogsCollectSpy()
      return creationTimeBound === null
        ? rows
        : rows.filter((row) => row._creationTime >= (creationTimeBound as number))
    }),
    take: vi.fn(async (n: number) => rows.slice(0, n)),
  }

  ctx.db.query = vi.fn((table: string) => {
    if (table === 'profiles') return profileQueryBuilder
    if (table === 'users') return userQueryBuilder
    if (table === 'adminAuditLogs') return auditLogsQueryBuilder
    return {
      withIndex: vi.fn().mockReturnThis(),
      filter: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      unique: vi.fn().mockResolvedValue(null),
      first: vi.fn().mockResolvedValue(null),
      collect: vi.fn().mockResolvedValue([]),
      take: vi.fn().mockResolvedValue([]),
    }
  })

  return { ctx, auditLogsQueryBuilder, auditLogsCollectSpy }
}

describe('adminAuditLogs.getStats — cota del conteo histórico', () => {
  beforeEach(() => {
    resetIdCounter()
    vi.clearAllMocks()
  })

  it('NO llama a .collect() sin límite sobre adminAuditLogs para el conteo histórico', async () => {
    const rows = buildLogRows(50, 1_700_000_000_000)
    const { ctx, auditLogsQueryBuilder, auditLogsCollectSpy } = seedCtx(rows)

    await getStatsHandler(ctx, {})

    // El full-table-scan original era exactamente esto: .query('adminAuditLogs')
    // seguido de .collect() SIN pasar antes por .take(). Con la cota aplicada,
    // el conteo histórico debe usar .take(cap) — nunca un .collect() abierto
    // adicional sobre la tabla completa.
    expect(auditLogsQueryBuilder.take).toHaveBeenCalled()

    // Y .collect() sobre adminAuditLogs ocurre EXACTAMENTE una vez: la ventana
    // de 7 días de recentLogs (.filter().collect(), ya acotada temporalmente).
    // Si una regresión reintroduce un segundo .collect() para totalLogs,
    // este conteo lo detecta aunque .take() siga llamándose.
    expect(auditLogsCollectSpy).toHaveBeenCalledTimes(1)
  })

  it('expone totalLogsCapped=true cuando la muestra alcanza el cap (no miente sub-contando en silencio)', async () => {
    const CAP_PROBE_SIZE = 10_000 // mayor que cualquier cap razonable
    const rows = buildLogRows(CAP_PROBE_SIZE, 1_700_000_000_000)
    const { ctx, auditLogsQueryBuilder } = seedCtx(rows)

    const stats = await getStatsHandler(ctx, {})

    // Derivamos el tamaño del probe del argumento real de .take(cap + 1) en
    // vez de hardcodear el cap: si el cap interno cambia, el test sigue
    // siendo válido mientras la fixture supere el probe.
    const probeSize = auditLogsQueryBuilder.take.mock.calls[0]?.[0] as number
    expect(probeSize).toBeGreaterThan(0)
    expect(rows.length).toBeGreaterThanOrEqual(probeSize)

    expect(stats.totalLogsCapped).toBe(true)
    // Probe lleno ⇒ el conteo reportado es exactamente el cap (probe - 1).
    expect(stats.totalLogs).toBe(probeSize - 1)
  })

  it('expone totalLogsCapped=false y el conteo exacto cuando la tabla es chica', async () => {
    const rows = buildLogRows(3, 1_700_000_000_000)
    const { ctx } = seedCtx(rows)

    const stats = await getStatsHandler(ctx, {})

    expect(stats.totalLogsCapped).toBe(false)
    expect(stats.totalLogs).toBe(3)
  })

  it('la ventana de recentLogs va por withIndex(by_creation_time), nunca .filter() en memoria', async () => {
    // ES: .filter() sin withIndex escanea la tabla COMPLETA y descarta en
    // memoria; el rango sobre el índice implícito by_creation_time lee solo
    // la ventana de 7 días. Fixture: 3 filas viejas (30 días) + 4 recientes.
    const now = Date.now()
    const oldRows = buildLogRows(3, now - 30 * 24 * 60 * 60 * 1000)
    const recentRows = buildLogRows(4, now - 1_000)
    const { ctx, auditLogsQueryBuilder } = seedCtx([...oldRows, ...recentRows])

    const stats = await getStatsHandler(ctx, {})

    expect(auditLogsQueryBuilder.withIndex).toHaveBeenCalledWith(
      'by_creation_time',
      expect.any(Function)
    )
    expect(auditLogsQueryBuilder.filter).not.toHaveBeenCalled()
    // Comportamiento: solo las filas dentro de la ventana cuentan.
    expect(stats.recentLogs).toBe(4)
  })
})
