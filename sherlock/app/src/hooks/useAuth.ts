// ============================================================================
// HOOK DE AUTENTICACIÓN (WORKOS + DEV BYPASS)
// ============================================================================
// Hook centralizado para acceder a la autenticación.
// - En producción: usa WorkOS AuthKit
// - En desarrollo con BYPASS_AUTH=true: usa DevAuth
//
// ¿Por qué crear un hook wrapper?
// 1. Centraliza la lógica de auth en un solo lugar
// 2. Permite bypass en desarrollo sin tocar código de producción
// 3. Interfaz unificada independiente del proveedor
//
// USO:
// const { user, isLoaded, isSignedIn, signOut } = useAuth()
//
// NOTA TÉCNICA:
// Este archivo re-exporta el hook correcto según DEV_AUTH_ENABLED.
// La selección se hace en build time, evitando cargar código innecesario.
//
// ===== LA FRONTERA DE VERDAD =====
// `useDevAuthImpl` y `useWorkOSAuthImpl` arman el usuario a mano desde su
// propio SDK ya tipado, así que TypeScript garantiza su forma en el punto
// donde nacen. Pero este archivo es el único lugar por el que TODOS esos
// usuarios pasan antes de llegar a los ~40 componentes que llaman `useAuth()`:
// es la frontera real, no la de cada implementación. Un cambio de versión de
// AuthKit o un seed de dev-auth editado a mano puede producir un objeto que
// compila (porque `AuthUser` es estructural) pero ya no es el que el resto de
// la app espera. `AuthUserSchema` decodifica ese punto de unión una vez, con
// el proveedor que sea.
// ============================================================================

'use client'

import { Effect, Schema } from 'effect'

import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { runClientSync } from '@/lib/effect/client-runtime'
// Importamos ambos pero solo usamos uno (tree-shaking elimina el no usado)
import { useDevAuthImpl } from './useDevAuth'
import { useWorkOSAuthImpl } from './useWorkOSAuth'

// ===== FORMA DEL USUARIO =====
// La unión de campos que WorkOS y dev-auth tienen que producir por igual.
// `createdAt` y `updatedAt` los provee el proveedor de auth.
const AuthUserSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  firstName: Schema.NullOr(Schema.String),
  lastName: Schema.NullOr(Schema.String),
  imageUrl: Schema.NullOr(Schema.String),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
})

export type AuthUser = typeof AuthUserSchema.Type

const isAuthUser = Schema.is(AuthUserSchema)

// ===== RETORNO DEL HOOK =====
// No es un schema porque tres de sus campos son funciones y una función no
// tiene forma que decodificar.
export interface UseAuthReturn {
  // Estado de carga
  isLoaded: boolean

  // Estado de autenticación
  isSignedIn: boolean

  // Datos del usuario (null si no está logueado)
  user: AuthUser | null

  // ID del usuario (shorthand común)
  userId: string | null

  // Función para cerrar sesión
  signOut: () => Promise<void>

  // Token JWT para llamadas a API (si lo necesitas)
  getToken: () => Promise<string | null>

  // ===== DEV AUTH EXTRAS =====
  // Indica si estamos en modo dev auth
  isDevMode: boolean
}

// ============================================================================
// HOOK PRINCIPAL
// ============================================================================
// La selección de implementación sigue siendo una constante evaluada en build
// time (el bundler puede seguir haciendo dead-code elimination sobre la que no
// se usa). El wrapper que la envuelve no cambia el contrato: sigue siendo
// `() => UseAuthReturn`, y sigue devolviendo lo que la implementación elegida
// devuelva. Lo único que agrega es la comprobación, en el borde, de que el
// usuario que salió del proveedor todavía tiene la forma que el resto de la
// app asume — nunca lanza, nunca cambia el valor que ve el caller: si el
// proveedor produjera un usuario deforme, es una señal para arreglar el
// proveedor, no un motivo para que 40 componentes se caigan a la vez.
const useSelectedAuthImpl: () => UseAuthReturn = DEV_AUTH_ENABLED
  ? useDevAuthImpl
  : useWorkOSAuthImpl

export function useAuth(): UseAuthReturn {
  const result = useSelectedAuthImpl()

  if (result.user !== null && !isAuthUser(result.user) && process.env.NODE_ENV !== 'production') {
    runClientSync(
      Effect.logWarning(
        'useAuth: el usuario del proveedor no calza con AuthUserSchema',
        result.user
      )
    )
  }

  return result
}
