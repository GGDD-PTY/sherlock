// ============================================================================
// VDR — intención de acceso (VIEW vs DOWNLOAD) y su efecto en la alarma
// ============================================================================
// Hasta ahora el data room solo sabía decir DOWNLOAD. Abrir el visor inline
// llamaba a la misma mutation que una descarga real, así que:
//   1. Cada vista quedaba auditada como descarga.
//   2. Cada vista incrementaba el contador de la alarma de descarga masiva, y
//      hojear la sala terminaba disparando un securityEvent de severidad ALERT.
//
// La intención se resuelve en el SERVIDOR y se persiste en el grant. La URL de
// entrega nunca decide qué se audita: el query param es controlable por el
// navegador, el grant no.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockRequireAuth,
  mockResolveDownloadAccess,
  mockRecordDocumentAccessLog,
  mockEnforceRateLimit,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockResolveDownloadAccess: vi.fn(),
  mockRecordDocumentAccessLog: vi.fn(),
  mockEnforceRateLimit: vi.fn(),
}))

vi.mock('../../../convex/_helpers/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}))

vi.mock('../../../convex/_helpers/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}))

// Solo se mockea el IO. `resolveDocumentAccessIntent` es la pieza bajo prueba,
// así que entra real desde el módulo original.
vi.mock('../../../convex/_documents/shared', async () => {
  const actual = await vi.importActual<typeof import('../../../convex/_documents/shared')>(
    '../../../convex/_documents/shared'
  )

  return {
    ...actual,
    createDocumentAccessGrantToken: () => 'plain-token',
    hashDocumentAccessGrantToken: async (token: string) => `hash:${token}`,
    recordDocumentAccessLog: (...args: unknown[]) => mockRecordDocumentAccessLog(...args),
    resolveDownloadAccess: (...args: unknown[]) => mockResolveDownloadAccess(...args),
  }
})

vi.mock('../../../convex/_documents/deliverableVersion', () => ({
  loadDeliverablePublishedVersion: vi.fn(
    async (
      _ctx: unknown,
      document: { storageId?: string },
      _now?: number,
      requestedVersionId?: string
    ) =>
      document?.storageId
        ? {
            _id:
              requestedVersionId ??
              (document.storageId === 'storage_2' ? 'version_2' : 'version_1'),
            sha256:
              requestedVersionId === 'version_historical'
                ? 'c'.repeat(64)
                : document.storageId === 'storage_2'
                  ? 'b'.repeat(64)
                  : 'a'.repeat(64),
            storageId:
              requestedVersionId === 'version_historical'
                ? 'storage_historical'
                : document.storageId,
            displayName:
              requestedVersionId === 'version_historical' ? 'historical-model.csv' : 'memo.pdf',
            detectedMimeType:
              requestedVersionId === 'version_historical' ? 'text/csv' : 'application/pdf',
          }
        : null
  ),
}))

vi.mock('../../../convex/_generated/api', () => ({
  internal: { documents: { _logBulkDownloadEvent: 'documents:_logBulkDownloadEvent' } },
}))

// Umbrales de producción (convex/security.ts): WARNING 20, ALERT 50, ventana 1h.
vi.mock('../../../convex/security', () => ({
  SECURITY_THRESHOLDS: {
    DATA_ROOM_DOWNLOADS_ALERT: 50,
    DATA_ROOM_DOWNLOADS_WARNING: 20,
  },
  SECURITY_WINDOWS: { DATA_ROOM_WINDOW_MS: 3_600_000 },
}))

import {
  consumeDownloadGrant,
  getDocumentAccessGrant,
  getDownloadUrl,
} from '../../../convex/_documents/storage'
import { createDocumentDeliveryProof } from '../../../convex/_documents/deliveryProof'

type Handler = (ctx: Record<string, unknown>, args: Record<string, unknown>) => Promise<unknown>
type LogRow = Record<string, unknown>
type RangePredicate = [op: string, field: string, value: unknown]

const issue = (getDownloadUrl as unknown as { _handler: Handler })._handler
const issueStructured = (getDocumentAccessGrant as unknown as { _handler: Handler })._handler
const consume = (consumeDownloadGrant as unknown as { _handler: Handler })._handler
const STORAGE_SECRET = 'document-delivery-secret-for-tests'

const PDF_DOCUMENT = {
  _id: 'document_1',
  companyId: 'company_1',
  storageId: 'storage_1',
  name: 'memo.pdf',
  fileType: 'application/pdf',
  accessLevel: 'NDA_REQUIRED',
}

const SPREADSHEET_DOCUMENT = {
  _id: 'document_2',
  companyId: 'company_1',
  storageId: 'storage_2',
  name: 'cap-table.xlsx',
  fileType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  accessLevel: 'NDA_REQUIRED',
}

const ALLOW = {
  decision: 'ALLOW',
  outcome: 'ALLOWED_CONFIDENTIAL',
  reason: 'Acceso autorizado por la policy del data room.',
  classification: 'CONFIDENTIAL',
  riskScore: 35,
  stepUpRequirement: 'NONE',
}

const DENY = {
  decision: 'REQUIRE_STEP_UP',
  outcome: 'REQUIRE_SIGNED_NDA',
  reason: 'Debes firmar un NDA activo antes de acceder.',
  classification: 'CONFIDENTIAL',
  riskScore: 35,
  stepUpRequirement: 'SIGNED_NDA',
}

function createIssueCtx(document: Record<string, unknown>) {
  return {
    db: {
      get: vi.fn(async () => document),
      patch: vi.fn(),
      insert: vi.fn(async () => 'grant_1'),
      query: vi.fn(() => ({
        withIndex: vi.fn().mockReturnThis(),
        collect: vi.fn().mockResolvedValue([]),
        take: vi.fn().mockResolvedValue([]),
      })),
    },
    scheduler: { runAfter: vi.fn() },
    storage: { getUrl: vi.fn().mockResolvedValue('https://files.example/memo.pdf') },
  }
}

const grantInsert = (ctx: ReturnType<typeof createIssueCtx>) => {
  const calls = ctx.db.insert.mock.calls as unknown as Array<[string, Record<string, unknown>]>
  return calls.filter((call) => call[0] === 'documentAccessGrants')[0]?.[1]
}

/**
 * Query builder que registra índice, rango y filas leídas — el mismo patrón que
 * `downloadGrantScanBound.test.ts`, para poder afirmar que una VISTA no toca la
 * tabla de bitácoras en absoluto.
 */
function createRecordingDb(logRows: LogRow[]) {
  const reads = { rowsRead: 0, indexName: '', range: [] as RangePredicate[] }

  const rangeQuery = {
    eq: (field: string, value: unknown) => {
      reads.range.push(['eq', field, value])
      return rangeQuery
    },
    gte: (field: string, value: unknown) => {
      reads.range.push(['gte', field, value])
      return rangeQuery
    },
  }

  const matched = () =>
    logRows.filter((row) =>
      reads.range.every(([op, field, value]) => {
        const actual = row[field]
        if (op === 'eq') return actual === value
        return typeof actual === 'number' && actual >= (value as number)
      })
    )

  const builder = {
    withIndex: (name: string, callback?: (q: typeof rangeQuery) => unknown) => {
      reads.indexName = name
      reads.range = []
      callback?.(rangeQuery)
      return builder
    },
    order: () => builder,
    collect: async () => {
      const rows = matched()
      reads.rowsRead += rows.length
      return rows
    },
    take: async (limit: number) => {
      const rows = matched().slice(0, limit)
      reads.rowsRead += rows.length
      return rows
    },
  }

  return { reads, query: () => builder }
}

function createConsumeCtx(grant: Record<string, unknown>, logRows: LogRow[] = []) {
  const recording = createRecordingDb(logRows)

  return {
    reads: recording.reads,
    ctx: {
      db: {
        get: vi.fn(async (id: unknown) => (id === 'grant_1' ? grant : PDF_DOCUMENT)),
        patch: vi.fn(),
        insert: vi.fn(async () => 'log_1'),
        query: vi.fn(recording.query),
      },
      scheduler: { runAfter: vi.fn() },
      storage: { getUrl: vi.fn().mockResolvedValue('https://files.example/memo.pdf') },
    },
  }
}

async function consumeArgs(now: number) {
  const grantId = 'grant_1'
  const token = 'plain-token'
  return {
    grantId,
    token,
    deliveryIssuedAt: now,
    deliveryProof: await createDocumentDeliveryProof(STORAGE_SECRET, {
      grantId,
      token,
      profileId: 'profile_1',
      issuedAt: now,
    }),
  }
}

function downloadLogs(count: number, accessedAt: number): LogRow[] {
  return Array.from({ length: count }, () => ({
    accessedById: 'profile_1',
    action: 'DOWNLOAD',
    accessedAt,
  }))
}

function baseGrant(now: number, overrides: Record<string, unknown> = {}) {
  return {
    _id: 'grant_1',
    documentId: 'document_1',
    documentVersionId: 'version_1',
    documentSha256: 'a'.repeat(64),
    companyId: 'company_1',
    profileId: 'profile_1',
    tokenHash: 'hash:plain-token',
    expiresAt: now + 5 * 60_000,
    useCount: 0,
    accessLevel: 'NDA_REQUIRED',
    // La emisión persiste la clasificación EVALUADA (inferida para documentos
    // legados sin `classification`); el consumo compara contra esa inferencia.
    classification: 'CONFIDENTIAL',
    ...overrides,
  }
}

describe('getDownloadUrl: la intención se resuelve en el servidor y viaja en el grant', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('STORAGE_SECRET', STORAGE_SECRET)
    vi.stubEnv('REQUIRE_DOCUMENT_DELIVERY_PROOF', 'true')
    mockRequireAuth.mockResolvedValue({
      user: { _id: 'user_1', email: 'investor@example.com' },
      profile: { _id: 'profile_1', role: 'COMPANY' },
    })
    mockEnforceRateLimit.mockResolvedValue(undefined)
    mockResolveDownloadAccess.mockResolvedValue(ALLOW)
  })

  it('con action VIEW emite un grant marcado VIEW y audita VIEW_GRANT_ISSUED', async () => {
    const ctx = createIssueCtx(PDF_DOCUMENT)

    await issue(ctx, { documentId: 'document_1', action: 'VIEW' })

    expect(grantInsert(ctx)?.action).toBe('VIEW')
    expect(mockRecordDocumentAccessLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'VIEW_GRANT_ISSUED' })
    )
  })

  it('binds a citation grant to the exact requested document version', async () => {
    const ctx = createIssueCtx(PDF_DOCUMENT)

    await issue(ctx, {
      documentId: 'document_1',
      versionId: 'version_historical',
      action: 'VIEW',
    })

    expect(grantInsert(ctx)).toMatchObject({
      documentVersionId: 'version_historical',
      documentSha256: 'c'.repeat(64),
      action: 'VIEW',
    })
  })

  it('classifies VIEW from the exact historical MIME instead of the current document MIME', async () => {
    const currentUnsupportedDocument = {
      ...PDF_DOCUMENT,
      name: 'current-package.zip',
      fileType: 'application/zip',
    }
    const ctx = createIssueCtx(currentUnsupportedDocument)

    await issue(ctx, {
      documentId: 'document_1',
      versionId: 'version_historical',
      action: 'VIEW',
    })

    expect(grantInsert(ctx)).toMatchObject({
      documentVersionId: 'version_historical',
      action: 'VIEW',
    })
    expect(mockRecordDocumentAccessLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'VIEW_GRANT_ISSUED' })
    )
  })

  it('returns a structured exact-version grant while the legacy caller still receives a URL', async () => {
    const currentUnsupportedDocument = {
      ...PDF_DOCUMENT,
      name: 'current-package.zip',
      fileType: 'application/zip',
    }
    const structuredCtx = createIssueCtx(currentUnsupportedDocument)
    const legacyCtx = createIssueCtx(currentUnsupportedDocument)
    const args = {
      documentId: 'document_1',
      versionId: 'version_historical',
      action: 'VIEW',
    }

    await expect(issueStructured(structuredCtx, args)).resolves.toEqual({
      allowed: true,
      url: '/api/documents/access/grant_1?token=plain-token',
      action: 'VIEW',
      versionId: 'version_historical',
      displayName: 'historical-model.csv',
      detectedMimeType: 'text/csv',
    })
    await expect(issue(legacyCtx, args)).resolves.toBe(
      '/api/documents/access/grant_1?token=plain-token'
    )
  })

  it.each([
    ['XLSX', SPREADSHEET_DOCUMENT],
    [
      'DOCX',
      {
        ...SPREADSHEET_DOCUMENT,
        name: 'memo.docx',
        fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ],
    [
      'PPTX',
      {
        ...SPREADSHEET_DOCUMENT,
        name: 'deck.pptx',
        fileType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      },
    ],
    ['CSV', { ...SPREADSHEET_DOCUMENT, name: 'datos.csv', fileType: 'text/csv' }],
    ['PNG', { ...SPREADSHEET_DOCUMENT, name: 'planta.png', fileType: 'image/png' }],
    ['JPEG', { ...SPREADSHEET_DOCUMENT, name: 'planta.jpg', fileType: 'image/jpeg' }],
    ['WEBP', { ...SPREADSHEET_DOCUMENT, name: 'planta.webp', fileType: 'image/webp' }],
    ['GIF', { ...SPREADSHEET_DOCUMENT, name: 'planta.gif', fileType: 'image/gif' }],
    ['AVIF', { ...SPREADSHEET_DOCUMENT, name: 'planta.avif', fileType: 'image/avif' }],
  ])('keeps server intent VIEW for inline-rendered %s files', async (_kind, document) => {
    const ctx = createIssueCtx(document)

    await issue(ctx, { documentId: 'document_2', action: 'VIEW' })

    expect(grantInsert(ctx)?.action).toBe('VIEW')
    expect(mockRecordDocumentAccessLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'VIEW_GRANT_ISSUED' })
    )
  })

  it('sin action se comporta exactamente como hoy (DOWNLOAD)', async () => {
    const ctx = createIssueCtx(PDF_DOCUMENT)

    await issue(ctx, { documentId: 'document_1' })

    expect(grantInsert(ctx)?.action).toBe('DOWNLOAD')
    expect(mockRecordDocumentAccessLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'DOWNLOAD_GRANT_ISSUED' })
    )
  })

  it('la denegación de una vista se audita como VIEW_DENIED, no como DOWNLOAD_DENIED', async () => {
    mockResolveDownloadAccess.mockResolvedValue(DENY)
    const ctx = createIssueCtx(PDF_DOCUMENT)

    // El deny se devuelve estructurado (no se lanza) para que la fila
    // VIEW_DENIED de auditoría commitee (#15).
    await expect(issue(ctx, { documentId: 'document_1', action: 'VIEW' })).resolves.toEqual({
      allowed: false,
      code: 'REQUIRE_SIGNED_NDA',
      message: expect.stringMatching(/NDA/i),
    })

    expect(grantInsert(ctx)).toBeUndefined()
    expect(mockRecordDocumentAccessLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'VIEW_DENIED' })
    )
  })

  it('preserves the structured denial contract on the version-aware wrapper', async () => {
    mockResolveDownloadAccess.mockResolvedValue(DENY)
    const ctx = createIssueCtx(PDF_DOCUMENT)

    await expect(
      issueStructured(ctx, {
        documentId: 'document_1',
        versionId: 'version_historical',
        action: 'VIEW',
      })
    ).resolves.toEqual({
      allowed: false,
      code: 'REQUIRE_SIGNED_NDA',
      message: expect.stringMatching(/NDA/i),
    })

    expect(grantInsert(ctx)).toBeUndefined()
    expect(mockRecordDocumentAccessLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'VIEW_DENIED' })
    )
  })
})

describe('consumeDownloadGrant: la entrega se audita según el grant, no según la URL', () => {
  let now: number

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('STORAGE_SECRET', STORAGE_SECRET)
    vi.stubEnv('REQUIRE_DOCUMENT_DELIVERY_PROOF', 'true')
    now = Date.now()
    mockRequireAuth.mockResolvedValue({
      user: { _id: 'user_1', email: 'investor@example.com' },
      profile: { _id: 'profile_1', role: 'COMPANY' },
    })
    mockResolveDownloadAccess.mockResolvedValue(ALLOW)
  })

  it('audita VIEW y no dispara la alarma de descarga masiva', async () => {
    // 60 descargas reales dentro de la ventana: muy por encima de ALERT (50).
    const { ctx, reads } = createConsumeCtx(baseGrant(now, { action: 'VIEW' }), [
      ...downloadLogs(60, now - 10 * 60_000),
    ])

    const result = await consume(ctx, await consumeArgs(now))

    expect(result).toMatchObject({ action: 'VIEW' })
    expect(ctx.db.insert).not.toHaveBeenCalled()
    expect(mockRecordDocumentAccessLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'VIEW' })
    )
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled()
    // `toBe(0)` codificaba el defecto, no la invariante: "hojear no cuesta
    // lecturas" era exactamente lo que hacía gratis pedir la sala entera
    // etiquetada VIEW. La entrega ahora lee su ventana —acotada por umbral— para
    // alimentar el contador de extracción total. Lo que sigue siendo cierto es
    // que la lectura tiene techo y que la alarma de DESCARGA no se enciende.
    // Ver src/__tests__/convex/bulkDeliveryAlarm.test.ts.
    expect(reads.rowsRead).toBeLessThanOrEqual(202)
  })

  it('returns renderer metadata from the exact immutable historical version', async () => {
    const { ctx } = createConsumeCtx(
      baseGrant(now, {
        action: 'VIEW',
        documentVersionId: 'version_historical',
        documentSha256: 'c'.repeat(64),
      })
    )

    const result = await consume(ctx, await consumeArgs(now))

    expect(result).toMatchObject({
      action: 'VIEW',
      fileName: 'historical-model.csv',
      fileType: 'text/csv',
    })
    expect(ctx.storage.getUrl).toHaveBeenCalledWith('storage_historical')
  })

  it('trata un grant sin action como DOWNLOAD (grants en vuelo del deploy anterior)', async () => {
    const { ctx, reads } = createConsumeCtx(baseGrant(now), [
      ...downloadLogs(25, now - 10 * 60_000),
    ])

    const result = await consume(ctx, await consumeArgs(now))

    expect(result).toMatchObject({ action: 'DOWNLOAD' })
    expect(mockRecordDocumentAccessLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'DOWNLOAD' })
    )
    expect(reads.indexName).toBe('by_accessedById_action_accessedAt')
    expect(reads.range.slice(0, 2)).toEqual([
      ['eq', 'accessedById', 'profile_1'],
      ['eq', 'action', 'DOWNLOAD'],
    ])
    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(
      0,
      'documents:_logBulkDownloadEvent',
      expect.objectContaining({ severity: 'WARNING', downloadCount: 25 })
    )
  })

  it('una entrega VIEW denegada se audita como VIEW_DENIED', async () => {
    mockResolveDownloadAccess.mockResolvedValue(DENY)
    const { ctx } = createConsumeCtx(baseGrant(now, { action: 'VIEW' }))

    await expect(consume(ctx, await consumeArgs(now))).resolves.toEqual({
      allowed: false,
      code: 'REQUIRE_SIGNED_NDA',
      message: expect.stringMatching(/NDA/i),
    })

    expect(mockRecordDocumentAccessLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'VIEW_DENIED' })
    )
  })
})
