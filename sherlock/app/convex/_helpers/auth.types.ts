import { Schema } from 'effect'

import type { QueryCtx, MutationCtx } from '../_generated/server'
import type { Doc } from '../_generated/dataModel'
import type { AuthProvider as AuthProviderCatalog } from '../schema'

export type AuthContext = QueryCtx | MutationCtx

// El catálogo de proveedores de identidad ya vive una sola vez, como
// `Schema.Literals`, en `schema.ts` (`AuthProvider.schema`, con `.validator`
// consumido por `defineTable`). Este archivo y `auth.identity.ts` lo repetían
// cada uno con su propio `'clerk' | 'workos'` a mano: dos listas que
// coincidían por casualidad, justo la duplicación que esta ola existe para
// matar. Acá se deriva el tipo del catálogo con `import type`, así que no
// agrega un `Schema.Literals` decorativo (ese ya lo pagó `schema.ts`) ni
// vuelve a entrar como valor muerto al bundle: el import se borra al
// compilar. `auth.identity.ts` sigue con su propia copia — converger esa
// también toca un archivo fuera de este lote.
type AuthProvider = (typeof AuthProviderCatalog)['schema']['Type']

export interface AuthResult {
  identity: {
    subject: string
    authProvider: AuthProvider
    issuer?: string
    sessionId?: string
    email?: string
    name?: string
  }
  user: Doc<'users'>
  profile: Doc<'profiles'>
}

// `ctx` es literalmente la entrada externa de cada handler: Convex promete
// `QueryCtx | MutationCtx`, pero nada en runtime obliga a que lo que llega
// calce. Antes este chequeo casteaba `ctx.db` a un tipo inventado
// (`{ insert?: unknown }`) para leer `insert` sin que el compilador se
// quejara — un cast ciego, no una guarda. El schema describe la forma real
// (un `db` con un `insert` invocable) y `Schema.is` la valida sin castear
// nada; el resultado es el mismo predicado, con la misma firma pública.
const isMutationShaped = Schema.is(
  Schema.Struct({
    db: Schema.Struct({
      insert: Schema.declare(
        (value: unknown): value is (...args: never[]) => unknown => typeof value === 'function'
      ),
    }),
  })
)

export function isMutationCtx(ctx: AuthContext): ctx is MutationCtx {
  return isMutationShaped(ctx)
}
