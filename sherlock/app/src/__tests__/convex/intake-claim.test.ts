import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createIntakeClaimProof } from './intake-claim-proof-test-helper'
import { hashIntakeSessionToken } from '../../../convex/_intake/crypto'
import {
  reconcileIntakeClaimByDigest,
  resetPendingClaimForDeletion,
} from '../../../convex/_intake/claim'
import { resolveActiveIntakeSession } from '../../../convex/_intake/sessions'
import { claimToAuthenticatedCompany, revokeSession } from '../../../convex/intake'
import { createIntakeServerProof } from '../../lib/intake/proof'
import {
  createConvexCtx,
  runHandler,
  runMutationHandlerWithOcc,
  type Row,
  type Tables,
} from './nda-convex-harness'

const SECRET = 'intake-claim-secret-for-tests-123456789012345' // gitleaks:allow -- deterministic test fixture, not a provider credential
const AUDIENCE = 'sherlock-test:intake-claim'
const SESSION_TOKEN = 's'.repeat(43)
const OWNER_SUBJECT = 'workos_owner'
const SECOND_SUBJECT = 'workos_second'
const PDF_HASH = 'a'.repeat(64)
const XLS_HASH = 'b'.repeat(64)

function row(overrides: Partial<Row> & Pick<Row, '_id'>): Row {
  return { _creationTime: 1, ...overrides }
}

async function claimTables(
  options: {
    includeSecondClean?: boolean
    includeForeignConflict?: boolean
    includeNotConfigured?: boolean
    identityName?: string
  } = {}
) {
  const sessionId = 'intake_session_1'
  const documents: Row[] = [
    row({
      _id: 'intake_document_pdf',
      intakeSessionId: sessionId,
      uploadIntentId: 'intake_intent_pdf',
      displayName: 'Estados financieros.pdf',
      declaredMimeType: 'application/pdf',
      detectedMimeType: 'application/pdf',
      byteSize: 128,
      sha256: PDF_HASH,
      storageId: 'storage_pdf',
      storageState: 'STAGED_INTAKE',
      inspectionStatus: 'CLEAN',
      claimable: true,
      signatureKind: 'PDF',
      scannerEngine: 'scanner',
      scannerScanId: 'scan-pdf',
      scannedAt: 100,
      createdAt: 100,
    }),
    row({
      _id: 'intake_document_quarantine',
      intakeSessionId: sessionId,
      uploadIntentId: 'intake_intent_quarantine',
      displayName: 'Sin inspeccionar.pdf',
      declaredMimeType: 'application/pdf',
      detectedMimeType: 'application/pdf',
      byteSize: 32,
      sha256: 'c'.repeat(64),
      storageId: 'storage_quarantine',
      storageState: 'STAGED_INTAKE',
      inspectionStatus: 'UNINSPECTED',
      claimable: false,
      signatureKind: 'PDF',
      createdAt: 101,
    }),
  ]
  if (options.includeNotConfigured) {
    documents.unshift(
      row({
        _id: 'intake_document_not_configured',
        intakeSessionId: sessionId,
        uploadIntentId: 'intake_intent_not_configured',
        displayName: 'Sin escáner.pdf',
        declaredMimeType: 'application/pdf',
        detectedMimeType: 'application/pdf',
        byteSize: 64,
        sha256: 'd'.repeat(64),
        storageId: 'storage_not_configured',
        storageState: 'STAGED_INTAKE',
        inspectionStatus: 'NOT_CONFIGURED',
        claimable: true,
        signatureKind: 'PDF',
        createdAt: 99,
      })
    )
  }
  if (options.includeSecondClean) {
    documents.push(
      row({
        _id: 'intake_document_xls',
        intakeSessionId: sessionId,
        uploadIntentId: 'intake_intent_xls',
        displayName: 'Modelo.xls',
        declaredMimeType: 'application/vnd.ms-excel',
        detectedMimeType: 'application/vnd.ms-excel',
        byteSize: 256,
        sha256: XLS_HASH,
        storageId: 'storage_xls',
        storageState: 'STAGED_INTAKE',
        inspectionStatus: 'CLEAN',
        claimable: true,
        signatureKind: 'OLE',
        scannerEngine: 'scanner',
        scannerScanId: 'scan-xls',
        scannedAt: 102,
        createdAt: 102,
      })
    )
  }

  const tables: Tables = {
    users: [
      row({
        _id: 'user_owner',
        authProvider: 'workos',
        providerUserId: OWNER_SUBJECT,
        workosUserId: OWNER_SUBJECT,
        email: 'owner@example.com',
        role: 'COMPANY',
      }),
      row({
        _id: 'user_second',
        authProvider: 'workos',
        providerUserId: SECOND_SUBJECT,
        workosUserId: SECOND_SUBJECT,
        email: 'second@example.com',
        role: 'COMPANY',
      }),
    ],
    profiles: [
      row({
        _id: 'profile_owner',
        userId: 'user_owner',
        role: 'COMPANY',
        roleConfirmed: true,
        isActive: true,
      }),
      row({
        _id: 'profile_second',
        userId: 'user_second',
        role: 'COMPANY',
        roleConfirmed: true,
        isActive: true,
      }),
    ],
    companies: [
      row({ _id: 'company_owner', ownerId: 'profile_owner', name: 'Owner Co' }),
      row({ _id: 'company_second', ownerId: 'profile_second', name: 'Second Co' }),
    ],
    companyChecklist: [],
    companyOrganizationBindings: [],
    companyAuthorizationControls: [],
    organizationMemberships: [],
    intakeSessions: [
      row({
        _id: sessionId,
        sessionTokenHash: await hashIntakeSessionToken(SESSION_TOKEN),
        anonymousKeyHash: 'd'.repeat(64),
        audience: AUDIENCE,
        status: 'ACTIVE',
        claimStatus: 'UNCLAIMED',
        ...(options.identityName === undefined
          ? {}
          : {
              identityEvidence: {
                kind: 'NAME',
                name: options.identityName,
                capturedAt: 100,
              },
            }),
        createdAt: Date.now() - 1_000,
        accessExpiresAt: Date.now() + 60_000,
        absoluteExpiresAt: Date.now() + 120_000,
        deletionProofExpiresAt: Date.now() + 180_000,
        rotationCount: 0,
        documentCount: documents.length,
        totalStagedBytes: documents.reduce((sum, document) => sum + Number(document.byteSize), 0),
      }),
    ],
    intakeDocuments: documents,
    intakeUploadIntents: [],
    intakeAssessments: [],
    intakeEvents: [],
    intakeProofNonces: [],
    documents: options.includeForeignConflict
      ? [
          row({
            _id: 'foreign_document',
            companyId: 'company_second',
            name: 'Foreign.xls',
            storageId: 'storage_xls',
            sourceType: 'USER_UPLOAD',
          }),
        ]
      : [],
    documentVersions: [],
    vdrUploadIntents: [],
    assetUploadIntents: [],
  }
  return tables
}

function claimArgs(subject = OWNER_SUBJECT, sessionToken = SESSION_TOKEN) {
  return {
    sessionToken,
    workosSubject: subject,
    ...createIntakeClaimProof({ sessionToken, workosSubject: subject }),
  }
}

function claimCtx(tables: Tables, subject = OWNER_SUBJECT) {
  const ctx = createConvexCtx(tables, {
    identity: {
      subject,
      issuer: 'https://api.workos.com/',
      email: subject === OWNER_SUBJECT ? 'owner@example.com' : 'second@example.com',
    },
  })
  const blobs: Record<string, Row> = {
    storage_pdf: row({
      _id: 'storage_pdf',
      size: 128,
      sha256: PDF_HASH,
      contentType: 'application/pdf',
    }),
    storage_xls: row({
      _id: 'storage_xls',
      size: 256,
      sha256: XLS_HASH,
      contentType: 'application/vnd.ms-excel',
    }),
    storage_quarantine: row({
      _id: 'storage_quarantine',
      size: 32,
      sha256: 'c'.repeat(64),
      contentType: 'application/pdf',
    }),
    storage_not_configured: row({
      _id: 'storage_not_configured',
      size: 64,
      sha256: 'd'.repeat(64),
      contentType: 'application/pdf',
    }),
  }
  Object.assign(ctx.db, { system: { get: vi.fn(async (id: string) => blobs[id] ?? null) } })
  // `ctx.storage.*` real devuelve promesas: el mock también, o `Effect.tryPromise`
  // le llama `.then` a `undefined` y muere.
  Object.assign(ctx, {
    storage: { delete: vi.fn(() => Promise.resolve()), get: vi.fn().mockResolvedValue(null) },
  })
  return ctx
}

describe('authenticated intake claim', () => {
  beforeEach(() => {
    vi.stubEnv('INTAKE_DEMO_MODE', 'true')
    vi.stubEnv('INTAKE_SERVER_SECRET', SECRET)
    vi.stubEnv('INTAKE_SERVER_AUDIENCE', AUDIENCE)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('derives the owner company, reuses each blob, and creates one immutable version root', async () => {
    const tables = await claimTables()
    const ctx = claimCtx(tables)
    const args = claimArgs()

    const prepared = await runHandler(claimToAuthenticatedCompany, ctx, args)
    const claimed = await runHandler(claimToAuthenticatedCompany, ctx, args)

    expect(prepared).toMatchObject({ status: 'PROCESSING', claimDigest: expect.any(String) })
    expect(claimed).toMatchObject({
      status: 'SUCCEEDED',
      companyId: 'company_owner',
      documentIds: [expect.any(String)],
      claimedDocumentCount: 1,
      skippedDocumentCount: 1,
    })
    expect(tables.documents).toHaveLength(1)
    expect(tables.documentVersions).toHaveLength(1)
    expect(tables.documents[0]).toMatchObject({
      companyId: 'company_owner',
      storageId: 'storage_pdf',
      currentVersionNumber: 1,
      currentVersionId: tables.documentVersions[0]._id,
      publishedVersionId: tables.documentVersions[0]._id,
      sourceType: 'USER_UPLOAD',
      provenanceNotes: expect.stringContaining('intake_document_pdf'),
    })
    expect(tables.documentVersions[0]).toMatchObject({
      documentId: tables.documents[0]._id,
      companyId: 'company_owner',
      versionNumber: 1,
      storageId: 'storage_pdf',
      replacesVersionId: undefined,
      verificationStatus: 'SIGNATURE_VERIFIED',
      malwareScanStatus: 'CLEAN',
      publicationStatus: 'PUBLISHED',
      createdByProfileId: 'profile_owner',
    })
    expect(tables.intakeDocuments[0]).toMatchObject({
      storageId: 'storage_pdf',
      storageState: 'OWNED_BY_COMPANY',
      claimable: false,
    })
    expect(tables.intakeDocuments[1]).toMatchObject({
      storageId: 'storage_quarantine',
      storageState: 'STAGED_INTAKE',
      inspectionStatus: 'UNINSPECTED',
    })
    expect(tables.intakeSessions[0]).toMatchObject({
      status: 'CLAIMED',
      claimStatus: 'CLAIMED',
      claimedProfileId: 'profile_owner',
      claimedCompanyId: 'company_owner',
      claimResult: { status: 'SUCCEEDED', completedAt: expect.any(Number) },
      revokedReason: 'CLAIM_SUCCEEDED',
    })
    expect(await resolveActiveIntakeSession(ctx as never, SESSION_TOKEN)).toBeNull()
    expect(
      (ctx as unknown as { storage: { delete: ReturnType<typeof vi.fn> } }).storage.delete
    ).not.toHaveBeenCalled()
  })

  it('preserves NOT_CONFIGURED while claiming it in an optional-scanner deployment', async () => {
    vi.stubEnv('CONVEX_ENV', 'dev')
    const tables = await claimTables({ includeNotConfigured: true })
    const ctx = claimCtx(tables)
    const args = claimArgs()

    await runHandler(claimToAuthenticatedCompany, ctx, args)
    const claimed = await runHandler(claimToAuthenticatedCompany, ctx, args)

    expect(claimed).toMatchObject({
      status: 'SUCCEEDED',
      claimedDocumentCount: 2,
      skippedDocumentCount: 1,
    })
    expect(tables.documentVersions.map((version) => version.malwareScanStatus)).toEqual([
      'NOT_CONFIGURED',
      'CLEAN',
    ])
  })

  it('revalidates optional-scanner policy at claim time and fails closed when it changes', async () => {
    vi.stubEnv('CONVEX_ENV', 'dev')
    const tables = await claimTables({ includeNotConfigured: true })
    const ctx = claimCtx(tables)
    const args = claimArgs()

    await runHandler(claimToAuthenticatedCompany, ctx, args)
    vi.stubEnv('CONVEX_ENV', 'production')
    const claimed = await runHandler(claimToAuthenticatedCompany, ctx, args)

    expect(claimed).toMatchObject({
      status: 'FAILED',
      code: 'CLAIM_RECONCILIATION_REQUIRED',
    })
    expect(tables.documents).toHaveLength(0)
    expect(tables.documentVersions).toHaveLength(0)
  })

  it('returns the exact recorded terminal result on retries without duplicate metadata', async () => {
    const tables = await claimTables()
    const ctx = claimCtx(tables)
    const args = claimArgs()

    await runHandler(claimToAuthenticatedCompany, ctx, args)
    const first = await runHandler(claimToAuthenticatedCompany, ctx, args)
    const documentCount = tables.documents.length
    const versionCount = tables.documentVersions.length
    const replay = await runHandler(claimToAuthenticatedCompany, ctx, args)

    expect(replay).toEqual(first)
    expect(tables.intakeSessions[0].claimResult).toMatchObject({
      status: 'SUCCEEDED',
      code: expect.stringContaining('"documentIds"'),
    })
    expect(tables.documents).toHaveLength(documentCount)
    expect(tables.documentVersions).toHaveLength(versionCount)
  })

  it('fails closed for a tampered proof and a different WorkOS subject after issuance', async () => {
    const tables = await claimTables()
    const ownerCtx = claimCtx(tables)
    const args = claimArgs()

    await runHandler(claimToAuthenticatedCompany, ownerCtx, args)

    await expect(
      runHandler(claimToAuthenticatedCompany, ownerCtx, {
        ...args,
        claimNonce: `${args.claimNonce.slice(0, -1)}x`,
      })
    ).rejects.toThrow(/autorizad/i)
    await expect(
      runHandler(claimToAuthenticatedCompany, ownerCtx, {
        ...args,
        sessionToken: 'r'.repeat(43),
      })
    ).rejects.toThrow(/autorizad/i)
    const anotherSessionProof = createIntakeClaimProof({
      sessionToken: 't'.repeat(43),
      workosSubject: OWNER_SUBJECT,
    })
    await expect(
      runHandler(claimToAuthenticatedCompany, ownerCtx, {
        ...args,
        ...anotherSessionProof,
      })
    ).rejects.toThrow(/autorizad/i)

    const secondCtx = claimCtx(tables, SECOND_SUBJECT)
    await expect(
      runHandler(claimToAuthenticatedCompany, secondCtx, claimArgs(SECOND_SUBJECT))
    ).rejects.toThrow(/autorizad/i)
    expect(tables.intakeSessions[0]).toMatchObject({
      claimStatus: 'PROCESSING',
      claimedProfileId: 'profile_owner',
      claimedCompanyId: 'company_owner',
    })
    expect(tables.documents).toHaveLength(0)
  })

  it('records recoverable failure after partial metadata work and converges on retry', async () => {
    const tables = await claimTables({ includeSecondClean: true, includeForeignConflict: true })
    const ctx = claimCtx(tables)
    const args = claimArgs()

    await runHandler(claimToAuthenticatedCompany, ctx, args)
    const failed = await runHandler(claimToAuthenticatedCompany, ctx, args)

    expect(failed).toMatchObject({
      status: 'FAILED',
      code: 'CLAIM_RECONCILIATION_REQUIRED',
    })
    expect(tables.intakeSessions[0]).toMatchObject({
      status: 'ACTIVE',
      claimStatus: 'FAILED',
      claimResult: {
        status: 'FAILED',
        code: 'CLAIM_RECONCILIATION_REQUIRED',
      },
    })
    expect(
      tables.documents.filter((document) => document.companyId === 'company_owner')
    ).toHaveLength(1)
    expect(tables.intakeDocuments[0].storageState).toBe('OWNED_BY_COMPANY')
    expect(tables.intakeDocuments[2].storageState).toBe('CLAIM_PENDING')

    tables.documents = tables.documents.filter((document) => document._id !== 'foreign_document')
    const recovered = await runHandler(claimToAuthenticatedCompany, ctx, args)

    expect(recovered).toMatchObject({ status: 'SUCCEEDED', claimedDocumentCount: 2 })
    expect(
      tables.documents.filter((document) => document.companyId === 'company_owner')
    ).toHaveLength(2)
    expect(tables.documentVersions).toHaveLength(2)
  })

  it('blocks a claim replay after visitor revocation without canonicalizing pending documents', async () => {
    const tables = await claimTables()
    const ctx = claimCtx(tables)
    const args = claimArgs()

    const prepared = await runHandler(claimToAuthenticatedCompany, ctx, args)
    await runHandler(revokeSession, ctx, {
      sessionToken: SESSION_TOKEN,
      ...createIntakeServerProof({
        operation: 'REVOKE_SESSION',
        bindingParts: [SESSION_TOKEN],
        secret: SECRET,
        audience: AUDIENCE,
      }),
    })

    const replay = await runHandler(claimToAuthenticatedCompany, ctx, args)

    expect(prepared).toMatchObject({ status: 'PROCESSING' })
    expect(replay).toMatchObject({ status: 'FAILED', code: 'CLAIM_RECONCILIATION_REQUIRED' })
    expect(tables.intakeSessions[0]).toMatchObject({
      status: 'REVOKED',
      claimStatus: 'FAILED',
      claimResult: { status: 'FAILED', code: 'CLAIM_RECONCILIATION_REQUIRED' },
    })
    expect(tables.documents).toHaveLength(0)
    expect(tables.intakeDocuments[0].storageState).toBe('CLAIM_PENDING')
  })

  it('fails scheduled reconciliation for expired sessions and preserves deletion reset', async () => {
    const tables = await claimTables()
    const ctx = claimCtx(tables)
    const args = claimArgs()

    const prepared = await runHandler<typeof args, { claimDigest: string }>(
      claimToAuthenticatedCompany,
      ctx,
      args
    )
    tables.intakeSessions[0].status = 'EXPIRED'

    const reconciled = await reconcileIntakeClaimByDigest(ctx as never, prepared.claimDigest)

    expect(reconciled).toMatchObject({
      status: 'FAILED',
      code: 'CLAIM_RECONCILIATION_REQUIRED',
    })
    expect(tables.intakeSessions[0]).toMatchObject({ status: 'EXPIRED', claimStatus: 'FAILED' })
    expect(tables.documents).toHaveLength(0)
    expect(tables.intakeDocuments[0].storageState).toBe('CLAIM_PENDING')

    await resetPendingClaimForDeletion(ctx as never, tables.intakeSessions[0]._id as never)

    expect(tables.intakeDocuments[0]).toMatchObject({
      storageState: 'STAGED_INTAKE',
      claimable: true,
    })
  })

  it('fails scheduled reconciliation when management authorization is revoked but the profile stays active', async () => {
    const tables = await claimTables()
    const ctx = claimCtx(tables)
    const args = claimArgs()

    const prepared = await runHandler<typeof args, { claimDigest: string }>(
      claimToAuthenticatedCompany,
      ctx,
      args
    )
    expect(tables.intakeSessions[0].claimStatus).toBe('PROCESSING')
    tables.organizationMemberships.push(
      row({
        _id: 'membership_owner',
        userId: 'user_owner',
        profileId: 'profile_owner',
        authProvider: 'workos',
        providerOrgId: 'org_owner',
        workosOrgId: 'org_owner',
        betaRole: 'COMPANY_OWNER',
        profileRole: 'COMPANY',
        status: 'INACTIVE',
        createdAt: 4,
      })
    )

    const reconciled = await reconcileIntakeClaimByDigest(ctx as never, prepared.claimDigest)

    expect(reconciled).toMatchObject({
      status: 'FAILED',
      code: 'CLAIM_RECONCILIATION_REQUIRED',
    })
    expect(tables.intakeSessions[0]).toMatchObject({ status: 'ACTIVE', claimStatus: 'FAILED' })
    expect(tables.documents).toHaveLength(0)
    expect(tables.intakeDocuments[0].storageState).toBe('CLAIM_PENDING')
    expect(tables.profiles[0].isActive).toBe(true)
  })

  it('reconciles a claim when the owner has one active membership and the switch is off', async () => {
    const tables = await claimTables()
    const ctx = claimCtx(tables)
    const args = claimArgs()

    tables.organizationMemberships.push(
      row({
        _id: 'membership_owner',
        userId: 'user_owner',
        profileId: 'profile_owner',
        authProvider: 'workos',
        providerOrgId: 'org_owner',
        workosOrgId: 'org_owner',
        betaRole: 'COMPANY_OWNER',
        profileRole: 'COMPANY',
        status: 'ACTIVE',
        createdAt: 4,
      })
    )

    const prepared = await runHandler<typeof args, { claimDigest: string }>(
      claimToAuthenticatedCompany,
      ctx,
      args
    )
    const reconciled = await reconcileIntakeClaimByDigest(ctx as never, prepared.claimDigest)

    expect(prepared).toMatchObject({ status: 'PROCESSING' })
    expect(reconciled).toMatchObject({ status: 'SUCCEEDED' })
    expect(tables.documents).toHaveLength(1)
    expect(tables.intakeDocuments[0].storageState).toBe('OWNED_BY_COMPANY')
  })

  it('records a recoverable failure when the claimed profile loses authority before reconciliation', async () => {
    const tables = await claimTables()
    const ctx = claimCtx(tables)
    const args = claimArgs()

    const prepared = await runHandler<typeof args, { claimDigest: string }>(
      claimToAuthenticatedCompany,
      ctx,
      args
    )
    expect(tables.intakeSessions[0].claimStatus).toBe('PROCESSING')
    tables.profiles[0].isActive = false

    const reconciled = await reconcileIntakeClaimByDigest(ctx as never, prepared.claimDigest)

    expect(reconciled).toMatchObject({
      status: 'FAILED',
      code: 'CLAIM_RECONCILIATION_REQUIRED',
    })
    expect(tables.intakeSessions[0]).toMatchObject({ status: 'ACTIVE', claimStatus: 'FAILED' })
    expect(tables.documents).toHaveLength(0)
    expect(tables.intakeDocuments[0].storageState).toBe('CLAIM_PENDING')

    await resetPendingClaimForDeletion(ctx as never, tables.intakeSessions[0]._id as never)

    expect(tables.intakeDocuments[0]).toMatchObject({
      storageState: 'STAGED_INTAKE',
      claimable: true,
    })
  })

  it('serializes concurrent finalizers to one authority transition', async () => {
    const tables = await claimTables()
    const ctx = claimCtx(tables)
    const args = claimArgs()

    await runHandler(claimToAuthenticatedCompany, ctx, args)
    const [left, right] = await Promise.all([
      runMutationHandlerWithOcc(claimToAuthenticatedCompany, ctx, args),
      runMutationHandlerWithOcc(claimToAuthenticatedCompany, ctx, args),
    ])

    expect(left).toEqual(right)
    expect(left).toMatchObject({ status: 'SUCCEEDED' })
    expect(tables.documents).toHaveLength(1)
    expect(tables.documentVersions).toHaveLength(1)
  })

  it('renames the company to the name declared in the intake without displacing the documents', async () => {
    const tables = await claimTables({ identityName: '  Sample   Hydro  ' })
    const ctx = claimCtx(tables)
    const args = claimArgs()

    await runHandler(claimToAuthenticatedCompany, ctx, args)
    const claimed = await runHandler(claimToAuthenticatedCompany, ctx, args)

    expect(claimed).toMatchObject({
      status: 'SUCCEEDED',
      companyId: 'company_owner',
      documentIds: [expect.any(String)],
      claimedDocumentCount: 1,
    })
    expect(tables.companies.find((company) => company._id === 'company_owner')).toMatchObject({
      name: 'Sample Hydro',
    })
  })

  // La sala de un cliente que ya existía no se renombra desde la landing: el
  // 2026-09-07 «Sample Hydro, S.A.» quedó llamada «Sample Foods, S.A.»
  // porque el claim aplicaba el nombre declarado sin mirar de dónde salió la
  // empresa. Los documentos sí entran a esa sala, y el nombre declarado le
  // llega al equipo dentro del resultado del claim.
  it('keeps the name of a company that predates the session and reports the declared one', async () => {
    const tables = await claimTables({ identityName: 'Sample Foods, S.A.' })
    tables.intakeSessions[0]._creationTime = 2

    const ctx = claimCtx(tables)
    const args = claimArgs()

    await runHandler(claimToAuthenticatedCompany, ctx, args)
    const claimed = await runHandler(claimToAuthenticatedCompany, ctx, args)

    expect(claimed).toMatchObject({
      status: 'SUCCEEDED',
      companyId: 'company_owner',
      claimedDocumentCount: 1,
      declaredName: 'Sample Foods, S.A.',
    })
    expect(tables.companies.find((company) => company._id === 'company_owner')).toMatchObject({
      name: 'Owner Co',
    })
    // Sin marca de nombre confirmado, el aviso del equipo conserva el nombre
    // que la persona escribió en la landing.
    expect(tables.companyChecklist).toHaveLength(0)
    expect(tables.documents).toHaveLength(1)
    expect(tables.documents[0]).toMatchObject({ companyId: 'company_owner' })
  })

  it('names the company born from this intake with the declared name', async () => {
    const tables = await claimTables({ identityName: 'Sample Foods, S.A.' })
    tables.companies[0]._creationTime = 2

    const ctx = claimCtx(tables)
    const args = claimArgs()

    await runHandler(claimToAuthenticatedCompany, ctx, args)
    const claimed = await runHandler(claimToAuthenticatedCompany, ctx, args)

    expect(claimed).toMatchObject({
      status: 'SUCCEEDED',
      companyId: 'company_owner',
      declaredName: 'Sample Foods, S.A.',
    })
    expect(tables.companies.find((company) => company._id === 'company_owner')).toMatchObject({
      name: 'Sample Foods, S.A.',
    })
    expect(tables.companyChecklist[0]).toMatchObject({
      companyId: 'company_owner',
      nameConfirmedAt: expect.any(Number),
      nameConfirmedSource: 'INTAKE_CLAIM',
    })
  })

  it('leaves the company name untouched when the intake declared none', async () => {
    const tables = await claimTables()
    const ctx = claimCtx(tables)
    const args = claimArgs()

    await runHandler(claimToAuthenticatedCompany, ctx, args)
    const claimed = await runHandler(claimToAuthenticatedCompany, ctx, args)

    expect(claimed).toMatchObject({ status: 'SUCCEEDED' })
    expect(tables.companies.find((company) => company._id === 'company_owner')).toMatchObject({
      name: 'Owner Co',
    })
  })

  it('does not rewrite the declared name over a later manual rename on a re-claim', async () => {
    const tables = await claimTables({ identityName: 'Sample Hydro' })
    const ctx = claimCtx(tables)
    const args = claimArgs()

    await runHandler(claimToAuthenticatedCompany, ctx, args)
    await runHandler(claimToAuthenticatedCompany, ctx, args)
    tables.companies[0].name = 'Renombrada a mano'

    const replay = await runHandler(claimToAuthenticatedCompany, ctx, args)

    expect(replay).toMatchObject({ status: 'SUCCEEDED' })
    expect(tables.companies[0].name).toBe('Renombrada a mano')
  })

  it('claims and replays more than twenty documents without losing any', async () => {
    const tables = await claimTables()
    const template = tables.intakeDocuments[0]
    const documents: Row[] = Array.from({ length: 21 }, (_, index) => ({
      ...template,
      _id: `intake_extra_${index}`,
      storageId: `storage_extra_${index}`,
      sha256: index.toString(16).padStart(64, '0'),
      displayName: `Documento-${index}.pdf`,
    }))
    tables.intakeDocuments = documents
    tables.intakeSessions[0].documentCount = 21
    const ctx = claimCtx(tables)
    const extraBlobs = Object.fromEntries(
      documents.map((document) => [
        String(document.storageId),
        row({
          _id: String(document.storageId),
          size: Number(document.byteSize),
          sha256: String(document.sha256),
          contentType: String(document.detectedMimeType),
        }),
      ])
    )
    ctx.db.system.get = vi.fn(async (id: string) => extraBlobs[id] ?? null)
    const args = claimArgs()
    await runHandler(claimToAuthenticatedCompany, ctx, args)
    const result = await runHandler(claimToAuthenticatedCompany, ctx, args)
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      claimedDocumentCount: 21,
      skippedDocumentCount: 0,
    })
    expect(tables.documents).toHaveLength(21)
    const replay = await runHandler(claimToAuthenticatedCompany, ctx, args)
    expect(replay).toEqual(result)
    expect(tables.documents).toHaveLength(21)
  })

  it.each([
    ['corrupt JSON', '{not-json'],
    [
      'wrong version',
      JSON.stringify({
        version: 2,
        documentIds: ['doc_1'],
        claimedDocumentCount: 1,
        skippedDocumentCount: 0,
      }),
    ],
    [
      'count mismatch',
      JSON.stringify({
        version: 1,
        documentIds: ['doc_1'],
        claimedDocumentCount: 99,
        skippedDocumentCount: 0,
      }),
    ],
    [
      'empty document id',
      JSON.stringify({
        version: 1,
        documentIds: [''],
        claimedDocumentCount: 1,
        skippedDocumentCount: 0,
      }),
    ],
  ])(
    'fails closed on a SUCCEEDED replay whose recorded claimResult is %s',
    async (_label, recorded) => {
      const tables = await claimTables()
      const ctx = claimCtx(tables)
      const args = claimArgs()

      await runHandler(claimToAuthenticatedCompany, ctx, args)
      const succeeded = await runHandler(claimToAuthenticatedCompany, ctx, args)
      expect(succeeded).toMatchObject({ status: 'SUCCEEDED' })
      expect(tables.intakeSessions[0].claimResult).toMatchObject({ status: 'SUCCEEDED' })
      const documentCount = tables.documents.length
      const versionCount = tables.documentVersions.length

      tables.intakeSessions[0].claimResult = {
        status: 'SUCCEEDED',
        completedAt: 1_700_000_000_000,
        code: recorded,
      }

      await expect(runHandler(claimToAuthenticatedCompany, ctx, args)).rejects.toThrow(
        /reconciliaci/
      )
      expect(tables.documents).toHaveLength(documentCount)
      expect(tables.documentVersions).toHaveLength(versionCount)
    }
  )
})
