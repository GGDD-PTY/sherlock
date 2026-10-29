'use server'

import { Effect } from 'effect'
import { api } from '@/../convex/_generated/api'
import { getUnauthenticatedConvex } from '@/lib/convex-auth'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { hasLocalConvexIdentity, isLoopbackConvexUrl } from '@/lib/dev-auth/local-convex-identity'
import { runServerEffect } from '@/lib/effect/runtime'

export async function prepareLocalDevLogin(): Promise<boolean> {
  if (!DEV_AUTH_ENABLED) return false
  // El carril E2E aislado no crea usuarios ni contacta un proveedor.
  if (!isLoopbackConvexUrl(process.env.NEXT_PUBLIC_CONVEX_URL)) return true
  if (!hasLocalConvexIdentity()) return false

  return runServerEffect(
    Effect.tryPromise({
      try: async () => {
        const client = getUnauthenticatedConvex()
        if (!client) return false
        const result = await client.mutation(api.devAuth.bootstrapUsers, {})
        return result.ready
      },
      catch: () => new Error('No se pudo preparar el acceso local.'),
    }).pipe(Effect.orElseSucceed(() => false))
  )
}
