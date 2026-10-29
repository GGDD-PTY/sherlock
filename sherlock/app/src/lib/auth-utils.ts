// ============================================================================
// SHARED AUTH UTILITIES
// ============================================================================
// Tipos y funciones compartidas para el flujo de autenticación.
// ============================================================================

import { Effect, Schema } from 'effect'

import { decodeBoundary } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'

/**
 * Parámetros de búsqueda para las páginas de auth
 * En Next.js 16+, searchParams es una Promise que debe ser "awaited"
 */
export type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

// El valor llega del query string, así que es entrada del browser: o es texto,
// o es la lista que Next arma con valores repetidos. Cualquier otra forma no
// se adivina, se descarta.
const redirectParamSchema = Schema.Union([Schema.String, Schema.Array(Schema.String)])

const getRedirectParamEffect = Effect.fn('AuthUtils.redirectParam')(function* (
  params: SearchParams
) {
  // Esperamos a que se resuelva la Promise de searchParams
  const resolvedParams = yield* Effect.promise(() => params)

  // Intentamos obtener el parámetro de redirección (varios nombres posibles)
  const redirect =
    resolvedParams.returnTo ||
    resolvedParams.redirect_url ||
    resolvedParams.redirectTo ||
    resolvedParams.after_sign_in_url ||
    resolvedParams.after_sign_up_url

  if (redirect === undefined) return undefined

  const decoded = yield* decodeBoundary(
    'authUtils.redirectParam',
    redirectParamSchema,
    redirect
  ).pipe(Effect.orElseSucceed(() => null))
  if (decoded === null) return undefined

  // Si es un array (puede pasar con múltiples valores), tomamos el primero
  return typeof decoded === 'string' ? decoded : decoded[0]
})

/**
 * Extrae el parámetro de redirección de los searchParams
 * @param params - SearchParams del request (Promise en Next.js 16+)
 * @returns El valor de 'returnTo', 'redirect_url', 'redirectTo' o aliases heredados
 *
 * IMPORTANTE: En Next.js 16, searchParams es una Promise.
 * Esta función debe ser llamada con await en componentes async.
 *
 * Ejemplo:
 * const redirectParam = await getRedirectParam(searchParams);
 */
export function getRedirectParam(params: SearchParams): Promise<string | undefined> {
  return runServerEffect(getRedirectParamEffect(params))
}
