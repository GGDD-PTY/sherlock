import { Effect } from 'effect'

import type { Doc } from '../_generated/dataModel'
import type { Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { convexPromise, runConvex } from '../_helpers/effect'

type DocumentReadCtx = Pick<QueryCtx | MutationCtx, 'db'>

/**
 * Resolves the one immutable version that may back a byte-delivery flow.
 *
 * Callers still own principal authorization and action-specific policy. This
 * helper owns only the document/version integrity boundary. Projection callers
 * can omit a document on `null` without turning record state into an oracle.
 */
const loadDeliverablePublishedVersionEffect = Effect.fn('DeliverableVersion.loadPublished')(
  function* (
    ctx: DocumentReadCtx,
    document: Doc<'documents'>,
    now = Date.now(),
    requestedVersionId?: Id<'documentVersions'>
  ) {
    if (
      document.lifecycleStatus !== 'ACTIVE' ||
      document.isExpired === true ||
      (document.expiresAt !== undefined && document.expiresAt <= now)
    ) {
      return null
    }

    if (requestedVersionId) {
      const requestedVersion = yield* convexPromise(() => ctx.db.get(requestedVersionId))
      if (!requestedVersion) return null
      if (
        requestedVersion.documentId !== document._id ||
        requestedVersion.companyId !== document.companyId ||
        !['PUBLISHED', 'SUPERSEDED'].includes(requestedVersion.publicationStatus) ||
        requestedVersion.verificationStatus !== 'SIGNATURE_VERIFIED' ||
        !scanStatusAllowsDelivery(requestedVersion.malwareScanStatus)
      ) {
        return null
      }

      return requestedVersion
    }

    const { currentVersionId, publishedVersionId } = document
    if (!currentVersionId || !publishedVersionId || currentVersionId !== publishedVersionId) {
      return null
    }

    const version = yield* convexPromise(() => ctx.db.get(currentVersionId))
    if (!version) return null
    if (
      version.documentId !== document._id ||
      version._id !== currentVersionId ||
      version.companyId !== document.companyId ||
      !document.storageId ||
      document.storageId !== version.storageId ||
      version.publicationStatus !== 'PUBLISHED' ||
      version.verificationStatus !== 'SIGNATURE_VERIFIED' ||
      !scanStatusAllowsDelivery(version.malwareScanStatus)
    ) {
      return null
    }

    return version
  }
)

export function loadDeliverablePublishedVersion(
  ctx: DocumentReadCtx,
  document: Doc<'documents'>,
  now = Date.now(),
  requestedVersionId?: Id<'documentVersions'>
): Promise<Doc<'documentVersions'> | null> {
  return runConvex(loadDeliverablePublishedVersionEffect(ctx, document, now, requestedVersionId))
}

// `NOT_CONFIGURED` is the ingest verdict when no scanner exists for the
// deployment (`requiresConfiguredScanner` already refuses it outside dev);
// delivery mirrors `vdrRead` so an accepted upload stays openable. PENDING,
// INFECTED and ERROR keep blocking.
function scanStatusAllowsDelivery(status: Doc<'documentVersions'>['malwareScanStatus']) {
  return status === 'CLEAN' || status === 'NOT_CONFIGURED'
}
