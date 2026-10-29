// ============================================================================
// DEV AUTH HOOK (DESARROLLO)
// ============================================================================
// Implementación de useAuth que usa el sistema de dev auth.
// Este archivo solo se carga cuando DEV_AUTH_ENABLED=true.
//
// ===== LA COSTURA CON EFFECT =====
// El token de desarrollo es un contrato: el backend reconoce el prefijo
// `dev_token_` y saca de ahí el id del usuario. Estaba escrito dentro de una
// función anónima async, sin nombre y sin traza. Ahora es un `Effect.sync` con
// span propio, y el hook lo corre en el borde, dentro de la función que
// devuelve. En una traza aparece como `DevAuth.token` y se ve cuándo se pidió.
// No usa `Effect.fn` porque no hay ningún paso que esperar: un generador sin
// un solo `yield` es un generador de mentira.
//
// Un arreglo de paso: el objeto del usuario se armaba en cada render, con dos
// `new Date()` frescos cada vez. Un consumidor con `useEffect(..., [user])`
// volvía a dispararse en cada pintada aunque nada hubiera cambiado. Ahora el
// mapeo va en `useMemo` con dependencias sobre los campos que sí cambian.
// ============================================================================

'use client'

import { useCallback, useMemo } from 'react'
import { Effect } from 'effect'

import { useDevAuth } from '@/lib/dev-auth'
import { runClientEffect } from '@/lib/effect/client-runtime'
import type { UseAuthReturn, AuthUser } from './useAuth'

/**
 * El token que reconoce el backend en modo desarrollo. Sin usuario no hay
 * token, y eso no es un fallo: es la respuesta correcta a "nadie ha entrado".
 */
const devToken = (userId: string | undefined) =>
  Effect.sync(() => (userId ? `dev_token_${userId}` : null)).pipe(Effect.withSpan('DevAuth.token'))

export function useDevAuthImpl(): UseAuthReturn {
  const devAuth = useDevAuth()

  const devUser = devAuth.user

  // ===== MAPEAR USUARIO DEV A NUESTRO TIPO =====
  const authUser: AuthUser | null = useMemo(() => {
    if (!devUser) return null

    // In dev mode, use current timestamp as defaults since these fields are
    // always required. Se calculan una vez por usuario, no por render.
    const now = new Date()

    return {
      id: devUser.id,
      email: devUser.email,
      name: devUser.name,
      firstName: devUser.firstName,
      lastName: devUser.lastName,
      imageUrl: devUser.imageUrl,
      createdAt: now,
      updatedAt: now,
    }
  }, [devUser])

  // ===== FUNCIÓN DE LOGOUT =====
  const signOut = useCallback(async (): Promise<void> => {
    devAuth.signOut()
  }, [devAuth])

  // ===== FUNCIÓN PARA OBTENER TOKEN (DEV) =====
  const getAuthToken = useCallback(
    (): Promise<string | null> => runClientEffect(devToken(devUser?.id)),
    [devUser?.id]
  )

  return {
    isLoaded: devAuth.isLoaded,
    isSignedIn: devAuth.isSignedIn,
    user: authUser,
    userId: devUser?.id ?? null,
    signOut,
    getToken: getAuthToken,
    isDevMode: true,
  }
}
