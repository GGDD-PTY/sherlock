import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../convex/_generated/api', () => ({
  internal: {
    documents: {
      _markExpiredDocuments: 'documents:_markExpiredDocuments',
      _revokeDocumentGrantsBatch: 'documents:_revokeDocumentGrantsBatch',
    },
  },
}))

import {
  _markExpiredDocuments,
  _revokeDocumentGrantsBatch,
} from '../../../convex/_documents/internals'

type Row = Record<string, unknown> & { _id: string }
type Handler = (
  ctx: ReturnType<typeof createCtx>,
  args: Record<string, unknown>
) => Promise<unknown>

function getHandler(value: object | undefined): Handler {
  if (!value) throw new Error('Mutation export is missing')
  const handler: unknown = Object.getOwnPropertyDescriptor(value, '_handler')?.value
  if (typeof handler !== 'function') throw new Error('Mutation handler is missing')
  return async (ctx, args) => await handler(ctx, args)
}

function createQueryBuilder(rows: Row[]) {
  const predicates: Array<(row: Row) => boolean> = []
  const range = {
    eq(field: string, value: unknown) {
      predicates.push((row) => row[field] === value)
      return range
    },
    gt(field: string, value: number) {
      predicates.push((row) => typeof row[field] === 'number' && row[field] > value)
      return range
    },
    gte(field: string, value: number) {
      predicates.push((row) => typeof row[field] === 'number' && row[field] >= value)
      return range
    },
    lt(field: string, value: number) {
      predicates.push((row) => typeof row[field] === 'number' && row[field] < value)
      return range
    },
  }
  const matchingRows = () => rows.filter((row) => predicates.every((predicate) => predicate(row)))
  const builder = {
    withIndex: vi.fn((_index: string, callback: (query: typeof range) => unknown) => {
      callback(range)
      return builder
    }),
    filter: vi.fn(() => builder),
    collect: vi.fn(async () => matchingRows()),
    take: vi.fn(async (limit: number) => matchingRows().slice(0, limit)),
  }
  return builder
}

function createCtx(tables: { documents?: Row[]; documentAccessGrants?: Row[] }) {
  const builders: ReturnType<typeof createQueryBuilder>[] = []
  const ctx = {
    db: {
      query: vi.fn((table: 'documents' | 'documentAccessGrants') => {
        const builder = createQueryBuilder(tables[table] ?? [])
        builders.push(builder)
        return builder
      }),
      patch: vi.fn(async () => undefined),
    },
    scheduler: {
      runAfter: vi.fn(
        async (_delayMs: number, _reference: string, _args: Record<string, unknown>) => undefined
      ),
    },
  }
  return { ...ctx, builders }
}

describe('document expiry batching', () => {
  it('marks one bounded document batch and schedules the remaining work', async () => {
    const now = Date.now()
    const documents = Array.from({ length: 26 }, (_, index) => ({
      _id: `document_${index}`,
      _creationTime: index,
      expiresAt: now - 1000 - index,
      isExpired: index % 2 === 0 ? undefined : false,
    }))
    const ctx = createCtx({ documents })
    const markExpired = getHandler(_markExpiredDocuments)

    await expect(markExpired(ctx, {})).resolves.toEqual({ markedCount: 25, isDone: false })

    expect(ctx.db.patch).toHaveBeenCalledTimes(25)
    expect(ctx.builders.every((builder) => builder.collect.mock.calls.length === 0)).toBe(true)
    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(0, 'documents:_markExpiredDocuments', {})
    const revokeCalls = ctx.scheduler.runAfter.mock.calls.filter(
      (call) => call[1] === 'documents:_revokeDocumentGrantsBatch'
    )
    expect(revokeCalls).toHaveLength(25)
  })

  it('revokes one bounded grant batch and schedules the remainder', async () => {
    const now = Date.now()
    const grants = Array.from({ length: 101 }, (_, index) => ({
      _id: `grant_${index}`,
      documentId: 'document_1',
      revokedAt: undefined,
      expiresAt: now + 60_000,
    }))
    const ctx = createCtx({ documentAccessGrants: grants })
    const revokeBatch = getHandler(_revokeDocumentGrantsBatch)

    await expect(
      revokeBatch(ctx, {
        documentId: 'document_1',
        reason: 'DOCUMENT_EXPIRED',
        revokedAt: now,
      })
    ).resolves.toEqual({ revokedCount: 100, isDone: false })

    expect(ctx.db.patch).toHaveBeenCalledTimes(100)
    expect(ctx.builders.every((builder) => builder.collect.mock.calls.length === 0)).toBe(true)
    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(0, 'documents:_revokeDocumentGrantsBatch', {
      documentId: 'document_1',
      reason: 'DOCUMENT_EXPIRED',
      revokedAt: now,
    })
  })
})
