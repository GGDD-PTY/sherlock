import { createHash } from 'node:crypto'
import { DateTime, Effect } from 'effect'
import { after } from 'next/server'

import { UnexpectedAppError } from '@/lib/effect/errors'
import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'

const SERVER_ANALYTICS_TIMEOUT_MS = 1_500
const MAX_CLAIMED_DOCUMENTS = 20
const CLAIM_EVENT_CONCURRENCY = 2

type AnalyticsLocale = 'es'
type IntakeClaimConversionArgs = {
  claimDigest: string
  claimedDocumentCount: number
  locale: AnalyticsLocale
  requestHeaders: Headers
}
type ClaimConversionEvent = {
  event: 'workspace_claimed' | 'first_durable_upload'
  fileCount?: number
}

function requestOptsOut(requestHeaders: Headers): boolean {
  return requestHeaders.get('dnt') === '1' || requestHeaders.get('sec-gpc') === '1'
}

const parsePostHogEventIngestUrl = Effect.fn('ClaimAnalytics.parsePostHogEventIngestUrl')(
  function* (configuredHost: string) {
    const host = yield* Effect.try({
      try: () => new URL(configuredHost),
      catch: (cause) =>
        new UnexpectedAppError({
          operation: 'claimAnalytics.parsePostHogEventIngestUrl',
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

function stableClaimDistinctId(claimDigest: string): string {
  return `claim_${createHash('sha256').update(`distinct:${claimDigest}`).digest('hex').slice(0, 32)}`
}

function stableClaimEventUuid(claimDigest: string, event: string): string {
  const bytes = createHash('sha256')
    .update(`event:${claimDigest}:${event}`)
    .digest()
    .subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const sendClaimConversionEvent = Effect.fn('ClaimAnalytics.sendEvent')(function* (args: {
  claimDigest: string
  distinctId: string
  event: ClaimConversionEvent
  ingestUrl: string
  locale: AnalyticsLocale
  projectKey: string
}) {
  const timestamp = DateTime.formatIso(yield* DateTime.now)
  const body = yield* Effect.try({
    try: () =>
      JSON.stringify({
        api_key: args.projectKey,
        uuid: stableClaimEventUuid(args.claimDigest, args.event.event),
        event: args.event.event,
        timestamp,
        properties: {
          token: args.projectKey,
          distinct_id: args.distinctId,
          $process_person_profile: false,
          $geoip_disable: true,
          locale: args.locale,
          mode: 'PERMANENT',
          ...(args.event.fileCount === undefined ? {} : { fileCount: args.event.fileCount }),
        },
      }),
    catch: (cause) =>
      new UnexpectedAppError({
        operation: 'claimAnalytics.serializeEvent',
        message: 'No se pudo serializar el evento de conversión.',
        cause,
      }),
  })

  return yield* externalCall({
    service: 'PostHog',
    operation: `capture.${args.event.event}`,
    timeout: SERVER_ANALYTICS_TIMEOUT_MS,
    // The stable UUID protects caller replays; transport retries stay off for one ingest attempt.
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

const captureIntakeClaimConversionEffect = Effect.fn('ClaimAnalytics.captureConversion')(function* (
  args: IntakeClaimConversionArgs
) {
  const projectKey = process.env.NEXT_PUBLIC_POSTHOG_KEY
  const ingestUrl = postHogEventIngestUrl()
  if (
    process.env.NODE_ENV !== 'production' ||
    !projectKey ||
    !ingestUrl ||
    requestOptsOut(args.requestHeaders) ||
    !/^[a-f0-9]{64}$/.test(args.claimDigest) ||
    !Number.isSafeInteger(args.claimedDocumentCount) ||
    args.claimedDocumentCount < 0 ||
    args.claimedDocumentCount > MAX_CLAIMED_DOCUMENTS
  ) {
    return false
  }

  const distinctId = stableClaimDistinctId(args.claimDigest)
  const events: ClaimConversionEvent[] = [
    { event: 'workspace_claimed' },
    ...(args.claimedDocumentCount > 0
      ? [{ event: 'first_durable_upload' as const, fileCount: args.claimedDocumentCount }]
      : []),
  ]
  const captured = yield* Effect.all(
    events.map((event) =>
      sendClaimConversionEvent({
        claimDigest: args.claimDigest,
        distinctId,
        event,
        ingestUrl,
        locale: args.locale,
        projectKey,
      }).pipe(
        Effect.match({
          onSuccess: (response) => response.ok,
          onFailure: () => false,
        })
      )
    ),
    { concurrency: CLAIM_EVENT_CONCURRENCY }
  )
  return captured.every(Boolean)
})

export function captureIntakeClaimConversion(args: IntakeClaimConversionArgs): Promise<boolean> {
  return runServerEffect(captureIntakeClaimConversionEffect(args))
}

export function scheduleIntakeClaimConversion(
  args: Parameters<typeof captureIntakeClaimConversion>[0]
): void {
  after(() => captureIntakeClaimConversion(args))
}
