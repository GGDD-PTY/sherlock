// ============================================================================
// DEV AUTH — resolución del perfil real de un dev user
// ============================================================================
// Existe para arreglar un defecto concreto: `useCurrentUserDev` sintetizaba un
// perfil cuyo `_id` era el literal `'demo_company_profile' as Id<'profiles'>`.
// Un `as` no convierte una cadena en un id de Convex, así que toda query que
// declarara `profileId: v.id('profiles')` la rechazaba con
// `Validator: v.id("profiles")`. En la práctica `/settings/privacy` caía al
// error boundary cada vez que alguien entraba por `/dev-login`, y lo mismo le
// pasaría a cualquier pantalla nueva que pase el perfil a Convex.
//
// El login local crea los usuarios y sus perfiles mediante `bootstrapUsers`.
// La lectura devuelve esos perfiles reales; no inventa ids ni crea empresas.
//
// El guard es el mismo que el resto del bypass y es fail-closed: exige
// `BYPASS_AUTH=true` **y** `CONVEX_ENV=dev`. Un `BYPASS_AUTH` olvidado en el
// deployment de producción deja esta query devolviendo `null`, no perfiles.
// ============================================================================

import { v } from 'convex/values'
import { Effect, Schema } from 'effect'

import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { isDevAuthBypassedViaEnv } from './_helpers/auth.dev'
import { convexPromise, runConvex } from './_helpers/effect'
import { unauthorized } from './_helpers/errors'
import { DEV_USERS } from '../src/lib/dev-auth/types'

// El dominio cerrado de `src/lib/dev-auth/types.ts`, escrito de nuevo aquí
// porque `convex/` no importa de `src/`: es la superficie que decide qué
// correos puede resolver una query sin sesión.
//
// Era una lista de tres literales. La tarjeta O3-01 abrió el dev-login a
// cualquier `*@dev.local` sembrado, y con la lista corta esta query devolvía
// `null` para el dueño de una empresa sembrada: `useCurrentUser` caía entonces
// al perfil sintético `demo_company_profile`, que no es un id de Convex, y
// `notifications:getNotifications` tumbaba la sala entera al error boundary.
// La parte local no puede ser vacía, igual que en `DevUserEmailSchema`.
const DevEmail = Schema.TemplateLiteral([
  Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  '@dev.local',
])
const isDevEmail = Schema.is(DevEmail)

const getDevProfileProgram = Effect.fn('DevAuth.getDevProfile')(function* (
  ctx: QueryCtx,
  args: { email: string }
) {
  // Fail-closed y en este orden: fuera de un deployment `dev` la query no llega
  // ni a mirar el correo, y un correo fuera de la lista no llega a la base.
  if (!isDevAuthBypassedViaEnv() || !isDevEmail(args.email)) {
    return null
  }

  const user = yield* convexPromise(() =>
    ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', args.email))
      .unique()
  )

  if (!user) return null

  const profile = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .unique()
  )

  if (!profile) return null

  // Whitelist explícita, no el documento crudo: aunque la query sea inerte
  // fuera de dev, la regla del repo es que ninguna superficie sin sesión
  // derrame un doc completo.
  return {
    _id: profile._id,
    // `profiles.role` es obligatorio en el schema; `users.role` es opcional.
    role: profile.role,
    isVerified: profile.isVerified ?? false,
    fullName: profile.fullName ?? user.name ?? null,
    phone: profile.phone ?? null,
    kycStatus: profile.kycStatus ?? null,
  }
})

export const getDevProfile = query({
  args: { email: v.string() },
  handler: (ctx, args) => runConvex(getDevProfileProgram(ctx, args)),
})

// El login local crea identidades, nunca empresas, documentos ni datos demo.
const bootstrapUsersProgram = Effect.fn('DevAuth.bootstrapUsers')(function* (ctx: MutationCtx) {
  if (!isDevAuthBypassedViaEnv()) {
    return yield* Effect.fail(unauthorized('Dev auth no está habilitado en este entorno'))
  }

  for (const definition of DEV_USERS) {
    const existing = yield* convexPromise(() =>
      ctx.db
        .query('users')
        .withIndex('by_email', (q) => q.eq('email', definition.email))
        .unique()
    )
    const identity = {
      workosUserId: definition.convexIdentity.subject,
      authProvider: 'workos' as const,
      providerUserId: definition.convexIdentity.subject,
    }
    const userId =
      existing?._id ??
      (yield* convexPromise(() =>
        ctx.db.insert('users', {
          ...identity,
          email: definition.email,
          name: definition.name,
          clerkId: definition.id,
          role: definition.role,
          emailVerified: true,
        })
      ))
    if (existing) yield* convexPromise(() => ctx.db.patch(userId, identity))
    const profile = yield* convexPromise(() =>
      ctx.db
        .query('profiles')
        .withIndex('by_userId', (q) => q.eq('userId', userId))
        .unique()
    )
    if (!profile)
      yield* convexPromise(() =>
        ctx.db.insert('profiles', {
          userId,
          role: definition.role,
          fullName: definition.name,
          language: 'es',
          isVerified: true,
          isActive: true,
          kycStatus: 'VERIFIED',
          roleConfirmed: true,
        })
      )
  }
  return { ready: true }
})

export const bootstrapUsers = mutation({
  args: {},
  handler: (ctx) => runConvex(bootstrapUsersProgram(ctx)),
})
