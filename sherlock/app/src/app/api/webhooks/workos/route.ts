import { WorkOS } from '@workos-inc/node'
import { createHash } from 'crypto'
import { Effect } from 'effect'
import { NextRequest } from 'next/server'
import { internal } from '../../../../../convex/_generated/api'
import { Id } from '../../../../../convex/_generated/dataModel'
import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { apiError, apiSuccess, getOrCreateRequestId, withRequestIdHeader } from '@/lib/api/response'
import {
  classifyConvexAdminFailure,
  getConvexAdminClient,
  type ConvexAdminHttpClient,
} from '@/lib/convex/admin-client'
import { createLogger } from '@/lib/logger'
import {
  checkRateLimitDistributed,
  createRateLimitResponse,
  getClientIp,
  RATE_LIMIT_PRESETS,
} from '@/lib/utils/rate-limit'
import {
  isReplayableWebhookRegistration,
  shouldProcessWebhookEvent,
  type WebhookRegistration,
} from '../_shared/idempotency'

const log = createLogger('API:Webhooks:WorkOS')
const ROUTE = '/api/webhooks/workos'

type WorkOsEvent = {
  id: string
  event: string
  data?: unknown
}

type WorkOsSyncResult = {
  action: string
  processed: boolean
  resourceId?: string
  details: string
}

async function runInternalMutation(
  client: ConvexAdminHttpClient,
  mutationRef: unknown,
  args: Record<string, unknown>
) {
  return client.mutation(mutationRef, args)
}

function sanitizeId(id: string | null | undefined): string {
  if (!id) return 'null'
  if (id.length <= 4) return '****'
  return `****${id.slice(-4)}`
}

const INTERNAL_WEBHOOK_ERROR = 'Internal WorkOS webhook error'

function internalWebhookError(requestId: string): Response {
  return apiError(requestId, 500, { error: INTERNAL_WEBHOOK_ERROR }, { route: ROUTE })
}

const postWorkOsWebhook = Effect.fn('WorkOSWebhook.POST')(function* (
  req: NextRequest,
  requestId: string
) {
  let registeredEventId: string | null = null
  let registeredClaimVersion: number | undefined
  let convex: ConvexAdminHttpClient | null = null
  const correlationId = requestId

  // `registeredEventId` y `convex` se mutan en el cuerpo y se leen en el
  // `catchTag` de markFailed. Un combinador de `Effect.fn` no ve esas locales:
  // el gen interior + `.pipe` es la forma de compartirlas.
  return yield* Effect.gen(function* () {
    convex = yield* routePromise('workosWebhook.convex.client', async () => getConvexAdminClient())
    if (!convex) {
      log.error('Convex admin client configuration missing')
      return yield* respond(internalWebhookError(requestId))
    }
    const convexClient = convex

    const clientIp = getClientIp(req)
    const clientIpHash = createHash('sha256').update(clientIp).digest('hex')
    const rateLimitResult = yield* routePromise('workosWebhook.rateLimit', () =>
      checkRateLimitDistributed(`webhook:workos:${clientIp}`, RATE_LIMIT_PRESETS.webhook)
    )

    if (!rateLimitResult.success) {
      log.warn('Rate limit exceeded', { ipHash: clientIpHash })
      return yield* respond(
        withRequestIdHeader(createRateLimitResponse(rateLimitResult), requestId)
      )
    }

    const apiKey = process.env.WORKOS_API_KEY
    const webhookSecret = process.env.WORKOS_WEBHOOK_SECRET

    if (!apiKey || !webhookSecret) {
      log.error('WorkOS webhook configuration missing')
      return yield* respond(internalWebhookError(requestId))
    }

    const signatureHeader = req.headers.get('workos-signature')
    const ipAddress = req.headers.get('x-forwarded-for') || 'unknown'
    const userAgent = req.headers.get('user-agent') || 'unknown'

    // Una firma ausente o inválida es entrada de afuera, no una falla nuestra:
    // va a warn para no inflar los errores de runtime con cada POST anónimo.
    if (!signatureHeader) {
      log.warn('Missing WorkOS signature header', { requestId, correlationId })
      return yield* respond(
        apiError(requestId, 400, { error: 'Missing WorkOS signature header' })
      )
    }

    const rawPayload = yield* routePromise('workosWebhook.readPayload', () => req.text())
    const workos = yield* routePromise('workosWebhook.client', async () => new WorkOS(apiKey))
    const verification = yield* routePromise('workosWebhook.verifySignature', () =>
      workos.webhooks.constructEvent({
        payload: rawPayload,
        sigHeader: signatureHeader,
        secret: webhookSecret,
      })
    ).pipe(
      Effect.match({
        onFailure: () => ({ valid: false as const }),
        onSuccess: (event) => ({ valid: true as const, event: event as WorkOsEvent }),
      })
    )

    if (!verification.valid) {
      log.warn('Invalid WorkOS signature', {
        errorCode: 'WORKOS_SIGNATURE_INVALID',
        requestId,
        correlationId,
      })
      return yield* respond(apiError(requestId, 400, { error: 'Invalid signature' }))
    }

    const event = verification.event
    const parsedPayload = yield* routePromise(
      'workosWebhook.parsePayload',
      async () => JSON.parse(rawPayload) as Record<string, unknown>
    )
    const eventType = event.event

    log.info('Received WorkOS webhook event', {
      event: eventType,
      eventId: sanitizeId(event.id),
    })

    const registration = (yield* routePromise('workosWebhook.registerEvent', () =>
      runInternalMutation(convexClient, internal.webhookEvents.registerEvent, {
        provider: 'workos',
        eventId: event.id,
        eventType,
        payload: parsedPayload,
        requestId,
        correlationId,
        ipAddress,
        userAgent,
      })
    )) as WebhookRegistration

    if (!shouldProcessWebhookEvent(registration)) {
      log.info('Duplicate WorkOS event, skipping', {
        eventId: sanitizeId(event.id),
        existingStatus: registration.status,
      })
      return yield* respond(
        apiSuccess(
          {
            received: true,
            duplicate: true,
            message: registration.message,
          },
          requestId
        )
      )
    }

    if (isReplayableWebhookRegistration(registration)) {
      // Reintento. El efecto y completed/skipped commitean en la mutation
      // siguiente, así que llegar aquí significa que esa mutation no commiteó.
      log.warn('Reprocessing WorkOS event after a non-terminal registration', {
        eventId: sanitizeId(event.id),
        existingStatus: registration.status,
      })
    }

    registeredEventId = registration.eventId
    registeredClaimVersion = registration.claimVersion ?? 0
    const syncResult = (yield* routePromise('workosWebhook.commitEvent', () =>
      runInternalMutation(convexClient, internal.users.commitWorkosWebhookEvent, {
        webhookEventId: registeredEventId as Id<'webhookEvents'>,
        claimVersion: registeredClaimVersion,
        eventType,
        data: event.data ?? parsedPayload.data ?? parsedPayload,
      })
    )) as WorkOsSyncResult

    if (syncResult.processed) {
      return apiSuccess(
        {
          received: true,
          processed: true,
          eventType,
          action: syncResult.action,
        },
        requestId
      )
    }

    return apiSuccess(
      {
        received: true,
        processed: false,
        eventType,
        action: syncResult.action,
      },
      requestId
    )
  }).pipe(
    Effect.catchTag('RouteOperationError', (error) =>
      Effect.gen(function* () {
        const failure = classifyConvexAdminFailure(error.cause)
        log.error('WorkOS webhook processing error', {
          errorCode: failure.code,
          requestId,
          correlationId,
        })

        if (registeredEventId && convex) {
          const failureClient = convex
          const failedEventId = registeredEventId
          // markFailed solo acepta códigos del validador Convex; los códigos del
          // cliente admin se mapean a INTERNAL_ERROR y se preservan en el contexto
          // para que la fila quede en 'failed' y el reintento de WorkOS reprocese.
          const persisted = yield* routePromise('workosWebhook.markFailed', () =>
            runInternalMutation(failureClient, internal.webhookEvents.markFailed, {
              eventId: failedEventId as Id<'webhookEvents'>,
              claimVersion: registeredClaimVersion,
              error: failure.safeMessage,
              errorCode: 'INTERNAL_ERROR',
              errorContext: { adminFailureCode: failure.code },
            })
          ).pipe(
            Effect.match({
              onFailure: () => false,
              onSuccess: () => true,
            })
          )

          if (!persisted) {
            log.error('Unable to persist WorkOS webhook failure', {
              errorCode: 'CONVEX_ADMIN_FAILURE_PERSIST_FAILED',
              requestId,
              correlationId,
            })
          }
        }

        return internalWebhookError(requestId)
      })
    )
  )
})

export function POST(req: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(req)
  return runRouteEffect(req, ROUTE, postWorkOsWebhook(req, requestId), {
    requestId,
    internalErrorMessage: INTERNAL_WEBHOOK_ERROR,
  })
}
