// ============================================================================
// API AUTHENTICATION WRAPPER
// ============================================================================
// Wrapper que elimina el boilerplate de autenticación en las rutas de API.
// Obtiene el usuario autenticado y su perfil/rol de Convex.
//
// ANTES (repetido en 8+ archivos):
//   const session = await auth()
//   if (!session?.user?.id) {
//     return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
//   }
//
// DESPUÉS (1 línea):
//   const { user, error } = await requireApiAuth()
//   if (error) return error
//
// El rechazo viaja como error tipado (`ApiAuthDenied`) y solo se convierte en
// NextResponse en el borde: un caso nuevo no puede olvidarse de responder.
// Este helper NUNCA redirige — eso es `requireAuth()` de lib/auth/session.ts.
// ============================================================================

import { Cause, Effect, Result, Schema } from 'effect'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { ADMIN_STEP_UP_COOKIE_NAME, isRecentAdminStepUpCookie } from '@/lib/auth/admin-step-up'
import { auth } from '@/lib/auth/auth'
import { getCurrentUser } from '@/lib/auth/session'
import { getCurrentAuthenticatedUserState } from '@/lib/convex-auth'
import { UnexpectedAppError } from '@/lib/effect/errors'
import { runServerEffect } from '@/lib/effect/runtime'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { localConvexAdminKey, localConvexIdentity } from '@/lib/dev-auth/local-convex-identity'
import { devUserFromEmail } from '@/lib/dev-auth/seed-identity'
import { Id } from '@/../convex/_generated/dataModel'

// ===== TIPOS =====

/**
 * Usuario autenticado con los campos que usamos en las APIs.
 * Incluye el rol desde Convex para validaciones de permisos.
 */
export interface ApiUser {
  id: string
  email: string
  name?: string | null
  role: 'COMPANY' | 'ADMIN'
  profileId: Id<'profiles'> | null
  sessionId: string | null
}

/**
 * Resultado de la verificación de autenticación
 * - Si hay usuario: { user: ApiUser, error: null }
 * - Si no hay usuario: { user: null, error: NextResponse }
 */
export type AuthResult = { user: ApiUser; error: null } | { user: null; error: NextResponse }

/**
 * Rechazo de autorización con el status y el texto que ya viajan al cliente.
 * Los internals se quedan del lado servidor: aquí solo entra copy genérico.
 */
class ApiAuthDenied extends Schema.TaggedError<ApiAuthDenied>()('ApiAuthDenied', {
  status: Schema.Literals([401, 403, 500]),
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
}) {}

function denied(status: 401 | 403 | 500, message: string, code?: string): ApiAuthDenied {
  return new ApiAuthDenied({ status, message, ...(code === undefined ? {} : { code }) })
}

function deniedResponse(error: ApiAuthDenied): NextResponse {
  return NextResponse.json(
    error.code === undefined
      ? { error: error.message }
      : { error: error.message, code: error.code },
    { status: error.status }
  )
}

/** IO de la frontera de auth: cualquier rechazo de promesa entra tipado. */
function apiAuthPromise<A>(
  operation: string,
  run: () => PromiseLike<A>
): Effect.Effect<A, UnexpectedAppError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new UnexpectedAppError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  })
}

// ===== FUNCIÓN PRINCIPAL =====

const requireApiAuthEffect = Effect.fn('ApiAuth.require')(function* () {
  // ===== DEMO MODE: BYPASS AUTH =====
  // ES: En demo devolvemos el usuario actual sin el proveedor real.
  // EN: In demo, return current user without the real provider.
  if (DEV_AUTH_ENABLED) {
    const demoUser = yield* apiAuthPromise('ApiAuth.demoUser', () => getCurrentUser())
    if (!demoUser) {
      return yield* denied(401, 'No autorizado')
    }

    const localAdminKey = localConvexAdminKey(
      {
        NODE_ENV: process.env.NODE_ENV,
        NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
        NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: process.env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY,
      },
      DEV_AUTH_ENABLED
    )

    // `dev:local` usa la fila real que corresponde a la identidad elegida
    // en `/dev-login`. El modo fixture conserva el resultado histórico.
    if (localAdminKey) {
      const configuredUser = devUserFromEmail(demoUser.email)
      if (!configuredUser || configuredUser.role !== demoUser.role) {
        return yield* denied(401, 'No autorizado')
      }

      const identity = localConvexIdentity(configuredUser)
      const currentUserState = yield* apiAuthPromise('ApiAuth.currentUserState', () =>
        getCurrentAuthenticatedUserState({ requireConvexAuth: true })
      )
      if (!currentUserState) {
        return yield* denied(500, 'No se pudo verificar la sesión de autorización')
      }
      if (
        !currentUserState.user ||
        !currentUserState.profile ||
        currentUserState.user.workosUserId !== identity.subject ||
        currentUserState.profile.role !== demoUser.role
      ) {
        return yield* denied(403, 'Perfil no sincronizado o permisos incompletos')
      }
      if (currentUserState.profile.isActive === false) {
        return yield* denied(403, 'Cuenta desactivada')
      }

      return {
        id: identity.subject,
        email: currentUserState.user.email,
        name: currentUserState.user.name ?? demoUser.name,
        role: currentUserState.profile.role,
        profileId: currentUserState.profile._id,
        sessionId: identity.sid ?? null,
      } satisfies ApiUser
    }

    return {
      id: demoUser.id,
      email: demoUser.email,
      name: demoUser.name,
      role: demoUser.role,
      profileId: demoUser.profileId as Id<'profiles'>,
      sessionId: null,
    } satisfies ApiUser
  }

  const session = yield* apiAuthPromise('ApiAuth.session', () => auth())

  if (!session?.user?.id) {
    return yield* denied(401, 'No autorizado')
  }

  const currentUserState = yield* apiAuthPromise('ApiAuth.currentUserState', () =>
    getCurrentAuthenticatedUserState({ requireConvexAuth: true })
  )

  if (!currentUserState) {
    return yield* denied(500, 'No se pudo verificar la sesión de autorización')
  }

  if (!currentUserState.user || !currentUserState.profile) {
    return yield* denied(403, 'Perfil no sincronizado o permisos incompletos')
  }

  if (currentUserState.profile.isActive === false) {
    return yield* denied(403, 'Cuenta desactivada')
  }

  return {
    id: session.user.id,
    email: session.user.email || currentUserState.user.email || '',
    name: session.user.name,
    role: currentUserState.profile.role as 'COMPANY' | 'ADMIN',
    profileId: currentUserState.profile._id as Id<'profiles'>,
    sessionId: session.sessionId,
  } satisfies ApiUser
})

/**
 * Corre la frontera de auth y devuelve el contrato histórico. Un rechazo
 * tipado se convierte en su respuesta; cualquier otra falla se loguea del lado
 * servidor y sale como 500 genérico.
 */
function runAuthResult(effect: Effect.Effect<ApiUser, ApiAuthDenied | UnexpectedAppError>) {
  return runServerEffect(
    effect.pipe(
      Effect.matchCause({
        onSuccess: (user): AuthResult => ({ user, error: null }),
        onFailure: (cause): AuthResult => {
          const failure = Cause.findError(cause)
          if (Result.isSuccess(failure) && failure.success._tag === 'ApiAuthDenied') {
            return { user: null, error: deniedResponse(failure.success) }
          }
          console.error(
            '[AUTH] Error verificando sesión:',
            Cause.prettyErrors(cause)[0] ?? new Error('Unknown auth failure')
          )
          return {
            user: null,
            error: NextResponse.json({ error: 'Error de autenticación' }, { status: 500 }),
          }
        },
      })
    )
  )
}

/**
 * Verifica que el usuario esté autenticado para una ruta de API
 *
 * @returns Objeto con `user` si está autenticado, o `error` (NextResponse 401) si no
 *
 * @example
 * export async function POST(request: NextRequest) {
 *   // Una sola línea reemplaza 9 líneas de boilerplate
 *   const { user, error } = await requireApiAuth()
 *   if (error) return error
 *
 *   // Ahora puedes usar user.id, user.email, etc.
 *   console.log(`Usuario ${user.id} haciendo request`)
 * }
 */
export function requireApiAuth(): Promise<AuthResult> {
  return runAuthResult(requireApiAuthEffect())
}

// ===== VARIANTES ÚTILES =====

/**
 * Igual que requireApiAuth pero requiere un rol específico.
 *
 * @param allowedRoles - Roles permitidos (ej: ['ADMIN', 'COMPANY'])
 *
 * @example
 * const { user, error } = await requireApiAuthWithRole(['ADMIN'])
 * if (error) return error
 */
export function requireApiAuthWithRole(allowedRoles: string[]): Promise<AuthResult> {
  return runAuthResult(
    Effect.gen(function* () {
      const user = yield* requireApiAuthEffect()

      // Verificar que el rol del usuario está en la lista permitida
      if (!allowedRoles.includes(user.role)) {
        return yield* denied(403, 'No tienes permisos para esta acción')
      }

      return user
    })
  )
}

// ===== ADMIN STEP-UP (MFA FRESCA) =====

/**
 * Código estable devuelto cuando falta la re-autenticación fuerte de admin.
 * ES: El cliente puede usarlo para mandar al usuario a re-autenticarse.
 * EN: Clients can use it to send the user through a fresh SSO/Passkey login.
 */
const ADMIN_STEP_UP_REQUIRED_CODE = 'ADMIN_STEP_UP_REQUIRED'

const ADMIN_STEP_UP_REQUIRED_MESSAGE =
  'Se requiere re-autenticación de administrador (SSO o Passkey) reciente'

function adminStepUpDenied(): ApiAuthDenied {
  return denied(403, ADMIN_STEP_UP_REQUIRED_MESSAGE, ADMIN_STEP_UP_REQUIRED_CODE)
}

/**
 * ¿El request trae la cookie de step-up de admin firmada y vigente?
 *
 * Espeja el guard SSR de `requireRole()` (src/lib/auth/session.ts) para que las
 * rutas de API no queden por debajo del control que ya aplican las páginas.
 * En modo demo/dev-auth no hay callback de WorkOS que emita la cookie, así que
 * el guard se considera satisfecho (igual que en `requireRole`).
 */
const hasRecentAdminApiStepUpEffect = Effect.fn('ApiAuth.hasRecentStepUp')(function* () {
  if (DEV_AUTH_ENABLED) {
    return true
  }

  return yield* Effect.gen(function* () {
    const session = yield* apiAuthPromise('ApiAuth.stepUpSession', () => auth())
    if (!session?.user?.id || !session.sessionId) return false
    const cookieStore = yield* apiAuthPromise('ApiAuth.stepUpCookies', () => cookies())
    return isRecentAdminStepUpCookie(cookieStore.get(ADMIN_STEP_UP_COOKIE_NAME)?.value, {
      subject: session.user.id,
      sessionId: session.sessionId,
    })
  }).pipe(Effect.orElseSucceed(() => false))
})

export function hasRecentAdminApiStepUp(): Promise<boolean> {
  return runServerEffect(hasRecentAdminApiStepUpEffect())
}

/**
 * Respuesta 403 estándar cuando falta el step-up de admin.
 */
export function requireAdminApiStepUp(user: ApiUser): Promise<NextResponse | null> {
  return runServerEffect(
    Effect.gen(function* () {
      if (user.role !== 'ADMIN') return null
      const fresh = yield* hasRecentAdminApiStepUpEffect()
      return fresh ? null : deniedResponse(adminStepUpDenied())
    })
  )
}

/**
 * Igual que requireApiAuth pero exige rol ADMIN **y** step-up reciente.
 *
 * Toda ruta bajo `src/app/api/admin/` (y cualquier otra ruta admin-only que mute
 * estado privilegiado) debe usar este helper en vez de comprobar el rol a mano.
 *
 * @example
 * const { user, error } = await requireAdminApiAuth()
 * if (error) return error
 */
export function requireAdminApiAuth(): Promise<AuthResult> {
  return runAuthResult(
    Effect.gen(function* () {
      const user = yield* requireApiAuthEffect()

      if (user.role !== 'ADMIN') {
        return yield* denied(403, 'No autorizado')
      }

      if (!(yield* hasRecentAdminApiStepUpEffect())) {
        return yield* adminStepUpDenied()
      }

      return user
    })
  )
}
