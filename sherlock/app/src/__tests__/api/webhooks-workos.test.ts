import { describe, expect, it, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  getConvexAdminClient: vi.fn(),
  mutation: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}))

vi.mock('@workos-inc/node', () => ({
  WorkOS: class MockWorkOS {
    webhooks = {
      constructEvent: mocks.constructEvent,
    }
  },
}))

vi.mock('@/lib/convex/admin-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/convex/admin-client')>()),
  getConvexAdminClient: mocks.getConvexAdminClient,
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mocks.logWarn,
    error: mocks.logError,
    debug: vi.fn(),
  }),
}))

vi.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitDistributed: vi.fn().mockResolvedValue({
    success: true,
    remaining: 99,
    resetAt: new Date(),
    retryAfterSec: 0,
  }),
  createRateLimitResponse: vi.fn(),
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
  RATE_LIMIT_PRESETS: { webhook: { maxRequests: 100, windowMs: 60000 } },
}))

import { POST } from '@/app/api/webhooks/workos/route'

function createRequest(
  body: object,
  signature = 'valid-workos-signature',
  requestId?: string
): NextRequest {
  return new NextRequest('http://localhost:3000/api/webhooks/workos', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: signature
      ? {
          'workos-signature': signature,
          'x-forwarded-for': '203.0.113.10',
          'user-agent': 'WorkOS-Webhooks/1.0',
          ...(requestId ? { 'x-request-id': requestId } : {}),
        }
      : {},
  })
}

describe('POST /api/webhooks/workos', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.WORKOS_API_KEY = 'workos_api_key_for_tests'
    process.env.WORKOS_WEBHOOK_SECRET = 'workos_webhook_secret_for_tests'
    mocks.getConvexAdminClient.mockReturnValue({ mutation: mocks.mutation })
    mocks.constructEvent.mockResolvedValue({
      id: 'event_workos_123',
      event: 'user.created',
      data: { id: 'user_workos_123' },
    })
  })

  it('returns 500 when Convex admin configuration is missing', async () => {
    mocks.getConvexAdminClient.mockReturnValue(null)

    const response = await POST(createRequest({ id: 'event_workos_123', event: 'user.created' }))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'Internal WorkOS webhook error',
      requestId: response.headers.get('x-request-id'),
    })
    expect(mocks.constructEvent).not.toHaveBeenCalled()
  })

  // QA post-deploy de #776: el rechazo salía en text/plain y a nivel error. Es
  // entrada de afuera: sobre JSON con requestId, no-store, nosniff, y warn.
  it('returns the 400 JSON envelope and logs at warn when the signature header is missing', async () => {
    const response = await POST(
      createRequest({ id: 'event_workos_123', event: 'user.created' }, '')
    )

    const requestId = response.headers.get('x-request-id')
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    await expect(response.json()).resolves.toEqual({
      error: 'Missing WorkOS signature header',
      requestId,
    })
    expect(mocks.logWarn).toHaveBeenCalledWith('Missing WorkOS signature header', {
      requestId,
      correlationId: requestId,
    })
    expect(mocks.logError).not.toHaveBeenCalled()
    expect(mocks.constructEvent).not.toHaveBeenCalled()
    expect(mocks.mutation).not.toHaveBeenCalled()
  })

  it('returns 400 when WorkOS signature verification fails', async () => {
    mocks.constructEvent.mockRejectedValueOnce(
      new Error('bad signature token=do-not-log-signature email=private@example.com')
    )

    const response = await POST(
      createRequest(
        { id: 'event_workos_123', event: 'user.created' },
        'invalid-workos-signature',
        'request-invalid-signature'
      )
    )

    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('x-request-id')).toBe('request-invalid-signature')
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid signature',
      requestId: 'request-invalid-signature',
    })
    expect(mocks.logWarn).toHaveBeenCalledWith('Invalid WorkOS signature', {
      errorCode: 'WORKOS_SIGNATURE_INVALID',
      requestId: 'request-invalid-signature',
      correlationId: 'request-invalid-signature',
    })
    expect(mocks.logError).not.toHaveBeenCalled()
    // La firma se rechaza antes de registrar el evento: nada llega a webhookEvents.
    expect(mocks.mutation).not.toHaveBeenCalled()
    const serializedLogs = JSON.stringify(mocks.logWarn.mock.calls)
    expect(serializedLogs).not.toContain('do-not-log-signature')
    expect(serializedLogs).not.toContain('private@example.com')
  })

  it('redacts failures while creating the Convex admin client', async () => {
    mocks.getConvexAdminClient.mockImplementationOnce(() => {
      throw new Error('client bootstrap failed token=do-not-log-client email=private@example.com')
    })

    const response = await POST(
      createRequest(
        { id: 'event_workos_123', event: 'user.created' },
        'valid-workos-signature',
        'request-admin-client'
      )
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'Internal WorkOS webhook error',
      requestId: 'request-admin-client',
    })
    expect(response.headers.get('x-request-id')).toBe('request-admin-client')
    expect(response.headers.get('x-correlation-id')).toBe('request-admin-client')
    expect(mocks.logError).toHaveBeenCalledWith('WorkOS webhook processing error', {
      errorCode: 'CONVEX_ADMIN_REQUEST_FAILED',
      requestId: 'request-admin-client',
      correlationId: 'request-admin-client',
    })
    const serializedLogs = JSON.stringify(mocks.logError.mock.calls)
    expect(serializedLogs).not.toContain('do-not-log-client')
    expect(serializedLogs).not.toContain('private@example.com')
  })

  it('returns a correlated generic failure and logs only a stable code when Convex denies admin auth', async () => {
    mocks.mutation.mockRejectedValueOnce(
      new Error('PERMISSION_DENIED token=do-not-log-token email=private@example.com')
    )

    const response = await POST(
      createRequest(
        { id: 'event_workos_123', event: 'user.created' },
        'valid-workos-signature',
        'request-issue-191'
      )
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'Internal WorkOS webhook error',
      requestId: 'request-issue-191',
    })
    expect(response.headers.get('x-request-id')).toBe('request-issue-191')
    expect(response.headers.get('x-correlation-id')).toBe('request-issue-191')
    expect(mocks.logError).toHaveBeenCalledWith('WorkOS webhook processing error', {
      errorCode: 'CONVEX_ADMIN_PERMISSION_DENIED',
      requestId: 'request-issue-191',
      correlationId: 'request-issue-191',
    })

    const serializedLogs = JSON.stringify(mocks.logError.mock.calls)
    expect(serializedLogs).not.toContain('do-not-log-token')
    expect(serializedLogs).not.toContain('private@example.com')
  })

  it('persists only the safe failure envelope when denial happens after event registration', async () => {
    mocks.mutation
      .mockResolvedValueOnce({
        isNew: true,
        eventId: 'webhook_event_registered',
        claimVersion: 7,
        status: 'received',
        message: 'Event registered',
      })
      .mockRejectedValueOnce(
        new Error('PERMISSION_DENIED token=do-not-persist email=private@example.com')
      )
      .mockResolvedValueOnce(undefined)

    const response = await POST(createRequest({ id: 'event_workos_123', event: 'user.created' }))

    expect(response.status).toBe(500)
    expect(mocks.mutation).toHaveBeenCalledTimes(3)
    // markFailed solo acepta VALIDATION_ERROR/SIGNATURE_VERIFICATION_FAILED/
    // INTERNAL_ERROR; el código admin viaja en errorContext.
    expect(mocks.mutation.mock.calls[2]?.[1]).toEqual({
      eventId: 'webhook_event_registered',
      claimVersion: 7,
      error: 'Convex rejected the server authorization.',
      errorCode: 'INTERNAL_ERROR',
      errorContext: { adminFailureCode: 'CONVEX_ADMIN_PERMISSION_DENIED' },
    })
    const persistedFailure = JSON.stringify(mocks.mutation.mock.calls[2]?.[1])
    expect(persistedFailure).not.toContain('do-not-persist')
    expect(persistedFailure).not.toContain('private@example.com')
    expect(mocks.mutation.mock.calls[1]?.[1]).toMatchObject({ claimVersion: 7 })
  })

  it('returns a retryable error when registration finds an event still in progress', async () => {
    mocks.mutation.mockRejectedValueOnce(new Error('El webhook de WorkOS sigue en proceso'))

    const response = await POST(createRequest({ id: 'event_workos_123', event: 'user.created' }))

    expect(response.status).toBe(500)
    expect(mocks.mutation).toHaveBeenCalledTimes(1)
    await expect(response.json()).resolves.toMatchObject({ error: 'Internal WorkOS webhook error' })
  })

  it('records duplicate WorkOS events without processing them again', async () => {
    mocks.mutation.mockResolvedValueOnce({
      isNew: false,
      eventId: 'webhook_event_123',
      status: 'completed',
      message: 'Event already processed',
    })

    const response = await POST(createRequest({ id: 'event_workos_123', event: 'user.created' }))
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data).toEqual({
      received: true,
      duplicate: true,
      message: 'Event already processed',
      requestId: response.headers.get('x-request-id'),
    })
    expect(mocks.mutation).toHaveBeenCalledTimes(1)
    expect(mocks.mutation.mock.calls[0]?.[1]).toMatchObject({
      provider: 'workos',
      eventId: 'event_workos_123',
      eventType: 'user.created',
      ipAddress: '203.0.113.10',
      userAgent: 'WorkOS-Webhooks/1.0',
    })
  })

  it('reprocesses a WorkOS retry of an event that previously failed', async () => {
    // El primer intento respondió 500 y dejó la fila en 'failed'; el reintento
    // de WorkOS debe volver a sincronizar en vez de descartarse como duplicado.
    mocks.mutation.mockResolvedValueOnce({
      isNew: false,
      eventId: 'webhook_event_failed',
      status: 'failed',
      message: 'Evento ya procesado con status: failed',
    })
    mocks.mutation.mockResolvedValueOnce({
      action: 'workos_user_synced',
      resourceId: 'user_workos_123',
      details: 'Synced WorkOS user user_workos_123',
      processed: true,
    })

    const response = await POST(createRequest({ id: 'event_workos_123', event: 'user.created' }))
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data).toEqual({
      received: true,
      processed: true,
      eventType: 'user.created',
      action: 'workos_user_synced',
      requestId: response.headers.get('x-request-id'),
    })
    // registerEvent, luego una sola mutation que sincroniza y completa.
    expect(mocks.mutation).toHaveBeenCalledTimes(2)
    expect(mocks.mutation.mock.calls[1]?.[1]).toMatchObject({
      webhookEventId: 'webhook_event_failed',
      eventType: 'user.created',
      data: { id: 'user_workos_123' },
    })
  })

  it('verifies, syncs, and completes handled WorkOS events', async () => {
    mocks.mutation.mockResolvedValueOnce({
      isNew: true,
      eventId: 'webhook_event_123',
      status: 'received',
      message: 'Event registered',
    })
    mocks.mutation.mockResolvedValueOnce({
      action: 'workos_user_synced',
      resourceId: 'user_workos_123',
      details: 'Synced WorkOS user user_workos_123',
      processed: true,
    })

    const response = await POST(createRequest({ id: 'event_workos_123', event: 'user.created' }))
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data).toEqual({
      received: true,
      processed: true,
      eventType: 'user.created',
      action: 'workos_user_synced',
      requestId: response.headers.get('x-request-id'),
    })
    expect(mocks.mutation).toHaveBeenCalledTimes(2)
    expect(mocks.mutation.mock.calls[1]?.[1]).toEqual({
      webhookEventId: 'webhook_event_123',
      claimVersion: 0,
      eventType: 'user.created',
      data: { id: 'user_workos_123' },
    })
  })

  it('marks a verified WorkOS event as skipped when it is not handled', async () => {
    mocks.mutation.mockResolvedValueOnce({
      isNew: true,
      eventId: 'webhook_event_skipped',
      status: 'received',
      message: 'Event registered',
    })
    mocks.mutation.mockResolvedValueOnce({
      action: 'ignored',
      details: 'WorkOS event user.created was verified but not handled.',
      processed: false,
    })

    const response = await POST(
      createRequest(
        { id: 'event_workos_123', event: 'user.created' },
        'valid-workos-signature',
        'request-workos-skipped'
      )
    )
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data).toEqual({
      received: true,
      processed: false,
      eventType: 'user.created',
      action: 'ignored',
      requestId: 'request-workos-skipped',
    })
    // registerEvent, luego una sola mutation que sincroniza y marca skipped.
    expect(mocks.mutation).toHaveBeenCalledTimes(2)
    expect(mocks.mutation.mock.calls[1]?.[1]).toEqual({
      webhookEventId: 'webhook_event_skipped',
      claimVersion: 0,
      eventType: 'user.created',
      data: { id: 'user_workos_123' },
    })
  })
})
