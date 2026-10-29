import { Effect } from 'effect'

import type { AuthContext, AuthResult } from './auth.types'
import { isMutationCtx } from './auth.types'
import { getDevAuthResult, isDevAuthBypassed } from './auth.dev'
import { convexPromise, convexSync, runConvex, type ConvexEffect } from './effect'
import type { AppError } from './errors'
import { notAuthenticated, profileNotFound, unauthorized, userNotFound } from './errors'
import type { Doc } from '../_generated/dataModel'

export type AuthProvider = 'clerk' | 'workos'

export type ProviderIdentity = {
  subject: string
  issuer?: string
  sid?: string
  email?: string
  name?: string
  givenName?: string
  pictureUrl?: string
}

export function getIdentityAuthProvider(identity: Pick<ProviderIdentity, 'issuer'>): AuthProvider {
  const issuer = identity.issuer ?? ''
  if (
    issuer === 'https://api.workos.com/' ||
    issuer.startsWith('https://api.workos.com/user_management/')
  ) {
    return 'workos'
  }

  // Historical tests and persisted identities may omit issuer or carry a
  // recognized Clerk issuer. Convex no longer trusts Clerk JWTs, but retaining
  // this classification preserves data lookup compatibility.
  if (
    issuer === '' ||
    issuer === 'https://clerk.dev' ||
    /^https:\/\/[a-z0-9-]+\.clerk\.accounts\.dev\/?$/i.test(issuer)
  ) {
    return 'clerk'
  }

  throw unauthorized('Proveedor de identidad no soportado')
}

function getProviderPatch(authProvider: AuthProvider, providerUserId: string) {
  if (authProvider === 'workos') {
    return {
      authProvider,
      providerUserId,
      workosUserId: providerUserId,
      emailVerified: true,
    }
  }

  return {
    authProvider,
    providerUserId,
  }
}

async function maybePatchProviderIdentity(
  ctx: AuthContext,
  user: Doc<'users'>,
  authProvider: AuthProvider,
  providerUserId: string
) {
  if (!isMutationCtx(ctx)) {
    return
  }

  // A retained Clerk credential may still resolve a dual-linked user through
  // `clerkId`, but it must never roll the canonical identity back from WorkOS.
  // Returning the row unchanged lets the live-session authorization gate fail
  // closed without mutating durable provider state.
  if (authProvider === 'clerk' && user.workosUserId) {
    return
  }

  const needsPatch =
    user.authProvider !== authProvider ||
    user.providerUserId !== providerUserId ||
    (authProvider === 'workos' && user.workosUserId !== providerUserId)

  if (!needsPatch) {
    return
  }

  await ctx.db.patch(user._id, getProviderPatch(authProvider, providerUserId))
}

// `user.deleted` es terminal: WorkOS no reutiliza el id. El alta de un
// membership y el primer login tienen que leer el mismo marcador.
export async function loadProviderUserTombstone(ctx: AuthContext, workosUserId: string) {
  return await ctx.db
    .query('providerUserTombstones')
    .withIndex('by_providerUserId', (q) =>
      q.eq('authProvider', 'workos').eq('providerUserId', workosUserId)
    )
    .unique()
}

export async function findUserByAuthIdentity(
  ctx: AuthContext,
  identity: ProviderIdentity
): Promise<Doc<'users'> | null> {
  const authProvider = getIdentityAuthProvider(identity)
  const providerUserId = identity.subject

  const byProviderUserId = await ctx.db
    .query('users')
    .withIndex('by_providerUserId', (q) =>
      q.eq('authProvider', authProvider).eq('providerUserId', providerUserId)
    )
    .first()

  if (byProviderUserId) {
    return byProviderUserId
  }

  if (authProvider === 'workos') {
    const byWorkosUserId = await ctx.db
      .query('users')
      .withIndex('by_workosUserId', (q) => q.eq('workosUserId', providerUserId))
      .first()

    if (byWorkosUserId) {
      await maybePatchProviderIdentity(ctx, byWorkosUserId, authProvider, providerUserId)
      return byWorkosUserId
    }

    return null
  }

  const byLegacyClerkId = await ctx.db
    .query('users')
    .withIndex('by_clerkId', (q) => q.eq('clerkId', providerUserId))
    .first()

  if (byLegacyClerkId) {
    await maybePatchProviderIdentity(ctx, byLegacyClerkId, authProvider, providerUserId)
    return byLegacyClerkId
  }

  return null
}

export async function findUserByProviderIdentifier(
  ctx: AuthContext,
  providerUserId: string
): Promise<Doc<'users'> | null> {
  const byWorkosProvider = await ctx.db
    .query('users')
    .withIndex('by_providerUserId', (q) =>
      q.eq('authProvider', 'workos').eq('providerUserId', providerUserId)
    )
    .first()
  if (byWorkosProvider) return byWorkosProvider

  const byClerkProvider = await ctx.db
    .query('users')
    .withIndex('by_providerUserId', (q) =>
      q.eq('authProvider', 'clerk').eq('providerUserId', providerUserId)
    )
    .first()
  if (byClerkProvider) return byClerkProvider

  const byWorkosUserId = await ctx.db
    .query('users')
    .withIndex('by_workosUserId', (q) => q.eq('workosUserId', providerUserId))
    .first()
  if (byWorkosUserId) return byWorkosUserId

  return await ctx.db
    .query('users')
    .withIndex('by_clerkId', (q) => q.eq('clerkId', providerUserId))
    .first()
}

// ============================================================================
// CORREOS SINTÉTICOS
// ============================================================================
// Cuando el token de acceso llega sin claim de correo, el usuario local se crea
// igual con una dirección inventada a partir del id del proveedor
// (`user_01…@workos.user`). Es relleno para que la fila tenga la forma de
// siempre, NO una dirección que exista: nadie la lee, nadie la escribe y nada
// de cara al cliente puede mostrarla ni derivar nada de ella.
//
// El dominio centinela se declara acá, una sola vez. Antes se escribía a mano
// en dos lugares —el bootstrap de este módulo y el webhook de `users.ts`—, que
// es justo como una de las dos se queda atrás.
// ============================================================================

const SYNTHETIC_EMAIL_DOMAIN: Record<AuthProvider, string> = {
  workos: 'workos.user',
  clerk: 'clerk.user',
}

/** La dirección de relleno de un usuario cuyo token no trae correo. */
export function syntheticIdentityEmail(authProvider: AuthProvider, subject: string): string {
  return `${subject}@${SYNTHETIC_EMAIL_DOMAIN[authProvider]}`
}

/** ¿Esta dirección la inventamos nosotros? */
export function isSyntheticIdentityEmail(email: string | null | undefined): boolean {
  if (typeof email !== 'string') return false
  const domain = email.split('@').pop()?.toLowerCase().trim()
  return domain !== undefined && Object.values(SYNTHETIC_EMAIL_DOMAIN).includes(domain)
}

export function buildUserInsertFromIdentity(
  identity: ProviderIdentity,
  role: Doc<'users'>['role']
) {
  const authProvider = getIdentityAuthProvider(identity)
  const email = identity.email || syntheticIdentityEmail(authProvider, identity.subject)
  const name = identity.name || identity.givenName || undefined

  return {
    ...getProviderPatch(authProvider, identity.subject),
    ...(authProvider === 'clerk' ? { clerkId: identity.subject } : {}),
    email,
    name,
    image: identity.pictureUrl || undefined,
    role,
  }
}

/**
 * Un perfil es utilizable mientras no haya sido desactivado.
 *
 * `isActive === false` es el mecanismo real de baneo (`deactivateOwnAccount`
 * y el webhook `user.deleted` de WorkOS). La comparación es
 * estricta contra `false` para no romper documentos legacy sin el campo.
 *
 * Fuente única compartida por `requireAuth` (auth obligatoria) y
 * `getOptionalProfile` (auth opcional de las superficies teaser) para que no
 * vuelvan a divergir.
 */
export function isProfileUsable(profile: Doc<'profiles'> | null | undefined): boolean {
  return Boolean(profile) && profile?.isActive !== false
}

/**
 * Las tres condiciones que el bypass de desarrollo cubre —sin identidad, sin
 * fila de usuario, sin perfil— comparten una sola decisión: en un deployment
 * declarado `dev` se resuelve la sesión de dev; en cualquier otro el fallo sale
 * por el canal de error. Antes esa decisión estaba escrita tres veces.
 */
function devAuthOr(ctx: AuthContext, liveFailure: AppError): ConvexEffect<AuthResult> {
  return Effect.suspend(() =>
    isDevAuthBypassed() ? convexPromise(() => getDevAuthResult(ctx)) : Effect.fail(liveFailure)
  )
}

/**
 * El invariante que CLAUDE.md exige en toda mutation, expresado en Effect: cada
 * salida está en el canal de error con su `AppError`, y el éxito es el único
 * camino que devuelve un `AuthResult`.
 */
export const requireAuthEffect = Effect.fn('ConvexAuth.requireAuth')(function* (ctx: AuthContext) {
  const identity = yield* convexPromise(() => ctx.auth.getUserIdentity())

  if (!identity) {
    return yield* devAuthOr(ctx, notAuthenticated())
  }

  const user = yield* convexPromise(() => findUserByAuthIdentity(ctx, identity))

  if (!user) {
    return yield* devAuthOr(ctx, userNotFound(identity.subject))
  }

  const authProvider = yield* convexSync(() => getIdentityAuthProvider(identity))

  if (authProvider === 'clerk' && user.workosUserId) {
    // WorkOS linkage permanently closes the retained Clerk session. Enforce
    // this before reading the profile so every query and mutation, including
    // admin-only handlers without a resource gate, shares the same boundary.
    return yield* Effect.fail(unauthorized('Sesión de proveedor incompatible'))
  }

  const profile = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .unique()
  )

  if (!profile) {
    return yield* devAuthOr(ctx, profileNotFound())
  }

  if (!isProfileUsable(profile)) {
    return yield* Effect.fail(unauthorized('Cuenta desactivada o inactiva'))
  }

  return {
    identity: {
      subject: identity.subject,
      authProvider,
      issuer: identity.issuer,
      sessionId: typeof identity.sid === 'string' ? identity.sid : undefined,
      email: identity.email,
      name: identity.name,
    },
    user,
    profile,
  } satisfies AuthResult
})

/**
 * El borde Promise que conservan los 317 sitios que todavía llaman a `requireAuth`
 * desde un handler `async`. Es la misma implementación: cada caller que se
 * convierte a Effect pasa a `requireAuthEffect` y este borde encoge.
 */
export function requireAuth(ctx: AuthContext): Promise<AuthResult> {
  return runConvex(requireAuthEffect(ctx))
}
