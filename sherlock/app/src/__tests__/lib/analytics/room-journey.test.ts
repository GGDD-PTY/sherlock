import { Exit, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseRoomJourneyJson, roomJourneyEventSchema } from '@/lib/analytics/room-journey-contract'

const capturedPayloadSchema = Schema.Struct({
  api_key: Schema.String,
  uuid: Schema.String,
  event: Schema.String,
  timestamp: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Unknown),
})

const decodeCapturedPayload = Schema.decodeUnknownSync(capturedPayloadSchema, {
  onExcessProperty: 'error',
})
const isRoomJourneyEvent = (input: unknown) =>
  Exit.isSuccess(
    Schema.decodeUnknownExit(roomJourneyEventSchema, { onExcessProperty: 'error' })(input)
  )

describe('room journey analytics contract', () => {
  it('accepts only the named document kind property for document events', () => {
    expect(
      isRoomJourneyEvent({
        event: 'document_opened',
        properties: { documentKind: 'pdf' },
      })
    ).toBe(true)
    expect(
      isRoomJourneyEvent({
        event: 'document_opened',
        properties: { documentKind: 'pdf', documentId: 'private-id' },
      })
    ).toBe(false)
    expect(
      isRoomJourneyEvent({
        event: 'room_entered',
        properties: { companyId: 'private-id' },
      })
    ).toBe(false)
  })

  it('bounds and validates JSON at the request boundary', async () => {
    const valid = await parseRoomJourneyJson(
      new Request('http://localhost/api/analytics/journey', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'assistant_opened', properties: {} }),
      })
    )
    const oversized = await parseRoomJourneyJson(
      new Request('http://localhost/api/analytics/journey', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'room_entered', properties: {}, padding: 'x'.repeat(600) }),
      })
    )

    expect(valid).toEqual({
      ok: true,
      data: { event: 'assistant_opened', properties: {} },
    })
    expect(oversized).toEqual({ ok: false, status: 413, code: 'PAYLOAD_TOO_LARGE' })
  })
})

describe('server-side room journey analytics', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test_project_key')
    vi.stubEnv('POSTHOG_INGEST_HOST', 'https://eu.i.posthog.com')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('emits only personless closed-schema properties with a hashed actor', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { captureRoomJourneyEvent } = await import('@/lib/analytics/room-journey-server')

    const captured = await captureRoomJourneyEvent({
      actorId: 'workos_random_user_123',
      actorRole: 'COMPANY',
      journeyEvent: { event: 'document_opened', properties: { documentKind: 'spreadsheet' } },
      requestHeaders: new Headers(),
    })

    expect(captured).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://eu.i.posthog.com/e/',
      expect.objectContaining({ method: 'POST', cache: 'no-store' })
    )

    const requestInit = fetchMock.mock.calls[0]?.[1]
    if (!requestInit || typeof requestInit.body !== 'string') {
      throw new Error('Expected a JSON PostHog request body')
    }
    const payload = decodeCapturedPayload(JSON.parse(requestInit.body) as unknown)
    expect(payload.event).toBe('document_opened')
    expect(payload.properties).toEqual({
      token: 'phc_test_project_key',
      distinct_id: expect.stringMatching(/^room_actor_[a-f0-9]{64}$/),
      $process_person_profile: false,
      $geoip_disable: true,
      actorRole: 'COMPANY',
      documentKind: 'spreadsheet',
    })
    expect(JSON.stringify(payload)).not.toMatch(
      /workos_random_user_123|email|companyId|documentId|filename|pathname|current_url/i
    )
  })

  it('honors DNT and GPC and never emits outside production', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const { captureRoomJourneyEvent } = await import('@/lib/analytics/room-journey-server')
    const baseInput = {
      actorId: 'workos_random_user_123',
      actorRole: 'ADMIN' as const,
      journeyEvent: { event: 'dashboard_opened' as const, properties: {} },
    }

    expect(
      await captureRoomJourneyEvent({
        ...baseInput,
        requestHeaders: new Headers({ dnt: '1' }),
      })
    ).toBe(false)
    expect(
      await captureRoomJourneyEvent({
        ...baseInput,
        requestHeaders: new Headers({ 'sec-gpc': '1' }),
      })
    ).toBe(false)

    vi.stubEnv('NODE_ENV', 'development')
    expect(await captureRoomJourneyEvent({ ...baseInput, requestHeaders: new Headers() })).toBe(
      false
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed without retrying when the ingest transport fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('network unavailable'))
    vi.stubGlobal('fetch', fetchMock)
    const { captureRoomJourneyEvent } = await import('@/lib/analytics/room-journey-server')

    await expect(
      captureRoomJourneyEvent({
        actorId: 'workos_random_user_123',
        actorRole: 'COMPANY',
        journeyEvent: { event: 'room_entered', properties: {} },
        requestHeaders: new Headers(),
      })
    ).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
