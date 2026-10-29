// ============================================================================
// CONVEX RATE LIMIT HELPER
// ============================================================================
// Lightweight, per-key rate limiting for Convex mutations.
// Stores counters in the "rateLimits" table.
// ============================================================================

import { ConvexError } from 'convex/values'
import { Effect } from 'effect'

import type { MutationCtx } from '../_generated/server'
import { convexPromise, runConvex } from './effect'

export type RateLimitConfig = {
  key: string
  limit: number
  windowMs: number
}

export type RateLimitResult = {
  remaining: number
  resetAt: number
}

// El valor que sale por el borde queda IDÉNTICO: un `ConvexError('Rate limit
// exceeded')` pelado, porque el cliente depende de esa forma exacta. Viaja como
// defecto a propósito — `runConvex` relanza un defecto `Error` intacto — para
// que ningún `Effect.catch` de un llamador lo confunda con una respuesta de
// negocio que se pueda recuperar.
const rateLimitExceededDefect = () =>
  Effect.die(new ConvexError('Rate limit exceeded')) as Effect.Effect<never>

const enforceRateLimitEffect = Effect.fn('RateLimit.enforce')(function* (
  ctx: MutationCtx,
  config: RateLimitConfig
) {
  const now = Date.now()

  const existing = yield* convexPromise(() =>
    ctx.db
      .query('rateLimits')
      .withIndex('by_key', (q) => q.eq('key', config.key))
      .first()
  )

  if (!existing) {
    yield* convexPromise(() =>
      ctx.db.insert('rateLimits', {
        key: config.key,
        count: 1,
        windowStart: now,
        windowMs: config.windowMs,
        lastHitAt: now,
      })
    )

    return {
      remaining: Math.max(0, config.limit - 1),
      resetAt: now + config.windowMs,
    } satisfies RateLimitResult
  }

  const windowExpired = now - existing.windowStart >= config.windowMs
  const windowChanged = existing.windowMs !== config.windowMs

  if (windowExpired || windowChanged) {
    yield* convexPromise(() =>
      ctx.db.patch(existing._id, {
        count: 1,
        windowStart: now,
        windowMs: config.windowMs,
        lastHitAt: now,
      })
    )

    return {
      remaining: Math.max(0, config.limit - 1),
      resetAt: now + config.windowMs,
    } satisfies RateLimitResult
  }

  if (existing.count >= config.limit) {
    return yield* rateLimitExceededDefect()
  }

  const nextCount = existing.count + 1
  yield* convexPromise(() =>
    ctx.db.patch(existing._id, {
      count: nextCount,
      lastHitAt: now,
    })
  )

  return {
    remaining: Math.max(0, config.limit - nextCount),
    resetAt: existing.windowStart + config.windowMs,
  } satisfies RateLimitResult
})

/**
 * Enforce a rate limit for a given key.
 * Throws ConvexError when limit is exceeded.
 */
export function enforceRateLimit(
  ctx: MutationCtx,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  return runConvex(enforceRateLimitEffect(ctx, config))
}
