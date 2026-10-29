import { ConvexHttpClient } from 'convex/browser'
import { Effect } from 'effect'

export type ConvexAdminHttpClient = {
  setAdminAuth: (token: string) => void
  mutation: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>
  query: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>
}

export type ConvexAdminFailure = {
  code: 'CONVEX_ADMIN_PERMISSION_DENIED' | 'CONVEX_ADMIN_REQUEST_FAILED'
  safeMessage: string
}

/**
 * Convert provider failures into an operational signal that is safe to log and
 * persist. Raw Convex errors can include deployment details or caller data, so
 * callers must not forward the original message beyond this adapter seam.
 */
export function classifyConvexAdminFailure(error: unknown): ConvexAdminFailure {
  const message = error instanceof Error ? error.message : ''
  if (/permission[_\s-]*denied|unauthorized|forbidden/i.test(message)) {
    return {
      code: 'CONVEX_ADMIN_PERMISSION_DENIED',
      safeMessage: 'Convex rejected the server authorization.',
    }
  }

  return {
    code: 'CONVEX_ADMIN_REQUEST_FAILED',
    safeMessage: 'Convex admin request failed.',
  }
}

function isConvexAdminClient(
  client: ConvexHttpClient
): client is ConvexHttpClient & ConvexAdminHttpClient {
  return typeof Reflect.get(client, 'setAdminAuth') === 'function'
}

const getConvexAdminClientEffect = Effect.fn('ConvexAdminClient.get')(function* () {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL
  const adminKey = process.env.CONVEX_DEPLOY_KEY

  if (!convexUrl || !adminKey) {
    return null
  }

  // Un cliente que no arma o que no expone la identidad de servidor no se
  // devuelve a medias: el caller decide sin excepción que perseguir.
  const client = yield* Effect.try(() => new ConvexHttpClient(convexUrl)).pipe(
    Effect.orElseSucceed(() => null)
  )
  if (!client || !isConvexAdminClient(client)) {
    return null
  }

  client.setAdminAuth(adminKey)
  return client as ConvexAdminHttpClient
})

// Puente síncrono para los callers existentes.
export function getConvexAdminClient(): ConvexAdminHttpClient | null {
  return Effect.runSync(getConvexAdminClientEffect())
}
