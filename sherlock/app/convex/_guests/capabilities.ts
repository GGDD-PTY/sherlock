import { Schema } from 'effect'

import { isGuestSecurityConfigured } from './crypto'
import {
  isGuestInitialInvitationDeliveryConfigured,
  isGuestOtpDeliveryConfigured,
} from './delivery'

/**
 * La landing receptora y el email inicial todavía no existen. Mantener este
 * gate en código (no solo en UI) evita crear invitaciones huérfanas y evita
 * exponer el invitationHandle al navegador.
 */
const INITIAL_GUEST_INVITATION_JOURNEY_IMPLEMENTED = true

/**
 * Lo que la sala de invitados le promete a la UI. Antes la forma solo existía
 * como inferencia del `return`, así que un campo que se cayera de aquí se
 * notaba en el navegador y no en el compilador.
 */
const GuestAccessCapabilitiesSchema = Schema.Struct({
  canInvite: Schema.Boolean,
  canExtend: Schema.Boolean,
  canRevoke: Schema.Boolean,
  canManageGroups: Schema.Boolean,
  emailDeliveryConfigured: Schema.Boolean,
  guestWebSessionConfigured: Schema.Boolean,
})

export type GuestAccessCapabilities = typeof GuestAccessCapabilitiesSchema.Type

export function getGuestAccessCapabilities(): GuestAccessCapabilities {
  const emailDeliveryConfigured = isGuestOtpDeliveryConfigured()
  const guestWebSessionConfigured = isGuestSecurityConfigured()
  const initialInvitationConfigured = isGuestInitialInvitationDeliveryConfigured()
  // El schema construye el valor en vez de solo describirlo: un campo que falte
  // o cambie de tipo falla acá y no dos capas más abajo, en la sala del invitado.
  return GuestAccessCapabilitiesSchema.make({
    canInvite:
      INITIAL_GUEST_INVITATION_JOURNEY_IMPLEMENTED &&
      initialInvitationConfigured &&
      emailDeliveryConfigured &&
      guestWebSessionConfigured,
    canExtend: true,
    canRevoke: true,
    canManageGroups: true,
    emailDeliveryConfigured,
    guestWebSessionConfigured,
  })
}
