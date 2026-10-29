// ============================================================================
// SESSION.TS - WORKOS SERVER AUTH HELPERS
// ============================================================================
// Este archivo provee funciones helper para autenticación en páginas SSR
// Reemplaza las funciones de NextAuth (requireAuth, requireRole, etc.)
//
// ADMIN VIEW AS FEATURE:
// Los administradores pueden "ver como" COMPANY usando cookies. Cuando un
// admin tiene la cookie `sherlock_view_as` activa, las funciones de este
// módulo respetan ese estado y permiten acceso a páginas de ese rol.
//
// EFFECT: la decisión vive en el generador y el destino de un rechazo viaja
// como error tipado (`AuthRedirect`). El `redirect()` de Next se ejecuta en el
// borde del archivo, donde su throw sigue siendo el throw que Next espera.
// Este helper SÍ redirige — para API routes va `requireApiAuth()`.
// ============================================================================

import { documentsHandoffNonce, withHandoffNonce } from '@/lib/mycroft/handoff-navigation'
import { cache } from 'react'
import { withAuth } from '@workos-inc/authkit-nextjs'
import { Cause, Duration, Effect, Schema } from 'effect'
import { redirect } from '@/i18n/navigation'
import { cookies } from 'next/headers'
import { defaultLocale } from '@/i18n/config'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { getCurrentAuthenticatedUserState } from '@/lib/convex-auth'
import { UnexpectedAppError } from '@/lib/effect/errors'
import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'
import { devUserForRole, devUserFromId } from '@/lib/dev-auth/seed-identity'
import {
  DEV_USERS,
  DEV_AUTH_COOKIE_ROLE,
  DEV_AUTH_COOKIE_USER,
  type DevRole,
  type DevUser,
} from '@/lib/dev-auth/types'
import { DEMO_COMPANY_PROFILE_ID } from '@/lib/dev-auth/demo-data'
import { hasLocalConvexIdentity } from '@/lib/dev-auth/local-convex-identity'
import {
  VIEW_AS_COOKIE_NAME,
  IMPERSONATE_COOKIE_NAME,
  type ViewAsRole,
} from '@/stores/useViewAsStore'
import {
  ADMIN_MFA_REQUIRED_PATH,
  ADMIN_STEP_UP_COOKIE_NAME,
  isRecentAdminStepUpCookie,
} from '@/lib/auth/admin-step-up'
import { homePathForRole } from '@/lib/navigation/home'

// ===== TIPO DE USUARIO AUTENTICADO =====
// Este es el tipo que devuelven las funciones de auth
export interface AuthUser {
  id: string // Provider user ID
  email: string // Email del usuario
  name: string | null // Nombre completo
  image: string | null // URL de avatar
  profileId: string // ID del perfil en Convex (profiles table)
  role: 'COMPANY' | 'ADMIN' // Rol real del usuario
  // ===== VIEW AS (Admin Feature) =====
  effectiveRole: 'COMPANY' | 'ADMIN' // Rol efectivo (respeta viewAs)
  isViewingAs: boolean // true si admin está usando "View As"
  viewAsRole: ViewAsRole // El rol que está "viendo como" (null si no)
  impersonateUserId: string | null // ID del usuario impersonado (null si no)
}

// ===== TIPO DE USUARIO EN BOOTSTRAP (SOFT AUTH) =====
// Forma que devuelve requireWorkosSession(): igual que AuthUser, pero permite
// perfil ausente (needsProfile) y fija los campos de "view as" en su default.
export interface BootstrapAuthUser {
  id: string
  email: string
  name: string | null
  image: string | null
  profileId: string | null
  role: 'COMPANY' | 'ADMIN' | null
  effectiveRole: 'COMPANY' | 'ADMIN' | null
  isViewingAs: false
  viewAsRole: null
  impersonateUserId: null
  needsProfile: boolean
}

/**
 * Destino al que hay que mandar al visitante. Es un error porque corta el
 * generador: ninguna rama puede seguir "autenticada" después de decidirlo.
 */
class AuthRedirect extends Schema.TaggedError<AuthRedirect>()('AuthRedirect', {
  href: Schema.String,
}) {}

function redirectTo(href: string): AuthRedirect {
  return new AuthRedirect({ href })
}

/** Corre la decisión y ejecuta el `redirect()` de Next en el borde. */
async function runAuthDecision<A>(
  effect: Effect.Effect<A, AuthRedirect>,
  locale: string
): Promise<A> {
  const outcome = await runServerEffect(
    effect.pipe(
      Effect.match({
        onSuccess: (value) => ({ _tag: 'value' as const, value }),
        onFailure: (redirection) => ({ _tag: 'redirect' as const, href: redirection.href }),
      })
    )
  )

  if (outcome._tag === 'redirect') {
    redirect({ href: outcome.href, locale })
    return {} as A
  }

  return outcome.value
}

/** Las cookies solo existen dentro de un request: fuera, no hay sesión. */
function readCookieStore() {
  return Effect.tryPromise({
    try: () => cookies(),
    catch: (cause) =>
      new UnexpectedAppError({
        operation: 'Session.cookies',
        message: 'El almacén de cookies no está disponible fuera de un request.',
        cause,
      }),
  })
}

/**
 * La sesión de AuthKit es IO. Sin reintento (un rechazo de sesión es
 * determinista) y con techo de tiempo, para que un WorkOS colgado no cuelgue
 * el render de la página.
 */
const workosSessionEffect = Effect.fn('Session.workosSession')(function* (operation: string) {
  return yield* externalCall({
    service: 'WorkOS',
    operation,
    retries: 0,
    timeout: Duration.seconds(8),
    run: () => withAuth(),
  }).pipe(
    Effect.match({
      onSuccess: (state) => ({ ok: true as const, state }),
      onFailure: (error) => ({ ok: false as const, error }),
    })
  )
})

// ============================================================================
// DEMO AUTH (SERVER) - HELPERS
// ============================================================================
// ES: Bypass de auth en demo para SSR y API routes.
// EN: Auth bypass in demo for SSR and API routes.
const getDemoRoleFromCookies = Effect.fn('Session.demoRoleCookie')(
  function* () {
    const cookieStore = yield* readCookieStore()
    const roleValue = cookieStore.get(DEV_AUTH_COOKIE_ROLE)?.value
    if (roleValue === 'ADMIN' || roleValue === 'COMPANY') {
      return roleValue
    }

    const userId = cookieStore.get(DEV_AUTH_COOKIE_USER)?.value
    const matchedUser = userId ? devUserFromId(userId) : null
    return matchedUser?.role ?? null
  },
  Effect.orElseSucceed(() => null)
)

const getDemoUserFromCookies = Effect.fn('Session.demoUserCookie')(
  function* () {
    const cookieStore = yield* readCookieStore()
    const userId = cookieStore.get(DEV_AUTH_COOKIE_USER)?.value
    return userId ? devUserFromId(userId) : null
  },
  Effect.orElseSucceed(() => null as DevUser | null)
)

// El perfil real del dueño sembrado, una sola lectura por request. Un usuario
// de `seed:company` no tiene fixture: su sala vive en el backend local y
// `resolveDemoCompany` la encuentra por el id de perfil de Convex. Con el id
// fijo del fixture abriría la sala de `company@dev.local`, que es de otro.
const seededDemoProfileId = cache(async (): Promise<string | null> => {
  const state = await getCurrentAuthenticatedUserState({ requireConvexAuth: true })
  return state?.profile?._id ?? null
})

const resolveDemoProfileId = Effect.fn('Session.demoProfileId')(function* (user: DevUser) {
  // Solo el carril sin backend local usa perfiles ficticios. En local,
  // también los dos usuarios fijos resuelven el perfil creado al iniciar sesión.
  if (!hasLocalConvexIdentity() && DEV_USERS.some((fixed) => fixed.id === user.id)) {
    return getFallbackDemoProfileId(user.role)
  }

  // Sin perfil en el backend, cadena vacía y no el fixture: el id del fixture
  // es la llave de la sala de `company@dev.local`, así que caer ahí le abriría
  // a este dueño la sala de otra empresa. Vacío manda la pantalla a
  // /onboarding, que es la verdad — esa sala todavía no existe.
  const profileId = yield* Effect.tryPromise({
    try: () => seededDemoProfileId(),
    catch: (cause) =>
      new UnexpectedAppError({
        operation: 'Session.seededDemoProfileId',
        message: 'El backend local no resolvió el perfil del dueño sembrado.',
        cause,
      }),
  }).pipe(Effect.orElseSucceed(() => null))

  return profileId ?? ''
})

function getFallbackDemoProfileId(role: DevRole): string {
  if (role === 'COMPANY') return DEMO_COMPANY_PROFILE_ID
  return ''
}

const buildDemoAuthUser = Effect.fn('Session.demoUser')(function* () {
  // ===== ROLE + USER =====
  // ES: Solo hay sesión demo si dev-login escribió cookies explícitas.
  // EN: Demo session exists only after dev-login writes cookies explicitly.
  const cookieRole = yield* getDemoRoleFromCookies()
  const cookieUser = yield* getDemoUserFromCookies()
  const realUser =
    cookieUser ?? (cookieRole ? DEV_USERS.find((user) => user.role === cookieRole) : null)

  if (!realUser) {
    return null
  }

  const viewAsRole = realUser.role === 'ADMIN' ? yield* getViewAsCookie() : null
  const impersonateUserId = realUser.role === 'ADMIN' ? yield* getImpersonateCookie() : null
  const roleUser = devUserForRole(realUser, viewAsRole ?? cookieRole)
  const effectiveRole = roleUser.role

  const profileId = yield* resolveDemoProfileId(roleUser)

  return {
    id: roleUser.providerUserId,
    email: roleUser.email,
    name: roleUser.name,
    image: null,
    profileId,
    role: realUser.role,
    // View As fields
    effectiveRole,
    isViewingAs: viewAsRole !== null,
    viewAsRole,
    impersonateUserId,
  } satisfies AuthUser
})

// ============================================================================
// HELPERS PARA COOKIES
// ============================================================================

const getViewAsCookie = Effect.fn('Session.viewAsCookie')(
  function* () {
    const cookieStore = yield* readCookieStore()
    const value = cookieStore.get(VIEW_AS_COOKIE_NAME)?.value
    return value === 'COMPANY' ? (value satisfies ViewAsRole) : null
  },
  Effect.orElseSucceed(() => null as ViewAsRole)
)

const getImpersonateCookie = Effect.fn('Session.impersonateCookie')(
  function* () {
    const cookieStore = yield* readCookieStore()
    return cookieStore.get(IMPERSONATE_COOKIE_NAME)?.value || null
  },
  Effect.orElseSucceed(() => null as string | null)
)

// ===== RESOLVE VIEW AS STATE =====
// Helper para resolver el estado de "view as" de manera centralizada
const resolveViewAsState = Effect.fn('Session.resolveViewAsState')(function* (
  realRole: 'COMPANY' | 'ADMIN'
) {
  // ===== VIEW AS LOGIC =====
  // Si el usuario es ADMIN, revisar si está usando "View As"
  let viewAsRole: ViewAsRole = null
  let impersonateUserId: string | null = null
  let effectiveRole = realRole
  let isViewingAs = false

  if (realRole === 'ADMIN') {
    viewAsRole = yield* getViewAsCookie()
    impersonateUserId = yield* getImpersonateCookie()

    if (viewAsRole) {
      effectiveRole = viewAsRole
      isViewingAs = true
    }
  }

  return {
    viewAsRole,
    impersonateUserId,
    effectiveRole,
    isViewingAs,
  }
})

function isInactiveProfile(profile: { isActive?: boolean }): boolean {
  return profile.isActive === false
}

const hasRecentAdminStepUp = Effect.fn('Session.hasRecentAdminStepUp')(
  function* () {
    const session = yield* workosSessionEffect('authkit.withAuth.stepUp')
    if (!session.ok || !session.state.user || !session.state.sessionId) return false
    const cookieStore = yield* readCookieStore()
    return isRecentAdminStepUpCookie(cookieStore.get(ADMIN_STEP_UP_COOKIE_NAME)?.value, {
      subject: session.state.user.id,
      sessionId: session.state.sessionId,
    })
  },
  Effect.orElseSucceed(() => false)
)

// ===== REQUIRE AUTH =====
// Requiere que el usuario esté autenticado. Si no lo está, redirige.
const requireAuthEffect = Effect.fn('Session.requireAuth')(function* (redirectPath?: string) {
  // ===== DEMO MODE: BYPASS =====
  // ES: Retorna usuario demo sin el proveedor real.
  // EN: Return demo user without the real provider.
  if (DEV_AUTH_ENABLED) {
    const demoUser = yield* buildDemoAuthUser()
    if (demoUser) {
      return demoUser
    }
    return yield* redirectTo('/dev-login')
  }

  const session = yield* workosSessionEffect('authkit.withAuth')
  if (!session.ok) {
    yield* Effect.logWarning('[requireAuth] WorkOS AuthKit session unavailable', session.error)
    return yield* redirectTo(redirectPath || '/sign-in')
  }

  const workosUser = session.state.user
  if (!workosUser) {
    return yield* redirectTo(redirectPath || '/sign-in')
  }

  const email = workosUser.email

  if (!email) {
    // Usuario sin email, redirigir a completar perfil
    return yield* redirectTo('/sign-in?error=no-email')
  }

  const currentUserState = yield* Effect.promise(() =>
    getCurrentAuthenticatedUserState({ requireConvexAuth: true })
  )

  if (!currentUserState) {
    yield* Effect.logError('[requireAuth] Error resolving authenticated Convex user state:', {
      email,
    })
    // No podemos continuar sin perfil de Convex
    return yield* redirectTo('/onboarding?error=profile-fetch-failed')
  }

  const profile = currentUserState.profile

  // Validar que el perfil existe
  // Si no existe, enviar a onboarding para que WorkspaceProvisioning haga el
  // bootstrap vía companies.ensureCompanyWorkspace.
  if (!currentUserState.user || !profile) {
    yield* Effect.logWarning(
      '[requireAuth] User authenticated in WorkOS but no profile in Convex:',
      email
    )
    return yield* redirectTo(
      withHandoffNonce('/onboarding?error=needs-profile', documentsHandoffNonce(redirectPath))
    )
  }

  if (isInactiveProfile(profile)) {
    yield* Effect.logWarning('[requireAuth] Inactive profile attempted to access server route:', {
      email,
      profileId: profile._id,
    })
    return yield* redirectTo('/sign-in?error=account-inactive')
  }

  const realRole = profile.role as 'COMPANY' | 'ADMIN'

  const { viewAsRole, impersonateUserId, effectiveRole, isViewingAs } =
    yield* resolveViewAsState(realRole)

  // Construir usuario autenticado
  return {
    id: workosUser.id,
    email,
    name: [workosUser.firstName, workosUser.lastName].filter(Boolean).join(' ') || null,
    image: null,
    profileId: profile._id,
    role: realRole,
    // View As fields
    effectiveRole,
    isViewingAs,
    viewAsRole,
    impersonateUserId,
  } satisfies AuthUser
})

// Uso: const user = await requireAuth(undefined, locale)
export function requireAuth(
  redirectPath?: string,
  locale: string = defaultLocale
): Promise<AuthUser> {
  return runAuthDecision(requireAuthEffect(redirectPath), locale)
}

// ===== REQUIRE WORKOS SESSION (SOFT BOOTSTRAP) =====
// Como requireAuth(), pero permite que el perfil de Convex todavía no exista.
// Uso exclusivo: el onboarding root, para renderizar <WorkspaceProvisioning />
// en first-login sin caer en loop. Páginas con perfil ya activo siguen usando
// requireAuth().
const requireWorkosSessionEffect = Effect.fn('Session.requireWorkosSession')(function* () {
  // ===== DEMO MODE: BYPASS =====
  if (DEV_AUTH_ENABLED) {
    const demoUser = yield* buildDemoAuthUser()
    if (demoUser) {
      return {
        id: demoUser.id,
        email: demoUser.email,
        name: demoUser.name,
        image: demoUser.image,
        profileId: demoUser.profileId || null,
        role: demoUser.role,
        effectiveRole: demoUser.role,
        isViewingAs: false,
        viewAsRole: null,
        impersonateUserId: null,
        needsProfile: false,
      } satisfies BootstrapAuthUser
    }
    return yield* redirectTo('/dev-login')
  }

  const session = yield* workosSessionEffect('authkit.withAuth')
  if (!session.ok) {
    yield* Effect.logWarning(
      '[requireWorkosSession] WorkOS AuthKit session unavailable',
      session.error
    )
    return yield* redirectTo('/sign-in')
  }

  const workosUser = session.state.user
  if (!workosUser) {
    return yield* redirectTo('/sign-in')
  }

  const email = workosUser.email

  if (!email) {
    return yield* redirectTo('/sign-in?error=no-email')
  }

  const name = [workosUser.firstName, workosUser.lastName].filter(Boolean).join(' ') || null

  const currentUserState = yield* Effect.promise(() =>
    getCurrentAuthenticatedUserState({ requireConvexAuth: true })
  )

  if (!currentUserState) {
    yield* Effect.logError(
      '[requireWorkosSession] Error resolving authenticated Convex user state:',
      {
        email,
      }
    )
    // Comportamiento de recuperación existente: mismo destino que requireAuth
    // cuando falla la resolución del backend (no confundir con perfil ausente).
    return yield* redirectTo('/onboarding?error=profile-fetch-failed')
  }

  const profile = currentUserState.profile

  // ===== BOOTSTRAP: PERFIL AÚN NO EXISTE =====
  // A diferencia de requireAuth(), NO redirigimos — el caller (onboarding root)
  // debe poder renderizar <WorkspaceProvisioning />, que crea perfil y empresa
  // en una sola mutación y aterriza al usuario en su workspace.
  if (!currentUserState.user || !profile) {
    return {
      id: workosUser.id,
      email,
      name,
      image: null,
      profileId: null,
      role: null,
      effectiveRole: null,
      isViewingAs: false,
      viewAsRole: null,
      impersonateUserId: null,
      needsProfile: true,
    } satisfies BootstrapAuthUser
  }

  if (isInactiveProfile(profile)) {
    yield* Effect.logWarning(
      '[requireWorkosSession] Inactive profile attempted to access server route:',
      {
        email,
        profileId: profile._id,
      }
    )
    return yield* redirectTo('/sign-in?error=account-inactive')
  }

  const realRole = profile.role as 'COMPANY' | 'ADMIN'

  return {
    id: workosUser.id,
    email,
    name,
    image: null,
    profileId: profile._id,
    role: realRole,
    effectiveRole: realRole,
    isViewingAs: false,
    viewAsRole: null,
    impersonateUserId: null,
    needsProfile: false,
  } satisfies BootstrapAuthUser
})

// Uso: const user = await requireWorkosSession(locale)
export function requireWorkosSession(locale: string = defaultLocale): Promise<BootstrapAuthUser> {
  return runAuthDecision(requireWorkosSessionEffect(), locale)
}

// ===== REQUIRE ROLE =====
// Requiere que el usuario tenga uno de los roles especificados
//
// ADMIN VIEW AS:
// Si el usuario es ADMIN y está usando "View As", se permite acceso si
// el rol efectivo (viewAs) está en la lista de roles permitidos.
// Esto permite a los admins navegar por la app como si fueran COMPANY.
const requireRoleEffect = Effect.fn('Session.requireRole')(function* (
  allowedRoles: ('COMPANY' | 'ADMIN')[],
  redirectPath?: string
) {
  // ===== DEMO MODE: BYPASS =====
  // ES: Usar rol demo para validación.
  // EN: Use demo role for validation.
  if (DEV_AUTH_ENABLED) {
    const user = yield* requireAuthEffect(redirectPath)
    if (user.role === 'ADMIN') {
      return user
    }
    if (!allowedRoles.includes(user.role)) {
      return yield* redirectTo(homePathForRole(user.role))
    }
    return user
  }

  // Primero verificar autenticación
  const user = yield* requireAuthEffect(redirectPath)

  const currentRole = user.role

  // ===== ADMIN SIEMPRE TIENE ACCESO =====
  // Si el usuario real es ADMIN, siempre permitir acceso (puede ver todo)
  if (currentRole === 'ADMIN') {
    if (!(yield* hasRecentAdminStepUp())) {
      return yield* redirectTo(ADMIN_MFA_REQUIRED_PATH)
    }

    // Actualizar effectiveRole si hay viewAs activo usando el viewAsRole ya presente en el user
    if (user.viewAsRole) {
      user.effectiveRole = user.viewAsRole
      user.isViewingAs = true
    }
    return user
  }

  // ===== VERIFICAR ROL PARA USUARIOS NO-ADMIN =====
  if (!allowedRoles.includes(currentRole)) {
    // De vuelta a su propia casa. El `?error=unauthorized` se fue con
    // `/dashboard`: ninguna superficie lo leía y no había nada que anunciar
    // ([F] 2026-09-07 09:00).
    return yield* redirectTo(homePathForRole(currentRole))
  }

  return user
})

// Uso: const user = await requireRole(['ADMIN', 'COMPANY'], undefined, locale)
export function requireRole(
  allowedRoles: ('COMPANY' | 'ADMIN')[],
  redirectPath?: string,
  locale: string = defaultLocale
): Promise<AuthUser> {
  return runAuthDecision(requireRoleEffect(allowedRoles, redirectPath), locale)
}

// ===== GET CURRENT USER =====
// Obtiene el usuario actual si está autenticado, o null si no
// No redirige, solo devuelve el usuario o null
const getCurrentUserEffect = Effect.fn('Session.getCurrentUser')(function* () {
  // ===== DEMO MODE: BYPASS =====
  // ES: Retorna usuario demo si está activo.
  // EN: Return demo user when active.
  if (DEV_AUTH_ENABLED) {
    return yield* buildDemoAuthUser()
  }

  const session = yield* workosSessionEffect('authkit.withAuth')
  if (!session.ok) {
    yield* Effect.logError('[getCurrentUser] Error:', session.error)
    return null
  }

  const workosUser = session.state.user
  if (!workosUser) {
    return null
  }

  const email = workosUser.email

  if (!email) {
    return null
  }

  const currentUserState = yield* Effect.promise(() =>
    getCurrentAuthenticatedUserState({ requireConvexAuth: true })
  )

  if (!currentUserState) {
    yield* Effect.logError('[getCurrentUser] Error resolving authenticated Convex user state:', {
      email,
    })
    return null
  }

  // Si no hay perfil en Convex, no devolvemos el usuario (requiere onboarding)
  if (!currentUserState.user || !currentUserState.profile) {
    return null
  }

  const profile = currentUserState.profile

  if (isInactiveProfile(profile)) {
    return null
  }

  const realRole = profile.role as 'COMPANY' | 'ADMIN'

  const { viewAsRole, impersonateUserId, effectiveRole, isViewingAs } =
    yield* resolveViewAsState(realRole)

  return {
    id: workosUser.id,
    email,
    name: [workosUser.firstName, workosUser.lastName].filter(Boolean).join(' ') || null,
    image: null,
    profileId: profile._id,
    role: realRole,
    // View As fields
    effectiveRole,
    isViewingAs,
    viewAsRole,
    impersonateUserId,
  } satisfies AuthUser
})

// Uso: const user = await getCurrentUser()
// ===== DEDUP DE REQUEST =====
// ES: cache() evita múltiples llamadas en el mismo request.
// EN: cache() deduplicates within the same request.
export const getCurrentUser = cache((): Promise<AuthUser | null> => {
  return runServerEffect(
    getCurrentUserEffect().pipe(
      Effect.catchCause((cause) =>
        Effect.logError(
          '[getCurrentUser] Error:',
          Cause.prettyErrors(cause)[0] ?? new Error('Unknown session failure')
        ).pipe(Effect.as(null))
      )
    )
  )
})
