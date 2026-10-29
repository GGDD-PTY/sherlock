import { Effect } from 'effect'

import type { AuthContext } from './auth.types'
import { requireAuthEffect } from './auth.identity'
import { requireCompanyReadAuthorization } from './companyAuthorization'
import { convexPromise, runConvex } from './effect'
import { missingProfile } from './errors'

// Los dos programas son locales por la misma razón que en `auth.guards.ts`:
// se exportan cuando el primer handler convertido los consuma.

const getAuthenticatedCompanyEffect = Effect.fn('ConvexAuth.getAuthenticatedCompany')(function* (
  ctx: AuthContext
) {
  const { profile } = yield* requireAuthEffect(ctx)

  const company = yield* convexPromise(() =>
    ctx.db
      .query('companies')
      .withIndex('by_ownerId', (q) => q.eq('ownerId', profile._id))
      .unique()
  )

  return { profile, company }
})

const requireAuthenticatedCompanyEffect = Effect.fn('ConvexAuth.requireAuthenticatedCompany')(
  function* (ctx: AuthContext) {
    const auth = yield* requireAuthEffect(ctx)
    const company = yield* convexPromise(() =>
      ctx.db
        .query('companies')
        .withIndex('by_ownerId', (q) => q.eq('ownerId', auth.profile._id))
        .unique()
    )

    if (!company) {
      return yield* Effect.fail(missingProfile('company'))
    }

    // La fila por ownerId no alcanza: un dueño revocado sigue siendo
    // ownerId mientras el perfil no se desactiva. La lectura pasa por el
    // evaluador de #776 y se niega si authorized es false.
    yield* convexPromise(() =>
      requireCompanyReadAuthorization(
        ctx,
        auth,
        company,
        'No tienes permiso para ver esta empresa'
      )
    )

    return { profile: auth.profile, company }
  }
)

// Los bordes Promise de los handlers todavía sin convertir.

export function getAuthenticatedCompany(ctx: AuthContext) {
  return runConvex(getAuthenticatedCompanyEffect(ctx))
}

export function requireAuthenticatedCompany(ctx: AuthContext) {
  return runConvex(requireAuthenticatedCompanyEffect(ctx))
}
