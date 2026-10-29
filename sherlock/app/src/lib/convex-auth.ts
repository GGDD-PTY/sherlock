// ============================================================================
// CONVEX AUTH HELPER
// ============================================================================
// Server-side Convex calls authenticated with WorkOS AuthKit access tokens.
// End-user auth must use the WorkOS session token, never Convex deploy/admin keys.
// ============================================================================

import { withAuth } from '@workos-inc/authkit-nextjs'
import { ConvexHttpClient } from 'convex/browser'
import { Duration, Effect } from 'effect'
import { api } from '@/../convex/_generated/api'
import type { Doc } from '@/../convex/_generated/dataModel'
import { UnexpectedAppError } from '@/lib/effect/errors'
import { externalCall } from '@/lib/effect/external'
import { runServerEffect, runServerEffectSync } from '@/lib/effect/runtime'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { localConvexAdminKey, localConvexIdentity } from '@/lib/dev-auth/local-convex-identity'
import { devUserForRole, devUserFromId } from '@/lib/dev-auth/seed-identity'
import { DEV_AUTH_COOKIE_ROLE, DEV_AUTH_COOKIE_USER } from '@/lib/dev-auth/types'
import { VIEW_AS_COOKIE_NAME } from '@/stores/useViewAsStore'

export type AuthenticatedConvexClient = {
  client: ConvexHttpClient
  token: string | null
  isAuthenticated: boolean
  /** Subject bound by the local-only authenticated client; absent for WorkOS. */
  localSubject?: string
}

type WorkosSessionState = Awaited<ReturnType<typeof withAuth>>

/**
 * La sesión de AuthKit es IO: cookie sellada más, cuando toca, un refresh
 * contra WorkOS. Sin reintento — un rechazo de sesión es determinista y esto
 * corre en el camino caliente de cada página — pero con techo de tiempo, para
 * que un WorkOS colgado no cuelgue el render.
 */
const workosSessionEffect = Effect.fn('ConvexAuth.workosSession')(function* (operation: string) {
  return yield* externalCall({
    service: 'WorkOS',
    operation,
    retries: 0,
    timeout: Duration.seconds(8),
    run: () => withAuth(),
  }).pipe(
    Effect.match({
      onSuccess: (state: WorkosSessionState) => ({ ok: true as const, state }),
      onFailure: (error) => ({ ok: false as const, error }),
    })
  )
})

/** SSR en `dev:local`: el backend local ve al usuario de la cookie de dev-auth
 *  (impersonación con la admin key local), no al admin de bypass. Contra la
 *  nube no hay key y el cliente sigue sin auth. */
const impersonateLocalDevUserEffect = Effect.fn('ConvexAuth.impersonateLocalDevUser')(function* (
  client: ConvexHttpClient
) {
  const adminKey = localConvexAdminKey(
    {
      NODE_ENV: process.env.NODE_ENV,
      NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
      NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: process.env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY,
    },
    DEV_AUTH_ENABLED
  )
  const setAdminAuth = Reflect.get(client, 'setAdminAuth') as
    ((token: string, identity: Record<string, string>) => void) | undefined
  if (!adminKey || typeof setAdminAuth !== 'function') return null

  // Fuera de un request (sin cookies) el cliente queda sin identidad.
  const selection = yield* Effect.tryPromise({
    try: async () => {
      const { cookies } = await import('next/headers')
      const store = await cookies()
      const viewAs = store.get(VIEW_AS_COOKIE_NAME)?.value
      return {
        userId: store.get(DEV_AUTH_COOKIE_USER)?.value,
        role: viewAs === 'COMPANY' ? viewAs : store.get(DEV_AUTH_COOKIE_ROLE)?.value,
      }
    },
    catch: (cause) =>
      new UnexpectedAppError({
        operation: 'ConvexAuth.readDevAuthCookie',
        message: 'La cookie de dev-auth no está disponible fuera de un request.',
        cause,
      }),
  }).pipe(Effect.orElseSucceed(() => undefined))

  const signedInUser = selection?.userId ? devUserFromId(selection.userId) : null
  if (!signedInUser) return null
  const user = devUserForRole(signedInUser, selection?.role)

  return yield* Effect.try({
    try: () => {
      setAdminAuth.call(client, adminKey, localConvexIdentity(user))
      return user.convexIdentity.subject
    },
    catch: (cause) =>
      new UnexpectedAppError({
        operation: 'ConvexAuth.setLocalAdminIdentity',
        message: 'El backend local no aceptó la identidad de dev-auth.',
        cause,
      }),
  }).pipe(Effect.orElseSucceed(() => null))
})

const getUnauthenticatedConvexEffect = Effect.fn('ConvexAuth.unauthenticatedClient')(function* () {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL
  if (!convexUrl) {
    yield* Effect.logError('[getUnauthenticatedConvex] NEXT_PUBLIC_CONVEX_URL not set')
    return null
  }
  return yield* Effect.sync(() => new ConvexHttpClient(convexUrl))
})

const getAuthenticatedConvexEffect = Effect.fn('ConvexAuth.authenticatedClient')(function* () {
  if (DEV_AUTH_ENABLED) {
    const client = yield* getUnauthenticatedConvexEffect()
    if (!client) return null
    const localSubject = yield* impersonateLocalDevUserEffect(client)
    return {
      client,
      token: null,
      isAuthenticated: localSubject !== null,
      ...(localSubject ? { localSubject } : {}),
    } satisfies AuthenticatedConvexClient
  }

  const session = yield* workosSessionEffect('authkit.withAuth')
  if (!session.ok) {
    yield* Effect.logWarning(
      '[getAuthenticatedConvex] WorkOS AuthKit session unavailable',
      session.error
    )
    return null
  }

  if (!session.state.user) {
    return null
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL
  if (!convexUrl) {
    yield* Effect.logError('[getAuthenticatedConvex] NEXT_PUBLIC_CONVEX_URL not set')
    return null
  }

  const client = new ConvexHttpClient(convexUrl)
  const token = session.state.accessToken ?? null

  if (!token) {
    yield* Effect.logWarning(
      '[getAuthenticatedConvex] WorkOS session exists but no access token is available'
    )
    return { client, token: null, isAuthenticated: false } satisfies AuthenticatedConvexClient
  }

  client.setAuth(token)
  return { client, token, isAuthenticated: true } satisfies AuthenticatedConvexClient
})

export function getAuthenticatedConvex(): Promise<AuthenticatedConvexClient | null> {
  return runServerEffect(getAuthenticatedConvexEffect())
}

export type CurrentAuthenticatedUserState = {
  user: Doc<'users'> | null
  profile: Doc<'profiles'> | null
}

const getCurrentAuthenticatedUserStateEffect = Effect.fn('ConvexAuth.currentUserState')(
  function* (options?: { requireConvexAuth?: boolean }) {
    const convexAuth = yield* getAuthenticatedConvexEffect()

    if (!convexAuth?.client) {
      return null
    }

    if (options?.requireConvexAuth && !convexAuth.isAuthenticated) {
      yield* Effect.logWarning(
        '[getCurrentAuthenticatedUserState] Convex authentication is required but unavailable'
      )
      return null
    }

    // Una lectura idempotente en el camino caliente de cada página: un reintento
    // cubre el parpadeo de red sin convertir una caída de Convex en segundos de
    // espera. El techo de tiempo evita que el render quede colgado.
    const state = yield* externalCall({
      service: 'Convex',
      operation: 'users.getCurrentUserState',
      retries: 1,
      timeout: Duration.seconds(8),
      run: () => convexAuth.client.query(api.users.getCurrentUserState, {}),
    }).pipe(
      Effect.match({
        onSuccess: (value) => ({ ok: true as const, value }),
        onFailure: (error) => ({ ok: false as const, error }),
      })
    )

    if (!state.ok) {
      yield* Effect.logError(
        '[getCurrentAuthenticatedUserState] Error resolving current user state:',
        state.error
      )
      return null
    }

    return state.value ?? null
  }
)

export function getCurrentAuthenticatedUserState(options?: {
  requireConvexAuth?: boolean
}): Promise<CurrentAuthenticatedUserState | null> {
  return runServerEffect(getCurrentAuthenticatedUserStateEffect(options))
}

// Puente síncrono para los handlers existentes.
export function getUnauthenticatedConvex(): ConvexHttpClient | null {
  return runServerEffectSync(getUnauthenticatedConvexEffect())
}
