import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getForCompany, publish } from '../../../convex/financialSnapshots'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const NOW = 1_900_000_000_000
const COMPANY_ID = 'company_issuer'
const COMPANY_NAME = 'Issuer One'
const OWNER_IDENTITY = {
  subject: 'workos_owner',
  issuer: 'https://api.workos.com/',
  email: 'owner@example.com',
}

function baseTables(): Tables {
  return {
    users: [
      {
        _id: 'user_owner',
        authProvider: 'workos',
        providerUserId: 'workos_owner',
        workosUserId: 'workos_owner',
        email: 'owner@example.com',
        role: 'COMPANY',
      },
      {
        _id: 'user_admin',
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'fixture-dbeda5ff@example.com',
        role: 'ADMIN',
      },
    ],
    profiles: [
      {
        _id: 'profile_owner',
        userId: 'user_owner',
        role: 'COMPANY',
        isActive: true,
      },
      {
        _id: 'profile_admin',
        userId: 'user_admin',
        role: 'ADMIN',
        isActive: true,
      },
    ],
    companies: [{ _id: COMPANY_ID, ownerId: 'profile_owner', name: COMPANY_NAME }],
    organizationMemberships: [
      {
        _id: 'membership_owner',
        userId: 'user_owner',
        profileId: 'profile_owner',
        authProvider: 'workos',
        providerOrgId: 'org_issuer',
        workosOrgId: 'org_issuer',
        betaRole: 'COMPANY_OWNER',
        profileRole: 'COMPANY',
        status: 'ACTIVE',
        createdAt: 1,
      },
    ],
    companyOrganizationBindings: [
      {
        _id: 'binding_issuer',
        companyId: COMPANY_ID,
        ownerProfileId: 'profile_owner',
        authProvider: 'workos',
        providerOrgId: 'org_issuer',
        createdAt: 1,
        createdByProfileId: 'profile_admin',
      },
    ],
    documents: [
      {
        _id: 'document_financials',
        companyId: COMPANY_ID,
        name: 'Estados financieros FY25.pdf',
        lifecycleStatus: 'ACTIVE',
        storageId: 'storage_financials_v1',
        currentVersionId: 'version_financials_v1',
        publishedVersionId: 'version_financials_v1',
      },
    ],
    documentVersions: [
      {
        _id: 'version_financials_v1',
        documentId: 'document_financials',
        companyId: COMPANY_ID,
        versionNumber: 1,
        storageId: 'storage_financials_v1',
        publicationStatus: 'PUBLISHED',
        verificationStatus: 'SIGNATURE_VERIFIED',
        malwareScanStatus: 'NOT_CONFIGURED',
      },
    ],
    financialSnapshots: [],
    adminAuditLogs: [],
  }
}

function publishArgs(value = 12_500_000) {
  return {
    companyId: COMPANY_ID,
    operatorProfileId: 'profile_admin',
    confirmCompanyName: COMPANY_NAME,
    reviewNote: '  Revisado contra los estados financieros aprobados.  ',
    metrics: [
      {
        metric: 'REVENUE',
        period: '  FY2025  ',
        periodEnd: '2025-12-31',
        value,
        currency: 'USD',
        source: {
          documentId: 'document_financials',
          versionId: 'version_financials_v1',
          locator: { kind: 'PAGE', page: 14 },
        },
      },
    ],
  }
}

describe('financialSnapshots', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('publica una fila manual acotada, normalizada y auditada', async () => {
    const tables = baseTables()
    const ctx = createConvexCtx(tables)

    const result = await runHandler(publish, ctx, publishArgs())

    expect(result).toMatchObject({
      companyId: COMPANY_ID,
      publishedAt: NOW,
      metricCount: 1,
      replaced: false,
    })
    expect(tables.financialSnapshots).toEqual([
      expect.objectContaining({
        companyId: COMPANY_ID,
        publishedAt: NOW,
        reviewedByProfileId: 'profile_admin',
        reviewNote: 'Revisado contra los estados financieros aprobados.',
        metrics: [
          {
            metric: 'REVENUE',
            period: 'FY2025',
            periodEnd: '2025-12-31',
            value: 12_500_000,
            currency: 'USD',
            source: {
              documentId: 'document_financials',
              versionId: 'version_financials_v1',
              locator: { kind: 'PAGE', page: 14 },
            },
          },
        ],
      }),
    ])
    expect(tables.adminAuditLogs).toEqual([
      expect.objectContaining({
        adminProfileId: 'profile_admin',
        action: 'SYSTEM_CONFIG_CHANGE',
        targetType: 'COMPANY',
        targetId: COMPANY_ID,
        newValue: {
          financialSnapshot: {
            publishedAt: NOW,
            metricCount: 1,
            sourceDocumentCount: 1,
          },
        },
      }),
    ])
  })

  it('reemplaza la fila de la empresa en vez de acumular historial', async () => {
    const tables = baseTables()
    const ctx = createConvexCtx(tables)
    const first = await runHandler<ReturnType<typeof publishArgs>, { snapshotId: string }>(
      publish,
      ctx,
      publishArgs()
    )
    vi.setSystemTime(NOW + 1_000)

    const second = await runHandler<
      ReturnType<typeof publishArgs>,
      { snapshotId: string; replaced: boolean }
    >(publish, ctx, publishArgs(13_000_000))

    expect(second).toEqual(
      expect.objectContaining({ snapshotId: first.snapshotId, replaced: true })
    )
    expect(tables.financialSnapshots).toHaveLength(1)
    expect(tables.financialSnapshots[0]).toEqual(
      expect.objectContaining({
        publishedAt: NOW + 1_000,
        metrics: [expect.objectContaining({ value: 13_000_000 })],
      })
    )
    expect(tables.adminAuditLogs[1]).toEqual(
      expect.objectContaining({
        previousValue: { financialSnapshot: { publishedAt: NOW, metricCount: 1 } },
      })
    )
  })

  it('rechaza referencias que no apuntan a la versión vigente y verificada', async () => {
    const tables = baseTables()
    tables.documents[0].currentVersionId = 'version_financials_v2'
    const ctx = createConvexCtx(tables)

    await expect(runHandler(publish, ctx, publishArgs())).rejects.toThrow(/versión vigente/i)
    expect(tables.financialSnapshots).toEqual([])
    expect(tables.adminAuditLogs).toEqual([])
  })

  it('valida periodEnd, rechaza duplicados por métrica, moneda y fecha, y ordena por fecha', async () => {
    const tables = baseTables()
    const args = publishArgs()
    args.metrics = [
      { ...args.metrics[0], metric: 'EBITDA', period: 'FY2025', periodEnd: '2025-12-31' },
      { ...args.metrics[0], metric: 'REVENUE', period: 'FY2024', periodEnd: '2024-12-31' },
    ]
    const ctx = createConvexCtx(tables)

    await runHandler(publish, ctx, args)

    expect(tables.financialSnapshots[0].metrics).toEqual([
      expect.objectContaining({ metric: 'REVENUE', periodEnd: '2024-12-31' }),
      expect.objectContaining({ metric: 'EBITDA', periodEnd: '2025-12-31' }),
    ])

    const invalidDate = publishArgs()
    invalidDate.metrics[0].periodEnd = '2025-02-30'
    await expect(runHandler(publish, ctx, invalidDate)).rejects.toThrow(/fecha válida/i)

    const duplicate = publishArgs()
    duplicate.metrics.push({ ...duplicate.metrics[0], period: 'Etiqueta alternativa' })
    await expect(runHandler(publish, ctx, duplicate)).rejects.toThrow(/más de un valor/i)
  })

  it('proyecta fuentes para el dueño y deja de servir métricas cuando la fuente cambia', async () => {
    const tables = baseTables()
    await runHandler(publish, createConvexCtx(tables), publishArgs())
    const ownerCtx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    const ready = await runHandler(getForCompany, ownerCtx, { companyId: COMPANY_ID })

    expect(ready).toEqual({
      status: 'READY',
      publishedAt: NOW,
      reviewedBy: 'Equipo de Sherlock',
      reviewNote: 'Revisado contra los estados financieros aprobados.',
      metrics: [
        {
          metric: 'REVENUE',
          period: 'FY2025',
          periodEnd: '2025-12-31',
          value: 12_500_000,
          currency: 'USD',
          source: {
            documentId: 'document_financials',
            versionId: 'version_financials_v1',
            documentName: 'Estados financieros FY25.pdf',
            versionNumber: 1,
            locator: { kind: 'PAGE', page: 14 },
          },
        },
      ],
    })

    tables.documents[0].currentVersionId = 'version_financials_v2'
    const stale = await runHandler(getForCompany, ownerCtx, { companyId: COMPANY_ID })

    expect(stale).toEqual({
      status: 'STALE',
      publishedAt: NOW,
      reason: 'SOURCE_VERSION_CHANGED',
    })
  })

  it('niega igual una empresa ajena existente y un id inexistente sin cargar ninguno', async () => {
    const tables = baseTables()
    tables.users.push({
      _id: 'user_other',
      authProvider: 'workos',
      providerUserId: 'workos_other',
      workosUserId: 'workos_other',
      email: 'other@example.com',
      role: 'COMPANY',
    })
    tables.profiles.push({
      _id: 'profile_other',
      userId: 'user_other',
      role: 'COMPANY',
      isActive: true,
    })
    tables.companies.push({
      _id: 'company_other',
      ownerId: 'profile_other',
      name: 'Other Company',
    })
    const identity = {
      subject: 'workos_other',
      issuer: 'https://api.workos.com/',
      email: 'other@example.com',
    }

    for (const companyId of [COMPANY_ID, 'company_missing']) {
      const ctx = createConvexCtx(tables, { identity })
      await expect(runHandler(getForCompany, ctx, { companyId })).rejects.toThrow(
        'No tienes permiso para abrir este data room'
      )
      expect(ctx.db.get).not.toHaveBeenCalledWith(companyId)
    }
  })

  it('niega el resumen financiero a un miembro con acceso READ_ONLY a la empresa', async () => {
    const tables = baseTables()
    tables.users.push({
      _id: 'user_member',
      authProvider: 'workos',
      providerUserId: 'workos_member',
      workosUserId: 'workos_member',
      email: 'member@example.com',
      role: 'COMPANY',
    })
    tables.profiles.push({
      _id: 'profile_member',
      userId: 'user_member',
      role: 'COMPANY',
      isActive: true,
    })
    tables.organizationMemberships.push({
      _id: 'membership_member',
      userId: 'user_member',
      profileId: 'profile_member',
      authProvider: 'workos',
      providerOrgId: 'org_issuer',
      workosOrgId: 'org_issuer',
      betaRole: 'COMPANY_MEMBER',
      profileRole: 'COMPANY',
      status: 'ACTIVE',
      createdAt: 2,
    })
    const ctx = createConvexCtx(tables, {
      identity: {
        subject: 'workos_member',
        issuer: 'https://api.workos.com/',
        email: 'member@example.com',
      },
    })

    await expect(runHandler(getForCompany, ctx, { companyId: COMPANY_ID })).rejects.toThrow(
      'No tienes permiso para abrir este data room'
    )
  })

  it('deja el snapshot STALE si la fuente vigente expira o pierde su veredicto de malware', async () => {
    const tables = baseTables()
    await runHandler(publish, createConvexCtx(tables), publishArgs())
    const ownerCtx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    tables.documents[0].isExpired = true
    const expired = await runHandler(getForCompany, ownerCtx, { companyId: COMPANY_ID })
    expect(expired).toEqual({
      status: 'STALE',
      publishedAt: NOW,
      reason: 'SOURCE_NOT_DELIVERABLE',
    })

    tables.documents[0].isExpired = false
    tables.documentVersions[0].malwareScanStatus = 'PENDING'
    const pendingScan = await runHandler(getForCompany, ownerCtx, { companyId: COMPANY_ID })
    expect(pendingScan).toEqual({
      status: 'STALE',
      publishedAt: NOW,
      reason: 'SOURCE_NOT_DELIVERABLE',
    })
  })
})
