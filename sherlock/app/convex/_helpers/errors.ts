// ============================================================================
// Sherlock - STANDARDIZED ERROR HANDLING
// ============================================================================
// Centralized error types and factory functions for Convex mutations.
// Provides consistent error codes for client-side handling.
//
// USAGE:
//   import { AppError, ErrorCode, notFound, unauthorized } from './_helpers/errors'
//
//   // Throw with code
//   throw new AppError(ErrorCode.NOT_FOUND, 'Documento no encontrado')
//
//   // Or use factory functions
//   throw notFound('Documento', documentId)
//   throw unauthorized('No tienes permiso para esta acción')
//   throw rateLimitExceeded()
// ============================================================================

import { ConvexError } from 'convex/values'
import { Schema } from 'effect'

// ============================================================================
// ERROR CODES
// ============================================================================
// Standardized codes for client-side error handling.
// Format: CATEGORY_SPECIFIC_ERROR
//
// El catálogo se escribe UNA vez, como `Schema.Literals`. Antes cada código
// vivía dos veces —la llave y su valor— y nada impedía que se separaran:
// `NOT_FOUND: 'NOT_FUND'` compilaba y el cliente recibía un código que no
// existe en ninguna otra parte del código. Desde acá el objeto se deriva de la
// lista, así que la llave y el valor no pueden dejar de coincidir, y el mismo
// catálogo sirve para validar un código en runtime.

const ErrorCodeSchema = Schema.Literals([
  // Authentication (401)
  'AUTH_NOT_AUTHENTICATED',
  'AUTH_SESSION_EXPIRED',

  // Authorization (403)
  'AUTHZ_UNAUTHORIZED',
  'AUTHZ_NOT_OWNER',
  'AUTHZ_ROLE_REQUIRED',
  'AUTHZ_ADMIN_REQUIRED',

  // Not Found (404)
  'NOT_FOUND',
  'USER_NOT_FOUND',
  'PROFILE_NOT_FOUND',
  'COMPANY_NOT_FOUND',
  'DOCUMENT_NOT_FOUND',
  'NDA_NOT_FOUND',
  'SESSION_NOT_FOUND',

  // Conflict (409)
  'CONFLICT_DUPLICATE',
  'CONFLICT_ALREADY_EXISTS',
  'CONFLICT_ALREADY_INTERESTED',

  // Business Logic (422)
  'BUSINESS_INVALID_STATE',
  'BUSINESS_INVALID_OPERATION',
  'BUSINESS_INSUFFICIENT_CREDITS',
  'BUSINESS_NDA_REQUIRED',
  'BUSINESS_MISSING_PROFILE',

  // Rate Limiting (429)
  'RATE_LIMIT_EXCEEDED',

  // Validation (400)
  'VALIDATION_FAILED',
  'VALIDATION_INVALID_INPUT',

  // Server Error (500)
  'INTERNAL_ERROR',
])

export type ErrorCodeType = typeof ErrorCodeSchema.Type

/**
 * El catálogo como objeto, para que `ErrorCode.NOT_FOUND` siga siendo el nombre
 * con el que se lee en los 300 sitios que lo usan. Cada llave conserva su tipo
 * literal, así que un código inventado sigue sin compilar.
 */
function asCatalog<const L extends readonly string[]>(
  literals: L
): { readonly [K in L[number]]: K } {
  const catalog: Record<string, string> = {}
  for (const literal of literals) catalog[literal] = literal
  return catalog as { readonly [K in L[number]]: K }
}

export const ErrorCode = asCatalog(ErrorCodeSchema.literals)

// ============================================================================
// APP ERROR CLASS
// ============================================================================
// Extends ConvexError for automatic serialization to client.
// Includes error code for programmatic handling.

/**
 * Error data structure for AppError.
 * Serialized as a plain object compatible with Convex Value type.
 */
export type AppErrorData = {
  code: string
  message: string
  details?: Record<string, string | number | boolean | null | undefined>
}

/**
 * Standardized application error for Convex.
 * Automatically serialized to client via ConvexError.
 *
 * @example
 * throw new AppError(ErrorCode.NOT_FOUND, 'Documento no encontrado', { documentId: '123' })
 */
export class AppError extends ConvexError<AppErrorData> {
  // El discriminante que pide el canal de error de Effect. `AppError` no puede
  // ser un `Schema.TaggedError` porque ya extiende `ConvexError` —y esa herencia
  // es la que hace que Convex serialice `data` al cliente—, así que el tag se
  // pone a mano. Con él, un programa recupera un fallo esperado con
  // `Effect.catchTag('AppError', ...)` en vez de mirar un `unknown`.
  readonly _tag = 'AppError'

  constructor(
    code: ErrorCodeType,
    message: string,
    details?: Record<string, string | number | boolean | null | undefined>
  ) {
    super({ code, message, details })
  }
}

/**
 * Un usuario o perfil local ausente es la única condición de auth recuperable
 * en el primer login: el cliente puede llegar a Convex antes que el webhook de
 * WorkOS escriba esas filas. Cualquier otro fallo de auth sigue fail-closed.
 */
const isBootstrapRecoverableCode = Schema.is(
  ErrorCodeSchema.pick(['USER_NOT_FOUND', 'PROFILE_NOT_FOUND'])
)

export function isBootstrapRecoverableAuthError(error: unknown): boolean {
  return error instanceof AppError && isBootstrapRecoverableCode(error.data.code)
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================
// Convenience functions for common error patterns.

/**
 * Resource not found error.
 * @example throw notFound('Documento', documentId)
 */
export function notFound(
  resourceType: string,
  resourceId?: string | { toString(): string }
): AppError {
  const idPart = resourceId ? ` (ID: ${resourceId.toString()})` : ''
  return new AppError(ErrorCode.NOT_FOUND, `${resourceType} no encontrado${idPart}`, {
    resourceType,
    resourceId: resourceId?.toString(),
  })
}

/**
 * User-specific not found error.
 */
export function userNotFound(clerkId?: string): AppError {
  return new AppError(
    ErrorCode.USER_NOT_FOUND,
    'Usuario no encontrado en la base de datos. Contacta soporte.',
    { clerkId }
  )
}

/**
 * Profile not found error.
 */
export function profileNotFound(): AppError {
  return new AppError(
    ErrorCode.PROFILE_NOT_FOUND,
    'Perfil no encontrado. Completa tu proceso de onboarding.'
  )
}

/**
 * Not authenticated error.
 */
export function notAuthenticated(): AppError {
  return new AppError(
    ErrorCode.AUTH_NOT_AUTHENTICATED,
    'No autenticado: Debes iniciar sesión para realizar esta acción'
  )
}

/**
 * Unauthorized access error.
 */
export function unauthorized(message?: string): AppError {
  return new AppError(
    ErrorCode.AUTHZ_UNAUTHORIZED,
    message ?? 'No tienes permiso para realizar esta acción'
  )
}

/**
 * Admin required error.
 */
export function adminRequired(): AppError {
  return new AppError(
    ErrorCode.AUTHZ_ADMIN_REQUIRED,
    'No autorizado: Solo administradores pueden realizar esta acción'
  )
}

/**
 * Resource already exists error.
 */
export function alreadyExists(resourceType: string, identifier?: string): AppError {
  const idPart = identifier ? ` (${identifier})` : ''
  return new AppError(ErrorCode.CONFLICT_ALREADY_EXISTS, `${resourceType} ya existe${idPart}`, {
    resourceType,
    identifier,
  })
}

/**
 * Rate limit exceeded error.
 */
export function rateLimitExceeded(retryAfterMs?: number): AppError {
  return new AppError(ErrorCode.RATE_LIMIT_EXCEEDED, 'Límite de solicitudes excedido', {
    retryAfterMs,
  })
}

/**
 * Validation failed error.
 */
export function validationFailed(message: string, field?: string): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, message, { field })
}

/**
 * Invalid business state error.
 */
export function invalidState(message: string, currentState?: string): AppError {
  return new AppError(ErrorCode.BUSINESS_INVALID_STATE, message, { currentState })
}

/**
 * Missing required profile error (e.g., company profile for a room action).
 */
export function missingProfile(profileType: 'company'): AppError {
  const typeLabel = profileType === 'company' ? 'empresa' : profileType
  return new AppError(
    ErrorCode.BUSINESS_MISSING_PROFILE,
    `No tienes un perfil de ${typeLabel}. Crea uno primero.`,
    { profileType }
  )
}
