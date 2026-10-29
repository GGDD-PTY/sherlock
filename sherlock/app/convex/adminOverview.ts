// ============================================================================
// ADMIN OVERVIEW — la superficie autorizada de la vista general del equipo
// ============================================================================
// Solo perfiles ADMIN. `requireAuthAdmin` corre ANTES de cualquier lectura: un
// guard después del primer `ctx.db` ya filtró datos para quien no debía verlos.
// En Effect ese orden es estructural: `buildAdminOverview` está detrás de un
// `yield*` que solo se alcanza si el guard resolvió.
//
// La lógica vive en `_admin/overview.ts` (módulo no direccionable) para que los
// tests la ejerciten sin montar un deployment. Acá solo va el guard.
//
// PII: el correo del DUEÑO de cada empresa sí sale — es el equipo mirando a sus
// propios clientes, y sin correo la tabla no sirve para llamar a nadie. No sale
// ningún identificador de WorkOS, token, ni dato de terceros.
// ============================================================================

import { Effect } from 'effect'

import { query, type QueryCtx } from './_generated/server'
import { requireAuthAdmin } from './_helpers/auth'
import { convexPromise, runConvex } from './_helpers/effect'
import { buildAdminOverview } from './_admin/overview'

const getAdminOverviewProgram = Effect.fn('AdminOverview.get')(function* (ctx: QueryCtx) {
  const auth = yield* convexPromise(() => requireAuthAdmin(ctx))
  return yield* convexPromise(() => buildAdminOverview(ctx, auth.profile._id))
})

export const getAdminOverview = query({
  args: {},
  handler: (ctx) => runConvex(getAdminOverviewProgram(ctx)),
})
