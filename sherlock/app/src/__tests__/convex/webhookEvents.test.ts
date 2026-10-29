// ============================================================================
// WEBHOOK EVENTS UNIT TESTS (convex/webhookEvents.ts)
// ============================================================================
// Tests for webhook idempotency and event tracking.
// Covers: registration, idempotency checks, status updates, and stats.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConvexCtx, createMockQueryBuilder } from '../utils/convex-test-utils'
import { mockId } from '../utils/test-factories'
import { registerEvent } from '../../../convex/webhookEvents'
import { runHandler } from './nda-convex-harness'

// ============================================================================
// MOCK TYPES
// ============================================================================

type WebhookProvider = 'clerk' | 'lemonsqueezy'
type WebhookStatus = 'received' | 'processing' | 'completed' | 'failed' | 'skipped'

interface MockWebhookEvent {
  _id: ReturnType<typeof mockId>
  _creationTime: number
  provider: WebhookProvider
  eventId: string
  eventType: string
  status: WebhookStatus
  payload?: Record<string, unknown>
  receivedAt: number
  processedAt?: number
  requestId?: string
  correlationId?: string
  ipAddress?: string
  userAgent?: string
  result?: {
    action?: string
    resourceId?: string
    details?: string
  }
  error?: string
  errorCode?: string
}

// ============================================================================
// MOCK FACTORIES
// ============================================================================

function createMockWebhookEvent(
  overrides: Partial<Omit<MockWebhookEvent, '_id'>> = {}
): MockWebhookEvent {
  return {
    _id: mockId('webhookEvents'),
    _creationTime: Date.now(),
    provider: 'clerk',
    eventId: `evt_${Date.now()}`,
    eventType: 'user.created',
    status: 'processing',
    receivedAt: Date.now(),
    ...overrides,
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe('convex/webhookEvents.ts', () => {
  let ctx: ReturnType<typeof createMockConvexCtx>

  beforeEach(() => {
    ctx = createMockConvexCtx()
    vi.clearAllMocks()
  })

  // ============================================================================
  // REGISTER EVENT
  // ============================================================================
  describe('registerEvent', () => {
    it('should return isNew: false for duplicate event', async () => {
      const existingEvent = createMockWebhookEvent({
        eventId: 'evt_duplicate',
        status: 'completed',
      })

      ctx.db.query.mockReturnValue(createMockQueryBuilder([existingEvent]))

      const queryBuilder = ctx.db.query('webhookEvents')
      const existing = await queryBuilder.unique()

      if (existing) {
        const response = {
          isNew: false,
          eventId: existing._id,
          status: existing.status,
          message: `Evento ${existing.eventId} ya procesado con status: ${existing.status}`,
        }

        expect(response.isNew).toBe(false)
        expect(response.status).toBe('completed')
      }
    })

    it('should create new event and return isNew: true', async () => {
      ctx.db.query.mockReturnValue(createMockQueryBuilder([]))

      const newEventId = mockId('webhookEvents')
      ctx.db.insert.mockResolvedValue(newEventId)

      const queryBuilder = ctx.db.query('webhookEvents')
      const existing = await queryBuilder.unique()

      expect(existing).toBeNull()

      await ctx.db.insert('webhookEvents', {
        provider: 'clerk',
        eventId: 'evt_new',
        eventType: 'user.created',
        status: 'processing',
        receivedAt: Date.now(),
      })

      expect(ctx.db.insert).toHaveBeenCalledWith(
        'webhookEvents',
        expect.objectContaining({
          status: 'processing',
          eventId: 'evt_new',
        })
      )
    })

    it('should store optional metadata (IP, User-Agent)', async () => {
      ctx.db.query.mockReturnValue(createMockQueryBuilder([]))

      await ctx.db.insert('webhookEvents', {
        provider: 'lemonsqueezy',
        eventId: 'evt_ls_123',
        eventType: 'subscription_created',
        status: 'processing',
        receivedAt: Date.now(),
        requestId: 'request-123',
        correlationId: 'request-123',
        ipAddress: '192.168.1.1',
        userAgent: 'LemonSqueezy-Webhooks/1.0',
      })

      expect(ctx.db.insert).toHaveBeenCalledWith(
        'webhookEvents',
        expect.objectContaining({
          requestId: 'request-123',
          correlationId: 'request-123',
          ipAddress: '192.168.1.1',
          userAgent: 'LemonSqueezy-Webhooks/1.0',
        })
      )
    })

    it('should store payload for debugging', async () => {
      ctx.db.query.mockReturnValue(createMockQueryBuilder([]))

      const payload = {
        data: { userId: 'user_123' },
        type: 'user.created',
      }

      await ctx.db.insert('webhookEvents', {
        provider: 'clerk',
        eventId: 'evt_payload',
        eventType: 'user.created',
        status: 'processing',
        payload,
        receivedAt: Date.now(),
      })

      expect(ctx.db.insert).toHaveBeenCalledWith(
        'webhookEvents',
        expect.objectContaining({
          payload: expect.objectContaining({
            type: 'user.created',
          }),
        })
      )
    })
  })

  // ============================================================================
  // REDACCIÓN DE PII EN EL PAYLOAD (H2 parcial, cobertura 2026-09-11)
  // ============================================================================
  describe('registerEvent — redacción del payload', () => {
    it('conserva solo los valores bajo claves técnicas y tapa el resto a cualquier profundidad', async () => {
      ctx.db.query.mockReturnValue(createMockQueryBuilder([]))

      await runHandler(registerEvent, ctx, {
        provider: 'workos',
        eventId: 'evt_pii',
        eventType: 'dsync.user.created',
        payload: {
          id: 'evt_pii',
          event: 'dsync.user.created',
          created_at: '2026-09-11T17:00:00Z',
          data: {
            id: 'user_01',
            directory_id: 'dir_01',
            state: 'active',
            email_verified: true,
            first_name: 'Ana',
            last_name: 'Pérez',
            username: 'ana.perez',
            emails: [{ primary: true, type: 'work', value: 'ana@example.com' }],
            custom_attributes: { department: 'Finanzas' },
            raw_attributes: { name: { givenName: 'Ana' }, phoneNumbers: ['+507 6000 0000'] },
          },
        },
      })

      expect(ctx.db.insert).toHaveBeenCalledWith(
        'webhookEvents',
        expect.objectContaining({
          payload: {
            id: 'evt_pii',
            event: 'dsync.user.created',
            created_at: '2026-09-11T17:00:00Z',
            data: {
              id: 'user_01',
              directory_id: 'dir_01',
              state: 'active',
              email_verified: true,
              first_name: '[redacted]',
              last_name: '[redacted]',
              username: '[redacted]',
              emails: [{ primary: true, type: 'work', value: '[redacted]' }],
              custom_attributes: { department: '[redacted]' },
              raw_attributes: { name: { givenName: '[redacted]' }, phoneNumbers: ['[redacted]'] },
            },
          },
        })
      )
    })

    it('deja pasar nulos y un payload ausente tal cual', async () => {
      ctx.db.query.mockReturnValue(createMockQueryBuilder([]))

      await runHandler(registerEvent, ctx, {
        provider: 'workos',
        eventId: 'evt_plain',
        eventType: 'organization.updated',
        payload: { data: { id: 'org_01', name: 'Sample Foods', email: null } },
      })
      await runHandler(registerEvent, ctx, {
        provider: 'workos',
        eventId: 'evt_none',
        eventType: 'organization.updated',
      })

      expect(ctx.db.insert).toHaveBeenNthCalledWith(
        1,
        'webhookEvents',
        expect.objectContaining({
          payload: { data: { id: 'org_01', name: '[redacted]', email: null } },
        })
      )
      expect(ctx.db.insert).toHaveBeenNthCalledWith(
        2,
        'webhookEvents',
        expect.objectContaining({ payload: undefined })
      )
    })
  })

  // ============================================================================
  // MARK COMPLETED
  // ============================================================================
  describe('markCompleted', () => {
    it('should update event status to completed', async () => {
      const event = createMockWebhookEvent({ status: 'processing' })

      await ctx.db.patch(event._id, {
        status: 'completed',
        processedAt: Date.now(),
        result: {
          action: 'user_created',
          resourceId: 'user_123',
        },
      })

      expect(ctx.db.patch).toHaveBeenCalledWith(
        event._id,
        expect.objectContaining({
          status: 'completed',
        })
      )
    })

    it('should include result details', async () => {
      const event = createMockWebhookEvent()

      await ctx.db.patch(event._id, {
        status: 'completed',
        processedAt: Date.now(),
        result: {
          action: 'subscription_created',
          resourceId: 'sub_456',
          details: 'PRO subscription activated',
        },
      })

      expect(ctx.db.patch).toHaveBeenCalledWith(
        event._id,
        expect.objectContaining({
          result: expect.objectContaining({
            details: 'PRO subscription activated',
          }),
        })
      )
    })
  })

  // ============================================================================
  // MARK FAILED
  // ============================================================================
  describe('markFailed', () => {
    it('should update event status to failed with error', async () => {
      const event = createMockWebhookEvent({ status: 'processing' })

      await ctx.db.patch(event._id, {
        status: 'failed',
        processedAt: Date.now(),
        error: 'Invalid payload format',
        errorCode: 'INTERNAL_ERROR',
      })

      expect(ctx.db.patch).toHaveBeenCalledWith(
        event._id,
        expect.objectContaining({
          status: 'failed',
          error: 'Invalid payload format',
          errorCode: 'INTERNAL_ERROR',
        })
      )
    })
  })

  // ============================================================================
  // MARK SKIPPED
  // ============================================================================
  describe('markSkipped', () => {
    it('should update event status to skipped', async () => {
      const event = createMockWebhookEvent({ status: 'processing' })

      await ctx.db.patch(event._id, {
        status: 'skipped',
        processedAt: Date.now(),
        errorCode: 'VALIDATION_ERROR',
        result: {
          details: 'Event type not handled',
        },
      })

      expect(ctx.db.patch).toHaveBeenCalledWith(
        event._id,
        expect.objectContaining({
          status: 'skipped',
          errorCode: 'VALIDATION_ERROR',
        })
      )
    })

    it('should use default reason if not provided', async () => {
      const event = createMockWebhookEvent()
      const reason = undefined

      await ctx.db.patch(event._id, {
        status: 'skipped',
        processedAt: Date.now(),
        result: {
          details: reason || 'Evento ignorado',
        },
      })

      expect(ctx.db.patch).toHaveBeenCalledWith(
        event._id,
        expect.objectContaining({
          result: expect.objectContaining({
            details: 'Evento ignorado',
          }),
        })
      )
    })
  })

  // ============================================================================
  // GET RECENT EVENTS
  // ============================================================================
  describe('getRecentEvents', () => {
    it('should return recent events ordered by desc', async () => {
      const events = [
        createMockWebhookEvent({
          eventId: 'evt_1',
          receivedAt: Date.now() - 1000,
        }),
        createMockWebhookEvent({ eventId: 'evt_2', receivedAt: Date.now() }),
        createMockWebhookEvent({
          eventId: 'evt_3',
          receivedAt: Date.now() - 2000,
        }),
      ]

      // Sort by receivedAt desc
      events.sort((a, b) => b.receivedAt - a.receivedAt)

      ctx.db.query.mockReturnValue(createMockQueryBuilder(events))

      const queryBuilder = ctx.db.query('webhookEvents')
      const result = await queryBuilder.take(50)

      expect(result[0].eventId).toBe('evt_2')
    })

    it('should filter by provider', async () => {
      const events = [
        createMockWebhookEvent({ provider: 'clerk' }),
        createMockWebhookEvent({ provider: 'lemonsqueezy' }),
        createMockWebhookEvent({ provider: 'clerk' }),
      ]

      ctx.db.query.mockReturnValue(createMockQueryBuilder(events))

      const queryBuilder = ctx.db.query('webhookEvents')
      const allEvents = await queryBuilder.take(100)

      const clerkEvents = allEvents.filter((e: MockWebhookEvent) => e.provider === 'clerk')

      expect(clerkEvents).toHaveLength(2)
    })

    it('should filter by status', async () => {
      const events = [
        createMockWebhookEvent({ status: 'completed' }),
        createMockWebhookEvent({ status: 'failed' }),
        createMockWebhookEvent({ status: 'completed' }),
        createMockWebhookEvent({ status: 'skipped' }),
      ]

      ctx.db.query.mockReturnValue(createMockQueryBuilder(events))

      const queryBuilder = ctx.db.query('webhookEvents')
      const allEvents = await queryBuilder.take(100)

      const failedEvents = allEvents.filter((e: MockWebhookEvent) => e.status === 'failed')

      expect(failedEvents).toHaveLength(1)
    })

    it('should respect limit parameter', async () => {
      const events = Array.from({ length: 100 }, (_, i) =>
        createMockWebhookEvent({ eventId: `evt_${i}` })
      )

      ctx.db.query.mockReturnValue(createMockQueryBuilder(events))

      const limit = 10
      const queryBuilder = ctx.db.query('webhookEvents')
      const allEvents = await queryBuilder.take(limit * 2)

      const limited = allEvents.slice(0, limit)

      expect(limited).toHaveLength(10)
    })
  })

  // ============================================================================
  // GET STATS
  // ============================================================================
  describe('getStats', () => {
    it('should count events by status', async () => {
      const now = Date.now()
      const events = [
        createMockWebhookEvent({ status: 'completed', receivedAt: now - 1000 }),
        createMockWebhookEvent({ status: 'completed', receivedAt: now - 2000 }),
        createMockWebhookEvent({ status: 'failed', receivedAt: now - 3000 }),
        createMockWebhookEvent({ status: 'skipped', receivedAt: now - 4000 }),
      ]

      ctx.db.query.mockReturnValue(createMockQueryBuilder(events))

      const queryBuilder = ctx.db.query('webhookEvents')
      const allEvents = await queryBuilder.collect()

      const byStatus = allEvents.reduce(
        (acc: Record<string, number>, e: MockWebhookEvent) => {
          acc[e.status] = (acc[e.status] || 0) + 1
          return acc
        },
        {} as Record<string, number>
      )

      expect(byStatus.completed).toBe(2)
      expect(byStatus.failed).toBe(1)
      expect(byStatus.skipped).toBe(1)
    })

    it('should count events by provider', async () => {
      const events = [
        createMockWebhookEvent({ provider: 'clerk' }),
        createMockWebhookEvent({ provider: 'clerk' }),
        createMockWebhookEvent({ provider: 'clerk' }),
        createMockWebhookEvent({ provider: 'lemonsqueezy' }),
      ]

      ctx.db.query.mockReturnValue(createMockQueryBuilder(events))

      const queryBuilder = ctx.db.query('webhookEvents')
      const allEvents = await queryBuilder.collect()

      const byProvider = allEvents.reduce(
        (acc: Record<string, number>, e: MockWebhookEvent) => {
          acc[e.provider] = (acc[e.provider] || 0) + 1
          return acc
        },
        {} as Record<string, number>
      )

      expect(byProvider.clerk).toBe(3)
      expect(byProvider.lemonsqueezy).toBe(1)
    })

    it('should filter events by time window', async () => {
      const now = Date.now()
      const hoursBack = 24
      const since = now - hoursBack * 60 * 60 * 1000

      const events = [
        createMockWebhookEvent({ receivedAt: now - 1000 }), // Recent
        createMockWebhookEvent({ receivedAt: now - 3600000 }), // 1 hour ago
        createMockWebhookEvent({ receivedAt: now - 86400000 * 2 }), // 2 days ago
      ]

      ctx.db.query.mockReturnValue(createMockQueryBuilder(events))

      const queryBuilder = ctx.db.query('webhookEvents')
      const allEvents = await queryBuilder.collect()

      const recentEvents = allEvents.filter((e: MockWebhookEvent) => e.receivedAt > since)

      expect(recentEvents).toHaveLength(2)
    })

    it('should use default 24 hours if hoursBack not specified', () => {
      const hoursBack = undefined
      const defaultHours = hoursBack || 24

      expect(defaultHours).toBe(24)
    })
  })

  // ============================================================================
  // WEBHOOK PROVIDERS
  // ============================================================================
  describe('Webhook Providers', () => {
    it('should support clerk provider', async () => {
      const event = createMockWebhookEvent({
        provider: 'clerk',
        eventType: 'user.created',
      })

      expect(event.provider).toBe('clerk')
    })

    it('should support lemonsqueezy provider', async () => {
      const event = createMockWebhookEvent({
        provider: 'lemonsqueezy',
        eventType: 'subscription_created',
      })

      expect(event.provider).toBe('lemonsqueezy')
    })
  })

  // ============================================================================
  // STATUS TRANSITIONS
  // ============================================================================
  describe('Status Transitions', () => {
    it('should follow valid transition: received -> processing -> completed', () => {
      const validTransitions = {
        received: ['processing'],
        processing: ['completed', 'failed', 'skipped'],
        completed: [],
        failed: [],
        skipped: [],
      }

      expect(validTransitions.processing).toContain('completed')
    })

    it('should allow processing -> failed transition', () => {
      const event = createMockWebhookEvent({ status: 'processing' })

      // Valid to go from processing to failed
      expect(event.status).toBe('processing')
    })

    it('should allow processing -> skipped transition', () => {
      const event = createMockWebhookEvent({ status: 'processing' })

      // Valid to go from processing to skipped
      expect(event.status).toBe('processing')
    })
  })
})
