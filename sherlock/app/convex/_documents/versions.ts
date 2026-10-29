import { v } from 'convex/values'
import { Effect } from 'effect'

import type { Id } from '../_generated/dataModel'
import { mutation, type MutationCtx } from '../_generated/server'
import { requireAuthEffect } from '../_helpers/auth.identity'
import { logAdminAction } from '../_helpers/auditLog'
import { convexPromise, runConvex } from '../_helpers/effect'
import type { AppError } from '../_helpers/errors'
import { invalidState, notFound, unauthorized } from '../_helpers/errors'
import { enforceRateLimit } from '../_helpers/rateLimit'
import { normalizeSha256Hex } from '../_helpers/sha256'
import { requireCompanyOwnerOrAdminEffect, revokeGrantsForDocumentEffect } from './shared'
import {
  adminVdrCapabilityValidator,
  requireAdminVdrCapability,
  withoutAdminVdrCapability,
} from '../_adminVdr/capability'
import { adminVdrTarget } from '../_adminVdr/capabilityFormat'

type RestoreVersionArgs = {
  adminCapability?: string
  documentId: Id<'documents'>
  versionId: Id<'documentVersions'>
  expectedCurrentVersionNumber: number
}

const restoreVersionProgram = Effect.fn('DocumentVersions.restore')(function* (
  ctx: MutationCtx,
  args: RestoreVersionArgs
): Effect.fn.Return<
  { restoredVersionId: Id<'documentVersions'>; versionNumber: number },
  AppError
> {
  const auth = yield* requireAuthEffect(ctx)
  const { user, profile } = auth
  const denied = 'No tienes permiso para restaurar versiones de este documento.'
  const document = yield* convexPromise(() => ctx.db.get(args.documentId))
  if (!document) {
    return yield* Effect.fail(
      profile.role === 'ADMIN' ? notFound('Documento', args.documentId) : unauthorized(denied)
    )
  }
  const company = yield* convexPromise(() => ctx.db.get(document.companyId))
  if (!company) return yield* Effect.fail(unauthorized(denied))
  yield* requireCompanyOwnerOrAdminEffect(ctx, auth, company, denied)
  yield* convexPromise(() =>
    requireAdminVdrCapability({
      ctx,
      auth,
      capability: args.adminCapability,
      company,
      action: 'DOCUMENT_VERSION_RESTORE',
      target: adminVdrTarget('DOCUMENT', `${document._id}`),
      input: withoutAdminVdrCapability(args),
    })
  )
  if (document.lifecycleStatus === 'ARCHIVED') {
    return yield* Effect.fail(
      invalidState('Un documento archivado no se puede restaurar.', 'DOCUMENT_ARCHIVED')
    )
  }

  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `documentVersionRestore:${profile._id}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    })
  )

  const selected = yield* convexPromise(() => ctx.db.get(args.versionId))
  if (!selected || selected.documentId !== document._id) {
    return yield* Effect.fail(unauthorized(denied))
  }
  if (
    selected.verificationStatus !== 'SIGNATURE_VERIFIED' ||
    selected.malwareScanStatus !== 'CLEAN'
  ) {
    return yield* Effect.fail(
      invalidState(
        'Solo puedes restaurar una versión cuya firma y análisis de malware fueron verificados.',
        'VERSION_NOT_RESTORABLE'
      )
    )
  }

  const currentVersionNumber = document.currentVersionNumber ?? 0
  if (currentVersionNumber !== args.expectedCurrentVersionNumber) {
    return yield* Effect.fail(
      invalidState('El documento cambió. Recarga antes de restaurar.', 'REVISION_CONFLICT')
    )
  }
  if (!document.currentVersionId || selected._id === document.currentVersionId) {
    return yield* Effect.fail(
      invalidState('Selecciona una versión anterior para restaurar.', 'VERSION_ALREADY_CURRENT')
    )
  }
  const currentVersionId = document.currentVersionId
  const current = yield* convexPromise(() => ctx.db.get(currentVersionId))
  if (
    !current ||
    current.documentId !== document._id ||
    current.versionNumber !== currentVersionNumber
  ) {
    return yield* Effect.fail(
      invalidState('El historial del documento requiere reconciliación.', 'VERSION_DRIFT')
    )
  }
  const selectedBlob = yield* convexPromise(() => ctx.db.system.get(selected.storageId))
  if (
    !selectedBlob ||
    normalizeSha256Hex(selectedBlob.sha256) !== normalizeSha256Hex(selected.sha256)
  ) {
    return yield* Effect.fail(
      invalidState('La evidencia de integridad de esta versión no está disponible.', 'BLOB_MISSING')
    )
  }

  const now = Date.now()
  const nextVersionNumber = currentVersionNumber + 1
  yield* convexPromise(() => ctx.db.patch(current._id, { publicationStatus: 'SUPERSEDED' }))
  const restoredVersionId = yield* convexPromise(() =>
    ctx.db.insert('documentVersions', {
      documentId: document._id,
      companyId: document.companyId,
      versionNumber: nextVersionNumber,
      storageId: selected.storageId,
      displayName: document.name,
      declaredMimeType: selected.declaredMimeType,
      detectedMimeType: selected.detectedMimeType,
      byteSize: selected.byteSize,
      sha256: selected.sha256,
      signatureKind: selected.signatureKind,
      verificationStatus: selected.verificationStatus,
      malwareScanStatus: selected.malwareScanStatus,
      publicationStatus: 'PUBLISHED',
      replacesVersionId: current._id,
      restoredFromVersionId: selected._id,
      createdAt: now,
      createdByProfileId: profile._id,
      publishedAt: now,
    })
  )
  yield* convexPromise(() =>
    ctx.db.patch(document._id, {
      storageId: selected.storageId,
      fileType: selected.detectedMimeType,
      fileSize: selected.byteSize,
      lifecycleStatus: 'ACTIVE',
      currentVersionNumber: nextVersionNumber,
      currentVersionId: restoredVersionId,
      publishedVersionId: restoredVersionId,
      updatedAt: now,
      protectionPolicyVersion: 'trust-os-v2',
    })
  )
  yield* revokeGrantsForDocumentEffect(ctx, document._id, 'DOCUMENT_VERSION_RESTORED')
  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      userId: profile._id,
      action: 'VDR_DOCUMENT_VERSION_RESTORED',
      entityType: 'DOCUMENT_VERSION',
      entityId: `${restoredVersionId}`,
      metadata: {
        resourceType: 'COMPANY',
        resourceId: `${document.companyId}`,
        details: {
          restoredFromVersionNumber: selected.versionNumber,
          publishedVersionNumber: nextVersionNumber,
        },
      },
    })
  )
  if (profile.role === 'ADMIN') {
    yield* convexPromise(() =>
      logAdminAction({
        ctx,
        adminProfileId: profile._id,
        adminEmail: user.email,
        action: 'DOCUMENT_VERSION_RESTORE',
        targetType: 'DOCUMENT',
        targetId: `${document._id}`,
        previousValue: { versionNumber: currentVersionNumber },
        newValue: {
          versionNumber: nextVersionNumber,
          restoredFromVersionNumber: selected.versionNumber,
        },
      })
    )
  }

  return { restoredVersionId, versionNumber: nextVersionNumber }
})

export const restoreVersion = mutation({
  args: {
    adminCapability: adminVdrCapabilityValidator,
    documentId: v.id('documents'),
    versionId: v.id('documentVersions'),
    expectedCurrentVersionNumber: v.number(),
  },
  handler: (ctx, args) => runConvex(restoreVersionProgram(ctx, args)),
})
