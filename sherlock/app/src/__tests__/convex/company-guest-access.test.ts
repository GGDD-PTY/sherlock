import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCompanyGuestInvitation,
  getCompanyGuestNda,
  acceptCompanyGuestNda,
  resolveCompanyGuestDocument,
} from '../../../convex/_guests/companyRoom'
import {
  prepareOtpChallengeForDelivery,
  revokeGuestInvitationRecord,
} from '../../../convex/_guests/service'
import {
  revokeGuestSessionRecord,
  verifyGuestOtpAndCreateSession,
} from '../../../convex/_guests/sessions'
import { buildGuestRoomProjection } from '../../../convex/_guests/projection'
import { sha256Hex } from '../../../convex/_adminVdr/capability'
import { hashGuestSessionToken } from '../../../convex/_guests/crypto'
import { requireAuth } from '../../../convex/_helpers/auth'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const NOW = 1_790_000_000_000
import {
  authorizeCompanyGuestDocument,
  configureCompanyNda,
  acceptCompanyNda,
} from '../../../convex/guestAccess'
import { mintAdminVdrCapability, TEST_ADMIN_SESSION_ID } from './admin-vdr-capability-test-helper'
import { withGuestServerProof } from './guest-server-proof-fixture'
const CONTENT = 'TEST FIXTURE ONLY. Approved confidentiality text.'
const identity = (name: string) => ({
  subject: `workos_${name}`,
  issuer: 'https://api.workos.com/',
  email: `${name}@example.com`,
})
async function fixture() {
  const tables: Tables = {
    users: ['owner', 'outsider', 'admin'].map((name) => ({
      _id: `user_${name}`,
      authProvider: 'workos',
      providerUserId: `workos_${name}`,
      workosUserId: `workos_${name}`,
      email: `${name}@example.com`,
      role: name === 'admin' ? 'ADMIN' : 'COMPANY',
    })),
    profiles: ['owner', 'outsider', 'admin'].map((name) => ({
      _id: `profile_${name}`,
      userId: `user_${name}`,
      role: name === 'admin' ? 'ADMIN' : 'COMPANY',
      isActive: true,
    })),
    companies: [
      { _id: 'company_1', ownerId: 'profile_owner', name: 'SAMPLE_LOGISTICS' },
      { _id: 'company_2', ownerId: 'profile_outsider', name: 'Other' },
    ],
    guestNdaTemplates: [
      {
        _id: 'template_1',
        companyId: 'company_1',
        title: 'Test NDA',
        content: CONTENT,
        contentHash: await sha256Hex(CONTENT),
        locale: 'es',
        version: '1',
        active: true,
        approvedAt: NOW - 1000,
        approvedByProfileId: 'profile_admin',
      },
    ],
    documents: ['selected', 'unselected', 'foreign'].map((name) => ({
      _id: `doc_${name}`,
      companyId: name === 'foreign' ? 'company_2' : 'company_1',
      name: `${name}.pdf`,
      fileType: 'application/pdf',
      fileSize: 50,
      folder: 'room_financial',
      accessLevel: 'NDA_REQUIRED',
      classification: 'CONFIDENTIAL',
      lifecycleStatus: 'ACTIVE',
      storageId: `storage_${name}`,
      currentVersionId: `version_${name}`,
      publishedVersionId: `version_${name}`,
    })),
    documentVersions: ['selected', 'unselected', 'foreign'].map((name) => ({
      _id: `version_${name}`,
      documentId: `doc_${name}`,
      companyId: name === 'foreign' ? 'company_2' : 'company_1',
      storageId: `storage_${name}`,
      versionNumber: 1,
      publicationStatus: 'PUBLISHED',
      verificationStatus: 'SIGNATURE_VERIFIED',
      malwareScanStatus: 'CLEAN',
      fileName: `${name}.pdf`,
      detectedMimeType: 'application/pdf',
      declaredMimeType: 'application/pdf',
      signatureKind: 'PDF',
      byteSize: 50,
    })),
    guestInvitations: [],
    guestSessions: [],
    guestOtpChallenges: [],
    guestNdaAcceptances: [],
    activityLogs: [],
    rateLimits: [],
  }
  const ctx = createConvexCtx(tables, { identity: identity('owner') })
  const actor = await requireAuth(ctx as never)
  return { tables, ctx, actor }
}
async function invited() {
  const f = await fixture()
  const created = await createCompanyGuestInvitation(f.ctx as never, {
    companyId: 'company_1' as never,
    documentIds: ['doc_selected' as never],
    email: 'guest@example.com',
    expiresInDays: 7,
    locale: 'es',
    actor: f.actor,
    now: NOW,
  })
  return { ...f, created }
}
async function verified() {
  const f = await invited()
  const prepared = await prepareOtpChallengeForDelivery(f.ctx as never, {
    invitationHandle: f.created.invitationHandle,
    email: 'guest@example.com',
    now: NOW,
    createCode: () => '123456',
  })
  const result = await verifyGuestOtpAndCreateSession(f.ctx as never, {
    invitationHandle: f.created.invitationHandle,
    challengeToken: prepared.response.challengeToken,
    code: '123456',
    now: NOW,
  })
  if (!result.verified) throw new Error('Fixture OTP failed')
  return { ...f, sessionToken: result.sessionToken }
}
async function accepted() {
  const f = await verified()
  await acceptCompanyGuestNda(f.ctx as never, {
    sessionToken: f.sessionToken,
    contentHash: await sha256Hex(CONTENT),
    signatoryName: 'Test Guest',
    now: NOW,
  })
  return f
}
beforeEach(() => {
  vi.stubEnv('CONVEX_ENV', 'dev')
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('company room guest boundaries', () => {
  it('invites only selected current published documents of the company room', async () => {
    const { tables, created } = await invited()
    expect(created.invitation).toMatchObject({
      companyId: 'company_1',
      companyRoom: {
        documents: [{ documentId: 'doc_selected', versionId: 'version_selected' }],
        ndaTemplateId: 'template_1',
      },
    })
    expect(JSON.stringify(tables)).not.toContain(created.invitationHandle)
  })
  it.each(['outsider', 'admin'])('denies %s without exact management authority', async (name) => {
    const f = await fixture()
    const actor = await requireAuth(
      createConvexCtx(f.tables, { identity: identity(name) }) as never
    )
    await expect(
      createCompanyGuestInvitation(f.ctx as never, {
        companyId: 'company_1' as never,
        documentIds: ['doc_selected' as never],
        email: 'guest@example.com',
        expiresInDays: 7,
        locale: 'es',
        actor,
        now: NOW,
      })
    ).rejects.toThrow(/permiso|administrativa/i)
    expect(f.tables.guestInvitations).toHaveLength(0)
  })
  it.each([
    'missingNda',
    'foreign',
    'unpublished',
    'empty',
    'private',
    'sensitive',
    'scanPending',
    'expired',
  ])('fails closed for %s', async (failure) => {
    const f = await fixture()
    if (failure === 'missingNda') f.tables.guestNdaTemplates = []
    if (failure === 'private') f.tables.documents[0].accessLevel = 'PRIVATE'
    if (failure === 'sensitive') f.tables.documents[0].classification = 'KYC_SENSITIVE'
    if (failure === 'scanPending') f.tables.documentVersions[0].malwareScanStatus = 'PENDING'
    if (failure === 'expired') f.tables.documents[0].expiresAt = NOW
    if (failure === 'unpublished') f.tables.documentVersions[0].publicationStatus = 'DRAFT'
    const ids =
      failure === 'foreign' ? ['doc_foreign'] : failure === 'empty' ? [] : ['doc_selected']
    await expect(
      createCompanyGuestInvitation(f.ctx as never, {
        companyId: 'company_1' as never,
        documentIds: ids as never,
        email: 'guest@example.com',
        expiresInDays: 7,
        locale: 'es',
        actor: f.actor,
        now: NOW,
      })
    ).rejects.toThrow()
    expect(f.tables.guestInvitations).toHaveLength(0)
  })
  // La UI ya deshabilita 31 días; la mutation es la frontera real (curl, MCP,
  // un cliente viejo). Sin estos bounds un invitador salta el NDA de 30 días o
  // mete un lote que no cabe en la proyección de la sala.
  it.each([
    { name: 'zero days', patch: { expiresInDays: 0 } },
    { name: 'thirty-one days', patch: { expiresInDays: 31 } },
    { name: 'a fractional duration', patch: { expiresInDays: 1.5 } },
    {
      name: 'more than fifty documents',
      patch: { documentIds: Array.from({ length: 51 }, (_, index) => `doc_${index}`) },
    },
    { name: 'english without an approved template', patch: { locale: 'en' } },
  ])('rejects an invitation with $name', async ({ patch }) => {
    const f = await fixture()
    await expect(
      createCompanyGuestInvitation(
        f.ctx as never,
        {
          companyId: 'company_1' as never,
          documentIds: ['doc_selected' as never],
          email: 'guest@example.com',
          expiresInDays: 7,
          locale: 'es',
          actor: f.actor,
          now: NOW,
          ...patch,
        } as never
      )
    ).rejects.toThrow()
    expect(f.tables.guestInvitations).toHaveLength(0)
  })
  it('refuses to invite when two active NDA templates share the locale', async () => {
    const f = await fixture()
    f.tables.guestNdaTemplates.push({ ...f.tables.guestNdaTemplates[0], _id: 'template_2' })
    await expect(
      createCompanyGuestInvitation(f.ctx as never, {
        companyId: 'company_1' as never,
        documentIds: ['doc_selected' as never],
        email: 'guest@example.com',
        expiresInDays: 7,
        locale: 'es',
        actor: f.actor,
        now: NOW,
      })
    ).rejects.toThrow()
    expect(f.tables.guestInvitations).toHaveLength(0)
  })
  it('rejects a second live invitation to the same email, even with different casing', async () => {
    const f = await invited()
    await expect(
      createCompanyGuestInvitation(f.ctx as never, {
        companyId: 'company_1' as never,
        documentIds: ['doc_selected' as never],
        email: 'Guest@Example.com',
        expiresInDays: 7,
        locale: 'es',
        actor: f.actor,
        now: NOW,
      })
    ).rejects.toThrow()
    expect(f.tables.guestInvitations).toHaveLength(1)
  })
  it('audits company-room session lifecycle against the company', async () => {
    const f = await verified()
    expect(
      f.tables.activityLogs.find((row) => row.action === 'GUEST_SESSION_CREATED')
    ).toMatchObject({
      metadata: { resourceType: 'COMPANY', resourceId: 'company_1' },
    })
    await revokeGuestSessionRecord(f.ctx as never, { sessionToken: f.sessionToken, now: NOW })
    expect(
      f.tables.activityLogs.find((row) => row.action === 'GUEST_SESSION_REVOKED')
    ).toMatchObject({
      metadata: { resourceType: 'COMPANY', resourceId: 'company_1' },
    })
  })
  it('requires verified OTP and exact approved NDA before granting room access', async () => {
    const f = await verified()
    expect(
      await buildGuestRoomProjection(f.ctx as never, { sessionToken: f.sessionToken, now: NOW })
    ).toMatchObject({ authenticated: true, roomAccessGranted: false, requiredGates: ['NDA'] })
    expect(
      await getCompanyGuestNda(f.ctx as never, { sessionToken: f.sessionToken, now: NOW })
    ).toMatchObject({ content: CONTENT })
    await expect(
      acceptCompanyGuestNda(f.ctx as never, {
        sessionToken: f.sessionToken,
        contentHash: '0'.repeat(64),
        signatoryName: 'Test Guest',
        now: NOW,
      })
    ).rejects.toThrow()
    await acceptCompanyGuestNda(f.ctx as never, {
      sessionToken: f.sessionToken,
      contentHash: await sha256Hex(CONTENT),
      signatoryName: 'Test Guest',
      now: NOW,
    })
    const projection = await buildGuestRoomProjection(f.ctx as never, {
      sessionToken: f.sessionToken,
      now: NOW,
    })
    expect(projection).toMatchObject({
      roomAccessGranted: true,
      room: { title: 'SAMPLE_LOGISTICS' },
      documents: [
        {
          name: 'selected.pdf',
          viewPath: '/api/vdr/guest/documents/doc_selected',
          downloadable: false,
        },
      ],
    })
    if (!projection.authenticated || !projection.roomAccessGranted)
      throw new Error('Expected authorized room')
    expect(projection.documents).toHaveLength(1)
    expect(JSON.stringify(projection)).not.toContain('storage_')
    expect(f.tables.guestNdaAcceptances).toHaveLength(1)
  })
  it('delivers only the selected version and immediately denies revoked, foreign and unpublished documents', async () => {
    const f = await accepted()
    expect(
      await resolveCompanyGuestDocument(f.ctx as never, {
        sessionToken: f.sessionToken,
        documentId: 'doc_selected' as never,
        now: NOW,
      })
    ).toMatchObject({
      documentId: 'doc_selected',
      versionId: 'version_selected',
      storageId: 'storage_selected',
    })
    for (const documentId of ['doc_unselected', 'doc_foreign']) {
      await expect(
        resolveCompanyGuestDocument(f.ctx as never, {
          sessionToken: f.sessionToken,
          documentId: documentId as never,
          now: NOW,
        })
      ).rejects.toThrow()
    }
    f.tables.documentVersions[0].publicationStatus = 'DRAFT'
    await expect(
      resolveCompanyGuestDocument(f.ctx as never, {
        sessionToken: f.sessionToken,
        documentId: 'doc_selected' as never,
        now: NOW,
      })
    ).rejects.toThrow()
    f.tables.documentVersions[0].publicationStatus = 'PUBLISHED'
    const invitation = await f.ctx.db.get(f.created.invitation._id)
    await revokeGuestInvitationRecord(f.ctx as never, {
      invitation: invitation as never,
      actorProfileId: 'profile_owner' as never,
      reason: 'Test revocation',
      now: NOW,
    })
    await expect(
      resolveCompanyGuestDocument(f.ctx as never, {
        sessionToken: f.sessionToken,
        documentId: 'doc_selected' as never,
        now: NOW,
      })
    ).rejects.toThrow()
    expect(
      await buildGuestRoomProjection(f.ctx as never, { sessionToken: f.sessionToken, now: NOW })
    ).toEqual({ authenticated: false })
  })
  it('rejects a replaced version, disabled NDA and expired session', async () => {
    const f = await accepted()
    f.tables.documents[0].currentVersionId = 'version_new'
    await expect(
      resolveCompanyGuestDocument(f.ctx as never, {
        sessionToken: f.sessionToken,
        documentId: 'doc_selected' as never,
        now: NOW,
      })
    ).rejects.toThrow()
    f.tables.documents[0].currentVersionId = 'version_selected'
    f.tables.guestNdaTemplates[0].active = false
    await expect(
      resolveCompanyGuestDocument(f.ctx as never, {
        sessionToken: f.sessionToken,
        documentId: 'doc_selected' as never,
        now: NOW,
      })
    ).rejects.toThrow()
    f.tables.guestNdaTemplates[0].active = true
    await expect(
      resolveCompanyGuestDocument(f.ctx as never, {
        sessionToken: f.sessionToken,
        documentId: 'doc_selected' as never,
        now: NOW + 31 * 60000,
      })
    ).rejects.toThrow()
  })
})

it('requires stepped-up ADMIN capability to configure text and records its exact hash', async () => {
  const f = await fixture()
  const input = {
    companyId: 'company_1',
    title: 'Approved test NDA',
    content: 'TEST ONLY revised terms',
    version: '2',
    locale: 'es',
  }
  await expect(runHandler(configureCompanyNda, f.ctx, input)).rejects.toThrow(/equipo/)
  const adminCtx = createConvexCtx(f.tables, {
    identity: { ...identity('admin'), sid: TEST_ADMIN_SESSION_ID },
  })
  await expect(runHandler(configureCompanyNda, adminCtx, input)).rejects.toThrow(/administrativa/)
  const args = await mintAdminVdrCapability({
    tables: f.tables,
    input,
    companyId: 'company_1',
    action: 'GUEST_INVITE',
    target: 'COMPANY_NDA:company_1',
    issuedAt: NOW,
  })
  await runHandler(configureCompanyNda, adminCtx, args)
  expect(f.tables.guestNdaTemplates[0].active).toBe(false)
  expect(f.tables.guestNdaTemplates[1]).toMatchObject({
    contentHash: await sha256Hex(input.content),
    approvedByProfileId: 'profile_admin',
    active: true,
  })
  expect(f.tables.adminAuditLogs.some((row) => row.action === 'NDA_TEMPLATE_CREATE')).toBe(true)
  await expect(runHandler(configureCompanyNda, adminCtx, args)).rejects.toThrow(/administrativa/)
})
it('allows an ADMIN invitation only with the exact consumed and audited capability', async () => {
  const f = await fixture()
  const actor = await requireAuth(
    createConvexCtx(f.tables, {
      identity: { ...identity('admin'), sid: TEST_ADMIN_SESSION_ID },
    }) as never
  )
  const input = {
    companyId: 'company_1',
    documentIds: ['doc_selected'],
    email: 'guest@example.com',
    expiresInDays: 7,
    locale: 'es',
  }
  const args = await mintAdminVdrCapability({
    tables: f.tables,
    input,
    companyId: 'company_1',
    action: 'GUEST_INVITE',
    target: 'COMPANY:company_1',
    issuedAt: NOW,
  })
  const created = await createCompanyGuestInvitation(f.ctx as never, {
    ...args,
    companyId: 'company_1' as never,
    documentIds: ['doc_selected' as never],
    locale: 'es',
    actor,
    now: NOW,
  })
  expect(created.invitation.createdByProfileId).toBe('profile_admin')
  expect(f.tables.adminVdrCapabilities[0].consumedAt).toBe(NOW)
  expect(f.tables.adminAuditLogs.some((row) => row.action === 'VDR_ADMIN_CAPABILITY_CONSUME')).toBe(
    true
  )
})
it('requires session-bound server proofs for NDA acceptance and document delivery', async () => {
  const f = await accepted()
  const ctx = {
    ...f.ctx,
    storage: { getUrl: vi.fn(async () => 'https://storage.example/private') },
  }
  const args = { sessionToken: f.sessionToken, documentId: 'doc_selected' }
  await expect(
    runHandler(authorizeCompanyGuestDocument, ctx, {
      ...args,
      serverIssuedAt: NOW,
      serverProof: '',
    })
  ).rejects.toThrow()
  const proof = withGuestServerProof('VIEW_DOCUMENT', [f.sessionToken, 'doc_selected'], args, NOW)
  const authorized = await runHandler(authorizeCompanyGuestDocument, ctx, proof)
  expect(authorized).toEqual({
    storageId: 'storage_selected',
    documentId: 'doc_selected',
    versionId: 'version_selected',
    invitationId: f.created.invitation._id,
    guestLabel: f.tables.guestInvitations[0].emailMasked,
    fileName: f.tables.documents[0].name,
  })
  // La URL de storage es permanente y sin auth: autorizar no puede acuñarla.
  expect(ctx.storage.getUrl).not.toHaveBeenCalled()
  await expect(
    runHandler(authorizeCompanyGuestDocument, ctx, { ...proof, documentId: 'doc_unselected' })
  ).rejects.toThrow()
  await expect(
    runHandler(acceptCompanyNda, ctx, {
      sessionToken: f.sessionToken,
      contentHash: await sha256Hex(CONTENT),
      signatoryName: 'Test Guest',
      serverIssuedAt: NOW,
      serverProof: '',
    })
  ).rejects.toThrow()
})
// `VDR_GUEST_SERVER_OPERATION_REPLAY_POLICY` declara VIEW_DOCUMENT como
// RATE_LIMITED. La prueba de servidor no lo verifica —ni le toca—: quien lo
// cumple es el presupuesto por sesion de `loadSessionByRawToken`. Este test
// convierte esa declaracion en algo ejecutado, para que un refactor que suelte
// el presupuesto no deje la politica reclamando algo que ya no pasa.
it('spends the per-session budget on every authorized document view', async () => {
  const f = await accepted()
  const key = `guestSession:${await hashGuestSessionToken(f.sessionToken)}`
  const budget = f.tables.rateLimits.find((row) => row.key === key)
  if (!budget) throw new Error('La sesion de invitado no gasto presupuesto de rate limit')

  budget.count = 120
  const args = { sessionToken: f.sessionToken, documentId: 'doc_selected' }
  const proof = withGuestServerProof('VIEW_DOCUMENT', [f.sessionToken, 'doc_selected'], args, NOW)

  await expect(runHandler(authorizeCompanyGuestDocument, f.ctx, proof)).rejects.toThrow(
    /Rate limit/
  )
})

it('rejects a wrong OTP, swapped session identity and a modified NDA artifact', async () => {
  const f = await invited()
  const prepared = await prepareOtpChallengeForDelivery(f.ctx as never, {
    invitationHandle: f.created.invitationHandle,
    email: 'guest@example.com',
    now: NOW,
    createCode: () => '123456',
  })
  const args = {
    invitationHandle: f.created.invitationHandle,
    challengeToken: prepared.response.challengeToken,
    now: NOW,
  }
  expect(await verifyGuestOtpAndCreateSession(f.ctx as never, { ...args, code: '654321' })).toEqual(
    { verified: false }
  )
  const verification = await verifyGuestOtpAndCreateSession(f.ctx as never, {
    ...args,
    code: '123456',
  })
  if (!verification.verified) throw new Error('Fixture OTP failed')
  const session = { sessionToken: verification.sessionToken, now: NOW }
  f.tables.guestNdaTemplates[0].content = 'Changed without a new approval'
  expect(await getCompanyGuestNda(f.ctx as never, session)).toBeNull()
  f.tables.guestNdaTemplates[0].content = CONTENT
  f.tables.guestSessions[0].guestId = 'another_guest'
  expect(await buildGuestRoomProjection(f.ctx as never, session)).toEqual({ authenticated: false })
})

it('rejects an NDA signature that is not a real name', async () => {
  const f = await verified()
  const contentHash = await sha256Hex(CONTENT)
  await expect(
    acceptCompanyGuestNda(f.ctx as never, {
      sessionToken: f.sessionToken,
      contentHash,
      signatoryName: 'A',
      now: NOW,
    })
  ).rejects.toThrow()
  await expect(
    acceptCompanyGuestNda(f.ctx as never, {
      sessionToken: f.sessionToken,
      contentHash,
      signatoryName: 'x'.repeat(151),
      now: NOW,
    })
  ).rejects.toThrow()
  expect(f.tables.guestNdaAcceptances).toHaveLength(0)
})

it('does not treat mutable document labels as proof of PDF bytes', async () => {
  const f = await accepted()
  f.tables.documentVersions[0].detectedMimeType = 'text/plain'
  f.tables.documentVersions[0].signatureKind = 'TEXT'
  await expect(
    resolveCompanyGuestDocument(f.ctx as never, {
      sessionToken: f.sessionToken,
      documentId: 'doc_selected' as never,
      now: NOW,
    })
  ).rejects.toThrow()
})
