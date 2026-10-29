import { Effect } from 'effect'

import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { convexPromise, convexSync, runConvex } from '../_helpers/effect'
import { enforceRateLimit } from '../_helpers/rateLimit'
import { invalidState } from '../_helpers/errors'
import {
  constantTimeHexEqual,
  createGuestOtp,
  createOpaqueGuestSecret,
  hashChallengeToken,
  hashGuestEmail,
  hashGuestOtp,
  hashInvitationHandle,
  normalizeGuestEmail,
} from './crypto'

const GUEST_OTP_TTL_MS = 10 * 60 * 1000
const GUEST_OTP_COOLDOWN_MS = 60 * 1000
export const GUEST_OTP_MAX_ATTEMPTS = 5
const MAX_REVOCATIONS_PER_INVITATION = 100

export type GenericOtpChallengeResponse = {
  accepted: true
  challengeToken: string
  expiresInSeconds: number
}

export type OtpDeliveryEnvelope = {
  destination: string
  code: string
  maskedDestination: string
  expiresAt: number
}

export function genericChallengeResponse(
  challengeToken = createOpaqueGuestSecret()
): GenericOtpChallengeResponse {
  return {
    accepted: true,
    challengeToken,
    expiresInSeconds: GUEST_OTP_TTL_MS / 1000,
  }
}

/**
 * Expira una invitación y toda autoridad derivada en una sola transacción
 * acotada. Se mantiene separado de la verificación OTP: controlar el buzón
 * nunca activa ni conserva acceso cuando la invitación ya venció.
 */
const expireGuestInvitationRecordEffect = Effect.fn('GuestService.expireInvitation')(function* (
  ctx: MutationCtx,
  input: {
    invitation: Doc<'guestInvitations'>
    now: number
  }
) {
  if (input.invitation.status === 'REVOKED') return input.invitation

  const invitationId = input.invitation._id
  const [challengesProbe, sessionsProbe] = yield* convexPromise(() =>
    Promise.all([
      ctx.db
        .query('guestOtpChallenges')
        .withIndex('by_invitation_status', (q) =>
          q.eq('guestInvitationId', invitationId).eq('status', 'ISSUED')
        )
        .take(MAX_REVOCATIONS_PER_INVITATION + 1),
      ctx.db
        .query('guestSessions')
        .withIndex('by_invitation_status', (q) =>
          q.eq('guestInvitationId', invitationId).eq('status', 'ACTIVE')
        )
        .take(MAX_REVOCATIONS_PER_INVITATION + 1),
    ])
  )
  if (
    challengesProbe.length > MAX_REVOCATIONS_PER_INVITATION ||
    sessionsProbe.length > MAX_REVOCATIONS_PER_INVITATION
  ) {
    return yield* Effect.fail(
      invalidState(
        'La expiración excede el límite seguro de una sola transacción.',
        'EXPIRATION_BATCH_REQUIRED'
      )
    )
  }

  yield* convexPromise(() => ctx.db.patch(invitationId, { status: 'EXPIRED' }))
  for (const challenge of challengesProbe) {
    yield* convexPromise(() => ctx.db.patch(challenge._id, { status: 'EXPIRED' }))
  }
  for (const session of sessionsProbe) {
    yield* convexPromise(() =>
      ctx.db.patch(session._id, {
        status: 'EXPIRED',
        expiredAt: input.now,
      })
    )
  }
  const updated = yield* convexPromise(() => ctx.db.get(invitationId))
  if (!updated) {
    return yield* Effect.fail(
      invalidState('No se pudo expirar la invitación.', 'INVITATION_MISSING')
    )
  }
  return updated
})

export function expireGuestInvitationRecord(
  ctx: MutationCtx,
  input: {
    invitation: Doc<'guestInvitations'>
    now: number
  }
): Promise<Doc<'guestInvitations'>> {
  return runConvex(expireGuestInvitationRecordEffect(ctx, input))
}

export function guestPrincipalKey(guestId: string): string {
  return `GUEST:${guestId}`
}

const prepareOtpChallengeForDeliveryEffect = Effect.fn('GuestService.prepareOtpChallenge')(
  function* (
    ctx: MutationCtx,
    input: {
      invitationHandle: string
      email: string
      now: number
      createToken?: () => string
      createCode?: () => string
      createSalt?: () => string
    }
  ) {
    const now = input.now
    const fakeResponse = genericChallengeResponse(input.createToken?.())

    // Email inválido, secreto ausente o presupuesto agotado dan exactamente la
    // misma respuesta genérica: nada de lo que pase aquí puede decirle al
    // navegador si el buzón existe.
    const admitted = yield* Effect.gen(function* () {
      const normalizedEmail = yield* convexSync(() => normalizeGuestEmail(input.email))
      const [invitationHandleHash, emailHash] = yield* convexPromise(() =>
        Promise.all([hashInvitationHandle(input.invitationHandle), hashGuestEmail(normalizedEmail)])
      )
      yield* convexPromise(() =>
        Promise.all([
          enforceRateLimit(ctx, {
            key: `guestOtpHandle:${invitationHandleHash}`,
            limit: 6,
            windowMs: 15 * 60 * 1000,
          }),
          enforceRateLimit(ctx, {
            key: `guestOtpEmail:${emailHash}`,
            limit: 6,
            windowMs: 15 * 60 * 1000,
          }),
        ])
      )
      return { normalizedEmail, invitationHandleHash, emailHash }
    }).pipe(Effect.catchCause(() => Effect.succeed(null)))

    if (!admitted) {
      return { response: fakeResponse, delivery: null as OtpDeliveryEnvelope | null }
    }

    const invitation = yield* convexPromise(() =>
      ctx.db
        .query('guestInvitations')
        .withIndex('by_invitationHandleHash', (q) =>
          q.eq('invitationHandleHash', admitted.invitationHandleHash)
        )
        .unique()
    )
    if (
      !invitation ||
      invitation.emailHash !== admitted.emailHash ||
      (invitation.status !== 'PENDING' && invitation.status !== 'VERIFIED') ||
      invitation.expiresAt <= now
    ) {
      if (
        (invitation?.status === 'PENDING' || invitation?.status === 'VERIFIED') &&
        invitation.expiresAt <= now
      ) {
        yield* expireGuestInvitationRecordEffect(ctx, { invitation, now })
      }
      return { response: fakeResponse, delivery: null as OtpDeliveryEnvelope | null }
    }

    const recent = yield* convexPromise(() =>
      ctx.db
        .query('guestOtpChallenges')
        .withIndex('by_invitation_issuedAt', (q) => q.eq('guestInvitationId', invitation._id))
        .order('desc')
        .first()
    )
    if (recent && recent.cooldownUntil > now) {
      // El challenge sigue ISSUED, pero el texto del token no está en la base.
      // Devolver el que el navegador presenta solo cuando el email coincide
      // diría si ese buzón es el invitado. La respuesta es la genérica de
      // siempre, igual que un email que no corresponde, y el código del correo
      // sigue verificando contra el token que ya se guardó.
      return { response: fakeResponse, delivery: null as OtpDeliveryEnvelope | null }
    }

    const outstanding = yield* convexPromise(() =>
      ctx.db
        .query('guestOtpChallenges')
        .withIndex('by_invitation_status', (q) =>
          q.eq('guestInvitationId', invitation._id).eq('status', 'ISSUED')
        )
        .take(20)
    )
    for (const challenge of outstanding) {
      yield* convexPromise(() =>
        ctx.db.patch(challenge._id, {
          status: challenge.expiresAt <= now ? 'EXPIRED' : 'LOCKED',
          lockedAt: challenge.expiresAt <= now ? undefined : now,
        })
      )
    }

    const challengeToken = input.createToken?.() ?? createOpaqueGuestSecret()
    const code = input.createCode?.() ?? createGuestOtp()
    const salt = input.createSalt?.() ?? createOpaqueGuestSecret()
    const expiresAt = now + GUEST_OTP_TTL_MS
    const [challengeTokenHash, otpHash] = yield* convexPromise(() =>
      Promise.all([hashChallengeToken(challengeToken), hashGuestOtp(salt, code)])
    )
    yield* convexPromise(() =>
      ctx.db.insert('guestOtpChallenges', {
        guestInvitationId: invitation._id,
        guestId: invitation.guestId,
        challengeTokenHash,
        otpSalt: salt,
        otpHash,
        status: 'ISSUED',
        attempts: 0,
        maxAttempts: GUEST_OTP_MAX_ATTEMPTS,
        issuedAt: now,
        expiresAt,
        cooldownUntil: now + GUEST_OTP_COOLDOWN_MS,
      })
    )

    return {
      response: genericChallengeResponse(challengeToken),
      delivery: {
        destination: admitted.normalizedEmail,
        code,
        maskedDestination: invitation.emailMasked,
        expiresAt,
      } as OtpDeliveryEnvelope | null,
    }
  }
)

export function prepareOtpChallengeForDelivery(
  ctx: MutationCtx,
  input: {
    invitationHandle: string
    email: string
    now?: number
    createToken?: () => string
    createCode?: () => string
    createSalt?: () => string
  }
): Promise<{
  response: GenericOtpChallengeResponse
  delivery: OtpDeliveryEnvelope | null
}> {
  return runConvex(
    prepareOtpChallengeForDeliveryEffect(ctx, { ...input, now: input.now ?? Date.now() })
  )
}

const verifyGuestOtpEffect = Effect.fn('GuestService.verifyOtp')(function* (
  ctx: MutationCtx,
  input: {
    invitationHandle: string
    challengeToken: string
    code: string
    now: number
  }
) {
  const now = input.now
  const hashes = yield* Effect.gen(function* () {
    const [invitationHandleHash, challengeTokenHash] = yield* convexPromise(() =>
      Promise.all([
        hashInvitationHandle(input.invitationHandle),
        hashChallengeToken(input.challengeToken),
      ])
    )
    yield* convexPromise(() =>
      enforceRateLimit(ctx, {
        key: `guestOtpVerify:${challengeTokenHash}`,
        limit: 8,
        windowMs: 15 * 60 * 1000,
      })
    )
    return { invitationHandleHash, challengeTokenHash }
  }).pipe(Effect.catchCause(() => Effect.succeed(null)))

  if (!hashes) return { verified: false }

  const [invitation, challenge] = yield* convexPromise(() =>
    Promise.all([
      ctx.db
        .query('guestInvitations')
        .withIndex('by_invitationHandleHash', (q) =>
          q.eq('invitationHandleHash', hashes.invitationHandleHash)
        )
        .unique(),
      ctx.db
        .query('guestOtpChallenges')
        .withIndex('by_challengeTokenHash', (q) =>
          q.eq('challengeTokenHash', hashes.challengeTokenHash)
        )
        .unique(),
    ])
  )
  if (
    !invitation ||
    !challenge ||
    challenge.guestInvitationId !== invitation._id ||
    (invitation.status !== 'PENDING' && invitation.status !== 'VERIFIED') ||
    invitation.expiresAt <= now ||
    challenge.status !== 'ISSUED'
  ) {
    if (
      (invitation?.status === 'PENDING' || invitation?.status === 'VERIFIED') &&
      invitation.expiresAt <= now
    ) {
      yield* expireGuestInvitationRecordEffect(ctx, { invitation, now })
    }
    return { verified: false }
  }
  if (challenge.expiresAt <= now) {
    yield* convexPromise(() => ctx.db.patch(challenge._id, { status: 'EXPIRED' }))
    return { verified: false }
  }
  if (!/^\d{6}$/.test(input.code)) return { verified: false }

  const expected = yield* convexPromise(() => hashGuestOtp(challenge.otpSalt, input.code))
  if (!constantTimeHexEqual(expected, challenge.otpHash)) {
    const attempts = challenge.attempts + 1
    yield* convexPromise(() =>
      ctx.db.patch(challenge._id, {
        attempts,
        status: attempts >= challenge.maxAttempts ? 'LOCKED' : 'ISSUED',
        lockedAt: attempts >= challenge.maxAttempts ? now : undefined,
      })
    )
    return { verified: false }
  }

  yield* convexPromise(() =>
    ctx.db.patch(challenge._id, {
      status: 'USED',
      attempts: challenge.attempts + 1,
      consumedAt: now,
    })
  )
  if (invitation.status === 'PENDING') {
    yield* convexPromise(() =>
      ctx.db.patch(invitation._id, { status: 'VERIFIED', verifiedAt: now })
    )
  }
  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      action: 'GUEST_EMAIL_VERIFIED',
      entityType: 'GUEST_INVITATION',
      entityId: `${invitation._id}`,
      metadata: {
        resourceType: 'COMPANY',
        resourceId: `${invitation.companyId}`,
        details: { guestId: invitation.guestId, roomAccessGranted: false },
      },
    })
  )
  return { verified: true }
})

export function verifyGuestOtp(
  ctx: MutationCtx,
  input: {
    invitationHandle: string
    challengeToken: string
    code: string
    now?: number
  }
): Promise<{ verified: boolean }> {
  return runConvex(verifyGuestOtpEffect(ctx, { ...input, now: input.now ?? Date.now() }))
}

const revokeGuestInvitationRecordEffect = Effect.fn('GuestService.revokeInvitation')(function* (
  ctx: MutationCtx,
  input: {
    invitation: Doc<'guestInvitations'>
    actorProfileId: Id<'profiles'>
    reason: string
    now: number
  }
) {
  if (input.invitation.status === 'REVOKED') return input.invitation

  const invitationId = input.invitation._id
  const [challengesProbe, sessionsProbe] = yield* convexPromise(() =>
    Promise.all([
      ctx.db
        .query('guestOtpChallenges')
        .withIndex('by_invitation_status', (q) =>
          q.eq('guestInvitationId', invitationId).eq('status', 'ISSUED')
        )
        .take(MAX_REVOCATIONS_PER_INVITATION + 1),
      ctx.db
        .query('guestSessions')
        .withIndex('by_invitation_status', (q) =>
          q.eq('guestInvitationId', invitationId).eq('status', 'ACTIVE')
        )
        .take(MAX_REVOCATIONS_PER_INVITATION + 1),
    ])
  )
  if (
    challengesProbe.length > MAX_REVOCATIONS_PER_INVITATION ||
    sessionsProbe.length > MAX_REVOCATIONS_PER_INVITATION
  ) {
    return yield* Effect.fail(
      invalidState(
        'La revocación excede el límite seguro de una sola transacción.',
        'REVOCATION_BATCH_REQUIRED'
      )
    )
  }

  yield* convexPromise(() =>
    ctx.db.patch(invitationId, {
      status: 'REVOKED',
      revokedAt: input.now,
      revokedByProfileId: input.actorProfileId,
      revokedReason: input.reason,
    })
  )
  for (const challenge of challengesProbe) {
    yield* convexPromise(() =>
      ctx.db.patch(challenge._id, { status: 'LOCKED', lockedAt: input.now })
    )
  }
  for (const session of sessionsProbe) {
    yield* convexPromise(() =>
      ctx.db.patch(session._id, {
        status: 'REVOKED',
        revokedAt: input.now,
        revokedReason: input.reason,
      })
    )
  }
  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      userId: input.actorProfileId,
      action: 'GUEST_INVITATION_REVOKED',
      entityType: 'GUEST_INVITATION',
      entityId: `${invitationId}`,
      metadata: {
        resourceType: 'COMPANY',
        resourceId: `${input.invitation.companyId}`,
        details: {
          guestId: input.invitation.guestId,
          sessionsRevoked: sessionsProbe.length,
        },
      },
    })
  )

  const updated = yield* convexPromise(() => ctx.db.get(invitationId))
  if (!updated) {
    return yield* Effect.fail(
      invalidState('No se pudo revocar la invitación.', 'INVITATION_MISSING')
    )
  }
  return updated
})

export function revokeGuestInvitationRecord(
  ctx: MutationCtx,
  input: {
    invitation: Doc<'guestInvitations'>
    actorProfileId: Id<'profiles'>
    reason: string
    now: number
  }
): Promise<Doc<'guestInvitations'>> {
  return runConvex(revokeGuestInvitationRecordEffect(ctx, input))
}
