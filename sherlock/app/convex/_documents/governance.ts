import { v } from 'convex/values'
import { Effect } from 'effect'

import type { Id } from '../_generated/dataModel'
import { mutation, query, type MutationCtx, type QueryCtx } from '../_generated/server'
import { requireAdmin } from '../_helpers/auth'
import { requireAuthEffect } from '../_helpers/auth.identity'
import { logAdminAction } from '../_helpers/auditLog'
import { convexPromise, convexSync, runConvex } from '../_helpers/effect'
import type { AppError } from '../_helpers/errors'
import { invalidState, notFound, unauthorized, validationFailed } from '../_helpers/errors'
import { enforceRateLimit } from '../_helpers/rateLimit'
import {
  adminVdrCapabilityValidator,
  requireAdminVdrCapability,
  withoutAdminVdrCapability,
} from '../_adminVdr/capability'
import { adminVdrTarget } from '../_adminVdr/capabilityFormat'
import { requireCompanyOwnerOrAdminEffect } from './shared'

const HOLD_REASON_MIN_LENGTH = 10
const HOLD_REASON_MAX_LENGTH = 1_000
const HOLD_REFERENCE_MAX_LENGTH = 200

function validateReason(value: string, field: string): string {
  const reason = value.trim()
  if (reason.length < HOLD_REASON_MIN_LENGTH || reason.length > HOLD_REASON_MAX_LENGTH) {
    throw validationFailed(
      `La razón debe tener entre ${HOLD_REASON_MIN_LENGTH} y ${HOLD_REASON_MAX_LENGTH} caracteres.`,
      field
    )
  }
  return reason
}

const getGovernanceStatusProgram = Effect.fn('DocumentGovernance.status')(function* (
  ctx: QueryCtx,
  args: { documentId: Id<'documents'> }
) {
  const auth = yield* requireAuthEffect(ctx)
  const { profile } = auth
  const denied = 'No tienes permiso para ver la gobernanza de este documento.'
  const document = yield* convexPromise(() => ctx.db.get(args.documentId))
  if (!document) {
    return yield* Effect.fail(
      profile.role === 'ADMIN' ? notFound('Documento', args.documentId) : unauthorized(denied)
    )
  }
  const company = yield* convexPromise(() => ctx.db.get(document.companyId))
  if (!company) return yield* Effect.fail(unauthorized(denied))
  yield* requireCompanyOwnerOrAdminEffect(ctx, auth, company, denied)

  const activeHold = yield* convexPromise(() =>
    ctx.db
      .query('documentLegalHolds')
      .withIndex('by_document_status', (q) =>
        q.eq('documentId', document._id).eq('status', 'ACTIVE')
      )
      .first()
  )

  return {
    lifecycleStatus: document.lifecycleStatus ?? 'ACTIVE',
    archivedAt: document.archivedAt,
    legalHold: activeHold
      ? {
          holdId: activeHold._id,
          status: activeHold.status,
          placedAt: activeHold.placedAt,
          ...(profile.role === 'ADMIN'
            ? {
                reason: activeHold.reason,
                externalReference: activeHold.externalReference,
              }
            : {}),
        }
      : null,
  }
})

export const getGovernanceStatus = query({
  args: { documentId: v.id('documents') },
  handler: (ctx, args) => runConvex(getGovernanceStatusProgram(ctx, args)),
})

type PlaceLegalHoldArgs = {
  adminCapability?: string
  documentId: Id<'documents'>
  reason: string
  externalReference?: string
}

const placeLegalHoldProgram = Effect.fn('DocumentGovernance.placeLegalHold')(function* (
  ctx: MutationCtx,
  args: PlaceLegalHoldArgs
): Effect.fn.Return<{ holdId: Id<'documentLegalHolds'> }, AppError> {
  const auth = yield* requireAuthEffect(ctx)
  const { user, profile } = auth
  yield* convexSync(() => requireAdmin(profile))

  const document = yield* convexPromise(() => ctx.db.get(args.documentId))
  if (!document) return yield* Effect.fail(notFound('Documento', args.documentId))
  const company = yield* convexPromise(() => ctx.db.get(document.companyId))
  if (!company) return yield* Effect.fail(notFound('Empresa', document.companyId))
  yield* convexPromise(() =>
    requireAdminVdrCapability({
      ctx,
      auth,
      capability: args.adminCapability,
      company,
      action: 'DOCUMENT_LEGAL_HOLD_PLACE',
      target: adminVdrTarget('DOCUMENT', `${document._id}`),
      input: withoutAdminVdrCapability(args),
    })
  )
  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `documentLegalHold:${profile._id}`,
      limit: 60,
      windowMs: 60 * 60 * 1000,
    })
  )
  const existing = yield* convexPromise(() =>
    ctx.db
      .query('documentLegalHolds')
      .withIndex('by_document_status', (q) =>
        q.eq('documentId', document._id).eq('status', 'ACTIVE')
      )
      .first()
  )
  if (existing) {
    return yield* Effect.fail(
      invalidState('Este documento ya tiene un legal hold activo.', 'LEGAL_HOLD_ACTIVE')
    )
  }

  const reason = yield* convexSync(() => validateReason(args.reason, 'reason'))
  const externalReference = args.externalReference?.trim()
  if (externalReference && externalReference.length > HOLD_REFERENCE_MAX_LENGTH) {
    return yield* Effect.fail(
      validationFailed('La referencia externa es demasiado larga.', 'externalReference')
    )
  }
  const now = Date.now()
  const holdId = yield* convexPromise(() =>
    ctx.db.insert('documentLegalHolds', {
      documentId: document._id,
      companyId: document.companyId,
      status: 'ACTIVE',
      reason,
      externalReference: externalReference || undefined,
      placedAt: now,
      placedByProfileId: profile._id,
    })
  )
  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      userId: profile._id,
      action: 'VDR_DOCUMENT_LEGAL_HOLD_PLACED',
      entityType: 'DOCUMENT',
      entityId: `${document._id}`,
      metadata: {
        resourceType: 'COMPANY',
        resourceId: `${document.companyId}`,
      },
    })
  )
  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: user.email,
      action: 'DOCUMENT_LEGAL_HOLD_PLACE',
      targetType: 'DOCUMENT',
      targetId: `${document._id}`,
      previousValue: { legalHold: null },
      newValue: { legalHold: 'ACTIVE', holdId: `${holdId}`, placedAt: now },
    })
  )
  return { holdId }
})

export const placeLegalHold = mutation({
  args: {
    adminCapability: adminVdrCapabilityValidator,
    documentId: v.id('documents'),
    reason: v.string(),
    externalReference: v.optional(v.string()),
  },
  handler: (ctx, args) => runConvex(placeLegalHoldProgram(ctx, args)),
})

type ReleaseLegalHoldArgs = {
  holdId: Id<'documentLegalHolds'>
  reason: string
  adminCapability?: string
}

const releaseLegalHoldProgram = Effect.fn('DocumentGovernance.releaseLegalHold')(function* (
  ctx: MutationCtx,
  args: ReleaseLegalHoldArgs
): Effect.fn.Return<{ released: true }, AppError> {
  const auth = yield* requireAuthEffect(ctx)
  const { user, profile } = auth
  yield* convexSync(() => requireAdmin(profile))

  const hold = yield* convexPromise(() => ctx.db.get(args.holdId))
  if (!hold) return yield* Effect.fail(notFound('Legal hold', args.holdId))
  const company = yield* convexPromise(() => ctx.db.get(hold.companyId))
  if (!company) return yield* Effect.fail(notFound('Empresa', hold.companyId))
  yield* convexPromise(() =>
    requireAdminVdrCapability({
      ctx,
      auth,
      capability: args.adminCapability,
      company,
      action: 'DOCUMENT_LEGAL_HOLD_RELEASE',
      target: adminVdrTarget('LEGAL_HOLD', `${hold._id}`),
      input: withoutAdminVdrCapability(args),
    })
  )
  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `documentLegalHold:${profile._id}`,
      limit: 60,
      windowMs: 60 * 60 * 1000,
    })
  )
  if (hold.status !== 'ACTIVE') {
    return yield* Effect.fail(
      invalidState('Este legal hold ya fue liberado.', 'LEGAL_HOLD_RELEASED')
    )
  }
  const reason = yield* convexSync(() => validateReason(args.reason, 'reason'))
  const now = Date.now()
  yield* convexPromise(() =>
    ctx.db.patch(hold._id, {
      status: 'RELEASED',
      releasedAt: now,
      releasedByProfileId: profile._id,
      releaseReason: reason,
    })
  )
  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      userId: profile._id,
      action: 'VDR_DOCUMENT_LEGAL_HOLD_RELEASED',
      entityType: 'DOCUMENT',
      entityId: `${hold.documentId}`,
      metadata: {
        resourceType: 'COMPANY',
        resourceId: `${hold.companyId}`,
      },
    })
  )
  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: user.email,
      action: 'DOCUMENT_LEGAL_HOLD_RELEASE',
      targetType: 'DOCUMENT',
      targetId: `${hold.documentId}`,
      previousValue: { legalHold: 'ACTIVE', holdId: `${hold._id}` },
      newValue: { legalHold: 'RELEASED', releasedAt: now },
    })
  )
  return { released: true as const }
})

export const releaseLegalHold = mutation({
  args: {
    holdId: v.id('documentLegalHolds'),
    reason: v.string(),
    adminCapability: adminVdrCapabilityValidator,
  },
  handler: (ctx, args) => runConvex(releaseLegalHoldProgram(ctx, args)),
})
