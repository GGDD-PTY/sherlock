import { Effect } from 'effect'

import type { AuthContext, AuthResult } from './auth.types'
import { requireAuth as requireAuthBound } from './auth.identity'
import { requireAdmin } from './auth.roles'
import {
  hasOwnership,
  requireOwnership,
} from './auth.ownership'
import { requireAuthAdmin as requireAuthAdminBound } from './auth.guards'
import {
  getAuthenticatedCompany as getAuthenticatedCompanyBound,
  requireAuthenticatedCompany as requireAuthenticatedCompanyBound,
} from './auth.entities'
import { convexPromise, runConvex } from './effect'

export type { AuthContext, AuthResult } from './auth.types'

export { requireAdmin }

export { hasOwnership, requireOwnership }

// Este barrel es el borde Promise que los handlers todavía importan. Cada
// export nombra su span y delega en el módulo dueño: la compuerta de admin vive
// UNA sola vez, en `auth.guards`, y aquí no se reimplementa.
const requireAuthProgram = Effect.fn('ConvexAuth.barrel.requireAuth')(function* (ctx: AuthContext) {
  return yield* convexPromise(() => requireAuthBound(ctx))
})

export function requireAuth(ctx: AuthContext): Promise<AuthResult> {
  return runConvex(requireAuthProgram(ctx))
}

const requireAuthAdminProgram = Effect.fn('ConvexAuth.barrel.requireAuthAdmin')(function* (
  ctx: AuthContext
) {
  return yield* convexPromise(() => requireAuthAdminBound(ctx))
})

export function requireAuthAdmin(ctx: AuthContext): Promise<AuthResult> {
  return runConvex(requireAuthAdminProgram(ctx))
}

const getAuthenticatedCompanyProgram = Effect.fn('ConvexAuth.barrel.getAuthenticatedCompany')(function* (
  ctx: AuthContext
) {
  return yield* convexPromise(() => getAuthenticatedCompanyBound(ctx))
})

export function getAuthenticatedCompany(ctx: AuthContext) {
  return runConvex(getAuthenticatedCompanyProgram(ctx))
}

const requireAuthenticatedCompanyProgram = Effect.fn('ConvexAuth.barrel.requireAuthenticatedCompany')(
  function* (ctx: AuthContext) {
    return yield* convexPromise(() => requireAuthenticatedCompanyBound(ctx))
  }
)

export function requireAuthenticatedCompany(ctx: AuthContext) {
  return runConvex(requireAuthenticatedCompanyProgram(ctx))
}
