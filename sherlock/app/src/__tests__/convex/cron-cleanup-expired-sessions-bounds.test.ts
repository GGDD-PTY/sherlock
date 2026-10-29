// ============================================================================
// CRON cleanupExpiredSessions — RANGO POR by_creation_time COMO PRE-FILTRO
// ============================================================================
// El corte real es por `lastHitAt` (no hay índice sobre ese campo, y no se
// puede agregar uno nuevo sin tocar schema.ts). Pero `lastHitAt` NUNCA es
// anterior a `_creationTime` — `enforceRateLimit` (convex/_helpers/rateLimit.ts)
// fija `lastHitAt: now` tanto al insertar como en cada patch posterior, así
// que `_creationTime <= lastHitAt` siempre se cumple. Eso hace seguro usar
// `by_creation_time` como PRE-FILTRO (superset — nunca excluye un positivo
// real) antes de aplicar el filtro exacto por `lastHitAt`: las filas creadas
// después del cutoff ni se tocan, sin cambiar qué filas terminan borradas.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cleanupExpiredSessions } from '../../../convex/cronHandlers'
import { createConvexCtx, runHandler, type HarnessCtx, type Tables } from './nda-convex-harness'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

type QueryBuilderMock = {
  withIndex: { mock: { calls: unknown[][] } }
  filter: { mock: { calls: unknown[][] } }
  take: { mock: { calls: unknown[] } }
}

function queryCallsFor(ctx: HarnessCtx, table: string): QueryBuilderMock[] {
  return ctx.db.query.mock.calls
    .map((call: unknown[], index: number) => ({
      table: call[0],
      builder: ctx.db.query.mock.results[index]?.value,
    }))
    .filter((entry: { table: unknown }) => entry.table === table)
    .map((entry: { builder: unknown }) => entry.builder as QueryBuilderMock)
}

function seed(): Tables {
  return {
    rateLimits: [
      {
        _id: 'rl_stale',
        _creationTime: NOW - 10 * DAY_MS,
        key: 'messages:profile_a',
        count: 1,
        windowStart: NOW - 10 * DAY_MS,
        windowMs: 60 * 60 * 1000,
        lastHitAt: NOW - 10 * DAY_MS,
      },
      {
        _id: 'rl_old_creation_recent_hit',
        _creationTime: NOW - 10 * DAY_MS,
        key: 'messages:profile_b',
        count: 5,
        windowStart: NOW - 30 * 60 * 1000,
        windowMs: 60 * 60 * 1000,
        lastHitAt: NOW - 30 * 60 * 1000, // renovado hace media hora — sigue vivo
      },
      {
        _id: 'rl_fresh',
        _creationTime: NOW - 30 * 60 * 1000,
        key: 'messages:profile_c',
        count: 1,
        windowStart: NOW - 30 * 60 * 1000,
        windowMs: 60 * 60 * 1000,
        lastHitAt: NOW - 30 * 60 * 1000,
      },
    ],
  }
}

describe('cronHandlers.cleanupExpiredSessions — rango por by_creation_time', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('usa el índice implícito by_creation_time como pre-filtro', async () => {
    const ctx = createConvexCtx(seed())
    await runHandler(cleanupExpiredSessions, ctx, {})

    const [builder] = queryCallsFor(ctx, 'rateLimits')
    expect(builder.withIndex.mock.calls.length).toBeGreaterThan(0)
    expect(builder.withIndex.mock.calls[0][0]).toBe('by_creation_time')
    expect(builder.take.mock.calls.length).toBeGreaterThan(0)
  })

  it('borra solo el contador realmente vencido — el creado hace tiempo pero renovado hace poco sobrevive', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables)
    const result = await runHandler<Record<string, never>, { cleaned: number }>(
      cleanupExpiredSessions,
      ctx,
      {}
    )

    expect(result.cleaned).toBe(1)
    const remainingIds = tables.rateLimits.map((row) => row._id)
    expect(remainingIds).not.toContain('rl_stale')
    expect(remainingIds).toContain('rl_old_creation_recent_hit')
    expect(remainingIds).toContain('rl_fresh')
  })
})
