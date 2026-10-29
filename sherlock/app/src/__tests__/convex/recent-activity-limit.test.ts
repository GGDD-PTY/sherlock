// ============================================================================
// buildRecentActivity - EL LIMIT SE PROPAGA AL FETCH POR TABLA
// ============================================================================
// ES: Antes fetchRecentActivitySources hardcodeaba take(5) por tabla (máx 15
//     filas) e ignoraba el limit pedido: la vista admin pedía 50 y recibía ~15.
//     Ahora el limit alimenta el take por tabla (con cap de seguridad) y las
// ============================================================================

import { describe, expect, it, vi } from 'vitest'
import { buildRecentActivity } from '../../../convex/_analytics/shared'
import type { QueryCtx } from '../../../convex/_generated/server'

interface FakeDoc {
  _id: string
  _creationTime: number
  [key: string]: unknown
}

function makeDocs(table: string, count: number, extra: (i: number) => object): FakeDoc[] {
  return Array.from({ length: count }, (_, i) => ({
    _id: `${table}_${i}`,
    _creationTime: 1_000_000 - i,
    ...extra(i),
  }))
}

function createCtx(tables: Record<string, FakeDoc[]>) {
  const takeCalls: Record<string, number[]> = {}

  const ctx = {
    db: {
      query: vi.fn((table: string) => ({
        order: () => ({
          take: async (n: number) => {
            takeCalls[table] = [...(takeCalls[table] ?? []), n]
            return (tables[table] ?? []).slice(0, n)
          },
        }),
      })),
      get: vi.fn(async () => null),
    },
  } as unknown as QueryCtx

  return { ctx, takeCalls }
}

function buildTables() {
  return {
    profiles: makeDocs('profile', 60, (i) => ({
      userId: undefined,
      fullName: `Usuario ${i}`,
      role: 'COMPANY',
    })),
  }
}

describe('buildRecentActivity propagates the requested limit', () => {
  it('returns locale-neutral event data instead of presentation copy', async () => {
    const { ctx } = createCtx(buildTables())

    const activities = await buildRecentActivity(ctx, 50)

    expect(activities).toContainEqual(
      expect.objectContaining({
        type: 'USER_JOINED',
        personLabel: 'Usuario 0',
        role: 'COMPANY',
      })
    )
    for (const activity of activities) {
      expect(activity).not.toHaveProperty('title')
      expect(activity).not.toHaveProperty('subtitle')
    }
  })

  it('returns up to `limit` activities when more than 15 records exist', async () => {
    const { ctx } = createCtx(buildTables())

    const activities = await buildRecentActivity(ctx, 50)

    expect(activities).toHaveLength(50)
  })

  it('fetches `limit` rows per table', async () => {
    const { ctx, takeCalls } = createCtx(buildTables())

    await buildRecentActivity(ctx, 50)

    expect(takeCalls.profiles).toEqual([50])
  })

  it('caps the per-table read even for absurd limits', async () => {
    const { ctx, takeCalls } = createCtx(buildTables())

    await buildRecentActivity(ctx, 10_000)

    expect(takeCalls.profiles).toEqual([100])
  })

  it('returns no activity without reading tables when the limit is non-positive', async () => {
    const { ctx, takeCalls } = createCtx(buildTables())

    await expect(buildRecentActivity(ctx, 0)).resolves.toEqual([])
    await expect(buildRecentActivity(ctx, -1)).resolves.toEqual([])
    expect(takeCalls).toEqual({})
  })
})
