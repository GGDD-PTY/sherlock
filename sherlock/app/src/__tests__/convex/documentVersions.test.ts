import { describe, expect, it, vi } from 'vitest'

import { finalizeInspectedUpload } from '../../../convex/_documents/ingest'
import { remove } from '../../../convex/_documents/mutations'
import { listVersions } from '../../../convex/_documents/queries'
import { findDocumentByStorageId, getCompanyDocumentsEffect } from '../../../convex/_documents/shared'
import { runConvex } from '../../../convex/_helpers/effect'
import { restoreVersion } from '../../../convex/_documents/versions'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'
import { mintAdminVdrCapability, TEST_ADMIN_SESSION_ID } from './admin-vdr-capability-test-helper'

const ISSUER_IDENTITY = {
  subject: 'workos_issuer',
  issuer: 'https://api.workos.com/',
  email: 'issuer@example.com',
}

const ADMIN_IDENTITY = {
  subject: 'workos_admin',
  sid: TEST_ADMIN_SESSION_ID,
  issuer: 'https://api.workos.com/',
  email: 'admin@example.com',
}

function tables(): Tables {
  return {
    users: [
      {
        _id: 'user_issuer',
        authProvider: 'workos',
        providerUserId: 'workos_issuer',
        workosUserId: 'workos_issuer',
        email: 'issuer@example.com',
        role: 'COMPANY',
      },
    ],
    profiles: [{ _id: 'profile_issuer', userId: 'user_issuer', role: 'COMPANY', isActive: true }],
    organizationMemberships: [
      {
        _id: 'membership_issuer',
        userId: 'user_issuer',
        profileId: 'profile_issuer',
        authProvider: 'workos',
        providerOrgId: 'org_issuer',
        workosOrgId: 'org_issuer',
        betaRole: 'COMPANY_OWNER',
        profileRole: 'COMPANY',
        status: 'ACTIVE',
        createdAt: 1,
      },
    ],
    companies: [{ _id: 'company_1', ownerId: 'profile_issuer', name: 'Issuer' }],
    companyOrganizationBindings: [
      {
        _id: 'binding_company_1',
        companyId: 'company_1',
        ownerProfileId: 'profile_issuer',
        authProvider: 'workos',
        providerOrgId: 'org_issuer',
        createdAt: 1,
        createdByProfileId: 'profile_issuer',
      },
    ],
    deals: [{ _id: 'deal_1', companyId: 'company_1', title: 'Growth facility' }],
    documents: [],
    documentVersions: [],
    documentAccessGrants: [],
    activityLogs: [],
    rateLimits: [],
    adminAuditLogs: [],
    vdrUploadIntents: [],
  }
}

/**
 * Un perfil ADMIN vivo. Es el destinatario del aviso interno del equipo y, con
 * `ADMIN_IDENTITY`, el actor del caso que sigue rechazado.
 */
function seedTeamProfile(state: Tables) {
  state.users.push({
    _id: 'user_admin',
    authProvider: 'workos',
    providerUserId: 'workos_admin',
    workosUserId: 'workos_admin',
    email: 'admin@example.com',
    role: 'ADMIN',
  })
  state.profiles.push({
    _id: 'profile_admin',
    userId: 'user_admin',
    role: 'ADMIN',
    isActive: true,
  })
}

/**
 * La OTRA rendition del mismo slot: un documento vivo y usable, con su versión
 * publicada. Sin esto un id inventado pasaba por «entrega vigente» y el test no
 * podía ver la diferencia entre una rendition que sirve y una que no.
 */
function seedSiblingRendition(
  state: Tables,
  input: { documentId: string; versionId: string; expiresAt?: number }
) {
  state.documents.push({
    _id: input.documentId,
    companyId: 'company_1',
    dealId: 'deal_1',
    name: 'Management presentation',
    lifecycleStatus: 'ACTIVE',
    storageId: 'storage_sibling',
    currentVersionId: input.versionId,
    publishedVersionId: input.versionId,
    currentVersionNumber: 1,
    accessLevel: 'NDA_REQUIRED',
    classification: 'CONFIDENTIAL',
    isExpired: false,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  })
  state.documentVersions.push({
    _id: input.versionId,
    documentId: input.documentId,
    companyId: 'company_1',
    versionNumber: 1,
    storageId: 'storage_sibling',
    publicationStatus: 'PUBLISHED',
    verificationStatus: 'SIGNATURE_VERIFIED',
    malwareScanStatus: 'CLEAN',
  })
}

function attachStorage(ctx: ReturnType<typeof createConvexCtx>) {
  Object.assign(ctx.db, {
    system: {
      get: vi.fn(async (storageId: string) => ({
        _id: storageId,
        _creationTime: storageId === 'storage_1' ? 1 : 2,
        size: 8,
        contentType: 'application/pdf',
        sha256:
          storageId === 'storage_1'
            ? 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
            : 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      })),
    },
  })
}

function issueFixtureIntent(
  state: Tables,
  input: {
    intentId: string
    storageId: string
    declaredSha256: string
    replaceDocumentId?: string
  }
) {
  const bound = {
    companyId: 'company_1',
    dealId: 'deal_1',
    requestedByProfileId: 'profile_issuer',
    fileName: 'financial-model.pdf',
    declaredMimeType: 'application/pdf',
    declaredByteSize: 8,
    declaredSha256: input.declaredSha256,
    name: 'Financial model',
    accessLevel: 'NDA_REQUIRED',
    classification: 'CONFIDENTIAL',
    folder: 'financial_information',
    ...(input.replaceDocumentId ? { replaceDocumentId: input.replaceDocumentId } : {}),
  }
  state.vdrUploadIntents.push({
    _id: input.intentId,
    ...bound,
    status: 'INSPECTING',
    storageId: input.storageId,
    preparedAt: Date.now(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  return { intentId: input.intentId, storageId: input.storageId, ...bound }
}

async function seedTwoVersions(
  ctx: ReturnType<typeof createConvexCtx>,
  state: Tables
): Promise<string> {
  const firstIntent = issueFixtureIntent(state, {
    intentId: 'intent_1',
    storageId: 'storage_1',
    declaredSha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  })
  const documentId = (await runHandler(finalizeInspectedUpload, ctx, {
    ...firstIntent,
    inspectedSize: 8,
    inspectedSha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    signature: 'PDF',
    malwareScanStatus: 'CLEAN',
    expectedCurrentVersionNumber: 0,
  })) as string
  const secondIntent = issueFixtureIntent(state, {
    intentId: 'intent_2',
    storageId: 'storage_2',
    declaredSha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    replaceDocumentId: documentId,
  })
  await runHandler(finalizeInspectedUpload, ctx, {
    ...secondIntent,
    inspectedSize: 8,
    inspectedSha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    signature: 'PDF',
    malwareScanStatus: 'CLEAN',
    expectedCurrentVersionNumber: 1,
  })
  return documentId
}

describe('document version history and restore', () => {
  it('keeps superseded blobs inside the protected VDR boundary', async () => {
    const state = tables()
    const ctx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(ctx)
    const documentId = await seedTwoVersions(ctx, state)

    const backingDocument = await findDocumentByStorageId(ctx as never, 'storage_1' as never)

    expect(backingDocument?._id).toBe(documentId)
  })

  it('returns a safe owner projection without exposing storage identifiers', async () => {
    const state = tables()
    const ctx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(ctx)
    const documentId = await seedTwoVersions(ctx, state)

    const history = (await runHandler(listVersions, ctx, { documentId })) as Array<
      Record<string, unknown>
    >

    expect(history.map((version) => version.versionNumber)).toEqual([2, 1])
    expect(history[0]).toMatchObject({
      isCurrent: true,
      sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      publicationStatus: 'PUBLISHED',
    })
    expect(history[0]).not.toHaveProperty('storageId')
    expect(history[0]).not.toHaveProperty('createdByProfileId')
  })

  // Un push de operador cuya firma no se pudo verificar entra como DRAFT en
  // cuarentena y NO mueve los punteros: la sala sigue sirviendo la anterior.
  // Al dueno COMPANY eso le anunciaba una entrega que no puede abrir.
  it('hides the quarantined draft from the company owner and keeps it for the admin', async () => {
    const state = tables()
    const ctx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(ctx)
    const documentId = await seedTwoVersions(ctx, state)

    state.documentVersions.push({
      _id: 'version_cuarentena',
      // Por encima de las filas que `insert` numera en el harness: el mock
      // ordena por `_creationTime`, no por el `versionNumber` del indice.
      _creationTime: 99_999,
      documentId,
      companyId: 'company_1',
      dealId: 'deal_1',
      versionNumber: 3,
      storageId: 'storage_3',
      displayName: 'entregable-sin-firma.bin',
      declaredMimeType: 'application/octet-stream',
      detectedMimeType: 'application/octet-stream',
      byteSize: 16,
      sha256: 'e'.repeat(64),
      signatureKind: 'UNKNOWN',
      verificationStatus: 'QUARANTINED',
      malwareScanStatus: 'PENDING',
      publicationStatus: 'DRAFT',
      createdAt: 3,
      createdByProfileId: 'profile_issuer',
    })

    const owned = (await runHandler(listVersions, ctx, { documentId })) as Array<
      Record<string, unknown>
    >
    expect(owned.map((version) => version.versionNumber)).toEqual([2, 1])

    // El mismo perfil, ahora ADMIN: la cuarentena es su cola de trabajo.
    state.profiles[0].role = 'ADMIN'
    state.users[0].role = 'ADMIN'
    const seen = (await runHandler(listVersions, ctx, { documentId })) as Array<
      Record<string, unknown>
    >
    expect(seen.map((version) => version.versionNumber)).toEqual([3, 2, 1])
  })

  it('restores old bytes as a new immutable version and revokes active grants', async () => {
    const state = tables()
    const ctx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(ctx)
    const documentId = await seedTwoVersions(ctx, state)
    const versionOne = state.documentVersions.find((version) => version.versionNumber === 1)!
    expect(versionOne).toMatchObject({
      verificationStatus: 'SIGNATURE_VERIFIED',
      malwareScanStatus: 'CLEAN',
      publicationStatus: 'SUPERSEDED',
      publishedAt: expect.any(Number),
    })
    state.documentAccessGrants.push({
      _id: 'grant_1',
      documentId,
      profileId: 'profile_investor',
      tokenHash: 'token',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })

    const result = await runHandler<
      { documentId: string; versionId: string; expectedCurrentVersionNumber: number },
      { restoredVersionId: string; versionNumber: number }
    >(restoreVersion, ctx, {
      documentId,
      versionId: versionOne._id,
      expectedCurrentVersionNumber: 2,
    })

    const restored = state.documentVersions.find(
      (version) => version._id === result.restoredVersionId
    )
    expect(result.versionNumber).toBe(3)
    expect(restored).toMatchObject({
      versionNumber: 3,
      sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      verificationStatus: 'SIGNATURE_VERIFIED',
      malwareScanStatus: 'CLEAN',
      publicationStatus: 'PUBLISHED',
      restoredFromVersionId: versionOne._id,
    })
    expect(state.documents[0]).toMatchObject({
      storageId: 'storage_1',
      currentVersionNumber: 3,
      currentVersionId: result.restoredVersionId,
    })
    expect(state.documentAccessGrants[0]).toMatchObject({
      revokedAt: expect.any(Number),
      outcome: 'DOCUMENT_VERSION_RESTORED',
    })
    expect(state.activityLogs).toContainEqual(
      expect.objectContaining({ action: 'VDR_DOCUMENT_VERSION_RESTORED' })
    )
  })

  it('restores a published model artifact using the raw Convex Storage digest', async () => {
    const state = tables()
    const ctx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(ctx)
    const documentId = await seedTwoVersions(ctx, state)
    const versionOne = state.documentVersions.find((version) => version.versionNumber === 1)!
    const storageDigest = Buffer.from('a'.repeat(64), 'hex').toString('base64')
    versionOne.sha256 = storageDigest
    Object.assign(ctx.db, {
      system: {
        get: vi.fn(async (storageId: string) => ({
          _id: storageId,
          _creationTime: storageId === 'storage_1' ? 1 : 2,
          size: 8,
          contentType: 'application/pdf',
          sha256:
            storageId === 'storage_1'
              ? storageDigest
              : 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        })),
      },
    })

    const result = await runHandler<
      { documentId: string; versionId: string; expectedCurrentVersionNumber: number },
      { restoredVersionId: string; versionNumber: number }
    >(restoreVersion, ctx, {
      documentId,
      versionId: versionOne._id,
      expectedCurrentVersionNumber: 2,
    })

    expect(
      state.documentVersions.find((version) => version._id === result.restoredVersionId)
    ).toMatchObject({
      storageId: 'storage_1',
      sha256: storageDigest,
      restoredFromVersionId: versionOne._id,
    })
  })

  it.each([
    ['NOT_CONFIGURED', 'NOT_CONFIGURED'],
    ['missing', undefined],
    ['PENDING', 'PENDING'],
    ['ERROR', 'ERROR'],
    ['INFECTED', 'INFECTED'],
  ])('fails closed when the historical source malware status is %s', async (_label, status) => {
    const state = tables()
    const ctx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(ctx)
    const documentId = await seedTwoVersions(ctx, state)
    const versionOne = state.documentVersions.find((version) => version.versionNumber === 1)!
    if (status === undefined) delete versionOne.malwareScanStatus
    else versionOne.malwareScanStatus = status

    await expect(
      runHandler(restoreVersion, ctx, {
        documentId,
        versionId: versionOne._id,
        expectedCurrentVersionNumber: 2,
      })
    ).rejects.toThrow(/scan|malware|restaurar/i)

    expect(state.documentVersions).toHaveLength(2)
    expect(state.documents[0]).toMatchObject({
      currentVersionNumber: 2,
      currentVersionId: state.documentVersions.find((version) => version.versionNumber === 2)?._id,
    })
  })

  it('archives without deleting bytes or immutable history and hides the record from active rooms', async () => {
    const state = tables()
    const ctx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(ctx)
    const documentId = await seedTwoVersions(ctx, state)
    state.documentAccessGrants.push({
      _id: 'grant_archive',
      documentId,
      profileId: 'profile_investor',
      tokenHash: 'token',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })
    const storageDelete = vi.fn()
    Object.assign(ctx, { storage: { delete: storageDelete } })

    const result = await runHandler(remove, ctx, { documentId })

    expect(result).toEqual({ archived: true })
    expect(state.documents).toHaveLength(1)
    expect(state.documentVersions).toHaveLength(2)
    expect(state.documents[0]).toMatchObject({
      _id: documentId,
      lifecycleStatus: 'ARCHIVED',
      archivedByProfileId: 'profile_issuer',
    })
    expect(
      state.documentVersions.find((version) => version._id === state.documents[0]?.currentVersionId)
    ).toMatchObject({ publicationStatus: 'ARCHIVED' })
    expect(state.documentAccessGrants[0]).toMatchObject({
      outcome: 'DOCUMENT_ARCHIVED',
    })
    expect(storageDelete).not.toHaveBeenCalled()
    expect(await runConvex(getCompanyDocumentsEffect(ctx as never, 'company_1' as never))).toEqual([])
  })

  // Este test PINEABA la negativa. La decisión de Maintainer del 2026-09-17
  // —textual: «cada cliente, dueño de sus documentos, no podemos prohibirle
  // borrar sus documentos de su VDR (no es lo mismo que de nuestro database,
  // sino de su VDR solamente)»— la saca del camino de archivar, así que ahora
  // pinea lo que la reemplaza: el dueño quita de su sala la entrega, la
  // rendition queda marcada como retirada, el retiro deja su fila de auditoría
  // y al equipo le suena la campanita. Los bytes no se tocan.
  it('lets the owner withdraw the document that backs a delivered deliverable', async () => {
    const state = tables()
    const ctx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(ctx)
    const documentId = await seedTwoVersions(ctx, state)
    seedTeamProfile(state)
    state.deliverables = [
      {
        _id: 'deliverable_mgmt',
        companyId: 'company_1',
        kind: 'MGMT_PRESENTATION',
        status: 'DELIVERED',
        renditions: [{ format: 'PDF', documentId }],
      },
    ]
    const storageDelete = vi.fn()
    Object.assign(ctx, { storage: { delete: storageDelete } })

    const result = await runHandler(remove, ctx, { documentId })

    expect(result).toEqual({ archived: true })
    expect(state.documents[0]).toMatchObject({ lifecycleStatus: 'ARCHIVED' })
    expect(storageDelete).not.toHaveBeenCalled()
    expect(state.documentVersions).toHaveLength(2)

    // El entregable queda marcado, no borrado ni movido de estado.
    const deliverable = state.deliverables[0]
    expect(deliverable?.status).toBe('DELIVERED')
    expect(deliverable?.renditions).toEqual([
      expect.objectContaining({
        format: 'PDF',
        documentId,
        withdrawnByProfileId: 'profile_issuer',
        withdrawnByClientAt: expect.any(Number),
      }),
    ])

    const withdrawalLog = state.activityLogs.find(
      (row) => row.action === 'VDR_DELIVERABLE_WITHDRAWN_BY_CLIENT'
    )
    expect(withdrawalLog).toMatchObject({
      userId: 'profile_issuer',
      entityType: 'DELIVERABLE',
      entityId: 'deliverable_mgmt',
    })
    expect(withdrawalLog?.metadata).toMatchObject({
      kind: 'MGMT_PRESENTATION',
      fullyWithdrawn: true,
      documentIds: [documentId],
    })

    expect(state.notifications ?? []).toEqual([
      expect.objectContaining({
        userId: 'profile_admin',
        type: 'system',
        entityType: 'deliverable',
        entityId: 'deliverable_mgmt',
        link: '/admin/companies/company_1/documents',
        title: 'Entrega retirada: Issuer',
      }),
    ])
    expect(String(state.notifications?.[0]?.message)).toContain('Presentación de management')
  })

  // El retiro se registra POR RENDITION: mientras al slot le quede una entrega
  // vigente, el entregable no está retirado y el aviso lo dice.
  it('marks only the withdrawn rendition when the deliverable keeps another one', async () => {
    const state = tables()
    const ctx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(ctx)
    const documentId = await seedTwoVersions(ctx, state)
    seedTeamProfile(state)
    seedSiblingRendition(state, { documentId: 'document_pptx', versionId: 'version_pptx' })
    state.deliverables = [
      {
        _id: 'deliverable_mgmt',
        companyId: 'company_1',
        kind: 'MGMT_PRESENTATION',
        status: 'DELIVERED',
        renditions: [
          { format: 'PDF', documentId },
          { format: 'PPTX', documentId: 'document_pptx' },
        ],
      },
    ]

    await runHandler(remove, ctx, { documentId })

    expect(state.deliverables[0]?.renditions).toEqual([
      expect.objectContaining({ format: 'PDF', withdrawnByClientAt: expect.any(Number) }),
      { format: 'PPTX', documentId: 'document_pptx' },
    ])
    const withdrawalLog = state.activityLogs.find(
      (row) => row.action === 'VDR_DELIVERABLE_WITHDRAWN_BY_CLIENT'
    )
    expect(withdrawalLog?.metadata).toMatchObject({ fullyWithdrawn: false })
    expect(String(state.notifications?.[0]?.message)).toContain(
      'El entregable conserva otra entrega vigente.'
    )
  })

  // «Conserva otra entrega vigente» tiene que ser cierto para el CLIENTE. La
  // otra rendition sigue sin sello de retiro, pero su documento está vencido
  // (`documents.update` acepta una fecha pasada), así que `listForCompany` ya
  // no la proyecta: el slot quedó vacío y el aviso lo dice.
  it('reports the deliverable as emptied when the surviving rendition is no longer usable', async () => {
    const state = tables()
    const ctx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(ctx)
    const documentId = await seedTwoVersions(ctx, state)
    seedTeamProfile(state)
    seedSiblingRendition(state, {
      documentId: 'document_pptx',
      versionId: 'version_pptx',
      expiresAt: Date.now() - 60_000,
    })
    state.deliverables = [
      {
        _id: 'deliverable_mgmt',
        companyId: 'company_1',
        kind: 'MGMT_PRESENTATION',
        status: 'DELIVERED',
        renditions: [
          { format: 'PDF', documentId },
          { format: 'PPTX', documentId: 'document_pptx' },
        ],
      },
    ]

    await runHandler(remove, ctx, { documentId })

    const withdrawalLog = state.activityLogs.find(
      (row) => row.action === 'VDR_DELIVERABLE_WITHDRAWN_BY_CLIENT'
    )
    expect(withdrawalLog?.metadata).toMatchObject({ fullyWithdrawn: true })
    expect(String(state.notifications?.[0]?.message)).toContain(
      'El entregable se quedó sin entrega vigente.'
    )
  })

  // El equipo devolvió a la sala el documento retirado
  // (`operatorRestore.restoreArchivedDocuments`), que no toca el sello viejo de
  // la rendition. El segundo retiro tiene que sonar igual que el primero: fila
  // de auditoría, campanita y sello nuevo con la fecha de hoy.
  it('logs and announces a second withdrawal of a document the team put back', async () => {
    const state = tables()
    const ctx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(ctx)
    const documentId = await seedTwoVersions(ctx, state)
    seedTeamProfile(state)
    state.deliverables = [
      {
        _id: 'deliverable_mgmt',
        companyId: 'company_1',
        kind: 'MGMT_PRESENTATION',
        status: 'DELIVERED',
        renditions: [
          {
            format: 'PDF',
            documentId,
            // El sello que dejó el primer retiro y que la restauración no borra.
            withdrawnByClientAt: 1,
            withdrawnByProfileId: 'profile_issuer',
          },
        ],
      },
    ]

    await runHandler(remove, ctx, { documentId })

    expect(state.deliverables[0]?.renditions).toEqual([
      expect.objectContaining({
        format: 'PDF',
        documentId,
        withdrawnByProfileId: 'profile_issuer',
      }),
    ])
    const renditions = (state.deliverables[0]?.renditions ?? []) as Array<Record<string, unknown>>
    const rendition = renditions[0]
    expect(Number(rendition?.withdrawnByClientAt)).toBeGreaterThan(1)

    const withdrawalLogs = state.activityLogs.filter(
      (row) => row.action === 'VDR_DELIVERABLE_WITHDRAWN_BY_CLIENT'
    )
    expect(withdrawalLogs).toHaveLength(1)
    expect(withdrawalLogs[0]?.metadata).toMatchObject({ fullyWithdrawn: true })
    expect(state.notifications ?? []).toEqual([
      expect.objectContaining({ userId: 'profile_admin', entityType: 'deliverable' }),
    ])
  })

  // El nombre de la empresa lo escribe el cliente y de acá sale al asunto y al
  // texto plano del correo del equipo, que no escapan nada. Un `\r\n` adentro
  // falsearía una segunda alerta, así que pasa por el mismo normalizador que el
  // resto del carril interno.
  it('keeps a client-written document name on one line in the team alert', async () => {
    const state = tables()
    const ctx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(ctx)
    const documentId = await seedTwoVersions(ctx, state)
    seedTeamProfile(state)
    const document = state.documents.find((row) => row._id === documentId)
    if (!document) throw new Error('seedTwoVersions no dejó el documento')
    document.name = 'Modelo\r\n\r\n[Sherlock] Entrega retirada: Otra Empresa\u0007'
    state.deliverables = [
      {
        _id: 'deliverable_mgmt',
        companyId: 'company_1',
        kind: 'MGMT_PRESENTATION',
        status: 'DELIVERED',
        renditions: [{ format: 'PDF', documentId }],
      },
    ]

    await runHandler(remove, ctx, { documentId })

    const notification = state.notifications?.[0]
    expect(String(notification?.message)).toContain(
      '«Modelo [Sherlock] Entrega retirada: Otra Empresa»'
    )
    expect(String(notification?.message)).not.toMatch(/\p{Cc}/u)
  })

  it('never lets a client-written company name forge the team alert', async () => {
    const state = tables()
    const ctx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(ctx)
    const documentId = await seedTwoVersions(ctx, state)
    seedTeamProfile(state)
    state.companies[0].name = 'Acme\r\n\r\n[Sherlock] Entrega retirada: Otra Empresa'
    state.deliverables = [
      {
        _id: 'deliverable_mgmt',
        companyId: 'company_1',
        kind: 'MGMT_PRESENTATION',
        status: 'DELIVERED',
        renditions: [{ format: 'PDF', documentId }],
      },
    ]

    await runHandler(remove, ctx, { documentId })

    // El salto de línea se colapsa: el asunto del correo queda en una sola
    // línea y no puede hacerse pasar por dos alertas.
    const notification = state.notifications?.[0]
    expect(notification?.title).toBe(
      'Entrega retirada: Acme [Sherlock] Entrega retirada: Otra Empresa'
    )
    expect(String(notification?.message)).not.toMatch(/\p{Cc}/u)
  })

  // El otro lado del mismo normalizador: lo que no es un nombre de empresa
  // —un carácter de control que no es espacio, o un texto sobre el techo de 120
  // caracteres— no llega al aviso del equipo.
  it('falls back to the unidentified label when the company name is not a name', async () => {
    const state = tables()
    const ctx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(ctx)
    const documentId = await seedTwoVersions(ctx, state)
    seedTeamProfile(state)
    state.companies[0].name = `Acme\u0007${'x'.repeat(200)}`
    state.deliverables = [
      {
        _id: 'deliverable_mgmt',
        companyId: 'company_1',
        kind: 'MGMT_PRESENTATION',
        status: 'DELIVERED',
        renditions: [{ format: 'PDF', documentId }],
      },
    ]

    await runHandler(remove, ctx, { documentId })

    expect(state.notifications?.[0]?.title).toBe('Entrega retirada: Empresa sin identificar')
  })

  // Lo que NO cambia: el equipo no saca su propia entrega archivando el
  // documento por debajo del slot. La retira desde Admin ([F] 2026-09-17,
  // punto 4 del brief).
  it('still refuses when an ADMIN archives the document that backs a delivered deliverable', async () => {
    const state = tables()
    const seedCtx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(seedCtx)
    const documentId = await seedTwoVersions(seedCtx, state)
    seedTeamProfile(state)
    state.deliverables = [
      {
        _id: 'deliverable_mgmt',
        companyId: 'company_1',
        kind: 'MGMT_PRESENTATION',
        status: 'DELIVERED',
        renditions: [{ format: 'PDF', documentId }],
      },
    ]

    const ctx = createConvexCtx(state, { identity: ADMIN_IDENTITY })
    attachStorage(ctx)
    const args = await mintAdminVdrCapability({
      tables: state,
      input: { documentId },
      companyId: 'company_1',
      action: 'DOCUMENT_ARCHIVE',
      target: `DOCUMENT:${documentId}`,
    })

    await expect(runHandler(remove, ctx, args)).rejects.toThrow(/entrega del equipo/i)

    expect(state.documents[0]?.lifecycleStatus).not.toBe('ARCHIVED')
    expect(state.deliverables[0]?.renditions).toEqual([{ format: 'PDF', documentId }])
    expect(state.notifications ?? []).toEqual([])
  })

  // El contrapeso: un slot en preparación no es trabajo publicado, así que el
  // dueño de la sala sigue archivando sus propios archivos.
  it('still archives when the deliverable that lists the document is a draft', async () => {
    const state = tables()
    const ctx = createConvexCtx(state, { identity: ISSUER_IDENTITY })
    attachStorage(ctx)
    const documentId = await seedTwoVersions(ctx, state)
    state.deliverables = [
      {
        _id: 'deliverable_draft',
        companyId: 'company_1',
        kind: 'MGMT_PRESENTATION',
        status: 'DRAFT',
        renditions: [{ format: 'PDF', documentId }],
      },
    ]

    const result = await runHandler(remove, ctx, { documentId })

    expect(result).toEqual({ archived: true })
    expect(state.documents[0]).toMatchObject({ lifecycleStatus: 'ARCHIVED' })
  })
})
