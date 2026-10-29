import type { Doc, Id } from '../_generated/dataModel'
import { unauthorized } from './errors'

// El bypass de ADMIN se queda escrito como comparación literal a propósito:
// `auth-audit.test.ts` lee el cuerpo de `requireOwnership` y de `requireAdmin`
// y pinnea esa forma exacta, porque es la línea que decide quién entra.

export function requireOwnership(
  profile: Doc<'profiles'>,
  resourceOwnerId: Id<'profiles'>,
  message = 'No tienes permiso para realizar esta acción sobre este recurso'
): void {
  const isAdmin = profile.role === 'ADMIN'
  const isOwner = profile._id === resourceOwnerId

  if (!isAdmin && !isOwner) {
    throw unauthorized(message)
  }
}

export function hasOwnership(profile: Doc<'profiles'>, resourceOwnerId: Id<'profiles'>): boolean {
  return profile.role === 'ADMIN' || profile._id === resourceOwnerId
}
