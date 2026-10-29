import { Schema } from 'effect'

import type { Doc } from '../_generated/dataModel'
import { adminRequired } from './errors'

// El bypass de ADMIN, nombrado en vez de comparado a mano — el mismo patrón
// que ya usan `kycFilter.ts` y `auth.ownership.ts`. `auth-audit.test.ts`
// («pins every named role predicate to its literal») barre convex/** buscando
// cualquier `isXRole = Schema.is(Schema.Literals([...]))` y exige que
// `isAdminRole` quede atado a `['ADMIN']`, así que un rol equivocado acá no
// pasa desapercibido.
const isAdminRole = Schema.is(Schema.Literals(['ADMIN']))

export function requireAdmin(profile: Doc<'profiles'>): void {
  if (!isAdminRole(profile.role)) {
    throw adminRequired()
  }
}
