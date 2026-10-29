import { Effect } from 'effect'

import type { AuthContext, AuthResult } from './auth.types'
import { requireAuthEffect } from './auth.identity'
import { requireAdmin } from './auth.roles'
import { convexSync, runConvex } from './effect'

// El invariante «auth + bypass admin» de CLAUDE.md, compuesto: `requireAuth`
// pone la identidad en el canal de éxito y el guarda síncrono pone su negativa
// en el canal de error. Un handler convertido encadena estos dos con `yield*` y
// no vuelve a ver un `unknown`.
//
// El programa es local a propósito: knip exige que un export tenga consumidor,
// así que el primer handler que se convierta a Effect le pone el `export`
// delante al mismo tiempo que lo importa.

const requireAuthAdminEffect = Effect.fn('ConvexAuth.requireAuthAdmin')(function* (
  ctx: AuthContext
) {
  const result = yield* requireAuthEffect(ctx)
  yield* convexSync(() => requireAdmin(result.profile))
  return result
})

// El borde Promise de los handlers todavía sin convertir.

export function requireAuthAdmin(ctx: AuthContext): Promise<AuthResult> {
  return runConvex(requireAuthAdminEffect(ctx))
}
