import { Effect } from 'effect'
import type { NextRequest } from 'next/server'
import {
  decodeCompanyGuestDocumentMetadata,
  GUEST_DOCUMENT_METADATA_HEADER,
} from '@/../convex/_guests/documentDelivery'
import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { apiError } from '@/lib/api/response'
import { rejectGuestCsrf, rejectGuestRateLimit, vdrGuestRequestId } from '@/lib/auth/vdr-guest-api'
import { readVdrGuestSessionToken } from '@/lib/auth/vdr-guest-session'
import { createVdrGuestServerProof } from '@/lib/auth/vdr-guest-server-proof'
import { resolveConvexSiteOrigin } from '@/lib/convex-site'
import { createGuestDocumentResponse } from '@/lib/documents/guest-delivery'

// Sin `route` un 5xx avisa como `/unknown` y se agrupa con el 5xx de cualquier
// otro handler que comparta nombre de error.
const ROUTE = '/api/vdr/guest/documents/[documentId]'

type RouteContext = { params: Promise<{ documentId: string }> }

const fetchGuestDocument = Effect.fn('VdrGuestDocument.fetch')(function* (
  convexSite: string,
  sessionToken: string,
  documentId: string
) {
  return yield* routePromise('vdrGuest.document.fetch', () =>
    fetch(`${convexSite}/vdr/guest/document`, {
      method: 'POST',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionToken,
        documentId,
        ...createVdrGuestServerProof({
          operation: 'VIEW_DOCUMENT',
          bindingParts: [sessionToken, documentId],
        }),
      }),
    })
  )
})

const deliverGuestDocument = Effect.fn('VdrGuestDocument.deliver')(function* (
  upstream: Response,
  metadata: Parameters<typeof createGuestDocumentResponse>[1],
  requestId: string
) {
  const bytes = yield* routePromise('vdrGuest.document.readBytes', () => upstream.arrayBuffer())
  return yield* routePromise('vdrGuest.document.createResponse', () =>
    createGuestDocumentResponse(bytes, metadata, requestId)
  )
})

const getGuestDocument = Effect.fn('VdrGuestDocument.GET')(function* (
  request: NextRequest,
  context: RouteContext,
  requestId: string
) {
  const csrf = rejectGuestCsrf(request, requestId)
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('vdrGuest.document.rateLimit', () =>
    rejectGuestRateLimit(request, requestId, 'room-read')
  )
  if (limited) return yield* respond(limited)
  const sessionToken = readVdrGuestSessionToken(request)
  if (!sessionToken) {
    return yield* respond(apiError(requestId, 401, { code: 'GUEST_SESSION_REQUIRED' }))
  }
  const { documentId } = yield* routePromise('vdrGuest.document.params', () => context.params)
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(documentId)) {
    return yield* respond(apiError(requestId, 403, { code: 'GUEST_DOCUMENT_DENIED' }))
  }
  const convexSite = resolveConvexSiteOrigin(process.env.NEXT_PUBLIC_CONVEX_URL)
  if (!convexSite) {
    return yield* respond(apiError(requestId, 503, { code: 'GUEST_UNAVAILABLE' }, { route: ROUTE }))
  }

  const upstream = yield* Effect.catchCause(
    fetchGuestDocument(convexSite, sessionToken, documentId),
    () => Effect.succeed(null)
  )
  if (!upstream) {
    // Convex inalcanzable no es una denegación: no se le dice al invitado que
    // perdió el acceso cuando lo que falló fue la red.
    return yield* respond(
      apiError(requestId, 502, { code: 'GUEST_DOCUMENT_UNAVAILABLE' }, { route: ROUTE })
    )
  }
  if (!upstream.ok) {
    return yield* respond(apiError(requestId, 403, { code: 'GUEST_DOCUMENT_DENIED' }))
  }

  const metadata = decodeCompanyGuestDocumentMetadata(
    upstream.headers.get(GUEST_DOCUMENT_METADATA_HEADER)
  )
  if (!metadata) {
    return yield* respond(
      apiError(requestId, 502, { code: 'GUEST_DOCUMENT_UNAVAILABLE' }, { route: ROUTE })
    )
  }

  const response = yield* Effect.catchCause(
    deliverGuestDocument(upstream, metadata, requestId),
    () => Effect.succeed(null)
  )
  if (!response) {
    // Falla cerrado: un PDF sin sello no sale de la sala.
    return yield* respond(
      apiError(requestId, 502, { code: 'GUEST_DOCUMENT_UNAVAILABLE' }, { route: ROUTE })
    )
  }
  return response
})

export function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = vdrGuestRequestId(request)
  return runRouteEffect(request, ROUTE, getGuestDocument(request, context, requestId), {
    requestId,
  })
}
