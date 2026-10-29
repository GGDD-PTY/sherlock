import { describe, expect, it } from 'vitest'

import type { Doc, Id } from '../../../convex/_generated/dataModel'
import type { QueryCtx } from '../../../convex/_generated/server'
import { loadDeliverablePublishedVersion } from '../../../convex/_documents/deliverableVersion'

const NOW = 1_900_000_000_000

function id<
  TableName extends 'companies' | 'documents' | 'documentVersions' | '_storage',
>(value: string): Id<TableName> {
  return value as Id<TableName>
}

function baseDocument(): Doc<'documents'> {
  return {
    _id: id<'documents'>('document_1'),
    _creationTime: NOW - 20_000,
    companyId: id<'companies'>('company_1'),
    name: 'financials.pdf',
    lifecycleStatus: 'ACTIVE',
    storageId: id<'_storage'>('storage_1'),
    currentVersionId: id<'documentVersions'>('version_1'),
    publishedVersionId: id<'documentVersions'>('version_1'),
    expiresAt: NOW + 60_000,
    isExpired: false,
  }
}

function baseVersion(): Doc<'documentVersions'> {
  return {
    _id: id<'documentVersions'>('version_1'),
    _creationTime: NOW - 10_000,
    documentId: id<'documents'>('document_1'),
    companyId: id<'companies'>('company_1'),
    versionNumber: 1,
    storageId: id<'_storage'>('storage_1'),
    displayName: 'financials.pdf',
    declaredMimeType: 'application/pdf',
    detectedMimeType: 'application/pdf',
    byteSize: 128,
    sha256: 'a'.repeat(64),
    signatureKind: 'PDF',
    verificationStatus: 'SIGNATURE_VERIFIED',
    malwareScanStatus: 'CLEAN',
    publicationStatus: 'PUBLISHED',
    createdAt: NOW - 10_000,
    createdByProfileId: 'profile_company' as Id<'profiles'>,
    publishedAt: NOW - 9_000,
  }
}

function createCtx(version: Doc<'documentVersions'> | null): Pick<QueryCtx, 'db'> {
  return {
    db: {
      get: async () => version,
    } as unknown as QueryCtx['db'],
  }
}

describe('deliverable document version boundary', () => {
  it('returns the exact active, current, published, verified and clean version', async () => {
    const document = baseDocument()
    const version = baseVersion()

    await expect(
      loadDeliverablePublishedVersion(createCtx(version), document, NOW)
    ).resolves.toBe(version)
  })

  it('loads an explicitly requested superseded version without substituting the current one', async () => {
    const historical = baseVersion()
    historical._id = id<'documentVersions'>('version_historical')
    historical.storageId = id<'_storage'>('storage_historical')
    historical.publicationStatus = 'SUPERSEDED'

    await expect(
      loadDeliverablePublishedVersion(createCtx(historical), baseDocument(), NOW, historical._id)
    ).resolves.toBe(historical)
  })

  it('returns no exact version when the requested row belongs to another document', async () => {
    const unrelated = baseVersion()
    unrelated._id = id<'documentVersions'>('version_unrelated')
    unrelated.documentId = id<'documents'>('document_other')

    await expect(
      loadDeliverablePublishedVersion(createCtx(unrelated), baseDocument(), NOW, unrelated._id)
    ).resolves.toBeNull()
  })

  it('denies a document that is not active', async () => {
    const document = baseDocument()
    document.lifecycleStatus = 'ARCHIVED'

    await expect(
      loadDeliverablePublishedVersion(createCtx(baseVersion()), document, NOW)
    ).resolves.toBeNull()
  })

  it.each([
    [
      'the persisted expiry flag is set',
      (document: Doc<'documents'>) => (document.isExpired = true),
    ],
    [
      'the expiry timestamp has elapsed',
      (document: Doc<'documents'>) => (document.expiresAt = NOW),
    ],
  ])('denies the document when %s', async (_label, expire) => {
    const document = baseDocument()
    expire(document)

    await expect(
      loadDeliverablePublishedVersion(createCtx(baseVersion()), document, NOW)
    ).resolves.toBeNull()
  })

  it.each([
    [
      'published version identity',
      (version: Doc<'documentVersions'>) => (version._id = id<'documentVersions'>('version_other')),
    ],
    [
      'document identity',
      (version: Doc<'documentVersions'>) =>
        (version.documentId = id<'documents'>('document_other')),
    ],
    [
      'company scope',
      (version: Doc<'documentVersions'>) => (version.companyId = id<'companies'>('company_other')),
    ],
  ])('denies a version with mismatched %s', async (_label, drift) => {
    const version = baseVersion()
    drift(version)

    await expect(
      loadDeliverablePublishedVersion(createCtx(version), baseDocument(), NOW)
    ).resolves.toBeNull()
  })

  it.each([
    ['unpublished', (version: Doc<'documentVersions'>) => (version.publicationStatus = 'DRAFT')],
    [
      'signature-unverified',
      (version: Doc<'documentVersions'>) => (version.verificationStatus = 'QUARANTINED'),
    ],
    [
      'malware-infected',
      (version: Doc<'documentVersions'>) => (version.malwareScanStatus = 'INFECTED'),
    ],
    [
      'malware-scan-pending',
      (version: Doc<'documentVersions'>) => (version.malwareScanStatus = 'PENDING'),
    ],
    [
      'malware-scan-errored',
      (version: Doc<'documentVersions'>) => (version.malwareScanStatus = 'ERROR'),
    ],
  ])('denies a %s immutable version', async (_label, makeUnsafe) => {
    const version = baseVersion()
    makeUnsafe(version)

    await expect(
      loadDeliverablePublishedVersion(createCtx(version), baseDocument(), NOW)
    ).resolves.toBeNull()
  })

  // Ingest already accepts a version when no scanner is configured
  // (`requiresConfiguredScanner`) and `vdrRead` already serves it; delivery has
  // to agree, otherwise an accepted upload can never be opened or downloaded.
  it('delivers a signature-verified version whose scanner was not configured', async () => {
    const version = baseVersion()
    version.malwareScanStatus = 'NOT_CONFIGURED'

    await expect(
      loadDeliverablePublishedVersion(createCtx(version), baseDocument(), NOW)
    ).resolves.toMatchObject({ _id: version._id })
  })

  it.each([
    ['missing document storage pointer', (document: Doc<'documents'>) => delete document.storageId],
    [
      'storage pointer drift',
      (document: Doc<'documents'>) => (document.storageId = id<'_storage'>('storage_other')),
    ],
  ])('denies %s', async (_label, mutateDocument) => {
    const document = baseDocument()
    mutateDocument(document)

    await expect(
      loadDeliverablePublishedVersion(createCtx(baseVersion()), document, NOW)
    ).resolves.toBeNull()
  })

  it('offers a non-throwing loader so projections can omit undeliverable documents', async () => {
    const document = baseDocument()
    document.publishedVersionId = id<'documentVersions'>('version_other')

    await expect(
      loadDeliverablePublishedVersion(createCtx(baseVersion()), document, NOW)
    ).resolves.toBeNull()
  })

  it.each([
    ['missing current pointer', (document: Doc<'documents'>) => delete document.currentVersionId],
    [
      'missing published pointer',
      (document: Doc<'documents'>) => delete document.publishedVersionId,
    ],
    [
      'drifting current and published pointers',
      (document: Doc<'documents'>) =>
        (document.publishedVersionId = id<'documentVersions'>('version_secret')),
    ],
  ])('denies %s', async (_label, mutateDocument) => {
    const document = baseDocument()
    mutateDocument(document)

    await expect(
      loadDeliverablePublishedVersion(createCtx(baseVersion()), document, NOW)
    ).resolves.toBeNull()
  })

  it('denies a missing version row', async () => {
    await expect(
      loadDeliverablePublishedVersion(createCtx(null), baseDocument(), NOW)
    ).resolves.toBeNull()
  })
})
