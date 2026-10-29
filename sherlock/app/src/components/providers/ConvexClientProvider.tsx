// ============================================================================
// CONVEX CLIENT PROVIDER (AUTO-SELECCIÓN)
// ============================================================================
// Provider que automáticamente selecciona entre:
// - ConvexProviderWithAuth + WorkOS AuthKit (producción)
// - DevConvexProvider (desarrollo con bypass)
//
// Uso: Reemplaza ConvexClientProvider en el layout
// ============================================================================

'use client'

import { useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { Effect, Schema } from 'effect'
import { useAccessToken, useAuth as useAuthKit } from '@workos-inc/authkit-nextjs/components'
import { ConvexProvider, ConvexProviderWithAuth, ConvexReactClient } from 'convex/react'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth'
import { useDevAuth } from '@/lib/dev-auth/context'
import { localConvexAdminKey, localConvexIdentity } from '@/lib/dev-auth/local-convex-identity'
import { runClientEffect } from '@/lib/effect/client-runtime'
import { devUserForRole } from '@/lib/dev-auth/seed-identity'
import { useViewAsStore } from '@/stores/useViewAsStore'

// ============================================================================
// CREAR CLIENTE DE CONVEX
// ============================================================================

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL

function isPlaceholderConvexUrl(value: string | undefined): boolean {
  if (!value) return true

  try {
    const url = new URL(value)
    const deploymentName = url.hostname.split('.')[0] ?? ''
    return (
      deploymentName === 'placeholder' ||
      deploymentName.startsWith('your-project') ||
      value.includes('placeholder')
    )
  } catch {
    return true
  }
}

function createDevNoopConvexClient(): ConvexReactClient {
  const disabledWatch = {
    localQueryResult: () => undefined,
    onUpdate: () => () => undefined,
    journal: () => undefined,
  }

  return {
    watchQuery: () => disabledWatch,
    watchPaginatedQuery: () => disabledWatch,
    query: async () => {
      throw new Error('Convex is disabled because NEXT_PUBLIC_CONVEX_URL is a local placeholder.')
    },
    mutation: async () => {
      throw new Error('Convex is disabled because NEXT_PUBLIC_CONVEX_URL is a local placeholder.')
    },
    action: async () => {
      throw new Error('Convex is disabled because NEXT_PUBLIC_CONVEX_URL is a local placeholder.')
    },
  } as unknown as ConvexReactClient
}

function createConvexClient(): ConvexReactClient {
  if (DEV_AUTH_ENABLED && isPlaceholderConvexUrl(convexUrl)) {
    return createDevNoopConvexClient()
  }

  if (!convexUrl) {
    throw new Error(
      'Falta NEXT_PUBLIC_CONVEX_URL en las variables de entorno. ' +
        'Ejecuta `bunx convex dev` para configurar Convex.'
    )
  }

  return new ConvexReactClient(convexUrl)
}

const convex = createConvexClient()

// ============================================================================
// PROVIDER COMPONENT
// ============================================================================

interface ConvexClientProviderProps {
  children: ReactNode
}

// La admin key del backend LOCAL, solo cuando `scripts/convex-local.mjs` la
// exporta y la URL es loopback (ver `local-convex-identity.ts`). Contra la
// nube es null y el cliente dev sigue sin identidad, como siempre.
const localAdminKey = localConvexAdminKey(
  {
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_CONVEX_URL: convexUrl,
    NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: process.env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY,
  },
  DEV_AUTH_ENABLED
)

/** Hace que el backend local vea al usuario elegido en `/dev-login` en vez de
 *  resolver todo al admin de bypass. Sin usuario firmado, limpia la auth. */
function DevConvexIdentity({ adminKey }: { adminKey: string }) {
  const { user, isLoaded, currentRole } = useDevAuth()
  const viewAsRole = useViewAsStore((state) => state.viewAsRole)
  useEffect(() => {
    if (!isLoaded) return
    const client = convex as ConvexReactClient & {
      setAdminAuth?: (token: string, identity: Record<string, string>) => void
    }
    if (user && typeof client.setAdminAuth === 'function') {
      client.setAdminAuth(
        adminKey,
        localConvexIdentity(devUserForRole(user, viewAsRole ?? currentRole))
      )
    } else {
      convex.clearAuth()
    }
  }, [adminKey, isLoaded, user, currentRole, viewAsRole])
  return null
}

export function ConvexClientProvider({ children }: ConvexClientProviderProps) {
  // ===== DEV MODE: Usar ConvexProvider básico =====
  if (DEV_AUTH_ENABLED) {
    return (
      <ConvexProvider client={convex}>
        {localAdminKey ? <DevConvexIdentity adminKey={localAdminKey} /> : null}
        {children}
      </ConvexProvider>
    )
  }

  // ===== PROD MODE: Usar WorkOS AuthKit access tokens para Convex =====
  return (
    <ConvexProviderWithAuth client={convex} useAuth={useAuthFromAuthKit}>
      {children}
    </ConvexProviderWithAuth>
  )
}

// ===== LA COSTURA CON EFFECT =====
// Convex le pide el token a AuthKit y acepta `null` como «sin sesión». Un fallo
// del proveedor se traducía a ese mismo `null` desde un `catch` anónimo, así
// que «no hay sesión» y «no se pudo preguntar» eran indistinguibles en el log.
// Siguen dando el mismo resultado —es lo que Convex entiende— pero ahora el
// fallo tiene nombre y se registra como lo que es.
class AccessTokenUnavailable extends Schema.TaggedError<AccessTokenUnavailable>()(
  'AccessTokenUnavailable',
  { cause: Schema.Defect() }
) {}

const readAccessToken = Effect.fn('ConvexAuth.readAccessToken')(function* (
  read: () => Promise<string | undefined>
): Effect.fn.Return<string | null> {
  return yield* Effect.tryPromise({
    try: read,
    catch: (cause) => new AccessTokenUnavailable({ cause }),
  }).pipe(
    Effect.map((token) => token ?? null),
    Effect.tapError((error) =>
      Effect.logWarning(
        '[ConvexClientProvider] Failed to get WorkOS access token for Convex',
        error.cause
      )
    ),
    Effect.orElseSucceed(() => null)
  )
})

function useAuthFromAuthKit() {
  const { user, loading } = useAuthKit()
  const { getAccessToken, refresh } = useAccessToken()

  const fetchAccessToken = useCallback(
    ({ forceRefreshToken }: { forceRefreshToken?: boolean } = {}) => {
      if (!user) return Promise.resolve(null)
      return runClientEffect(
        readAccessToken(() => (forceRefreshToken ? refresh() : getAccessToken()))
      )
    },
    [getAccessToken, refresh, user]
  )

  return useMemo(
    () => ({
      isLoading: loading,
      isAuthenticated: Boolean(user),
      fetchAccessToken,
    }),
    [fetchAccessToken, loading, user]
  )
}
