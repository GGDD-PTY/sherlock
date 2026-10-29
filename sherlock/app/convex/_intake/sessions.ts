import { Effect, Schema } from 'effect'

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { convexPromise, runConvex } from '../_helpers/effect'
import { unauthorized } from '../_helpers/errors'
import { hashIntakeSessionToken, isValidOpaqueIntakeToken } from './crypto'

// Los dos conjuntos de estados que esta puerta reconoce, cada uno con una sola
// definición. `pick` los ata al mismo literal, así que un estado renombrado en
// el schema deja de compilar aquí en vez de caerse del conjunto en silencio.
const IntakeSessionStatus = Schema.Literals(['ACTIVE', 'EXPIRED', 'REVOKED', 'CLAIMED'])
const DeletionProofStatus = IntakeSessionStatus.pick(['ACTIVE', 'EXPIRED', 'REVOKED'])
const isDeletionProofStatus = Schema.is(DeletionProofStatus)

/**
 * Un token que no tiene la forma acuñada, o un secreto de intake ausente, no
 * llega a tocar la tabla: los dos casos devuelven «no hay sesión».
 */
const loadIntakeSessionByToken = Effect.fn('IntakeSessions.loadByToken')(function* (
  ctx: MutationCtx,
  sessionToken: string
) {
  if (!isValidOpaqueIntakeToken(sessionToken)) return null

  const sessionTokenHash = yield* convexPromise(() => hashIntakeSessionToken(sessionToken)).pipe(
    Effect.catchCause(() => Effect.succeed(null))
  )
  if (sessionTokenHash === null) return null

  return yield* convexPromise(() =>
    ctx.db
      .query('intakeSessions')
      .withIndex('by_sessionTokenHash', (q) => q.eq('sessionTokenHash', sessionTokenHash))
      .unique()
  )
})

function hasCurrentAudience(session: Doc<'intakeSessions'>): boolean {
  return Boolean(
    process.env.INTAKE_SERVER_AUDIENCE && session.audience === process.env.INTAKE_SERVER_AUDIENCE
  )
}

function canUseIntakeDeletionProof(session: Doc<'intakeSessions'>): boolean {
  if (!isDeletionProofStatus(session.status)) return false
  return session.status !== 'REVOKED' || session.revokedReason === 'VISITOR_ENDED_ACCESS'
}

const resolveActiveIntakeSessionEffect = Effect.fn('IntakeSessions.resolveActive')(function* (
  ctx: MutationCtx,
  sessionToken: string,
  now: number
) {
  const session = yield* loadIntakeSessionByToken(ctx, sessionToken)
  if (!session || !hasCurrentAudience(session) || session.status !== 'ACTIVE') return null
  if (session.accessExpiresAt <= now || session.absoluteExpiresAt <= now) {
    yield* convexPromise(() => ctx.db.patch(session._id, { status: 'EXPIRED', expiredAt: now }))
    yield* convexPromise(() =>
      ctx.db.insert('intakeEvents', {
        intakeSessionId: session._id,
        type: 'SESSION_EXPIRED',
        createdAt: now,
      })
    )
    return null
  }
  return session
})

export function resolveActiveIntakeSession(
  ctx: MutationCtx,
  sessionToken: string,
  now = Date.now()
): Promise<Doc<'intakeSessions'> | null> {
  return runConvex(resolveActiveIntakeSessionEffect(ctx, sessionToken, now))
}

export const requireActiveIntakeSessionEffect = Effect.fn('IntakeSessions.requireActive')(
  function* (ctx: MutationCtx, sessionToken: string, now: number) {
    const session = yield* resolveActiveIntakeSessionEffect(ctx, sessionToken, now)
    if (!session) return yield* Effect.fail(unauthorized('La sesión temporal no está disponible.'))
    return session
  }
)

export function requireActiveIntakeSession(
  ctx: MutationCtx,
  sessionToken: string,
  now = Date.now()
): Promise<Doc<'intakeSessions'>> {
  return runConvex(requireActiveIntakeSessionEffect(ctx, sessionToken, now))
}

const requireIntakeDeletionAuthorityEffect = Effect.fn('IntakeSessions.requireDeletionAuthority')(
  function* (ctx: MutationCtx, sessionToken: string, now: number) {
    const session = yield* loadIntakeSessionByToken(ctx, sessionToken)
    if (
      !session ||
      !hasCurrentAudience(session) ||
      !canUseIntakeDeletionProof(session) ||
      session.deletionProofExpiresAt <= now
    ) {
      return yield* Effect.fail(
        unauthorized('La autoridad temporal de eliminación no está disponible.')
      )
    }
    return session
  }
)

export function requireIntakeDeletionAuthority(
  ctx: MutationCtx,
  sessionToken: string,
  now = Date.now()
): Promise<Doc<'intakeSessions'>> {
  return runConvex(requireIntakeDeletionAuthorityEffect(ctx, sessionToken, now))
}
