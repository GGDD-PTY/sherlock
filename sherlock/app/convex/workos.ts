import { v } from 'convex/values'
import { Effect } from 'effect'

import { query, type QueryCtx } from './_generated/server'
import { requireAuth } from './_helpers/auth'
import { convexPromise, runConvex } from './_helpers/effect'

const getMyMembershipForOrgProgram = Effect.fn('Workos.getMyMembershipForOrg')(function* (
  ctx: QueryCtx,
  args: { workosOrgId: string }
) {
  const { user } = yield* convexPromise(() => requireAuth(ctx))
  // Se recorre lo del usuario (pocas filas) y no la organización entera.
  return yield* convexPromise(() =>
    ctx.db
      .query('organizationMemberships')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .filter((q) => q.eq(q.field('workosOrgId'), args.workosOrgId))
      .first()
  )
})

export const getMyMembershipForOrg = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: (ctx, args) => runConvex(getMyMembershipForOrgProgram(ctx, args)),
})
