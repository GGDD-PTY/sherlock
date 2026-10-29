import { createHash, randomUUID } from 'node:crypto'
import { DateTime, Effect } from 'effect'
import { after } from 'next/server'

import type { RoomJourneyEvent } from '@/lib/analytics/room-journey-contract'
import { UnexpectedAppError, type ExternalServiceError } from '@/lib/effect/errors'
import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'
import { createLogger } from '@/lib/logger'

const ROOM_JOURNEY_TIMEOUT_MS = 1_500
const log = createLogger('RoomJourneyAnalytics')

type RoomJourneyActorRole = 'COMPANY' | 'ADMIN'
type RoomJourneyCaptureError = ExternalServiceError | UnexpectedAppError

export type RoomJourneyCapture = {
  actorId: string
  actorRole: RoomJourneyActorRole
  journeyEvent: RoomJourneyEvent
  requestHeaders: Headers
}

export function roomJourneyRequestOptsOut(requestHeaders: Headers): boolean {
  return requestHeaders.get('dnt') === '1' || requestHeaders.get('sec-gpc') === '1'
}

const parsePostHogEventIngestUrl = Effect.fn('RoomJourneyAnalytics.parsePostHogEventIngestUrl')(
  function* (configuredHost: string) {
    const host = yield* Effect.try({
      try: () => new URL(configuredHost),
      catch: (cause) =>
        new UnexpectedAppError({
          operation: 'roomJourneyAnalytics.parsePostHogEventIngestUrl',
          message: 'La URL de ingesta de PostHog no es válida.',
          cause,
        }),
    })
    if (
      host.protocol !== 'https:' ||
      host.username !== '' ||
      host.password !== '' ||
      host.search !== '' ||
      host.hash !== ''
    ) {
      return null
    }
    const base = host.toString().endsWith('/') ? host.toString() : `${host.toString()}/`
    return new URL('e/', base).toString()
  }
)

function postHogEventIngestUrl(): string | null {
  const configuredHost = process.env.POSTHOG_INGEST_HOST
  if (!configuredHost) return null

  return Effect.runSync(
    parsePostHogEventIngestUrl(configuredHost).pipe(
      Effect.match({
        onSuccess: (url) => url,
        onFailure: () => null,
      })
    )
  )
}

export function roomJourneyAnalyticsEnabled(): boolean {
  return (
    process.env.NODE_ENV === 'production' &&
    Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY) &&
    postHogEventIngestUrl() !== null
  )
}

function roomJourneyActorDigest(actorId: string, namespace: 'actor' | 'rate-limit'): string {
  return createHash('sha256')
    .update(`sherlock:room-journey:${namespace}:v1\0`, 'utf8')
    .update(actorId, 'utf8')
    .digest('hex')
}

export function roomJourneyRateLimitKey(actorId: string): string {
  return `room-journey:${roomJourneyActorDigest(actorId, 'rate-limit')}`
}

function roomJourneyDistinctId(actorId: string): string {
  return `room_actor_${roomJourneyActorDigest(actorId, 'actor')}`
}

function eventProperties(journeyEvent: RoomJourneyEvent): Record<string, unknown> {
  switch (journeyEvent.event) {
    case 'document_opened':
      return { documentKind: journeyEvent.properties.documentKind }
    case 'room_entered':
    case 'company_profile_saved':
    case 'contact_saved':
    case 'assistant_opened':
    case 'dashboard_opened':
      return {}
  }
  const exhaustive: never = journeyEvent
  return exhaustive
}

function ingestFailureReason(error: RoomJourneyCaptureError): 'timeout' | 'network_error' {
  if (error._tag !== 'ExternalServiceError') return 'network_error'
  if (error.reason === 'timeout') return 'timeout'
  return error.cause instanceof DOMException && error.cause.name === 'TimeoutError'
    ? 'timeout'
    : 'network_error'
}

const sendRoomJourneyEvent = Effect.fn('RoomJourneyAnalytics.sendEvent')(function* (args: {
  input: RoomJourneyCapture
  ingestUrl: string
  projectKey: string
}) {
  const timestamp = DateTime.formatIso(yield* DateTime.now)
  const body = yield* Effect.try({
    try: () =>
      JSON.stringify({
        api_key: args.projectKey,
        uuid: randomUUID(),
        event: args.input.journeyEvent.event,
        timestamp,
        properties: {
          token: args.projectKey,
          distinct_id: roomJourneyDistinctId(args.input.actorId),
          $process_person_profile: false,
          $geoip_disable: true,
          actorRole: args.input.actorRole,
          ...eventProperties(args.input.journeyEvent),
        },
      }),
    catch: (cause) =>
      new UnexpectedAppError({
        operation: 'roomJourneyAnalytics.serializeEvent',
        message: 'No se pudo serializar el evento de recorrido.',
        cause,
      }),
  })

  return yield* externalCall({
    service: 'PostHog',
    operation: `capture.${args.input.journeyEvent.event}`,
    timeout: ROOM_JOURNEY_TIMEOUT_MS,
    // A random UUID is not a durable caller idempotency key, so transport retries stay off.
    retries: 0,
    run: (signal) =>
      fetch(args.ingestUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        cache: 'no-store',
        signal,
      }),
  })
})

const captureRoomJourneyEventEffect = Effect.fn('RoomJourneyAnalytics.captureEvent')(function* (
  input: RoomJourneyCapture
) {
  const projectKey = process.env.NEXT_PUBLIC_POSTHOG_KEY
  const ingestUrl = postHogEventIngestUrl()
  if (
    !roomJourneyAnalyticsEnabled() ||
    !projectKey ||
    !ingestUrl ||
    !input.actorId ||
    input.actorId.length > 256 ||
    roomJourneyRequestOptsOut(input.requestHeaders)
  ) {
    return false
  }

  const outcome = yield* sendRoomJourneyEvent({ input, ingestUrl, projectKey }).pipe(
    Effect.match({
      onSuccess: (response) => ({ ok: true as const, response }),
      onFailure: (error) => ({ ok: false as const, error }),
    })
  )
  if (!outcome.ok) {
    log.warn('Room journey ingest failed', {
      event: input.journeyEvent.event,
      reason: ingestFailureReason(outcome.error),
    })
    return false
  }
  if (!outcome.response.ok) {
    log.warn('Room journey ingest failed', {
      event: input.journeyEvent.event,
      reason: 'provider_response',
      status: outcome.response.status,
    })
    return false
  }
  return true
})

/** Sends one privacy-bounded VDR event. This function never throws. */
export function captureRoomJourneyEvent(input: RoomJourneyCapture): Promise<boolean> {
  return runServerEffect(captureRoomJourneyEventEffect(input))
}

const scheduleRoomJourneyEventEffect = Effect.fn('RoomJourneyAnalytics.scheduleEvent')(function* (
  input: RoomJourneyCapture
) {
  yield* Effect.try({
    try: () => after(() => captureRoomJourneyEvent(input)),
    catch: (cause) =>
      new UnexpectedAppError({
        operation: 'roomJourneyAnalytics.scheduleEvent',
        message: 'No se pudo agendar el evento de recorrido.',
        cause,
      }),
  })
})

export function scheduleRoomJourneyEvent(input: RoomJourneyCapture): boolean {
  return Effect.runSync(
    scheduleRoomJourneyEventEffect(input).pipe(
      Effect.match({
        onSuccess: () => true,
        onFailure: () => {
          log.warn('Room journey ingest failed', {
            event: input.journeyEvent.event,
            reason: 'schedule_error',
          })
          return false
        },
      })
    )
  )
}
