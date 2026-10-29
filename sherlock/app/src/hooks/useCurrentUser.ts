// ============================================================================
// HOOK: useCurrentUser
// ============================================================================
// Este hook combina WorkOS AuthKit (autenticación) con Convex (datos del usuario).
//
// ¿Por qué necesitamos esto?
// - WorkOS maneja el login/logout y la sesión
// - Convex almacena los datos adicionales del usuario (role, profile, etc.)
// - Este hook une ambos: obtiene el usuario de WorkOS y sus datos de Convex
//
// ===== FUNCIONALIDAD "VIEW AS" (para Admins) =====
// Los administradores pueden "ver como" una empresa sin
// cambiar su rol real en la base de datos. Esto es útil para debugging.
//
// - effectiveRole: El rol que se usa para mostrar la UI (viewAs o real)
// - realRole: El rol real del usuario en la base de datos (siempre)
// - isViewingAs: true si el admin está en modo "View As"
//
// Uso:
// const { user, profile, isLoading, effectiveRole, realRole, isViewingAs } = useCurrentUser();
// ============================================================================

'use client'

import { useMemo } from 'react'
import { Schema } from 'effect'
import { useAuth as useAuthKit } from '@workos-inc/authkit-nextjs/components'
import { useConvexAuth, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { useViewAsStore } from '@/stores/useViewAsStore'
import { useShallow } from 'zustand/shallow'
import type { ViewAsRole } from '@/stores/useViewAsStore'
import type { Id } from '../../convex/_generated/dataModel'
import { useDevAuth, DEV_AUTH_ENABLED } from '@/lib/dev-auth'
import { hasLocalConvexIdentity } from '@/lib/dev-auth/local-convex-identity'
import { devUserForRole } from '@/lib/dev-auth/seed-identity'

// ============================================================================
// TIPOS
// ============================================================================

// ===== EL CATÁLOGO DE ROLES =====
// Esta unión estaba escrita a mano cinco veces en este archivo, otra vez en el
// store de "view as" y otra en el schema de Convex. Cuando se agrega un rol, o
// se cambia en un solo sitio o el sistema queda mintiendo en los demás.
// `Schema.Literals` la define una vez y el tipo se deriva de esa definición.
const UserRoleSchema = Schema.Literals(['COMPANY', 'ADMIN'])
export type UserRole = typeof UserRoleSchema.Type

// ===== EL ROL «VER COMO» SE PREGUNTA, NO SE CONFÍA =====
// `useViewAsStore` se rehidrata de una cookie que el navegador puede editar y
// no la valida al hacerlo: el tipo dice `'COMPANY' | null` y el valor puede ser
// cualquier cosa. La vía del servidor (`parseViewAsCookie`) sí compara contra
// el literal. Acá ese valor entra al rol efectivo de la UI, así que se decide
// igual: tiene que ser un rol del catálogo y además el único que un admin
// puede pintar. ADMIN es el rol del que se sale, así que una cookie con ese
// valor cae al rol real, que sigue viniendo de la base.
const isUserRole = Schema.is(UserRoleSchema)
const VIEW_AS_ROLE: UserRole = 'COMPANY'

function isViewAsRole(value: unknown): boolean {
  return isUserRole(value) && value === VIEW_AS_ROLE
}

// La forma del usuario combinado que las dos implementaciones producen. Nadie
// la decodifica contra un payload externo (cada implementación la arma a mano
// desde su propio proveedor ya tipado), así que queda como tipo plano; los
// campos de Convex quedan opcionales porque se asignan como `undefined`
// explícito mientras la query está en vuelo.
interface CurrentUser {
  // Datos del proveedor de autenticación
  providerUserId: string
  workosUserId?: string
  email: string
  firstName: string | null
  lastName: string | null
  fullName: string | null
  imageUrl: string

  // Datos de Convex (pueden ser undefined si aún no se sincronizó)
  convexId?: string
  role?: UserRole
  isVerified?: boolean
}

// ============================================================================
// DEMO CONSTANTS
// ============================================================================
// ============================================================================
// TIPOS LOCALES
// ============================================================================

interface ViewAsData {
  viewAsRole: ViewAsRole
  impersonateUserId: Id<'profiles'> | null
  setViewAs: (role: 'COMPANY') => void
  clearViewAs: () => void
  setImpersonateUser: (userId: Id<'profiles'>, role: 'COMPANY') => void
  clearImpersonate: () => void
}

// ============================================================================
// HOOK
// ============================================================================

// ===== EXPORT SEGÚN MODO =====
// ES: Seleccionamos la implementación en tiempo de módulo.
// EN: Choose implementation at module evaluation time.
export const useCurrentUser = DEV_AUTH_ENABLED ? useCurrentUserDev : useCurrentUserWorkOS

// ============================================================================
// WORKOS IMPLEMENTATION (PRODUCCIÓN)
// ============================================================================
function useCurrentUserWorkOS() {
  const { user: workosUser, loading } = useAuthKit()
  const isSignedIn = Boolean(workosUser)

  // ES: AuthKit ya tiene el usuario en la hidratación, pero Convex todavía no
  // tiene el token: `ConvexProviderWithAuth` hace `client.setAuth` en un efecto
  // del PADRE, que corre DESPUÉS del efecto de suscripción de este hijo, y lo
  // repite en cada refresh. Suscribirse en esa ventana manda la query sin
  // identidad. `isAuthenticated` es la única señal de que el backend ya validó
  // el token.
  // EN: Gate on the Convex session, not on the AuthKit user.
  const { isAuthenticated: isConvexSessionReady } = useConvexAuth()

  // Resolver user + profile autenticados en una sola query autocontenida.
  const currentUserState = useQuery(
    api.users.getCurrentUserState,
    workosUser && isConvexSessionReady ? {} : 'skip'
  )
  const convexUser = currentUserState?.user ?? null
  const profile = currentUserState?.profile ?? null

  // ===== ESTADOS DE CARGA =====
  // Consideramos que está cargando si:
  // 1. la sesión aún no terminó de cargar
  // 2. El usuario está logueado pero no tenemos el convexUser todavía
  // 3. Tenemos convexUser pero el profile aún está cargando (profile === undefined)
  //
  // NOTA: profile === null significa que no existe (no cargando).
  //       profile === undefined significa que está cargando.
  // Con sesión de AuthKit y sin sesión de Convex la query está en 'skip': eso es
  // seguir cargando, no "usuario anónimo". Si no, la UI parpadea el estado
  // deslogueado entre la hidratación y el `setAuth` del provider.
  const isLoading =
    loading || (isSignedIn && (!isConvexSessionReady || currentUserState === undefined))

  // ===== VIEW AS (para Admins) =====
  // Consolidated selector for viewAs store to avoid multiple subscriptions
  const {
    viewAsRole,
    impersonateUserId,
    setViewAs,
    clearViewAs,
    setImpersonateUser,
    clearImpersonate,
  } = useViewAsStore(
    useShallow((state): ViewAsData => ({
      viewAsRole: state.viewAsRole,
      impersonateUserId: state.impersonateUserId,
      setViewAs: state.setViewAs,
      clearViewAs: state.clearViewAs,
      setImpersonateUser: state.setImpersonateUser,
      clearImpersonate: state.clearImpersonate,
    }))
  )

  // El rol real del usuario (siempre de la base de datos)
  const realRole = convexUser?.role

  // ¿Es admin viendo como otro rol?
  // Solo aplica si: 1) es ADMIN, 2) hay un viewAsRole activo
  const isViewingAs = realRole === 'ADMIN' && isViewAsRole(viewAsRole)

  // ¿Está impersonando un usuario específico?
  const isImpersonating = realRole === 'ADMIN' && impersonateUserId !== null

  // El rol "efectivo" para la UI
  // Si es admin y está en modo "view as", usa viewAsRole
  // Si no, usa el rol real
  const effectiveRole = isViewingAs ? viewAsRole : realRole

  // ===== USUARIO COMBINADO (MEMOIZADO) =====
  // ES: useMemo evita recrear el objeto user si las dependencias no cambian.
  // EN: useMemo prevents recreating user object if dependencies haven't changed.
  const user: CurrentUser | null = useMemo(() => {
    if (!workosUser || !isSignedIn) return null
    const fullName = [workosUser.firstName, workosUser.lastName].filter(Boolean).join(' ') || null
    return {
      providerUserId: workosUser.id,
      workosUserId: workosUser.id,
      email: workosUser.email || '',
      firstName: workosUser.firstName ?? null,
      lastName: workosUser.lastName ?? null,
      fullName,
      imageUrl: '',

      // Datos de Convex
      convexId: convexUser?._id,
      role: convexUser?.role,
      isVerified: profile?.isVerified,
    }
  }, [workosUser, isSignedIn, convexUser?._id, convexUser?.role, profile?.isVerified])

  return {
    // Usuario combinado
    user,

    // Datos de Convex separados (para acceso directo)
    convexUser,
    profile,

    // Estados
    isLoading,
    // Solo la sesión, sin esperar el perfil de Convex. Una superficie que solo
    // pregunta "¿hay sesión?" (el botón de cuenta, el enlace al data room) no
    // tiene por qué quedarse en esqueleto durante el round trip del rol.
    isAuthLoading: loading,
    isSignedIn: isSignedIn ?? false,
    // ¿Convex ya aceptó el token? Quien dispare una query que llama
    // `requireAuth` tiene que esperar a esto, no solo a tener perfil.
    isConvexSessionReady,

    // ===== VIEW AS =====
    // Rol real del usuario (de la DB, nunca cambia por viewAs)
    realRole,
    // Rol efectivo para UI (respeta viewAs si es admin)
    effectiveRole,
    // ¿Está el admin en modo "view as"?
    isViewingAs,
    // El rol que está "viendo como" (null si no está en modo view as)
    viewAsRole,
    // ¿Está impersonando un usuario específico?
    isImpersonating,
    // ID del usuario que está impersonando (null si no)
    impersonateUserId,

    // ===== VIEW AS ACTIONS =====
    setViewAs,
    clearViewAs,
    setImpersonateUser,
    clearImpersonate,

    // ===== HELPERS =====
    // hasRole usa effectiveRole para que la UI respete el "view as"
    hasRole: (role: UserRole) => effectiveRole === role,
    // hasRealRole siempre usa el rol real (para lógica de auth)
    hasRealRole: (role: UserRole) => realRole === role,
    // ¿Es admin? (rol real, no efectivo - para mostrar controles de admin)
    isAdmin: realRole === 'ADMIN',
    needsOnboarding: isSignedIn && convexUser && !convexUser.role,
  }
}

// ============================================================================
// DEV AUTH IMPLEMENTATION (DEMO)
// ============================================================================
function useCurrentUserDev() {
  // ===== DEV AUTH STATE =====
  const devAuth = useDevAuth()
  const {
    viewAsRole,
    impersonateUserId,
    setViewAs,
    clearViewAs,
    setImpersonateUser,
    clearImpersonate,
  } = useViewAsStore(
    useShallow((state): ViewAsData => ({
      viewAsRole: state.viewAsRole,
      impersonateUserId: state.impersonateUserId,
      setViewAs: state.setViewAs,
      clearViewAs: state.clearViewAs,
      setImpersonateUser: state.setImpersonateUser,
      clearImpersonate: state.clearImpersonate,
    }))
  )

  const realRole = devAuth.isSignedIn ? (devAuth.user?.role ?? null) : null
  const activeRole = devAuth.isSignedIn ? (devAuth.currentRole ?? realRole) : null
  const isViewingAs = realRole === 'ADMIN' && isViewAsRole(viewAsRole)
  const isImpersonating = realRole === 'ADMIN' && impersonateUserId !== null
  const demoRole = isViewingAs ? viewAsRole : activeRole
  const profileUser =
    hasLocalConvexIdentity() && devAuth.user ? devUserForRole(devAuth.user, demoRole) : devAuth.user

  // ===== PERFIL DE CONVEX =====
  // El `_id` se lee de Convex, nunca se fabrica. El fallback a
  // `'demo_company_profile'` cubría el primer render (query pendiente) y el
  // «ver como» de un admin: `useNotifications` mandaba esa cadena a queries
  // con `v.id('profiles')` y Convex tiraba ArgumentValidationError. Producción
  // nunca inventa un perfil. En el backend local, cambiar de rol selecciona
  // otra identidad de prueba y lee el perfil real de esa identidad.
  const realProfile = useQuery(
    api.devAuth.getDevProfile,
    devAuth.isSignedIn && profileUser?.email ? { email: profileUser.email } : 'skip'
  )

  const profile = useMemo(() => {
    if (!realProfile) return null
    return {
      _id: realProfile._id,
      role: realProfile.role,
      isVerified: realProfile.isVerified,
      fullName: realProfile.fullName ?? profileUser?.name ?? 'Dev User',
      phone: realProfile.phone ?? null,
      kycStatus: realProfile.kycStatus ?? ('VERIFIED' as const),
    }
  }, [realProfile, profileUser?.name])

  // ===== ESTADOS DE CARGA =====
  // `isAuthLoading` es solo la sesión. `isLoading` también espera el perfil
  // de Convex para no pintar un vacío entre la cookie y `getDevProfile`.
  const isAuthLoading = !devAuth.isLoaded
  const isLoading = isAuthLoading || (devAuth.isSignedIn && realProfile === undefined)

  // ===== USUARIO COMBINADO =====
  const user: CurrentUser | null =
    devAuth.isSignedIn && profileUser && demoRole
      ? {
          providerUserId: profileUser.providerUserId,
          email: profileUser.email,
          firstName: profileUser.firstName,
          lastName: profileUser.lastName,
          fullName: profileUser.name,
          imageUrl: profileUser.imageUrl || '',
          convexId: undefined,
          role: realRole ?? demoRole ?? undefined,
          isVerified: profile?.isVerified,
        }
      : null

  return {
    // Usuario combinado
    user,

    // Datos de Convex separados (para acceso directo)
    convexUser: null,
    profile,

    // Estados
    isLoading,
    isAuthLoading,
    isSignedIn: devAuth.isSignedIn,
    // Dev-auth monta un `ConvexProvider` pelado (sin `ConvexProviderWithAuth`),
    // así que `useConvexAuth()` tiraría aquí. Convex autoriza este camino con
    // BYPASS_AUTH del lado del deployment: no hay token que esperar.
    isConvexSessionReady: true,

    // ===== VIEW AS =====
    realRole: realRole ?? undefined,
    effectiveRole: demoRole ?? undefined,
    isViewingAs,
    viewAsRole,
    isImpersonating,
    impersonateUserId,
    setViewAs,
    clearViewAs,
    setImpersonateUser,
    clearImpersonate,

    // ===== HELPERS =====
    hasRole: (role: UserRole) => demoRole === role,
    hasRealRole: (role: UserRole) => realRole === role,
    isAdmin: realRole === 'ADMIN',
    needsOnboarding: false,
  }
}

// ============================================================================
// EJEMPLO DE USO
// ============================================================================
//
// function MyComponent() {
//   const {
//     user,
//     isLoading,
//     isSignedIn,
//     hasRole,         // Usa effectiveRole (respeta "view as")
//     hasRealRole,     // Siempre usa rol real
//     isAdmin,         // true si rol real es ADMIN
//     isViewingAs,     // true si admin está en modo "view as"
//     effectiveRole,   // El rol para mostrar UI
//     realRole,        // El rol real en DB
//     needsOnboarding,
//   } = useCurrentUser();
//
//   if (isLoading) return <div>Cargando...</div>;
//
//   if (!isSignedIn) return <div>No has iniciado sesión</div>;
//
//   // Para UI: usa hasRole (respeta view as)
//   if (hasRole("COMPANY")) {
//     return <div>Viendo como empresa</div>;
//   }
//
//   // Para auth/permisos reales: usa hasRealRole o isAdmin
//   if (isAdmin) {
//     // Mostrar controles de admin (siempre visibles para admin)
//   }
//
//   // Mostrar indicador de "view as" si está activo
//   if (isViewingAs) {
//     // Banner: "Viendo como {effectiveRole}"
//   }
//
//   return <div>Bienvenido, {user?.fullName}</div>;
// }
//
// ============================================================================
