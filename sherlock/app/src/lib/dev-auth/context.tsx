// ============================================================================
// DEV AUTH CONTEXT
// ============================================================================
// Contexto de React para manejar autenticación en desarrollo.
// Simula una sesión local sin la complejidad del proveedor real.
// ============================================================================

'use client'

import { Option, Schema } from 'effect'
import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import { devUserFromEmail, devUserFromId } from './seed-identity'
import {
  type DevUser,
  type DevRole,
  type DevAuthState,
  DevRoleSchema,
  DEV_USERS,
  DEV_AUTH_STORAGE_KEY,
  DEV_AUTH_COOKIE_USER,
  DEV_AUTH_COOKIE_ROLE,
} from './types'

// ============================================================================
// LO QUE GUARDA EL NAVEGADOR
// ============================================================================
// `localStorage` es entrada externa: cualquiera puede editarla desde la consola.
// El chequeo de antes solo pedía `typeof parsed.currentRole === 'string'` y
// después lo metía en el estado como si fuera un `DevRole`, así que el tipo
// mentía: un `currentRole` inventado a mano entraba entero. Acá se decodifica
// contra el vocabulario y un valor que no sea un rol tira la sesión guardada,
// igual que hoy tira una estructura rota.
const StoredDevSessionSchema = Schema.Struct({
  userId: Schema.String,
  currentRole: DevRoleSchema,
})

const decodeStoredDevSession = Schema.decodeUnknownOption(StoredDevSessionSchema)

// ============================================================================
// COOKIE HELPERS (CLIENT-SIDE)
// ============================================================================
// ES: Sincronizamos cookies para que SSR conozca el rol demo.
// EN: Sync cookies so SSR can read demo role/user.
function setDevAuthCookies(userId: string, role: DevRole) {
  // ===== GUARD: SOLO CLIENTE =====
  // ES: Evitar uso de document en SSR.
  // EN: Avoid document usage during SSR.
  if (typeof document === 'undefined') return

  document.cookie = `${DEV_AUTH_COOKIE_USER}=${userId}; path=/; SameSite=Lax; max-age=86400`
  document.cookie = `${DEV_AUTH_COOKIE_ROLE}=${role}; path=/; SameSite=Lax; max-age=86400`
}

function clearDevAuthCookies() {
  // ===== GUARD: SOLO CLIENTE =====
  // ES: Evitar uso de document en SSR.
  // EN: Avoid document usage during SSR.
  if (typeof document === 'undefined') return

  document.cookie = `${DEV_AUTH_COOKIE_USER}=; path=/; SameSite=Lax; max-age=0`
  document.cookie = `${DEV_AUTH_COOKIE_ROLE}=; path=/; SameSite=Lax; max-age=0`
}

// ===== INTERFACE DEL CONTEXTO =====
interface DevAuthContextValue extends DevAuthState {
  // Acciones
  signIn: (email: string) => boolean
  signOut: () => void
  switchRole: (role: DevRole) => void
  // Lista de usuarios disponibles
  availableUsers: DevUser[]
}

// ===== CREAR CONTEXTO =====
const DevAuthContext = createContext<DevAuthContextValue | null>(null)

// ===== INITIAL STATE (MODULE-LEVEL) =====
// ES: Estado inicial seguro para SSR (evita hydration mismatch).
// EN: SSR-safe initial state (prevents hydration mismatch).
const SERVER_SAFE_INITIAL_STATE: DevAuthState = {
  isLoaded: false,
  isSignedIn: false,
  user: null,
  currentRole: null,
}

// ===== PROVIDER =====
interface DevAuthProviderProps {
  children: ReactNode
}

export function DevAuthProvider({ children }: DevAuthProviderProps) {
  // ===== CARGAR ESTADO INICIAL =====
  const loadInitialState = useCallback((): DevAuthState => {
    // Solo en cliente
    if (typeof window === 'undefined') {
      return SERVER_SAFE_INITIAL_STATE
    }

    try {
      const stored = localStorage.getItem(DEV_AUTH_STORAGE_KEY)
      if (stored) {
        // ===== VALIDATE JSON STRUCTURE BEFORE USING =====
        try {
          // First, check if it's valid JSON
          const parsed: unknown = JSON.parse(stored)
          const session = decodeStoredDevSession(parsed)

          if (Option.isNone(session)) {
            console.warn('[DevAuth] Invalid structure in localStorage, clearing')
            localStorage.removeItem(DEV_AUTH_STORAGE_KEY)
            // Fall through to a signed-out state
          } else {
            // Structure is valid, find user
            const user = devUserFromId(session.value.userId)
            if (user) {
              // ===== SYNC COOKIES =====
              // ES: Mantener cookies alineadas con localStorage.
              // EN: Keep cookies aligned with localStorage.
              setDevAuthCookies(user.id, session.value.currentRole)
              return {
                isLoaded: true,
                isSignedIn: true,
                user,
                currentRole: session.value.currentRole,
              }
            } else {
              // User ID not found, clear and continue signed out
              console.warn('[DevAuth] User not found, clearing localStorage')
              localStorage.removeItem(DEV_AUTH_STORAGE_KEY)
            }
          }
        } catch (parseError) {
          // JSON.parse failed - data is corrupted
          console.error('[DevAuth] JSON parse failed, clearing:', parseError)
          localStorage.removeItem(DEV_AUTH_STORAGE_KEY)
          // Fall through to a signed-out state
        }
      }
    } catch (storageError) {
      // localStorage access failed (rare but possible)
      console.error('[DevAuth] localStorage access failed:', storageError)
      // Fall through to a signed-out state
    }

    // No hay sesión guardada
    clearDevAuthCookies()
    return {
      isLoaded: true,
      isSignedIn: false,
      user: null,
      currentRole: null,
    }
  }, [])

  // ===== ESTADO =====
  const [state, setState] = useState<DevAuthState>(SERVER_SAFE_INITIAL_STATE)

  // ===== HIDRATAR EN CLIENTE =====
  // ES: Cargar localStorage solo en cliente para evitar hydration mismatch.
  // EN: Load localStorage client-side only to avoid hydration mismatch.
  useEffect(() => {
    setState(loadInitialState())
  }, [loadInitialState])

  // ===== SIGN IN =====
  // Entra cualquier `*@dev.local`, no solo los dos fijos: `seed:company`
  // fabrica un dueño por empresa y su sesión se reconstruye desde el correo
  // con la misma regla que usó el seed ([F] D1, tarjeta O3-01).
  const signIn = useCallback((email: string): boolean => {
    const user = devUserFromEmail(email)

    if (!user) {
      return false
    }

    // Guardar en localStorage
    localStorage.setItem(
      DEV_AUTH_STORAGE_KEY,
      JSON.stringify({
        userId: user.id,
        currentRole: user.role,
      })
    )
    setDevAuthCookies(user.id, user.role)

    setState({
      isLoaded: true,
      isSignedIn: true,
      user,
      currentRole: user.role,
    })

    return true
  }, [])

  // ===== SIGN OUT =====
  const signOut = useCallback(() => {
    localStorage.removeItem(DEV_AUTH_STORAGE_KEY)
    clearDevAuthCookies()
    setState({
      isLoaded: true,
      isSignedIn: false,
      user: null,
      currentRole: null,
    })
  }, [])

  // ===== SWITCH ROLE (SOLO ADMIN) =====
  const switchRole = useCallback(
    (role: DevRole) => {
      if (!state.user) return

      // Solo admin puede switchear roles
      if (state.user.role !== 'ADMIN') {
        console.warn('[DevAuth] Solo admin puede cambiar de rol')
        return
      }

      // Actualizar localStorage
      localStorage.setItem(
        DEV_AUTH_STORAGE_KEY,
        JSON.stringify({
          userId: state.user.id,
          currentRole: role,
        })
      )
      setDevAuthCookies(state.user.id, role)

      setState((prev) => ({
        ...prev,
        currentRole: role,
      }))
    },
    [state.user]
  )

  // ===== VALOR DEL CONTEXTO =====
  const value: DevAuthContextValue = {
    ...state,
    signIn,
    signOut,
    switchRole,
    availableUsers: DEV_USERS,
  }

  return <DevAuthContext.Provider value={value}>{children}</DevAuthContext.Provider>
}

// ===== HOOK PARA USAR EL CONTEXTO =====
export function useDevAuth(): DevAuthContextValue {
  const context = useContext(DevAuthContext)

  // Si no hay contexto (DEV_AUTH_ENABLED=false), retornar valores seguros no-op
  if (!context) {
    return {
      isLoaded: true,
      isSignedIn: false,
      user: null,
      currentRole: null,
      signIn: () => false,
      signOut: () => {},
      switchRole: () => {},
      availableUsers: [],
    }
  }

  return context
}

// ===== EXPORT DEL CONTEXTO (para casos especiales) =====
