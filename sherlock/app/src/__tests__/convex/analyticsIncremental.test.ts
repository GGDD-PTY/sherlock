// ============================================================================
// convex/analyticsIncremental.ts
// ============================================================================
// `reconcileStats` recalcula los contadores de `systemStats` desde `profiles`.
// Nada en producción lo agenda. Se fija la aritmética por rol y la decisión
// insert/patch del módulo que queda hasta borrar las filas.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { reconcileStats } from '../../../convex/analyticsIncremental'

// ============================================================================
// FAKE CTX
// ============================================================================

type Row = Record<string, unknown>

function createCtx(tables: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = { systemStats: [], ...tables }

  const db = {
    query: vi.fn((table: string) => {
      const rows = store[table] ?? []
      const builder = {
        withIndex: vi.fn(() => builder),
        filter: vi.fn(() => builder),
        order: vi.fn(() => builder),
        first: vi.fn(async () => rows[0] ?? null),
        collect: vi.fn(async () => rows.slice()),
      }
      return builder
    }),
    patch: vi.fn(async () => undefined),
    insert: vi.fn(async () => 'systemStats_1'),
    get: vi.fn(async () => null),
  }

  return { ctx: { db }, store }
}

type Handler<A> = (ctx: unknown, args: A) => Promise<unknown>

const handlerOf = <A>(fn: unknown): Handler<A> => (fn as { _handler: Handler<A> })._handler

const runReconcileStats = handlerOf<Record<string, never>>(reconcileStats)

// ============================================================================
// FIXTURE — la aritmética que puede driftear en silencio
// ============================================================================

function populatedTables() {
  return {
    profiles: [{ role: 'COMPANY' }, { role: 'COMPANY' }, { role: 'ADMIN' }],
  }
}

const EXPECTED_STATS = {
  key: 'global',
  totalUsers: 3,
  totalCompanies: 2,
  totalAdmins: 1,
}

// ============================================================================
// TESTS
// ============================================================================

describe('convex/analyticsIncremental.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('aritmética de reconciliación', () => {
    it('reconcileStats cuenta los perfiles por rol desde la tabla', async () => {
      const { ctx } = createCtx(populatedTables())

      const result = (await runReconcileStats(ctx, {})) as {
        success: boolean
        stats: Record<string, unknown>
      }

      expect(result.success).toBe(true)
      expect(result.stats).toMatchObject(EXPECTED_STATS)
      expect(typeof result.stats.lastUpdated).toBe('number')
    })

    it('inserta el registro global cuando no existe', async () => {
      const { ctx } = createCtx(populatedTables())

      await runReconcileStats(ctx, {})

      expect(ctx.db.insert).toHaveBeenCalledWith(
        'systemStats',
        expect.objectContaining(EXPECTED_STATS)
      )
      expect(ctx.db.patch).not.toHaveBeenCalled()
    })

    it('parcha el registro global cuando ya existe', async () => {
      const tables = { ...populatedTables(), systemStats: [{ _id: 'systemStats_1' }] }
      const { ctx } = createCtx(tables)

      await runReconcileStats(ctx, {})

      expect(ctx.db.patch).toHaveBeenCalledWith(
        'systemStats_1',
        expect.objectContaining(EXPECTED_STATS)
      )
      expect(ctx.db.insert).not.toHaveBeenCalled()
    })
  })
})
