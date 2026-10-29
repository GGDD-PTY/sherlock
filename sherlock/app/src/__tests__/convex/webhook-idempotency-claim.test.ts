import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { commitWorkosWebhookEvent } from '../../../convex/users'
import {
  markFailed,
  registerEvent,
  WEBHOOK_PROCESSING_LEASE_MS,
} from '../../../convex/webhookEvents'
import { shouldProcessWebhookEvent } from '@/app/api/webhooks/_shared/idempotency'
import { createConvexCtx, runHandler } from './nda-convex-harness'

type EventRow = {
  _id: string
  provider: 'workos'
  eventId: string
  eventType: string
  status: 'received' | 'processing' | 'completed' | 'failed' | 'skipped'
  receivedAt: number
  claimVersion?: number
  processedAt?: number
  error?: string
  errorCode?: string
  result?: Record<string, unknown>
}

const runRegister = (
  registerEvent as unknown as {
    _handler: (
      ctx: unknown,
      args: {
        provider: 'workos'
        eventId: string
        eventType: string
      }
    ) => Promise<{
      isNew: boolean
      eventId: string
      status: string
      message: string
      claimVersion: number
    }>
  }
)._handler

function createCtx(initial?: EventRow) {
  let event = initial ? { ...initial } : null

  const ctx = {
    db: {
      query: vi.fn(() => ({
        withIndex: vi.fn().mockReturnThis(),
        unique: vi.fn(async () => (event ? { ...event } : null)),
      })),
      patch: vi.fn(async (_id: string, patch: Partial<EventRow>) => {
        if (!event) throw new Error('missing event')
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) {
            delete (event as Record<string, unknown>)[key]
          } else {
            ;(event as Record<string, unknown>)[key] = value
          }
        }
      }),
      insert: vi.fn(async (_table: string, row: Omit<EventRow, '_id'>) => {
        event = { ...row, _id: 'webhook_new' }
        return event._id
      }),
    },
  }

  return { ctx, getEvent: () => event }
}

const args = {
  provider: 'workos' as const,
  eventId: 'evt_retry',
  eventType: 'user.updated',
}

describe('webhookEvents.registerEvent — atomic retry claim', () => {
  it.each(['failed', 'received'] as const)(
    'allows only the first serialized retry to claim a %s event',
    async (status) => {
      const { ctx, getEvent } = createCtx({
        _id: 'webhook_existing',
        ...args,
        status,
        receivedAt: 1,
        processedAt: 2,
        error: 'transient',
        errorCode: 'INTERNAL_ERROR',
        result: { details: 'failed' },
      })

      const first = await runRegister(ctx, args)
      await expect(runRegister(ctx, args)).rejects.toMatchObject({
        data: { code: 'BUSINESS_INVALID_STATE' },
      })

      expect(first.status).toBe(status)
      expect(first.claimVersion).toBe(1)
      expect(shouldProcessWebhookEvent(first)).toBe(true)
      expect(getEvent()).toMatchObject({ status: 'processing' })
      expect(getEvent()).not.toHaveProperty('error')
      expect(getEvent()).not.toHaveProperty('processedAt')
    }
  )

  it('does not reclaim a completed event', async () => {
    const { ctx } = createCtx({
      _id: 'webhook_existing',
      ...args,
      status: 'completed',
      receivedAt: 1,
    })

    const registration = await runRegister(ctx, args)

    expect(shouldProcessWebhookEvent(registration)).toBe(false)
    expect(ctx.db.patch).not.toHaveBeenCalled()
  })
})

describe('webhookEvents.registerEvent — processing lease', () => {
  const now = 1_800_000_000_000

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pins the lease to the WorkOS route default of 300s', () => {
    expect(WEBHOOK_PROCESSING_LEASE_MS).toBe(300_000)
  })

  it('reclaims a processing row whose claim is older than the lease', async () => {
    const { ctx, getEvent } = createCtx({
      _id: 'webhook_existing',
      ...args,
      status: 'processing',
      receivedAt: now - WEBHOOK_PROCESSING_LEASE_MS - 1,
    })

    const first = await runRegister(ctx, args)
    await expect(runRegister(ctx, args)).rejects.toMatchObject({
      data: { code: 'BUSINESS_INVALID_STATE' },
    })

    expect(first.isNew).toBe(false)
    expect(shouldProcessWebhookEvent(first)).toBe(true)
    expect(getEvent()).toMatchObject({ status: 'processing', receivedAt: now })
  })

  it('requires redelivery while a processing claim is still inside the lease', async () => {
    const { ctx } = createCtx({
      _id: 'webhook_existing',
      ...args,
      status: 'processing',
      receivedAt: now - WEBHOOK_PROCESSING_LEASE_MS,
    })

    await expect(runRegister(ctx, args)).rejects.toMatchObject({
      data: { code: 'BUSINESS_INVALID_STATE' },
    })
    expect(ctx.db.patch).not.toHaveBeenCalled()
  })

  it('never reprocesses a completed event, even after the lease', async () => {
    const { ctx } = createCtx({
      _id: 'webhook_existing',
      ...args,
      status: 'completed',
      receivedAt: now - WEBHOOK_PROCESSING_LEASE_MS - 1,
      processedAt: now - WEBHOOK_PROCESSING_LEASE_MS,
    })

    const registration = await runRegister(ctx, args)

    expect(registration.status).toBe('completed')
    expect(shouldProcessWebhookEvent(registration)).toBe(false)
    expect(ctx.db.patch).not.toHaveBeenCalled()
  })
})

describe('commitWorkosWebhookEvent', () => {
  it('retries rather than acknowledging a pending event after an unversioned failure', async () => {
    const tables = {
      webhookEvents: [
        {
          _id: 'webhook_rollout',
          _creationTime: 1,
          ...args,
          status: 'processing',
          receivedAt: Date.now(),
          claimVersion: 1,
        },
      ],
    }
    const ctx = createConvexCtx(tables)

    await runHandler(markFailed, ctx, { eventId: 'webhook_rollout', error: 'old handler failed' })
    await expect(runRegister(ctx, args)).rejects.toMatchObject({
      data: { code: 'BUSINESS_INVALID_STATE' },
    })
    expect(tables.webhookEvents[0]).toMatchObject({ status: 'processing', claimVersion: 1 })

    tables.webhookEvents[0]!.receivedAt = Date.now() - WEBHOOK_PROCESSING_LEASE_MS - 1
    const retry = await runRegister(ctx, args)
    expect(retry.claimVersion).toBe(2)
    expect(shouldProcessWebhookEvent(retry)).toBe(true)
  })

  it('ignores an obsolete claim before applying any WorkOS effect', async () => {
    const tables = {
      webhookEvents: [
        {
          _id: 'webhook_claim',
          _creationTime: 1,
          ...args,
          status: 'processing',
          receivedAt: 1,
          claimVersion: 2,
        },
      ],
      providerUserTombstones: [],
      users: [],
    }
    const ctx = createConvexCtx(tables)

    const result = await runHandler(commitWorkosWebhookEvent, ctx, {
      webhookEventId: 'webhook_claim',
      claimVersion: 1,
      eventType: 'user.deleted',
      data: { id: 'user_obsolete_claim' },
    })

    expect(result).toMatchObject({ processed: false, action: 'workos_claim_stale' })
    expect(tables.providerUserTombstones).toEqual([])
    expect(tables.webhookEvents[0]).toMatchObject({ status: 'processing', claimVersion: 2 })
    expect(ctx.db.patch).not.toHaveBeenCalled()
  })

  it.each(['completed', 'skipped'])('does not undo %s after a lost response', async (status) => {
    const tables = {
      webhookEvents: [
        {
          _id: 'webhook_terminal',
          _creationTime: 1,
          ...args,
          status,
          receivedAt: 1,
          claimVersion: 1,
        },
      ],
      providerUserTombstones: [],
      users: [],
    }
    const ctx = createConvexCtx(tables)

    await runHandler(markFailed, ctx, {
      eventId: 'webhook_terminal',
      claimVersion: 1,
      error: 'response lost',
    })
    const result = await runHandler(commitWorkosWebhookEvent, ctx, {
      webhookEventId: 'webhook_terminal',
      claimVersion: 1,
      eventType: 'user.deleted',
      data: { id: 'user_terminal_claim' },
    })

    expect(result).toMatchObject({ processed: false })
    expect(tables.webhookEvents[0]).toMatchObject({ status })
    expect(tables.providerUserTombstones).toEqual([])
    expect(ctx.db.patch).not.toHaveBeenCalled()
  })

  it('keeps a retry claim safe from a late failure of the previous request', async () => {
    const tables = {
      webhookEvents: [
        {
          _id: 'webhook_retry',
          _creationTime: 1,
          ...args,
          status: 'processing',
          receivedAt: Date.now(),
          claimVersion: 1,
        },
      ],
      providerUserTombstones: [],
      users: [],
    }
    const ctx = createConvexCtx(tables)
    await runHandler(markFailed, ctx, {
      eventId: 'webhook_retry',
      claimVersion: 1,
      error: 'transient',
    })
    expect(tables.webhookEvents[0]).toMatchObject({ status: 'failed' })

    const registration = await runRegister(ctx, args)
    expect(registration.claimVersion).toBe(2)
    await runHandler(markFailed, ctx, {
      eventId: 'webhook_retry',
      claimVersion: 1,
      error: 'obsolete failure',
    })
    expect(tables.webhookEvents[0]).toMatchObject({ status: 'processing', claimVersion: 2 })

    const result = await runHandler(commitWorkosWebhookEvent, ctx, {
      webhookEventId: 'webhook_retry',
      claimVersion: 2,
      eventType: 'user.deleted',
      data: { id: 'user_valid_retry' },
    })
    expect(result).toMatchObject({ processed: true })
    expect(tables.webhookEvents[0]).toMatchObject({ status: 'completed', claimVersion: 2 })
    expect(tables.providerUserTombstones).toHaveLength(1)
  })

  it('writes the WorkOS effect and completed status in one mutation', async () => {
    const tables = {
      webhookEvents: [
        {
          _id: 'webhook_existing',
          _creationTime: 1,
          provider: 'workos' as const,
          eventId: 'evt_user_deleted',
          eventType: 'user.deleted',
          status: 'processing' as const,
          receivedAt: 1,
        },
      ],
      providerUserTombstones: [],
      users: [],
    }
    const ctx = createConvexCtx(tables)

    const result = await runHandler<
      { webhookEventId: string; claimVersion: number; eventType: string; data: unknown },
      { action: string; processed: boolean }
    >(commitWorkosWebhookEvent, ctx, {
      webhookEventId: 'webhook_existing',
      claimVersion: 0,
      eventType: 'user.deleted',
      data: { id: 'user_deleted_atomic' },
    })

    expect(result).toMatchObject({ action: 'workos_user_delete_noop', processed: true })
    expect(tables.providerUserTombstones).toEqual([
      expect.objectContaining({
        authProvider: 'workos',
        providerUserId: 'user_deleted_atomic',
      }),
    ])
    expect(tables.webhookEvents[0]).toMatchObject({
      status: 'completed',
      result: expect.objectContaining({ action: 'workos_user_delete_noop' }),
    })

    const patchesAfterCommit = ctx.db.patch.mock.calls.length
    const registration = await runRegister(ctx, {
      provider: 'workos',
      eventId: 'evt_user_deleted',
      eventType: 'user.deleted',
    })
    expect(registration.status).toBe('completed')
    expect(shouldProcessWebhookEvent(registration)).toBe(false)
    expect(ctx.db.patch.mock.calls).toHaveLength(patchesAfterCommit)
  })

  it('marks skipped in the same mutation when the event is not handled', async () => {
    const tables = {
      webhookEvents: [
        {
          _id: 'webhook_skip',
          _creationTime: 1,
          provider: 'workos' as const,
          eventId: 'evt_unknown',
          eventType: 'invoice.paid',
          status: 'processing' as const,
          receivedAt: 1,
        },
      ],
    }
    const ctx = createConvexCtx(tables)

    const result = await runHandler<
      { webhookEventId: string; claimVersion: number; eventType: string; data: unknown },
      { action: string; processed: boolean }
    >(commitWorkosWebhookEvent, ctx, {
      webhookEventId: 'webhook_skip',
      claimVersion: 0,
      eventType: 'invoice.paid',
      data: { id: 'in_1' },
    })

    expect(result).toMatchObject({ action: 'workos_event_skipped', processed: false })
    expect(tables.webhookEvents[0]).toMatchObject({
      status: 'skipped',
      result: { details: 'No local sync handler for WorkOS event invoice.paid' },
    })
  })
})
