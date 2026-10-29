// ============================================================================
// Reporte de poda de Convex (convex/operatorPrune.ts)
// ============================================================================
// `pruneDryRun` no borra: cuenta. Lo que no puede equivocarse:
//  - una SUPERSEDED vieja con PUBLISHED vigente es candidata;
//  - un documento con una sola versión PUBLISHED nunca lo es;
//  - un blob sin ninguna fila que lo apunte es candidato;
//  - dos corridas seguidas dan los mismos conteos (nada se consumió).
// El reloj va fijo con `vi.useFakeTimers`: los handlers leen `Date.now()` y un
// seed con offsets relativos cruzaría a rojo a medianoche UTC.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pruneDryRun, type PruneReport } from '../../../convex/operatorPrune'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const NOW = Date.UTC(2026, 8, 6, 5, 0, 0)
const DAY = 24 * 60 * 60 * 1000

const COMPANY = 'company_sampleenergy'
const COMPANY_NAME = 'Sample Hydro, S.A.'

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

function categoryOf(report: PruneReport, key: string) {
  const row = report.categories.find((candidate) => candidate.key === key)
  if (!row) throw new Error(`El reporte no trae la categoría ${key}`)
  return row
}

function version(id: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    documentId: 'doc_model',
    companyId: COMPANY,
    versionNumber: 1,
    storageId: `blob_${id}`,
    byteSize: 1_000,
    verificationStatus: 'SIGNATURE_VERIFIED',
    publicationStatus: 'PUBLISHED',
    createdAt: NOW,
    ...overrides,
  }
}

function baseTables(overrides: Partial<Tables> = {}): Tables {
  return {
    companies: [{ _id: COMPANY, name: COMPANY_NAME }],
    documents: [
      {
        _id: 'doc_model',
        companyId: COMPANY,
        name: 'Modelo financiero',
        currentVersionId: 'ver_published',
        publishedVersionId: 'ver_published',
      },
    ],
    documentVersions: [],
    documentAccessGrants: [],
    documentRedactions: [],
    documentLegalHolds: [],
    intakeDocuments: [],
    intakeUploadIntents: [],
    vdrUploadIntents: [],
    assetUploadIntents: [],
    pruneReports: [],
    _storage: [],
    ...overrides,
  }
}

async function run(tables: Tables) {
  const ctx = createConvexCtx(tables)
  return runHandler<Record<string, never>, PruneReport>(pruneDryRun, ctx, {})
}

describe('operatorPrune.pruneDryRun', () => {
  it('cuenta la SUPERSEDED vieja de un documento que ya tiene PUBLISHED vigente', async () => {
    const tables = baseTables({
      documentVersions: [
        version('ver_old', {
          versionNumber: 1,
          publicationStatus: 'SUPERSEDED',
          createdAt: NOW - 200 * DAY,
          byteSize: 4_000,
        }),
        version('ver_published', { versionNumber: 2 }),
      ],
      _storage: [
        { _id: 'blob_ver_old', size: 4_000, _creationTime: NOW - 200 * DAY },
        { _id: 'blob_ver_published', size: 1_000, _creationTime: NOW },
      ],
    })

    const report = await run(tables)

    expect(categoryOf(report, 'SUPERSEDED_VERSIONS')).toMatchObject({
      candidates: 1,
      bytes: 4_000,
    })
    expect(report.mode).toBe('DRY_RUN')
  })

  it('nunca marca un documento con una sola versión PUBLISHED', async () => {
    const tables = baseTables({
      documentVersions: [version('ver_published')],
      _storage: [{ _id: 'blob_ver_published', size: 1_000, _creationTime: NOW }],
    })

    const report = await run(tables)

    expect(categoryOf(report, 'SUPERSEDED_VERSIONS').candidates).toBe(0)
    expect(report.totals.candidates).toBe(0)
  })

  it('deja fuera la SUPERSEDED que aún no cumple los 90 días de holgura', async () => {
    const tables = baseTables({
      documentVersions: [
        version('ver_1', {
          versionNumber: 1,
          publicationStatus: 'SUPERSEDED',
          createdAt: NOW - 400 * DAY,
        }),
        version('ver_2', {
          versionNumber: 2,
          publicationStatus: 'SUPERSEDED',
          createdAt: NOW - 200 * DAY,
        }),
        version('ver_3', {
          versionNumber: 3,
          publicationStatus: 'SUPERSEDED',
          createdAt: NOW - 10 * DAY,
        }),
        version('ver_published', { versionNumber: 4 }),
      ],
      _storage: ['ver_1', 'ver_2', 'ver_3', 'ver_published'].map((id) => ({
        _id: `blob_${id}`,
        size: 1_000,
        _creationTime: NOW - 400 * DAY,
      })),
    })

    const report = await run(tables)

    expect(categoryOf(report, 'SUPERSEDED_VERSIONS')).toMatchObject({
      candidates: 2,
      bytes: 2_000,
    })
  })

  it('cuenta el blob que ninguna fila apunta y deja fuera el que sí', async () => {
    const tables = baseTables({
      documentVersions: [version('ver_published')],
      _storage: [
        { _id: 'blob_ver_published', size: 1_000, _creationTime: NOW - 30 * DAY },
        { _id: 'blob_huerfano', size: 7_000, _creationTime: NOW - 30 * DAY },
      ],
    })

    const report = await run(tables)

    expect(categoryOf(report, 'ORPHAN_BLOBS')).toMatchObject({ candidates: 1, bytes: 7_000 })
  })

  it('deja fuera el blob recién subido: su fila puede estar a medio escribir', async () => {
    const tables = baseTables({
      _storage: [{ _id: 'blob_recien', size: 7_000, _creationTime: NOW - 60 * 60 * 1000 }],
    })

    const report = await run(tables)

    expect(categoryOf(report, 'ORPHAN_BLOBS').candidates).toBe(0)
  })

  it('cuenta intents vencidos, cuarentena vencida y grants vencidos', async () => {
    const tables = baseTables({
      documentVersions: [
        version('ver_published'),
        version('ver_cuarentena', {
          versionNumber: 2,
          verificationStatus: 'QUARANTINED',
          publicationStatus: 'DRAFT',
          createdAt: NOW - 30 * DAY,
        }),
      ],
      vdrUploadIntents: [
        { _id: 'intent_viejo', companyId: COMPANY, status: 'EXPIRED', expiresAt: NOW - 90 * DAY },
        { _id: 'intent_vivo', companyId: COMPANY, status: 'ISSUED', expiresAt: NOW + DAY },
      ],
      documentAccessGrants: [
        { _id: 'grant_viejo', documentId: 'doc_model', expiresAt: NOW - 90 * DAY },
        { _id: 'grant_reciente', documentId: 'doc_model', expiresAt: NOW - 60 * 1000 },
      ],
      _storage: [
        { _id: 'blob_ver_published', size: 1_000, _creationTime: NOW },
        { _id: 'blob_ver_cuarentena', size: 2_000, _creationTime: NOW - 30 * DAY },
      ],
    })

    const report = await run(tables)

    expect(categoryOf(report, 'EXPIRED_UPLOAD_INTENTS').candidates).toBe(1)
    expect(categoryOf(report, 'STALE_QUARANTINE')).toMatchObject({ candidates: 1, bytes: 2_000 })
    expect(categoryOf(report, 'EXPIRED_GRANTS').candidates).toBe(1)
  })

  it('nunca marca la versión en cuarentena que sigue siendo la vigente del documento', async () => {
    const tables = baseTables({
      documents: [
        {
          _id: 'doc_model',
          companyId: COMPANY,
          name: 'Subida del cliente',
          currentVersionId: 'ver_cuarentena',
        },
      ],
      documentVersions: [
        version('ver_cuarentena', {
          verificationStatus: 'QUARANTINED',
          publicationStatus: 'DRAFT',
          createdAt: NOW - 30 * DAY,
        }),
      ],
      _storage: [{ _id: 'blob_ver_cuarentena', size: 2_000, _creationTime: NOW - 30 * DAY }],
    })

    const report = await run(tables)

    expect(categoryOf(report, 'STALE_QUARANTINE').candidates).toBe(0)
  })

  it('nunca marca un documento con legal hold ACTIVE', async () => {
    const tables = baseTables({
      documentVersions: [
        version('ver_old', {
          publicationStatus: 'SUPERSEDED',
          createdAt: NOW - 200 * DAY,
        }),
        version('ver_published', { versionNumber: 2 }),
      ],
      documentLegalHolds: [
        { _id: 'hold', documentId: 'doc_model', companyId: COMPANY, status: 'ACTIVE' },
      ],
      _storage: [
        { _id: 'blob_ver_old', size: 1_000, _creationTime: NOW - 200 * DAY },
        { _id: 'blob_ver_published', size: 1_000, _creationTime: NOW },
      ],
    })

    const report = await run(tables)

    expect(categoryOf(report, 'SUPERSEDED_VERSIONS').candidates).toBe(0)
  })

  it('escribe una fila de reporte por corrida y no borra nada', async () => {
    const tables = baseTables({
      documentVersions: [
        version('ver_old', {
          publicationStatus: 'SUPERSEDED',
          createdAt: NOW - 200 * DAY,
        }),
        version('ver_published', { versionNumber: 2 }),
      ],
      _storage: [
        { _id: 'blob_ver_old', size: 1_000, _creationTime: NOW - 200 * DAY },
        { _id: 'blob_ver_published', size: 1_000, _creationTime: NOW },
      ],
    })

    await run(tables)

    expect(tables.pruneReports).toHaveLength(1)
    expect(tables.pruneReports[0]).toMatchObject({ mode: 'DRY_RUN', generatedAt: NOW })
    expect(tables.documentVersions).toHaveLength(2)
    expect(tables._storage).toHaveLength(2)
  })

  it('la segunda corrida devuelve los mismos conteos: el dry-run no consume nada', async () => {
    const tables = baseTables({
      documentVersions: [
        version('ver_old', {
          publicationStatus: 'SUPERSEDED',
          createdAt: NOW - 200 * DAY,
        }),
        version('ver_published', { versionNumber: 2 }),
      ],
      _storage: [
        { _id: 'blob_ver_old', size: 1_000, _creationTime: NOW - 200 * DAY },
        { _id: 'blob_ver_published', size: 1_000, _creationTime: NOW },
        { _id: 'blob_huerfano', size: 5_000, _creationTime: NOW - 30 * DAY },
      ],
    })

    const first = await run(tables)
    const second = await run(tables)

    expect(second.categories).toEqual(first.categories)
    expect(second.totals).toEqual(first.totals)
    expect(tables.pruneReports).toHaveLength(2)
  })
})
