import { Effect } from 'effect'

import type { MutationCtx } from '../_generated/server'
import { convexPromise, runConvex } from '../_helpers/effect'
import { buildCompanyGuestRoomProjectionEffect, type GuestSafeDocument } from './companyRoom'
import { resolveGuestSessionRecordEffect } from './sessions'

// La única puerta que separa a un invitado de la sala de su empresa: el NDA
// aprobado de esa empresa. Las demás compuertas pertenecían al ciclo de acceso
// por transacción, que salió del árbol con su subsistema ([F] 2026-09-17).
type GuestRoomRequiredGate = 'NDA'

export type GuestRoomProjection =
  | { authenticated: false }
  | {
      authenticated: true
      expiresAt: number
      roomAccessGranted: false
      requiredGates: readonly GuestRoomRequiredGate[]
    }
  | {
      authenticated: true
      expiresAt: number
      roomAccessGranted: true
      requiredGates: readonly []
      room: { title: string }
      documents: GuestSafeDocument[]
      documentsTruncated: boolean
      downloadDeliveryAvailable: false
    }

const buildGuestRoomProjectionEffect = Effect.fn('GuestProjection.buildRoom')(function* (
  ctx: MutationCtx,
  input: { sessionToken: string; now: number }
) {
  const resolution = yield* resolveGuestSessionRecordEffect(ctx, input)
  if (!resolution.authenticated) return { authenticated: false } satisfies GuestRoomProjection

  const invitation = yield* convexPromise(() => ctx.db.get(resolution.guestInvitationId))
  // Sin el sobre `companyRoom` no hay sala que proyectar: la invitación no ancla
  // ningún documento ni ninguna plantilla de NDA, así que falla cerrada.
  if (!invitation?.companyRoom) return { authenticated: false } satisfies GuestRoomProjection

  return yield* buildCompanyGuestRoomProjectionEffect(ctx, input, resolution.expiresAt)
})

export function buildGuestRoomProjection(
  ctx: MutationCtx,
  input: { sessionToken: string; now?: number }
): Promise<GuestRoomProjection> {
  return runConvex(
    buildGuestRoomProjectionEffect(ctx, {
      sessionToken: input.sessionToken,
      now: input.now ?? Date.now(),
    })
  )
}
