import { v } from 'convex/values'
import { Effect } from 'effect'

import { internal } from './_generated/api'
import { internalMutation, mutation, type MutationCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { requireAuth } from './_helpers/auth'
import { logAdminAction } from './_helpers/auditLog'
import { convexPromise, runConvex, type ConvexEffect } from './_helpers/effect'
import { enforceRateLimit } from './_helpers/rateLimit'
import { unauthorized } from './_helpers/errors'
import {
  ADMIN_VDR_CAPABILITY_TTL_MS,
  isAdminVdrAction,
  isValidAdminVdrBindingIdentifier,
} from './_adminVdr/capabilityFormat'
import { requireAdminVdrCapabilityServerProof } from './_adminVdr/serverProof'
import { adminVdrIdentityBindingDigest } from './_adminVdr/capability'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const EXPIRED_CAPABILITY_PURGE_BATCH = 200
// Referencia tipada de `_generated`, no una cadena: si el export se renombra,
// el typecheck falla antes de desplegar. El `makeFunctionReference(...) as
// unknown as FunctionReference<…>` que había aquí escribía a mano el tipo que
// `_generated` ya conoce, y con él se perdía justamente esa garantía.
const purgeExpiredRef = internal.adminVdrCapabilities._purgeExpired

const issueProgram = Effect.fn('AdminVdrCapability.issue')(function* (
  ctx: MutationCtx,
  args: {
    tokenHash: string
    companyId: Id<'companies'>
    action: string
    target: string
    inputDigest: string
    issuedAt: number
    expiresAt: number
    proof: string
  }
) {
  const denied = unauthorized('Autorización administrativa VDR denegada.')
  const auth = yield* convexPromise(() => requireAuth(ctx))
  // El guard estrecha un local, no una propiedad de `args`: `action` sale de
  // aquí ya tipada como acción VDR conocida y nadie más abajo la vuelve a
  // ensanchar a `string`.
  const action = args.action
  if (
    auth.profile.role !== 'ADMIN' ||
    auth.identity.authProvider !== 'workos' ||
    !auth.identity.sessionId ||
    auth.user.workosUserId !== auth.identity.subject ||
    !isAdminVdrAction(action) ||
    !SHA256_PATTERN.test(args.tokenHash) ||
    !SHA256_PATTERN.test(args.inputDigest) ||
    !isValidAdminVdrBindingIdentifier(args.target, 1_024) ||
    args.expiresAt - args.issuedAt !== ADMIN_VDR_CAPABILITY_TTL_MS
  ) {
    return yield* Effect.fail(denied)
  }

  // El objeto se arma FUERA del callback a propósito: TypeScript no conserva el
  // estrechamiento de `auth.identity.sessionId` —que el guard de arriba ya
  // probó no vacío— dentro de una función que se ejecuta después.
  const proofInput = {
    ...args,
    subject: auth.identity.subject,
    sessionId: auth.identity.sessionId,
    action,
  }
  yield* convexPromise(() => requireAdminVdrCapabilityServerProof(proofInput))
  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) return yield* Effect.fail(denied)

  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `admin-vdr-capability:${auth.profile._id}`,
      limit: 60,
      windowMs: 60_000,
    })
  )

  const duplicate = yield* convexPromise(() =>
    ctx.db
      .query('adminVdrCapabilities')
      .withIndex('by_tokenHash', (query) => query.eq('tokenHash', args.tokenHash))
      .unique()
  )
  if (duplicate) return yield* Effect.fail(denied)

  const identityBindingDigest = yield* convexPromise(() =>
    adminVdrIdentityBindingDigest(proofInput.subject, proofInput.sessionId)
  )
  if (!identityBindingDigest) return yield* Effect.fail(denied)
  const capabilityId = yield* convexPromise(() =>
    ctx.db.insert('adminVdrCapabilities', {
      tokenHash: args.tokenHash,
      profileId: auth.profile._id,
      identityBindingDigest,
      companyId: company._id,
      action,
      target: args.target,
      inputDigest: args.inputDigest,
      issuedAt: args.issuedAt,
      expiresAt: args.expiresAt,
    })
  )
  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: auth.profile._id,
      adminEmail: auth.user.email,
      action: 'VDR_ADMIN_CAPABILITY_ISSUE',
      targetType: 'COMPANY',
      targetId: `${company._id}`,
      newValue: {
        capabilityId: `${capabilityId}`,
        action,
        target: args.target,
        inputDigest: args.inputDigest,
        expiresAt: args.expiresAt,
      },
    })
  )

  return { expiresAt: args.expiresAt }
})

export const issue = mutation({
  args: {
    tokenHash: v.string(),
    companyId: v.id('companies'),
    action: v.string(),
    target: v.string(),
    inputDigest: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
    proof: v.string(),
  },
  handler: (ctx, args) => runConvex(issueProgram(ctx, args)),
})

// La anotación explícita del retorno corta el ciclo de tipos: el programa se
// reencola a sí mismo por `purgeExpiredRef`, cuyo tipo sale de `_generated`, que
// a su vez lee el tipo de `_purgeExpired`. Escribir el retorno aquí es lo que
// permite usar la referencia tipada en vez del `as unknown as` que había antes.
const purgeExpiredProgram: (
  ctx: MutationCtx
) => ConvexEffect<{ deleted: number; hasMore: boolean }> = Effect.fn(
  'AdminVdrCapability.purgeExpired'
)(function* (ctx: MutationCtx) {
  const expired = yield* convexPromise(() =>
    ctx.db
      .query('adminVdrCapabilities')
      .withIndex('by_expiresAt', (query) => query.lte('expiresAt', Date.now()))
      .take(EXPIRED_CAPABILITY_PURGE_BATCH)
  )

  for (const capability of expired) {
    yield* convexPromise(() => ctx.db.delete(capability._id))
  }

  const hasMore = expired.length === EXPIRED_CAPABILITY_PURGE_BATCH
  if (hasMore) yield* convexPromise(() => ctx.scheduler.runAfter(0, purgeExpiredRef, {}))
  return { deleted: expired.length, hasMore }
})

export const _purgeExpired = internalMutation({
  args: {},
  handler: (ctx) => runConvex(purgeExpiredProgram(ctx)),
})
