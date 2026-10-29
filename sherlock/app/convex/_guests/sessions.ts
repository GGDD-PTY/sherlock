import { Effect, Schema } from 'effect'

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { convexPromise, runConvex } from '../_helpers/effect'
import { enforceRateLimit } from '../_helpers/rateLimit'
import { invalidState } from '../_helpers/errors'
import { createOpaqueGuestSecret, hashGuestSessionToken, hashInvitationHandle } from './crypto'
import { expireGuestInvitationRecord, verifyGuestOtp } from './service'

const GUEST_SESSION_TTL_MS = 30 * 60 * 1000
const MAX_ACTIVE_SESSIONS_PER_INVITATION = 20

// La única compuerta que le queda al invitado de la sala de empresa: el NDA
// aprobado de esa empresa. Las demás se fueron con el subsistema retirado.
const REQUIRED_GATES = ['NDA'] as const

export type GuestSessionResolution =
  | { authenticated: false }
  | {
      authenticated: true
      guestInvitationId: Doc<'guestInvitations'>['_id']
      guestId: string
      principalKey: string
      expiresAt: number
      roomAccessGranted: false
      requiredGates: typeof REQUIRED_GATES
    }

// La forma de un secreto opaco de invitado, en una sola definición.
const OpaqueGuestSecret = Schema.String.pipe(
  Schema.check(Schema.isLengthBetween(32, 256), Schema.isPattern(/^[a-zA-Z0-9_-]+$/))
)
const isOpaqueGuestSecret = Schema.is(OpaqueGuestSecret)

function guestSessionResource(invitation: Doc<'guestInvitations'> | null) {
  if (invitation?.companyId) {
    return { resourceType: 'COMPANY', resourceId: `${invitation.companyId}` }
  }
  return {
    resourceType: 'GUEST_INVITATION',
    resourceId: invitation ? `${invitation._id}` : 'unavailable',
  }
}

/**
 * Un token con forma inválida, o un pepper de invitados ausente, no gasta
 * presupuesto de rate limit ni toca la tabla. El límite sí se aplica —y su
 * `ConvexError` sí sube— en cuanto el token tiene forma de token.
 */
const loadSessionByRawToken = Effect.fn('GuestSessions.loadByRawToken')(function* (
  ctx: MutationCtx,
  sessionToken: string
) {
  if (!isOpaqueGuestSecret(sessionToken)) return null

  const sessionTokenHash = yield* convexPromise(() => hashGuestSessionToken(sessionToken)).pipe(
    Effect.catchCause(() => Effect.succeed(null))
  )
  if (sessionTokenHash === null) return null

  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `guestSession:${sessionTokenHash}`,
      limit: 120,
      windowMs: 15 * 60 * 1000,
    })
  )
  return yield* convexPromise(() =>
    ctx.db
      .query('guestSessions')
      .withIndex('by_sessionTokenHash', (q) => q.eq('sessionTokenHash', sessionTokenHash))
      .unique()
  )
})

const createSession = Effect.fn('GuestSessions.create')(function* (
  ctx: MutationCtx,
  invitation: Doc<'guestInvitations'>,
  input: { now: number; createToken?: () => string }
) {
  const active = yield* convexPromise(() =>
    ctx.db
      .query('guestSessions')
      .withIndex('by_invitation_status', (q) =>
        q.eq('guestInvitationId', invitation._id).eq('status', 'ACTIVE')
      )
      .take(MAX_ACTIVE_SESSIONS_PER_INVITATION + 1)
  )
  if (active.length > MAX_ACTIVE_SESSIONS_PER_INVITATION) {
    return yield* Effect.fail(
      invalidState(
        'La invitación excede el límite seguro de sesiones activas.',
        'GUEST_SESSION_ROTATION_REQUIRED'
      )
    )
  }
  for (const previous of active) {
    yield* convexPromise(() =>
      ctx.db.patch(previous._id, { status: 'ROTATED', rotatedAt: input.now })
    )
  }

  const sessionToken = input.createToken?.() ?? createOpaqueGuestSecret()
  const expiresAt = Math.min(invitation.expiresAt, input.now + GUEST_SESSION_TTL_MS)
  const sessionTokenHash = yield* convexPromise(() => hashGuestSessionToken(sessionToken))
  yield* convexPromise(() =>
    ctx.db.insert('guestSessions', {
      guestInvitationId: invitation._id,
      guestId: invitation.guestId,
      principalKey: invitation.principalKey,
      sessionTokenHash,
      status: 'ACTIVE',
      createdAt: input.now,
      expiresAt,
    })
  )
  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      action: 'GUEST_SESSION_CREATED',
      entityType: 'GUEST_INVITATION',
      entityId: `${invitation._id}`,
      metadata: {
        ...guestSessionResource(invitation),
        details: { guestId: invitation.guestId, roomAccessGranted: false },
      },
    })
  )
  return { sessionToken, expiresAt }
})

const verifyGuestOtpAndCreateSessionEffect = Effect.fn('GuestSessions.verifyOtpAndCreate')(
  function* (
    ctx: MutationCtx,
    input: {
      invitationHandle: string
      challengeToken: string
      code: string
      now: number
      createSessionToken?: () => string
    }
  ) {
    const verification = yield* convexPromise(() => verifyGuestOtp(ctx, input))
    if (!verification.verified) return { verified: false as const }

    const invitationHandleHash = yield* convexPromise(() =>
      hashInvitationHandle(input.invitationHandle)
    ).pipe(Effect.catchCause(() => Effect.succeed(null)))
    if (invitationHandleHash === null) return { verified: false as const }

    const invitation = yield* convexPromise(() =>
      ctx.db
        .query('guestInvitations')
        .withIndex('by_invitationHandleHash', (q) =>
          q.eq('invitationHandleHash', invitationHandleHash)
        )
        .unique()
    )
    if (!invitation || invitation.status !== 'VERIFIED' || invitation.expiresAt <= input.now) {
      return { verified: false as const }
    }

    const session = yield* createSession(ctx, invitation, {
      now: input.now,
      createToken: input.createSessionToken,
    })
    return { verified: true as const, ...session, roomAccessGranted: false as const }
  }
)

export function verifyGuestOtpAndCreateSession(
  ctx: MutationCtx,
  input: {
    invitationHandle: string
    challengeToken: string
    code: string
    now?: number
    createSessionToken?: () => string
  }
): Promise<
  | { verified: false }
  | {
      verified: true
      sessionToken: string
      expiresAt: number
      roomAccessGranted: false
    }
> {
  return runConvex(
    verifyGuestOtpAndCreateSessionEffect(ctx, { ...input, now: input.now ?? Date.now() })
  )
}

export const resolveGuestSessionRecordEffect = Effect.fn('GuestSessions.resolve')(function* (
  ctx: MutationCtx,
  input: { sessionToken: string; now: number }
) {
  const now = input.now
  const session = yield* loadSessionByRawToken(ctx, input.sessionToken)
  if (!session || session.status !== 'ACTIVE') return { authenticated: false as const }

  const invitation = yield* convexPromise(() => ctx.db.get(session.guestInvitationId))
  if (
    !invitation ||
    invitation.guestId !== session.guestId ||
    invitation.principalKey !== session.principalKey ||
    invitation.status !== 'VERIFIED'
  ) {
    yield* convexPromise(() =>
      ctx.db.patch(session._id, {
        status: 'REVOKED',
        revokedAt: now,
        revokedReason: 'INVITATION_UNAVAILABLE',
      })
    )
    return { authenticated: false as const }
  }
  if (session.expiresAt <= now || invitation.expiresAt <= now) {
    yield* convexPromise(() => ctx.db.patch(session._id, { status: 'EXPIRED', expiredAt: now }))
    if (invitation.expiresAt <= now) {
      yield* convexPromise(() => expireGuestInvitationRecord(ctx, { invitation, now }))
    }
    return { authenticated: false as const }
  }

  return {
    authenticated: true as const,
    guestInvitationId: invitation._id,
    guestId: invitation.guestId,
    principalKey: invitation.principalKey,
    expiresAt: session.expiresAt,
    roomAccessGranted: false as const,
    requiredGates: REQUIRED_GATES,
  }
})

export function resolveGuestSessionRecord(
  ctx: MutationCtx,
  input: { sessionToken: string; now?: number }
): Promise<GuestSessionResolution> {
  return runConvex(
    resolveGuestSessionRecordEffect(ctx, {
      sessionToken: input.sessionToken,
      now: input.now ?? Date.now(),
    })
  )
}

const rotateGuestSessionRecordEffect = Effect.fn('GuestSessions.rotate')(function* (
  ctx: MutationCtx,
  input: { sessionToken: string; now: number; createSessionToken?: () => string }
) {
  const now = input.now
  const current = yield* loadSessionByRawToken(ctx, input.sessionToken)
  if (!current || current.status !== 'ACTIVE') return { rotated: false as const }
  const resolution = yield* resolveGuestSessionRecordEffect(ctx, {
    sessionToken: input.sessionToken,
    now,
  })
  if (!resolution.authenticated) return { rotated: false as const }
  const invitation = yield* convexPromise(() => ctx.db.get(resolution.guestInvitationId))
  if (!invitation || invitation.status !== 'VERIFIED') return { rotated: false as const }

  yield* convexPromise(() => ctx.db.patch(current._id, { status: 'ROTATED', rotatedAt: now }))
  const session = yield* createSession(ctx, invitation, {
    now,
    createToken: input.createSessionToken,
  })
  return { rotated: true as const, ...session, roomAccessGranted: false as const }
})

export function rotateGuestSessionRecord(
  ctx: MutationCtx,
  input: { sessionToken: string; now?: number; createSessionToken?: () => string }
): Promise<
  | { rotated: false }
  | { rotated: true; sessionToken: string; expiresAt: number; roomAccessGranted: false }
> {
  return runConvex(rotateGuestSessionRecordEffect(ctx, { ...input, now: input.now ?? Date.now() }))
}

const revokeGuestSessionRecordEffect = Effect.fn('GuestSessions.revoke')(function* (
  ctx: MutationCtx,
  input: { sessionToken: string; now: number }
) {
  const now = input.now
  const session = yield* loadSessionByRawToken(ctx, input.sessionToken)
  if (session?.status === 'ACTIVE') {
    yield* convexPromise(() =>
      ctx.db.patch(session._id, {
        status: 'REVOKED',
        revokedAt: now,
        revokedReason: 'GUEST_LOGOUT',
      })
    )
    const invitation = yield* convexPromise(() => ctx.db.get(session.guestInvitationId))
    yield* convexPromise(() =>
      ctx.db.insert('activityLogs', {
        action: 'GUEST_SESSION_REVOKED',
        entityType: 'GUEST_INVITATION',
        entityId: `${session.guestInvitationId}`,
        metadata: {
          ...guestSessionResource(invitation),
          details: { guestId: session.guestId, roomAccessGranted: false },
        },
      })
    )
  }
  return { revoked: true as const }
})

export function revokeGuestSessionRecord(
  ctx: MutationCtx,
  input: { sessionToken: string; now?: number }
): Promise<{ revoked: true }> {
  return runConvex(revokeGuestSessionRecordEffect(ctx, { ...input, now: input.now ?? Date.now() }))
}
