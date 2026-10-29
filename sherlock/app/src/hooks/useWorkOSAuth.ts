// ============================================================================
// WORKOS AUTH HOOK (PRODUCCIÓN)
// ============================================================================
// ===== LA COSTURA CON EFFECT =====
// El mapeo del usuario es derivación pura y se queda como está: React ya es
// dueño de eso. Lo único que puede fallar acá es pedirle el access token a
// AuthKit, y ese punto tenía un `catch {}` anónimo — sin variable, sin tipo,
// sin rastro. Ahora es un programa con error etiquetado
// (`WorkOSAccessTokenError`) y span con nombre, corrido en el borde del
// callback. El contrato no se mueve: `getToken()` sigue devolviendo
// `Promise<string | null>` y un rechazo de AuthKit sigue saliendo como `null`,
// en silencio, sin tumbar a quien lo llame.
// ============================================================================

'use client'

import { useAccessToken, useAuth as useAuthKit } from '@workos-inc/authkit-nextjs/components'
import { Effect, Schema } from 'effect'

import { runClientEffect } from '@/lib/effect/client-runtime'
import type { AuthUser, UseAuthReturn } from './useAuth'

/**
 * El rechazo de AuthKit, con nombre. No se exporta: el contrato del hook sigue
 * siendo `string | null`. El tag existe para que el fallo deje de ser un
 * `catch` sin variable y tenga un tipo en el canal de error del programa.
 */
class WorkOSAccessTokenError extends Schema.TaggedError<WorkOSAccessTokenError>()(
  'WorkOSAccessTokenError',
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

/**
 * Pide el token y colapsa las dos formas de no tenerlo —AuthKit rechazó, o
 * AuthKit resolvió vacío— en el mismo `null` que los consumidores ya esperan.
 */
const resolveAccessToken = Effect.fn('WorkOSAuth.accessToken')(function* (
  getAccessToken: () => Promise<string | undefined | null>
): Effect.fn.Return<string | null> {
  return yield* Effect.tryPromise({
    try: () => getAccessToken(),
    catch: (cause) =>
      new WorkOSAccessTokenError({
        message: 'AuthKit rechazó la entrega del access token.',
        cause,
      }),
  }).pipe(
    Effect.match({
      onSuccess: (token): string | null => token ?? null,
      onFailure: (): string | null => null,
    })
  )
})

export function useWorkOSAuthImpl(): UseAuthReturn {
  const { user, loading, signOut } = useAuthKit()
  const { getAccessToken } = useAccessToken()

  const authUser: AuthUser | null = user
    ? {
        id: user.id,
        email: user.email ?? null,
        name: [user.firstName, user.lastName].filter(Boolean).join(' ') || null,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        imageUrl: null,
        createdAt: user.createdAt ? new Date(user.createdAt) : new Date(0),
        updatedAt: user.updatedAt ? new Date(user.updatedAt) : new Date(0),
      }
    : null

  const getAuthToken = async (): Promise<string | null> =>
    runClientEffect(resolveAccessToken(getAccessToken))

  return {
    isLoaded: !loading,
    isSignedIn: Boolean(user),
    user: authUser,
    userId: user?.id ?? null,
    signOut: async () => {
      await signOut()
    },
    getToken: getAuthToken,
    isDevMode: false,
  }
}
