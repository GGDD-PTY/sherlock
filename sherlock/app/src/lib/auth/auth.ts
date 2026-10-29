// ============================================================================
// AUTH.TS - WORKOS SERVER AUTH FUNCTIONS
// ============================================================================
// Este archivo provee funciones de autenticación para API routes usando WorkOS
// Reemplaza las funciones de NextAuth (auth())
// ============================================================================

import { withAuth } from '@workos-inc/authkit-nextjs'
import { Duration, Effect } from 'effect'
import { buildWorkOsAuthSession } from '@/lib/auth/provider-boundary'
import { UnexpectedAppError } from '@/lib/effect/errors'
import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { getCurrentUser } from '@/lib/auth/session'

// ===== TIPO DE SESIÓN =====
// Mantenemos compatibilidad con el formato que usaba NextAuth
export interface Session {
  sessionId: string | null
  user: {
    id: string
    email: string | null
    name: string | null
    image: string | null
    // Campos adicionales que pueden venir de Convex/DB
    profileId?: string
    role?: 'COMPANY' | 'ADMIN'
  } | null
}

const authEffect = Effect.fn('Auth.session')(function* () {
  // ===== DEMO MODE: BYPASS =====
  // ES: En demo devolvemos sesión desde getCurrentUser().
  // EN: In demo return session from getCurrentUser().
  if (DEV_AUTH_ENABLED) {
    const demoUser = yield* Effect.tryPromise({
      try: () => getCurrentUser(),
      catch: (cause) =>
        new UnexpectedAppError({
          operation: 'Auth.demoUser',
          message: 'No se pudo resolver el usuario demo.',
          cause,
        }),
    })
    if (!demoUser) return null

    return {
      sessionId: null,
      user: {
        id: demoUser.id,
        email: demoUser.email,
        name: demoUser.name,
        image: demoUser.image,
        profileId: demoUser.profileId ?? undefined,
        role: demoUser.role,
      },
    } satisfies Session
  }

  // Sin reintento: un rechazo de sesión de AuthKit es determinista y esto corre
  // en cada request de API. El techo de tiempo sí entra.
  const workosAuth = yield* externalCall({
    service: 'WorkOS',
    operation: 'authkit.withAuth',
    retries: 0,
    timeout: Duration.seconds(8),
    run: () => withAuth(),
  })
  const workosUser = workosAuth.user
  if (!workosUser) {
    return null
  }

  const providerSession = yield* Effect.try({
    try: () =>
      buildWorkOsAuthSession({
        user: {
          id: workosUser.id,
          email: workosUser.email || '',
          firstName: workosUser.firstName,
          lastName: workosUser.lastName,
        },
        organization: workosAuth.organizationId
          ? { id: workosAuth.organizationId, name: workosAuth.organizationId }
          : null,
        roleSlug: workosAuth.role,
      }),
    catch: (cause) =>
      new UnexpectedAppError({
        operation: 'Auth.buildProviderSession',
        message: 'La sesión de WorkOS no encuadra en la frontera de proveedor.',
        cause,
      }),
  })

  // Construir sesión compatible con formato NextAuth
  return {
    sessionId: workosAuth.sessionId,
    user: {
      id: providerSession.identity.providerUserId,
      email: providerSession.identity.email || null,
      name: providerSession.identity.name,
      image: providerSession.identity.imageUrl,
      // NOTE: profileId y role se obtienen de Convex en los componentes via useCurrentUser()
      // Esto evita una llamada extra a la base de datos en cada request de auth
    },
  } satisfies Session
})

// ===== AUTH FUNCTION =====
// Esta función es usada en API routes para verificar autenticación
// Devuelve una sesión compatible con el formato de NextAuth.
//
// `null` significa una sola cosa: nadie firmado. Un fallo de transporte (WorkOS
// colgado, la cota de 8 s, la frontera de proveedor rota) RECHAZA con el error
// tipado en vez de disfrazarse de sesión ausente: antes ambos salían `null` y
// `requireApiAuth` respondía 401 durante una caída de WorkOS, y la UI lo leía
// como sesión expirada (A1-03). El caller decide qué hacer con el fallo; en
// `with-auth.ts` es un 500 con la causa logueada del lado servidor.
export function auth(): Promise<Session | null> {
  return runServerEffect(authEffect())
}
