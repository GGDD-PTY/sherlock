// ============================================================================
// CONVEX RATE LIMIT HELPER — BEHAVIORAL SUITE
// ============================================================================
// `enforceRateLimit` es el único throttle que protege getStorageUrl,
// localStorageAccess, docDownload y las mutations de deals/interests. Antes de
// esta suite no tenía ningún test de comportamiento: los cuatro branches
// (insert inicial, expiración de ventana, cambio de config, y el throw por
// límite) podían romperse en verde. Cada caso de aquí ancla uno.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConvexError } from 'convex/values'

import { enforceRateLimit } from '../../../convex/_helpers/rateLimit'
import type { MutationCtx } from '../../../convex/_generated/server'
import {
  createMockConvexCtx,
  createMockQueryBuilder,
  type MockConvexCtx,
} from '../utils/convex-test-utils'

const NOW = 1_800_000_000_000
const WINDOW_MS = 60_000
const KEY = 'doc_download:profile_1'

type RateLimitRow = {
  _id: string
  key: string
  count: number
  windowStart: number
  windowMs: number
  lastHitAt: number
}

function seedExistingRow(ctx: MockConvexCtx, overrides: Partial<RateLimitRow> = {}): RateLimitRow {
  const row: RateLimitRow = {
    _id: 'rate_limit_1',
    key: KEY,
    count: 1,
    windowStart: NOW,
    windowMs: WINDOW_MS,
    lastHitAt: NOW,
    ...overrides,
  }

  ctx.db.query.mockReturnValue(createMockQueryBuilder([row]))

  return row
}

const run = (ctx: MockConvexCtx, config: { key: string; limit: number; windowMs: number }) =>
  enforceRateLimit(ctx as unknown as MutationCtx, config)

describe('convex/_helpers/rateLimit — enforceRateLimit', () => {
  let ctx: MockConvexCtx

  beforeEach(() => {
    ctx = createMockConvexCtx()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens a fresh window when no counter exists yet', async () => {
    const result = await run(ctx, { key: KEY, limit: 30, windowMs: WINDOW_MS })

    expect(ctx.db.insert).toHaveBeenCalledWith('rateLimits', {
      key: KEY,
      count: 1,
      windowStart: NOW,
      windowMs: WINDOW_MS,
      lastHitAt: NOW,
    })
    expect(result).toEqual({ remaining: 29, resetAt: NOW + WINDOW_MS })
  })

  it('increments inside the window without sliding windowStart forward', async () => {
    seedExistingRow(ctx, { count: 29, windowStart: NOW - 30_000, lastHitAt: NOW - 30_000 })

    const result = await run(ctx, { key: KEY, limit: 30, windowMs: WINDOW_MS })

    expect(ctx.db.patch).toHaveBeenCalledWith('rate_limit_1', { count: 30, lastHitAt: NOW })
    const patched = ctx.db.patch.mock.calls[0][1] as Record<string, unknown>
    expect('windowStart' in patched).toBe(false)
    expect(result.remaining).toBe(0)
  })

  it('reports resetAt from the original windowStart, not from now', async () => {
    const windowStart = NOW - 45_000
    seedExistingRow(ctx, { count: 5, windowStart, lastHitAt: windowStart })

    const result = await run(ctx, { key: KEY, limit: 30, windowMs: WINDOW_MS })

    expect(result.resetAt).toBe(windowStart + WINDOW_MS)
    expect(result.resetAt).not.toBe(NOW + WINDOW_MS)
  })

  it('throws once the limit is reached and does not advance the counter', async () => {
    seedExistingRow(ctx, { count: 30, windowStart: NOW - 10_000, lastHitAt: NOW - 1_000 })

    await expect(run(ctx, { key: KEY, limit: 30, windowMs: WINDOW_MS })).rejects.toThrow(
      ConvexError
    )

    expect(ctx.db.patch).not.toHaveBeenCalled()
    expect(ctx.db.insert).not.toHaveBeenCalled()
  })

  it('resets the counter once the window has elapsed', async () => {
    seedExistingRow(ctx, {
      count: 30,
      windowStart: NOW - WINDOW_MS,
      lastHitAt: NOW - 1_000,
    })

    const result = await run(ctx, { key: KEY, limit: 30, windowMs: WINDOW_MS })

    expect(ctx.db.patch).toHaveBeenCalledWith('rate_limit_1', {
      count: 1,
      windowStart: NOW,
      windowMs: WINDOW_MS,
      lastHitAt: NOW,
    })
    expect(result).toEqual({ remaining: 29, resetAt: NOW + WINDOW_MS })
  })

  it('resets when the configured window size changed since the row was written', async () => {
    seedExistingRow(ctx, { count: 30, windowStart: NOW - 1_000, windowMs: 3_600_000 })

    const result = await run(ctx, { key: KEY, limit: 30, windowMs: WINDOW_MS })

    expect(ctx.db.patch).toHaveBeenCalledWith('rate_limit_1', {
      count: 1,
      windowStart: NOW,
      windowMs: WINDOW_MS,
      lastHitAt: NOW,
    })
    expect(result.remaining).toBe(29)
  })

  it('allows exactly one call per window when limit is 1', async () => {
    const first = await run(ctx, { key: KEY, limit: 1, windowMs: WINDOW_MS })
    expect(first.remaining).toBe(0)

    seedExistingRow(ctx, { count: 1 })

    await expect(run(ctx, { key: KEY, limit: 1, windowMs: WINDOW_MS })).rejects.toThrow(ConvexError)
  })
})
