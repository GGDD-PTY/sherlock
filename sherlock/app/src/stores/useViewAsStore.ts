// ============================================================================
// STORE: useViewAsStore (View As / Impersonation for Admin)
// ============================================================================
// Este store permite a los administradores "ver como" COMPANY
// sin cambiar su rol real en la base de datos.
//
// ¿Por qué necesitamos esto?
// - Los admins necesitan poder "ponerse en los zapatos" de otros usuarios
// - Para debugging y verificar que la experiencia de usuario es correcta
// - Sin perder acceso al panel de admin (no cambiamos el rol real)
//
// ¿Cómo funciona?
// - El admin sigue siendo ADMIN en la base de datos
// - Pero la UI muestra la experiencia como si fuera COMPANY
// - Un banner visible indica que está en modo "View As"
// - Se guarda en COOKIE para que SSR pueda leerlo también
//
// Uso:
// const { viewAsRole, setViewAs, clearViewAs, isViewingAs } = useViewAsStore();
// ============================================================================

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Id } from '../../convex/_generated/dataModel'

// ============================================================================
// CONSTANTES
// ============================================================================

// Nombre de la cookie para viewAs
export const VIEW_AS_COOKIE_NAME = 'sherlock_view_as'

// Nombre de la cookie para impersonación de usuario específico
export const IMPERSONATE_COOKIE_NAME = 'sherlock_impersonate'

// ============================================================================
// TIPOS
// ============================================================================

// Roles que un admin puede "ver como"
// Nota: No incluye ADMIN porque ya ES admin
export type ViewAsRole = 'COMPANY' | null

// Estado del store
interface ViewAsState {
  // ===== ESTADO =====
  // El rol que el admin está "viendo como" (null = ver como su rol real)
  viewAsRole: ViewAsRole

  // ID del usuario que estamos impersonando (para ver como usuario específico)
  impersonateUserId: Id<'profiles'> | null

  // ===== ACCIONES =====
  // Establecer el rol a "ver como"
  setViewAs: (role: 'COMPANY') => void

  // Volver a ver como su rol real (ADMIN)
  clearViewAs: () => void

  // Toggle: si ya está viendo como ese rol, volver a normal
  toggleViewAs: (role: 'COMPANY') => void

  // Impersonar un usuario específico
  setImpersonateUser: (userId: Id<'profiles'>, role: 'COMPANY') => void

  // Dejar de impersonar
  clearImpersonate: () => void
}

// ============================================================================
// COOKIE HELPERS
// ============================================================================

// Crear un storage personalizado que usa cookies en lugar de sessionStorage
// Esto permite que el servidor (SSR) lea el estado de viewAs
function createCookieStorage() {
  return {
    getItem: (name: string): string | null => {
      if (typeof document === 'undefined') return null

      const cookies = document.cookie.split(';')
      for (const cookie of cookies) {
        const trimmedCookie = cookie.trim()
        const idx = trimmedCookie.indexOf('=')
        if (idx === -1) continue // No equals sign found

        const key = trimmedCookie.substring(0, idx)
        const value = trimmedCookie.substring(idx + 1)

        if (key === name) {
          try {
            return decodeURIComponent(value)
          } catch {
            return null
          }
        }
      }
      return null
    },

    setItem: (name: string, value: string): void => {
      if (typeof document === 'undefined') return

      // Cookie con path=/ para que esté disponible en todas las rutas
      // SameSite=Lax para seguridad
      // No HttpOnly porque necesitamos leerla desde JS
      const encodedValue = encodeURIComponent(value)
      document.cookie = `${name}=${encodedValue}; path=/; SameSite=Lax; max-age=86400` // 24 horas
    },

    removeItem: (name: string): void => {
      if (typeof document === 'undefined') return

      // Eliminar cookie estableciendo max-age=0
      document.cookie = `${name}=; path=/; SameSite=Lax; max-age=0`
    },
  }
}

// ============================================================================
// STORE
// ============================================================================

export const useViewAsStore = create<ViewAsState>()(
  persist(
    (set, get) => ({
      // ===== ESTADO INICIAL =====
      viewAsRole: null,
      impersonateUserId: null,

      // ===== ACCIONES =====

      // Establecer el rol a "ver como"
      setViewAs: (role: 'COMPANY') => {
        set({ viewAsRole: role, impersonateUserId: null })
        // También actualizar cookie directamente para SSR inmediato
        if (typeof document !== 'undefined') {
          document.cookie = `${VIEW_AS_COOKIE_NAME}=${role}; path=/; SameSite=Lax; max-age=86400`
          document.cookie = `${IMPERSONATE_COOKIE_NAME}=; path=/; SameSite=Lax; max-age=0`
        }
      },

      // Volver a ver como su rol real
      clearViewAs: () => {
        set({ viewAsRole: null, impersonateUserId: null })
        // Limpiar cookies
        if (typeof document !== 'undefined') {
          document.cookie = `${VIEW_AS_COOKIE_NAME}=; path=/; SameSite=Lax; max-age=0`
          document.cookie = `${IMPERSONATE_COOKIE_NAME}=; path=/; SameSite=Lax; max-age=0`
        }
      },

      // Toggle: útil para botones que alternan entre modos
      toggleViewAs: (role: 'COMPANY') => {
        const current = get().viewAsRole
        if (current === role) {
          // Ya está viendo como ese rol, volver a normal
          get().clearViewAs()
        } else {
          // Cambiar a ver como ese rol
          get().setViewAs(role)
        }
      },

      // Impersonar un usuario específico
      setImpersonateUser: (userId: Id<'profiles'>, role: 'COMPANY') => {
        set({ impersonateUserId: userId, viewAsRole: role })
        if (typeof document !== 'undefined') {
          document.cookie = `${VIEW_AS_COOKIE_NAME}=${role}; path=/; SameSite=Lax; max-age=86400`
          document.cookie = `${IMPERSONATE_COOKIE_NAME}=${userId}; path=/; SameSite=Lax; max-age=86400`
        }
      },

      // Dejar de impersonar
      clearImpersonate: () => {
        get().clearViewAs()
      },
    }),
    {
      // ===== CONFIGURACIÓN DE PERSISTENCIA =====
      name: 'sherlock-view-as', // Nombre único para el storage

      // Usar cookies en lugar de sessionStorage
      // Esto permite que el servidor lea el estado en SSR
      storage: createJSONStorage(() => createCookieStorage()),

      // Solo persistir viewAsRole e impersonateUserId, no las funciones
      partialize: (state) => ({
        viewAsRole: state.viewAsRole,
        impersonateUserId: state.impersonateUserId,
      }),
    }
  )
)

// ============================================================================
// SERVER-SIDE HELPERS
// ============================================================================

// Helper para leer el viewAs desde cookies en el servidor (SSR)
// Uso: const viewAs = getViewAsFromCookies(cookies);
export function parseViewAsCookie(cookieHeader: string | null): ViewAsRole {
  if (!cookieHeader) return null

  const cookies = cookieHeader.split(';')
  for (const cookie of cookies) {
    const trimmedCookie = cookie.trim()
    const idx = trimmedCookie.indexOf('=')
    if (idx === -1) continue // No equals sign found

    const key = trimmedCookie.substring(0, idx)
    const value = trimmedCookie.substring(idx + 1)

    if (key === VIEW_AS_COOKIE_NAME) {
      const decoded = decodeURIComponent(value || '')
      if (decoded === 'COMPANY') {
        return decoded
      }
    }
  }
  return null
}
