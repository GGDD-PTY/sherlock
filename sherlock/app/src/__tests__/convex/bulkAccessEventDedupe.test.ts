// ============================================================================
// `_logBulkAccessEvent` — el evento de extracción masiva y su dedupe acotado
// ============================================================================
// La invariante de esta familia de mutations es "como máximo un evento SIN
// RESOLVER de este tipo por usuario y por ventana". El gesamplefoods de descargas la
// resolvía con `.collect()` de todos los eventos sin resolver del usuario y un
// filtro en JS: la misma clase de lectura sin techo que ya se corrigió del lado
// de la bitácora. Con un índice por (usuario, tipo), el evento MÁS RECIENTE
// responde la pregunta completa: una fila.
//
// Delta consciente: si un operador RESOLVIÓ el evento hace diez minutos y el
// usuario sigue extrayendo, entra uno nuevo. Es la dirección correcta de fallo:
// informar de nuevo, no callar.
// ============================================================================

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../convex/_generated/api', () => ({
  internal: {
    documents: {
      _logBulkDownloadEvent: 'documents:_logBulkDownloadEvent',
      _logBulkAccessEvent: 'documents:_logBulkAccessEvent',
      _backfillAccessLogCompanyId: 'documents:_backfillAccessLogCompanyId',
    },
  },
}))

vi.mock('../../../convex/security', () => ({
  SECURITY_THRESHOLDS: {
    DATA_ROOM_DOWNLOADS_ALERT: 50,
    DATA_ROOM_DOWNLOADS_WARNING: 20,
    DATA_ROOM_DELIVERIES_ALERT: 150,
    DATA_ROOM_DELIVERIES_WARNING: 80,
  },
  SECURITY_WINDOWS: { DATA_ROOM_WINDOW_MS: 3_600_000 },
}))

import { _logBulkAccessEvent, _logBulkDownloadEvent } from '../../../convex/_documents/internals'

type Handler = (ctx: Record<string, unknown>, args: Record<string, unknown>) => Promise<unknown>
type RangePredicate = [op: string, field: string, value: unknown]

const logBulkAccess = (_logBulkAccessEvent as unknown as { _handler: Handler })._handler
const logBulkDownload = (_logBulkDownloadEvent as unknown as { _handler: Handler })._handler
const HOUR_MS = 3_600_000

function createEventCtx(latest: Record<string, unknown> | null) {
  const reads = { indexName: '', range: [] as RangePredicate[], took: -1, collected: false }

  const rangeQuery = {
    eq: (field: string, value: unknown) => {
      reads.range.push(['eq', field, value])
      return rangeQuery
    },
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
    take: async (limit: number) => {
      reads.took = limit
      return latest ? [latest] : []
    },
    collect: async () => {
      reads.collected = true
      return latest ? [latest] : []
    },
  }

  return {
    reads,
    ctx: {
      db: {
        query: vi.fn(() => builder),
        insert: vi.fn(async () => 'security_event_1'),
      },
    },
  }
}

const ACCESS_ARGS = {
  userId: 'user_1',
  userEmail: 'investor@example.com',
  profileId: 'profile_1',
  deliveryCount: 151,
  viewCount: 151,
  downloadCount: 0,
  distinctDocuments: 42,
  severity: 'ALERT' as const,
  companyId: 'company_1',
}

describe('_logBulkAccessEvent', () => {
  it('no duplica un evento sin resolver dentro de la ventana', async () => {
    const { ctx } = createEventCtx({
      _id: 'event_1',
      _creationTime: Date.now() - 10 * 60_000,
      severity: 'ALERT',
      resolved: false,
    })

    await logBulkAccess(ctx, ACCESS_ARGS)

    expect(ctx.db.insert).not.toHaveBeenCalled()
  })

  it('vuelve a informar cuando el último evento quedó fuera de la ventana', async () => {
    const { ctx, reads } = createEventCtx({
      _id: 'event_1',
      _creationTime: Date.now() - 2 * HOUR_MS,
      severity: 'ALERT',
      resolved: false,
    })

    await logBulkAccess(ctx, ACCESS_ARGS)

    expect(ctx.db.insert).toHaveBeenCalledWith(
      'securityEvents',
      expect.objectContaining({
        type: 'DATA_ROOM_BULK_ACCESS',
        severity: 'ALERT',
        resolved: false,
        details: expect.objectContaining({
          deliveryCount: 151,
          viewCount: 151,
          downloadCount: 0,
          distinctDocuments: 42,
          countedActions: 'VIEW+DOWNLOAD',
        }),
      })
    )
    // Acotado: índice por (usuario, tipo), una sola fila, nunca `.collect()`.
    expect(reads.indexName).toBe('by_userId_type')
    expect(reads.range).toEqual([
      ['eq', 'userId', 'user_1'],
      ['eq', 'type', 'DATA_ROOM_BULK_ACCESS'],
    ])
    expect(reads.took).toBe(1)
    expect(reads.collected).toBe(false)
  })

  it('informa de nuevo si el operador ya resolvió el evento anterior', async () => {
    const { ctx } = createEventCtx({
      _id: 'event_1',
      _creationTime: Date.now() - 10 * 60_000,
      severity: 'ALERT',
      resolved: true,
    })

    await logBulkAccess(ctx, ACCESS_ARGS)

    expect(ctx.db.insert).toHaveBeenCalled()
  })
})

// ============================================================================
// Escalada dentro de la ventana: un WARNING no puede tapar el ALERT
// ============================================================================
// El dedupe saltaba ante CUALQUIER evento sin resolver del mismo tipo, sin mirar
// la severidad. Con el techo de 30 grants/minuto, el WARNING de 80 entregas cae
// cerca de t+2,7 min y el ALERT de 150 cerca de t+5 min: el ALERT se descartaba y
// nada nuevo podía entrar hasta ~t+62 min. La consola del operador decía "80
// entregas" mientras salían ~1.800. El salto 80→150 es mucho más ancho que el
// 20→50 de descargas, así que muerde más fuerte.
// Regla: solo se salta cuando el último evento sin resolver de la ventana tiene
// severidad IGUAL o MAYOR. Escalar siempre pasa; degradar nunca hace ruido.
// ============================================================================
describe('dedupe de alarmas masivas: la escalada de severidad pasa', () => {
  const recentUnresolved = (severity: string) => ({
    _id: 'event_1',
    _creationTime: Date.now() - 3 * 60_000,
    severity,
    resolved: false,
  })

  it('deja pasar el ALERT cuando el evento vigente de la ventana es un WARNING', async () => {
    const { ctx } = createEventCtx(recentUnresolved('WARNING'))

    await logBulkAccess(ctx, ACCESS_ARGS)

    expect(ctx.db.insert).toHaveBeenCalledWith(
      'securityEvents',
      expect.objectContaining({
        type: 'DATA_ROOM_BULK_ACCESS',
        severity: 'ALERT',
        details: expect.objectContaining({ deliveryCount: 151 }),
      })
    )
  })

  it('no repite el WARNING mientras el WARNING de la ventana sigue sin resolver', async () => {
    const { ctx } = createEventCtx(recentUnresolved('WARNING'))

    await logBulkAccess(ctx, { ...ACCESS_ARGS, severity: 'WARNING', deliveryCount: 88 })

    expect(ctx.db.insert).not.toHaveBeenCalled()
  })

  it('no degrada un ALERT vigente a WARNING', async () => {
    const { ctx } = createEventCtx(recentUnresolved('ALERT'))

    await logBulkAccess(ctx, { ...ACCESS_ARGS, severity: 'WARNING', deliveryCount: 88 })

    expect(ctx.db.insert).not.toHaveBeenCalled()
  })

  it('no repite el ALERT ya informado en la ventana', async () => {
    const { ctx } = createEventCtx(recentUnresolved('ALERT'))

    await logBulkAccess(ctx, { ...ACCESS_ARGS, deliveryCount: 300 })

    expect(ctx.db.insert).not.toHaveBeenCalled()
  })

  it('aplica la misma escalada a la alarma estricta de descargas', async () => {
    const { ctx } = createEventCtx(recentUnresolved('WARNING'))

    await logBulkDownload(ctx, {
      userId: 'user_1',
      userEmail: 'investor@example.com',
      profileId: 'profile_1',
      downloadCount: 55,
      severity: 'ALERT' as const,
      companyId: 'company_1',
    })

    expect(ctx.db.insert).toHaveBeenCalledWith(
      'securityEvents',
      expect.objectContaining({ type: 'DATA_ROOM_BULK_DOWNLOAD', severity: 'ALERT' })
    )
  })
})

describe('_logBulkDownloadEvent: mismo dedupe, ahora acotado', () => {
  const DOWNLOAD_ARGS = {
    userId: 'user_1',
    userEmail: 'investor@example.com',
    profileId: 'profile_1',
    downloadCount: 55,
    severity: 'ALERT' as const,
    companyId: 'company_1',
  }

  it('lee el último evento por (usuario, tipo) en vez de coleccionar el historial', async () => {
    const { ctx, reads } = createEventCtx(null)

    await logBulkDownload(ctx, DOWNLOAD_ARGS)

    expect(reads.indexName).toBe('by_userId_type')
    expect(reads.range).toEqual([
      ['eq', 'userId', 'user_1'],
      ['eq', 'type', 'DATA_ROOM_BULK_DOWNLOAD'],
    ])
    expect(reads.took).toBe(1)
    expect(reads.collected).toBe(false)
    expect(ctx.db.insert).toHaveBeenCalledWith(
      'securityEvents',
      expect.objectContaining({ type: 'DATA_ROOM_BULK_DOWNLOAD', severity: 'ALERT' })
    )
  })

  it('sigue saltando el duplicado sin resolver de la misma ventana', async () => {
    const { ctx } = createEventCtx({
      _id: 'event_1',
      _creationTime: Date.now() - 10 * 60_000,
      severity: 'ALERT',
      resolved: false,
    })

    await logBulkDownload(ctx, DOWNLOAD_ARGS)

    expect(ctx.db.insert).not.toHaveBeenCalled()
  })
})
