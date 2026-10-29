// ============================================================================
// VDR — una entrega etiquetada VIEW también es extracción
// ============================================================================
// La ruta de entrega devuelve EXACTAMENTE los mismos bytes para una vista y para
// una descarga: lo único que cambia es el header `Content-Disposition`
// (src/app/api/documents/access/[grantId]/route.ts). El cuerpo va watermarkeado
// en los dos casos.
//
// Cuando la alarma de descarga masiva dejó de contar las vistas —correcto, para
// que hojear la sala no encendiera un ALERT—, el presupuesto de extracción quedó
// contado solo en la rama DOWNLOAD. Pedir el data room entero con
// `action: 'VIEW'` costaba cero señales: con el rate limit de 30 grants/minuto,
// ~1.800 archivos por hora sin un solo `securityEvent`.
//
// Estos tests fijan dos alarmas independientes:
//   1. `DATA_ROOM_BULK_DOWNLOAD` sigue estricta: solo la alimenta una entrega con
//      intención DOWNLOAD. Hojear no la enciende.
//   2. `DATA_ROOM_BULK_ACCESS` cuenta ENTREGAS TOTALES (vistas + descargas) y
//      corre en las DOS ramas —si corriera solo en la rama VIEW, bastaría con
//      hojear primero y descargar después para quedarse debajo de las dos líneas.
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
  loadDeliverablePublishedVersion: vi.fn(async (_ctx: unknown, document: { storageId?: string }) =>
    document?.storageId
      ? { _id: 'version_1', sha256: 'a'.repeat(64), storageId: document.storageId }
      : null
  ),
}))

vi.mock('../../../convex/_generated/api', () => ({
  internal: {
    documents: {
      _logBulkDownloadEvent: 'documents:_logBulkDownloadEvent',
      _logBulkAccessEvent: 'documents:_logBulkAccessEvent',
      _backfillAccessLogCompanyId: 'documents:_backfillAccessLogCompanyId',
    },
  },
}))

// Umbrales de producción (convex/security.ts): descargas 20/50, entregas 80/150,
// ventana 1h.
vi.mock('../../../convex/security', () => ({
  SECURITY_THRESHOLDS: {
    DATA_ROOM_DOWNLOADS_ALERT: 50,
    DATA_ROOM_DOWNLOADS_WARNING: 20,
    DATA_ROOM_DELIVERIES_ALERT: 150,
    DATA_ROOM_DELIVERIES_WARNING: 80,
  },
  SECURITY_WINDOWS: { DATA_ROOM_WINDOW_MS: 3_600_000 },
}))

import { consumeDownloadGrant } from '../../../convex/_documents/storage'
import { createDocumentDeliveryProof } from '../../../convex/_documents/deliveryProof'

type Handler = (ctx: Record<string, unknown>, args: Record<string, unknown>) => Promise<unknown>
type LogRow = Record<string, unknown>
type RangePredicate = [op: string, field: string, value: unknown]
type RecordedQuery = { table: string; indexName: string; range: RangePredicate[] }

const consume = (consumeDownloadGrant as unknown as { _handler: Handler })._handler
const STORAGE_SECRET = 'document-delivery-secret-for-tests'

const DOCUMENT = {
  _id: 'document_1',
  companyId: 'company_1',
  storageId: 'storage_1',
  name: 'memo.pdf',
  fileType: 'application/pdf',
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

/**
 * Igual que el builder de `downloadGrantScanBound.test.ts`, pero ACUMULA cada
 * consulta en una lista en vez de sobrescribir la última: la pregunta acá es si
 * hay DOS escaneos, uno por acción.
 */
function createRecordingDb(logRows: LogRow[]) {
  const reads = { rowsRead: 0, queries: [] as RecordedQuery[] }
  let current: RecordedQuery = { table: '', indexName: '', range: [] }

  const rangeQuery = {
    eq: (field: string, value: unknown) => {
      current.range.push(['eq', field, value])
      return rangeQuery
    },
    gte: (field: string, value: unknown) => {
      current.range.push(['gte', field, value])
      return rangeQuery
    },
    lt: (field: string, value: unknown) => {
      current.range.push(['lt', field, value])
      return rangeQuery
    },
  }

  const matched = () =>
    logRows.filter((row) =>
      current.range.every(([op, field, value]) => {
        const actual = row[field]
        if (op === 'eq') return actual === value
        if (op === 'gte') return typeof actual === 'number' && actual >= (value as number)
        return typeof actual === 'number' && actual < (value as number)
      })
    )

  const makeBuilder = (table: string) => {
    const builder = {
      withIndex: (name: string, callback?: (q: typeof rangeQuery) => unknown) => {
        current = { table, indexName: name, range: [] }
        reads.queries.push(current)
        callback?.(rangeQuery)
        return builder
      },
      order: () => builder,
      filter: () => builder,
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
      first: async () => matched()[0] ?? null,
    }

    return builder
  }

  return { reads, query: (table: string) => makeBuilder(table) }
}

function createCtx(logRows: LogRow[], grant: Record<string, unknown>) {
  const recording = createRecordingDb(logRows)

  return {
    reads: recording.reads,
    ctx: {
      db: {
        get: vi.fn(async (id: unknown) => (id === 'grant_1' ? grant : DOCUMENT)),
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

function accessLogs(count: number, action: string, accessedAt: number, documentId = 'document_1') {
  return Array.from({ length: count }, (_unused, index) => ({
    accessedById: 'profile_1',
    action,
    accessedAt,
    documentId: `${documentId}_${index % 7}`,
  }))
}

function grantFor(now: number, overrides: Record<string, unknown> = {}) {
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

function scheduled(ctx: { scheduler: { runAfter: ReturnType<typeof vi.fn> } }, reference: string) {
  return ctx.scheduler.runAfter.mock.calls.filter((call) => call[1] === reference)
}

describe('consumeDownloadGrant: la extracción total se mide en las dos ramas', () => {
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

  it('enciende la alarma de extracción cuando la sala sale entera etiquetada VIEW', async () => {
    // Cero descargas. Hoy esto no produce NI UNA señal: es la regresión.
    const { ctx } = createCtx(
      accessLogs(200, 'VIEW', now - 10 * 60_000),
      grantFor(now, {
        action: 'VIEW',
      })
    )

    await consume(ctx, await consumeArgs(now))

    expect(scheduled(ctx, 'documents:_logBulkAccessEvent')[0]?.[2]).toMatchObject({
      severity: 'ALERT',
      deliveryCount: 151,
      viewCount: 151,
      downloadCount: 0,
    })
    // Y la alarma estricta de descargas sigue apagada: no se descargó nada.
    expect(scheduled(ctx, 'documents:_logBulkDownloadEvent')).toHaveLength(0)
  })

  it('suma vistas y descargas del mismo perfil: el orden no compra presupuesto', async () => {
    const { ctx } = createCtx(
      [
        ...accessLogs(19, 'DOWNLOAD', now - 20 * 60_000),
        ...accessLogs(70, 'VIEW', now - 10 * 60_000),
      ],
      grantFor(now)
    )

    await consume(ctx, await consumeArgs(now))

    expect(scheduled(ctx, 'documents:_logBulkAccessEvent')[0]?.[2]).toMatchObject({
      severity: 'WARNING',
      deliveryCount: 89,
      viewCount: 70,
      downloadCount: 19,
    })
    // 19 descargas siguen por debajo de WARNING (20): la alarma estricta no cambia.
    expect(scheduled(ctx, 'documents:_logBulkDownloadEvent')).toHaveLength(0)
  })

  it('acota las dos lecturas por índice y por umbral, nunca el historial de vida', async () => {
    const { ctx, reads } = createCtx(
      [
        ...accessLogs(5_000, 'VIEW', now - 10 * 60_000),
        ...accessLogs(5_000, 'DOWNLOAD', now - 10 * 60_000),
      ],
      grantFor(now)
    )

    await consume(ctx, await consumeArgs(now))

    // (ALERT entregas + 1) + (ALERT descargas + 1) = 151 + 51.
    expect(reads.rowsRead).toBeLessThanOrEqual(202)

    const logQueries = reads.queries.filter((entry) => entry.table === 'documentAccessLogs')
    expect(logQueries).toHaveLength(2)
    for (const entry of logQueries) {
      expect(entry.indexName).toBe('by_accessedById_action_accessedAt')
    }
    const actions = logQueries.map(
      (entry) => entry.range.find(([op, field]) => op === 'eq' && field === 'action')?.[2]
    )
    expect(actions).toEqual(['VIEW', 'DOWNLOAD'])
  })

  it('una entrega VIEW nunca alimenta la alarma estricta de descargas', async () => {
    // 60 descargas viejas del mismo perfil, muy por encima de ALERT (50). Abrir
    // una vista previa no puede volver a encender esa alarma.
    const { ctx } = createCtx(
      accessLogs(60, 'DOWNLOAD', now - 10 * 60_000),
      grantFor(now, { action: 'VIEW' })
    )

    await consume(ctx, await consumeArgs(now))

    expect(scheduled(ctx, 'documents:_logBulkDownloadEvent')).toHaveLength(0)
  })
})
