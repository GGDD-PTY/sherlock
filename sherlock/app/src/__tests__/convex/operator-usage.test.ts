// ============================================================================
// Medidor de uso Convex por empresa (convex/operatorUsage.ts)
// ============================================================================
// Lo que este carril no puede equivocarse:
//  - dos empresas no se mezclan (bytes, versiones ni bitácoras);
//  - vigentes / SUPERSEDED / QUARANTINED se cuentan por fila de versión, y los
//    MB de blob por storageId único (un restore no cobra dos veces el plan);
//  - la edad de la bitácora más vieja sale de la fila, no de Date.now() suelto.
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getUsageByCompany, LOG_READ_LIMIT, type UsageReport } from '../../../convex/operatorUsage'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const NOW = Date.UTC(2026, 8, 1, 18, 0, 0)
const DAY = 24 * 60 * 60 * 1000

const SAMPLE_ENERGY = 'company_sampleenergy'
const SAMPLE_ENERGY_NAME = 'Sample Hydro, S.A.'
const ANDINA = 'company_andina'
const ANDINA_NAME = 'Andina Capital'

const MIB = 1024 * 1024

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

function baseTables(overrides: Partial<Tables> = {}): Tables {
  return {
    companies: [
      { _id: SAMPLE_ENERGY, name: SAMPLE_ENERGY_NAME, ownerId: 'profile_owner' },
      { _id: ANDINA, name: ANDINA_NAME, ownerId: 'profile_owner' },
    ],
    profiles: [
      { _id: 'profile_owner', userId: 'user_owner', role: 'COMPANY' },
      { _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true },
    ],
    users: [
      { _id: 'user_owner', email: 'fixture-befbb74d@example.com' },
      { _id: 'user_admin', email: 'fixture-dbeda5ff@example.com' },
    ],
    documents: [
      {
        _id: 'doc_modelo',
        companyId: SAMPLE_ENERGY,
        name: 'Modelo financiero',
        lifecycleStatus: 'ACTIVE',
        currentVersionId: 'ver_current',
        fileSize: 2 * MIB,
      },
      {
        _id: 'doc_scan',
        companyId: SAMPLE_ENERGY,
        name: 'Escaneo dudoso',
        lifecycleStatus: 'QUARANTINED',
        currentVersionId: 'ver_quarantined',
        fileSize: 1 * MIB,
      },
    ],
    documentVersions: [
      {
        _id: 'ver_superseded',
        documentId: 'doc_modelo',
        companyId: SAMPLE_ENERGY,
        versionNumber: 1,
        storageId: 'blob_old',
        byteSize: 4 * MIB,
        publicationStatus: 'SUPERSEDED',
        verificationStatus: 'SIGNATURE_VERIFIED',
        createdAt: NOW - 40 * DAY,
      },
      {
        _id: 'ver_current',
        documentId: 'doc_modelo',
        companyId: SAMPLE_ENERGY,
        versionNumber: 2,
        storageId: 'blob_current',
        byteSize: 2 * MIB,
        publicationStatus: 'PUBLISHED',
        verificationStatus: 'SIGNATURE_VERIFIED',
        createdAt: NOW - 1 * DAY,
      },
      {
        _id: 'ver_quarantined',
        documentId: 'doc_scan',
        companyId: SAMPLE_ENERGY,
        versionNumber: 1,
        storageId: 'blob_quarantine',
        byteSize: 1 * MIB,
        publicationStatus: 'DRAFT',
        verificationStatus: 'QUARANTINED',
        createdAt: NOW - 2 * DAY,
      },
    ],
    documentAccessLogs: [
      {
        _id: 'access_old',
        documentId: 'doc_modelo',
        companyId: SAMPLE_ENERGY,
        accessedAt: NOW - 10 * DAY,
        _creationTime: NOW - 10 * DAY,
      },
      {
        _id: 'access_new',
        documentId: 'doc_modelo',
        companyId: SAMPLE_ENERGY,
        accessedAt: NOW - 1 * DAY,
        _creationTime: NOW - 1 * DAY,
      },
      {
        _id: 'access_andina',
        documentId: 'doc_andina',
        companyId: ANDINA,
        accessedAt: NOW - 3 * DAY,
        _creationTime: NOW - 3 * DAY,
      },
    ],
    vdrReadAudits: [
      {
        _id: 'vdr_sampleenergy',
        companyId: SAMPLE_ENERGY,
        occurredAt: NOW - 5 * DAY,
        _creationTime: NOW - 5 * DAY,
      },
    ],
    teamAlerts: [
      {
        _id: 'alert_sampleenergy',
        companyId: SAMPLE_ENERGY,
        openedAt: NOW - 4 * DAY,
        _creationTime: NOW - 4 * DAY,
      },
      {
        _id: 'alert_andina',
        companyId: ANDINA,
        openedAt: NOW - 1 * DAY,
        _creationTime: NOW - 1 * DAY,
      },
    ],
    adminAuditLogs: [
      {
        _id: 'audit_sampleenergy',
        action: 'DOCUMENT_UPLOAD',
        targetType: 'DOCUMENT',
        targetId: 'doc_modelo',
        _creationTime: NOW - 20 * DAY,
      },
      {
        _id: 'audit_system',
        action: 'SYSTEM_CONFIG_CHANGE',
        targetType: 'SYSTEM',
        targetId: 'flags',
        _creationTime: NOW - 90 * DAY,
      },
    ],
    ...overrides,
  }
}

function usageOf(report: UsageReport, companyId: string) {
  return report.companies.find((row) => row.companyId === companyId)
}

async function reportOf(tables: Tables, args: { logReadLimit?: number } = {}) {
  return runHandler<{ logReadLimit?: number }, UsageReport>(
    getUsageByCompany,
    createConvexCtx(tables),
    args
  )
}

describe('operatorUsage.getUsageByCompany', () => {
  it('es internalQuery, no una query pública', () => {
    const source = readFileSync(join(process.cwd(), 'convex/operatorUsage.ts'), 'utf8')
    expect(source).toMatch(/export const getUsageByCompany = internalQuery\(/)
    expect(source).not.toMatch(/export const getUsageByCompany = query\(/)
  })

  it('separa dos empresas, tres versiones y una QUARANTINED', async () => {
    const report = await reportOf(baseTables())

    expect(report.generatedAt).toBe(NOW)
    expect(report.companies.map((row) => row.companyId)).toEqual([ANDINA, SAMPLE_ENERGY])

    const sampleenergy = usageOf(report, SAMPLE_ENERGY)
    expect(sampleenergy).toMatchObject({
      name: SAMPLE_ENERGY_NAME,
      documents: 2,
      // doc_scan.currentVersionId apunta a ver_quarantined: vigente, no podable.
      versions: { current: 2, superseded: 1, quarantined: 0, other: 0, currentQuarantined: 1 },
      blobBytes: {
        current: 3 * MIB,
        superseded: 4 * MIB,
        quarantined: 0,
        other: 0,
        total: 7 * MIB,
        currentQuarantined: 1 * MIB,
      },
      logs: {
        documentAccessLogs: { count: 2, oldestAt: NOW - 10 * DAY, oldestAgeDays: 10 },
        vdrReadAudits: { count: 1, oldestAt: NOW - 5 * DAY, oldestAgeDays: 5 },
        teamAlerts: { count: 1, oldestAt: NOW - 4 * DAY, oldestAgeDays: 4 },
        adminAuditLogs: { count: 1, oldestAt: NOW - 20 * DAY, oldestAgeDays: 20 },
      },
    })

    const andina = usageOf(report, ANDINA)
    expect(andina).toMatchObject({
      name: ANDINA_NAME,
      documents: 0,
      versions: { current: 0, superseded: 0, quarantined: 0, other: 0, currentQuarantined: 0 },
      blobBytes: {
        current: 0,
        superseded: 0,
        quarantined: 0,
        other: 0,
        total: 0,
        currentQuarantined: 0,
      },
      logs: {
        documentAccessLogs: { count: 1, oldestAt: NOW - 3 * DAY, oldestAgeDays: 3 },
        vdrReadAudits: { count: 0, oldestAt: null, oldestAgeDays: null },
        teamAlerts: { count: 1, oldestAt: NOW - 1 * DAY, oldestAgeDays: 1 },
        adminAuditLogs: { count: 0, oldestAt: null, oldestAgeDays: null },
      },
    })

    expect(report.total).toMatchObject({
      companies: 2,
      documents: 2,
      versions: { current: 2, superseded: 1, quarantined: 0, other: 0, currentQuarantined: 1 },
      blobBytes: { total: 7 * MIB },
      unattributed: { adminAuditLogs: { count: 1, oldestAt: NOW - 90 * DAY } },
      logs: {
        documentAccessLogs: { count: 3 },
        vdrReadAudits: { count: 1 },
        teamAlerts: { count: 2 },
        adminAuditLogs: { count: 2, oldestAt: NOW - 90 * DAY, oldestAgeDays: 90 },
      },
    })
  })

  it('un restore que comparte storageId no cobra el blob dos veces', async () => {
    const tables = baseTables({
      documentVersions: [
        {
          _id: 'ver_superseded',
          documentId: 'doc_modelo',
          companyId: SAMPLE_ENERGY,
          versionNumber: 1,
          storageId: 'blob_shared',
          byteSize: 4 * MIB,
          publicationStatus: 'SUPERSEDED',
          verificationStatus: 'SIGNATURE_VERIFIED',
          createdAt: NOW - 40 * DAY,
        },
        {
          _id: 'ver_current',
          documentId: 'doc_modelo',
          companyId: SAMPLE_ENERGY,
          versionNumber: 2,
          storageId: 'blob_shared',
          byteSize: 4 * MIB,
          publicationStatus: 'PUBLISHED',
          verificationStatus: 'SIGNATURE_VERIFIED',
          createdAt: NOW - 1 * DAY,
        },
        {
          _id: 'ver_quarantined',
          documentId: 'doc_scan',
          companyId: SAMPLE_ENERGY,
          versionNumber: 1,
          storageId: 'blob_quarantine',
          byteSize: 1 * MIB,
          publicationStatus: 'DRAFT',
          verificationStatus: 'QUARANTINED',
          createdAt: NOW - 2 * DAY,
        },
      ],
    })
    const report = await reportOf(tables)
    const sampleenergy = usageOf(report, SAMPLE_ENERGY)

    expect(sampleenergy?.versions).toEqual({
      current: 2,
      superseded: 1,
      quarantined: 0,
      other: 0,
      currentQuarantined: 1,
    })
    expect(sampleenergy?.blobBytes).toEqual({
      current: 5 * MIB,
      superseded: 0,
      quarantined: 0,
      other: 0,
      total: 5 * MIB,
      currentQuarantined: 1 * MIB,
    })
  })

  it('una QUARANTINED que es currentVersionId cuenta como vigente, no podable', async () => {
    const report = await reportOf({
      companies: [{ _id: SAMPLE_ENERGY, name: SAMPLE_ENERGY_NAME, ownerId: 'profile_owner' }],
      documents: [
        {
          _id: 'doc_scan',
          companyId: SAMPLE_ENERGY,
          name: 'Escaneo vigente en cuarentena',
          lifecycleStatus: 'QUARANTINED',
          currentVersionId: 'ver_quarantined',
          fileSize: 5 * MIB,
        },
      ],
      documentVersions: [
        {
          _id: 'ver_quarantined',
          documentId: 'doc_scan',
          companyId: SAMPLE_ENERGY,
          versionNumber: 1,
          storageId: 'blob_quarantine',
          byteSize: 5 * MIB,
          publicationStatus: 'DRAFT',
          verificationStatus: 'QUARANTINED',
          createdAt: NOW - 2 * DAY,
        },
      ],
    })
    const sampleenergy = usageOf(report, SAMPLE_ENERGY)

    expect(sampleenergy?.versions).toEqual({
      current: 1,
      superseded: 0,
      quarantined: 0,
      other: 0,
      currentQuarantined: 1,
    })
    expect(sampleenergy?.blobBytes).toEqual({
      current: 5 * MIB,
      superseded: 0,
      quarantined: 0,
      other: 0,
      total: 5 * MIB,
      currentQuarantined: 5 * MIB,
    })
  })

  it('un documento legacy con storageId y sin versiones suma sus MB como vigentes', async () => {
    const report = await reportOf({
      companies: [{ _id: SAMPLE_ENERGY, name: SAMPLE_ENERGY_NAME, ownerId: 'profile_owner' }],
      documents: [
        {
          _id: 'doc_legacy',
          companyId: SAMPLE_ENERGY,
          name: 'Acta escaneada',
          storageId: 'blob_legacy',
          fileSize: 20 * MIB,
        },
      ],
    })
    const sampleenergy = usageOf(report, SAMPLE_ENERGY)

    expect(sampleenergy).toMatchObject({
      documents: 1,
      versions: { current: 0, superseded: 0, quarantined: 0, other: 0, currentQuarantined: 0 },
      blobBytes: {
        current: 20 * MIB,
        superseded: 0,
        quarantined: 0,
        other: 0,
        total: 20 * MIB,
        currentQuarantined: 0,
      },
    })
    expect(report.total.documents).toBe(1)
    expect(report.total.blobBytes.current).toBe(20 * MIB)
  })

  it('un audit sobre un deliverable de la empresa A aparece en A', async () => {
    const report = await reportOf(
      baseTables({
        deliverables: [
          {
            _id: 'deliv_sampleenergy',
            companyId: SAMPLE_ENERGY,
            kind: 'FINANCIAL_MODEL',
            status: 'REQUESTED',
            updatedAt: NOW,
          },
        ],
        adminAuditLogs: [
          {
            _id: 'audit_sampleenergy',
            action: 'DOCUMENT_UPLOAD',
            targetType: 'DOCUMENT',
            targetId: 'doc_modelo',
            _creationTime: NOW - 20 * DAY,
          },
          {
            _id: 'audit_deliverable',
            action: 'DELIVERABLE_REQUEST',
            targetType: 'DELIVERABLE',
            targetId: 'deliv_sampleenergy',
            _creationTime: NOW - 2 * DAY,
          },
          {
            _id: 'audit_system',
            action: 'SYSTEM_CONFIG_CHANGE',
            targetType: 'SYSTEM',
            targetId: 'flags',
            _creationTime: NOW - 90 * DAY,
          },
        ],
      })
    )
    const sampleenergy = usageOf(report, SAMPLE_ENERGY)
    const andina = usageOf(report, ANDINA)

    expect(sampleenergy?.logs.adminAuditLogs).toMatchObject({
      count: 2,
      oldestAt: NOW - 20 * DAY,
      oldestAgeDays: 20,
    })
    expect(andina?.logs.adminAuditLogs.count).toBe(0)
    expect(report.total.unattributed.adminAuditLogs).toMatchObject({
      count: 1,
      oldestAt: NOW - 90 * DAY,
    })
    expect(report.total.logs.adminAuditLogs.count).toBe(3)
  })

  it('tope de lectura: count = LIMIT, capped, oldest del first() y no del take', async () => {
    expect(LOG_READ_LIMIT).toBe(5000)
    const limit = 2
    const accessLogs = [
      {
        _id: 'access_oldest',
        documentId: 'doc_modelo',
        companyId: SAMPLE_ENERGY,
        accessedAt: NOW - 30 * DAY,
        _creationTime: NOW - 30 * DAY,
      },
      {
        _id: 'access_mid',
        documentId: 'doc_modelo',
        companyId: SAMPLE_ENERGY,
        accessedAt: NOW - 10 * DAY,
        _creationTime: NOW - 10 * DAY,
      },
      {
        _id: 'access_new',
        documentId: 'doc_modelo',
        companyId: SAMPLE_ENERGY,
        accessedAt: NOW - 1 * DAY,
        _creationTime: NOW - 1 * DAY,
      },
    ]
    const report = await reportOf(baseTables({ documentAccessLogs: accessLogs }), {
      logReadLimit: limit,
    })
    const sampleenergy = usageOf(report, SAMPLE_ENERGY)

    expect(sampleenergy?.logs.documentAccessLogs).toEqual({
      count: limit,
      oldestAt: NOW - 30 * DAY,
      oldestAgeDays: 30,
      countCapped: true,
    })
    expect(report.total.logs.documentAccessLogs.countCapped).toBe(true)
    expect(report.total.logs.documentAccessLogs.count).toBeGreaterThanOrEqual(limit)
  })

  it('el tope también aplica a teamAlerts y adminAuditLogs fleet-wide', async () => {
    const limit = 2
    const report = await reportOf(
      baseTables({
        teamAlerts: [
          {
            _id: 'alert_1',
            companyId: SAMPLE_ENERGY,
            openedAt: NOW - 9 * DAY,
            _creationTime: NOW - 9 * DAY,
          },
          {
            _id: 'alert_2',
            companyId: SAMPLE_ENERGY,
            openedAt: NOW - 8 * DAY,
            _creationTime: NOW - 8 * DAY,
          },
          {
            _id: 'alert_3',
            companyId: SAMPLE_ENERGY,
            openedAt: NOW - 1 * DAY,
            _creationTime: NOW - 1 * DAY,
          },
        ],
        adminAuditLogs: [
          {
            _id: 'audit_system',
            action: 'SYSTEM_CONFIG_CHANGE',
            targetType: 'SYSTEM',
            targetId: 'flags',
            _creationTime: NOW - 90 * DAY,
          },
          {
            _id: 'audit_sampleenergy',
            action: 'DOCUMENT_UPLOAD',
            targetType: 'DOCUMENT',
            targetId: 'doc_modelo',
            _creationTime: NOW - 20 * DAY,
          },
          {
            _id: 'audit_sampleenergy_2',
            action: 'DOCUMENT_UPLOAD',
            targetType: 'DOCUMENT',
            targetId: 'doc_modelo',
            _creationTime: NOW - 2 * DAY,
          },
        ],
      }),
      { logReadLimit: limit }
    )
    const sampleenergy = usageOf(report, SAMPLE_ENERGY)

    // Con `.take(2)` sobre tres filas el medidor solo ve las dos más viejas: el
    // conteo sale corto y marcado. Un `collect()` fleet-wide devolvería 3.
    expect(sampleenergy?.logs.teamAlerts).toEqual({
      count: limit,
      oldestAt: NOW - 9 * DAY,
      oldestAgeDays: 9,
      countCapped: true,
    })
    expect(report.total.logs.teamAlerts).toMatchObject({ count: limit, countCapped: true })
    expect(sampleenergy?.logs.adminAuditLogs).toMatchObject({ count: 1, countCapped: true })
    expect(report.total.logs.adminAuditLogs).toMatchObject({ count: limit, countCapped: true })
    expect(report.total.unattributed.adminAuditLogs).toMatchObject({
      count: 1,
      countCapped: true,
    })
  })

  it('un teamAlert sin companyId cae en el bucket no atribuido, no se evapora', async () => {
    const report = await reportOf(
      baseTables({
        teamAlerts: [
          {
            _id: 'alert_sampleenergy',
            companyId: SAMPLE_ENERGY,
            openedAt: NOW - 4 * DAY,
            _creationTime: NOW - 4 * DAY,
          },
          {
            _id: 'alert_huerfano',
            companyName: 'Sala sin fila companies',
            openedAt: NOW - 30 * DAY,
            _creationTime: NOW - 30 * DAY,
          },
        ],
      })
    )

    expect(usageOf(report, SAMPLE_ENERGY)?.logs.teamAlerts.count).toBe(1)
    expect(usageOf(report, ANDINA)?.logs.teamAlerts.count).toBe(0)
    expect(report.total.unattributed.teamAlerts).toMatchObject({
      count: 1,
      oldestAt: NOW - 30 * DAY,
      oldestAgeDays: 30,
    })
    // La suma cuadra: por sala + no atribuidos = el total fleet-wide.
    expect(report.total.logs.teamAlerts.count).toBe(2)
  })

  it('el reporte anuncia que los accessLogs legacy sin companyId no se cuentan', async () => {
    const report = await reportOf(baseTables())

    expect(report.notes).toHaveLength(1)
    expect(report.notes[0]).toMatch(/documentAccessLogs sin companyId/)
    expect(report.notes[0]).toMatch(/by_companyId_accessedAt/)
  })
})
