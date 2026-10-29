// ============================================================================
// VDR — la alarma de descargas masivas debe leer la ventana, no la vida entera
// ============================================================================
// `consumeDownloadGrant` corre en la ruta ALLOW de CADA apertura de archivo del
// data room. Para responder "¿hubo >=20 o >=50 descargas en la última hora?"
// leía el historial COMPLETO de `documentAccessLogs` del perfil.
//
// Cuando ese historial cruza el techo por transacción de Convex, la mutation
// lanza y la transacción entera hace rollback. Tres consecuencias, todas malas:
//   1. El usuario deja de poder abrir NINGÚN documento, y la ruta de API mapea
//      el error a un 403 "Acceso denegado" idéntico al de un NDA faltante.
//   2. El insert de auditoría de storage.ts:263 también se revierte, así que la
//      bitácora de 5 años deja de registrar justo a los usuarios más pesados.
//   3. La alarma muere exactamente en el perfil que existe para detectar.
//
// Los ADMIN son los primeros en llegar ahí: la policy les da ALLOWED_ADMIN
// sobre todas las empresas, así que el equipo curador acumula más rápido.
//
// Estos tests usan un query builder que REGISTRA el índice y el rango pedidos.
// Los mocks existentes usan `withIndex: vi.fn().mockReturnThis()`, que descarta
// el callback del índice y por eso no pueden distinguir un escaneo acotado de
// uno sin acotar.
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

vi.mock('../../../convex/_documents/shared', () => ({
  createDocumentAccessGrantToken: () => 'plain-token',
  hashDocumentAccessGrantToken: async (token: string) => `hash:${token}`,
  recordDocumentAccessLog: (...args: unknown[]) => mockRecordDocumentAccessLog(...args),
  resolveDownloadAccess: (...args: unknown[]) => mockResolveDownloadAccess(...args),
  findDocumentByStorageId: vi.fn(async () => null),
  findDocumentByStoragePath: vi.fn(async () => null),
}))

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
    },
  },
}))

// Umbrales de producción (convex/security.ts): descargas 20/50, entregas 80/150,
// ventana 1h. Las dos llaves de ENTREGAS son obligatorias acá: sin ellas el tope
// del escaneo de vistas se vuelve `undefined + 1 = NaN`, ese escaneo devuelve
// cero filas y la cota que este archivo bloquea deja de medir la mitad de la
// lectura real.
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

const consume = (consumeDownloadGrant as unknown as { _handler: Handler })._handler
const STORAGE_SECRET = 'document-delivery-secret-for-tests'
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

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
 * Query builder que registra qué índice se usó, qué predicados de rango se
 * pidieron y CUÁNTAS FILAS se leyeron de verdad. Ese último número es el que
 * distingue un `.collect()` sin acotar de un `.take(n)` sobre un rango.
 */
function createRecordingDb(logRows: LogRow[]) {
  // `indexName`/`range` describen la ÚLTIMA consulta; `scans` las acumula todas.
  // La lista existe porque el handler hace dos escaneos (VIEW y DOWNLOAD) y este
  // archivo, mirando solo el último, no podía ver si el primero ocurría.
  const reads = {
    rowsRead: 0,
    indexName: '',
    range: [] as RangePredicate[],
    scans: [] as Array<{ indexName: string; action: unknown; rowsRead: number }>,
  }

  const rangeQuery = {
    eq: (field: string, value: unknown) => {
      reads.range.push(['eq', field, value])
      return rangeQuery
    },
    gte: (field: string, value: unknown) => {
      reads.range.push(['gte', field, value])
      return rangeQuery
    },
    lt: (field: string, value: unknown) => {
      reads.range.push(['lt', field, value])
      return rangeQuery
    },
  }

  const matched = () =>
    logRows.filter((row) =>
      reads.range.every(([op, field, value]) => {
        const actual = row[field]
        if (op === 'eq') return actual === value
        if (op === 'gte') return typeof actual === 'number' && actual >= (value as number)
        return typeof actual === 'number' && actual < (value as number)
      })
    )

  const trackScan = (rowsRead: number) => {
    reads.scans.push({
      indexName: reads.indexName,
      action: reads.range.find(([op, field]) => op === 'eq' && field === 'action')?.[2],
      rowsRead,
    })
  }

  const builder = {
    withIndex: (name: string, callback?: (q: typeof rangeQuery) => unknown) => {
      reads.indexName = name
      reads.range = []
      callback?.(rangeQuery)
      return builder
    },
    order: () => builder,
    filter: () => builder,
    collect: async () => {
      const rows = matched()
      reads.rowsRead += rows.length
      trackScan(rows.length)
      return rows
    },
    take: async (limit: number) => {
      const rows = matched().slice(0, limit)
      reads.rowsRead += rows.length
      trackScan(rows.length)
      return rows
    },
    first: async () => matched()[0] ?? null,
  }

  return { reads, query: () => builder }
}

function createCtx(logRows: LogRow[]) {
  const recording = createRecordingDb(logRows)
  return {
    reads: recording.reads,
    ctx: {
      db: {
        get: vi.fn(async () => DOCUMENT),
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

function downloadLogs(count: number, accessedAt: number, overrides: LogRow = {}): LogRow[] {
  return Array.from({ length: count }, () => ({
    accessedById: 'profile_1',
    action: 'DOWNLOAD',
    accessedAt,
    ...overrides,
  }))
}

describe('consumeDownloadGrant: la alarma de descargas lee una ventana acotada', () => {
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

  function grantFor(now: number) {
    return {
      _id: 'grant_1',
      documentId: 'document_1',
      documentVersionId: 'version_1',
      documentSha256: 'a'.repeat(64),
      companyId: 'company_1',
      profileId: 'profile_1',
      tokenHash: 'hash:plain-token',
      expiresAt: now + 5 * 60_000,
      revokedAt: undefined,
      useCount: 0,
      maxUses: 1,
      accessLevel: 'NDA_REQUIRED',
      // La emisión persiste la clasificación EVALUADA (inferida para documentos
      // legados sin `classification`); el consumo compara contra esa inferencia.
      classification: 'CONFIDENTIAL',
    }
  }

  it('acota el escaneo a la ventana, no al historial de vida del perfil', async () => {
    // Un inversionista pesado: 4.940 descargas viejas + 60 dentro de la hora.
    const rows = [...downloadLogs(4_940, now - 30 * DAY_MS), ...downloadLogs(60, now - 10 * 60_000)]
    const { ctx, reads } = createCtx(rows)
    ctx.db.get = vi.fn(async (id: unknown) =>
      id === 'grant_1' ? grantFor(now) : DOCUMENT
    ) as never

    await consume(ctx, await consumeArgs(now))

    // ALERT + 1 filas bastan para distinguir <20 / [20,50) / >=50 sin error.
    expect(reads.rowsRead).toBeLessThanOrEqual(51)
    // Y la alarma sigue disparando bajo el tope: acotar no puede apagarla.
    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(
      0,
      'documents:_logBulkDownloadEvent',
      expect.objectContaining({ severity: 'ALERT' })
    )
  })

  it('acota la lectura COMBINADA: el escaneo de vistas también cuenta', async () => {
    // Este archivo mockeaba `SECURITY_THRESHOLDS` con solo las dos llaves de
    // DOWNLOADS. Cuando el handler sumó el escaneo de VISTAS, su tope quedó en
    // `undefined + 1 = NaN`, y `.slice(0, NaN)` devuelve cero filas: el escaneo
    // era INVISIBLE para este suite. El `rowsRead <= 51` de arriba pasaba porque
    // no veía la mitad de la lectura, no porque la cota se cumpliera —producción
    // ya leía hasta 202. Acá se fija la cota real de las DOS lecturas.
    const rows = [
      ...downloadLogs(5_000, now - 10 * 60_000, { action: 'VIEW' }),
      ...downloadLogs(5_000, now - 10 * 60_000),
    ]
    const { ctx, reads } = createCtx(rows)
    ctx.db.get = vi.fn(async (id: unknown) =>
      id === 'grant_1' ? grantFor(now) : DOCUMENT
    ) as never

    await consume(ctx, await consumeArgs(now))

    // (ALERT entregas + 1) + (ALERT descargas + 1) = 151 + 51.
    expect(reads.rowsRead).toBeLessThanOrEqual(202)
    // Y las dos lecturas ocurrieron de verdad: un tope NaN volvería a dejar el
    // escaneo de vistas en cero filas sin que ninguna aserción se entere.
    const logScans = reads.scans.filter((scan) => scan.action !== undefined)
    expect(logScans.map((scan) => scan.action)).toEqual(['VIEW', 'DOWNLOAD'])
    expect(logScans[0].rowsRead).toBe(151)
    expect(logScans[1].rowsRead).toBe(51)
    // La alarma de extracción total sí se enciende con 202 entregas en la hora.
    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(
      0,
      'documents:_logBulkAccessEvent',
      expect.objectContaining({ severity: 'ALERT', deliveryCount: 202 })
    )
  })

  it('consulta el índice compuesto con el rango de la ventana', async () => {
    const { ctx, reads } = createCtx(downloadLogs(3, now - 60_000))
    ctx.db.get = vi.fn(async (id: unknown) =>
      id === 'grant_1' ? grantFor(now) : DOCUMENT
    ) as never

    await consume(ctx, await consumeArgs(now))

    expect(reads.indexName).toBe('by_accessedById_action_accessedAt')
    expect(reads.range.slice(0, 2)).toEqual([
      ['eq', 'accessedById', 'profile_1'],
      ['eq', 'action', 'DOWNLOAD'],
    ])
    // El handler toma su propio Date.now(), así que el borde de la ventana no
    // es idéntico al del test: se verifica que sea una hora atrás, no el valor exacto.
    const [op, field, value] = reads.range[2]
    expect([op, field]).toEqual(['gte', 'accessedAt'])
    expect(value).toBeGreaterThanOrEqual(now - HOUR_MS)
    expect(value).toBeLessThanOrEqual(now - HOUR_MS + 5_000)
  })

  it('no cuenta filas sin accessedAt ni acciones distintas de DOWNLOAD', async () => {
    // Equivalencia con el guard en JS que se reemplaza:
    // log.action === 'DOWNLOAD' && log.accessedAt && log.accessedAt >= windowStart
    const rows = [
      ...downloadLogs(25, now - 60_000),
      ...downloadLogs(40, now - 60_000, { action: 'VIEW' }),
      ...downloadLogs(40, now - 60_000, { action: undefined }),
      ...downloadLogs(40, now - 60_000, { accessedAt: undefined }),
      ...downloadLogs(40, now - 2 * HOUR_MS),
    ]
    const { ctx } = createCtx(rows)
    ctx.db.get = vi.fn(async (id: unknown) =>
      id === 'grant_1' ? grantFor(now) : DOCUMENT
    ) as never

    await consume(ctx, await consumeArgs(now))

    // 25 descargas en ventana: WARNING (>=20), nunca ALERT (>=50).
    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(
      0,
      'documents:_logBulkDownloadEvent',
      expect.objectContaining({ severity: 'WARNING', downloadCount: 25 })
    )
  })
})
