import { Effect } from 'effect'
import { NextRequest, NextResponse } from 'next/server'

import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { getUnauthenticatedConvex } from '@/lib/convex-auth'
import {
  rejectGuestCsrf,
  rejectGuestRateLimit,
  secureGuestResponse,
  vdrGuestRequestId,
} from '@/lib/auth/vdr-guest-api'
import { createVdrGuestServerProof } from '@/lib/auth/vdr-guest-server-proof'
import {
  clearVdrGuestSessionCookie,
  getGuestRoomProjectionRef,
  readVdrGuestSessionToken,
  VDR_GUEST_SESSION_TTL_SECONDS,
} from '@/lib/auth/vdr-guest-session'
import { guestUnavailable } from '../_unavailable'

const ROUTE = '/api/vdr/guest/room'

type GuestClient = NonNullable<ReturnType<typeof getUnauthenticatedConvex>>

const REQUIRED_GATES = new Set(['NDA'])
const DOCUMENT_CLASSIFICATIONS = new Set(['PUBLIC_TEASER', 'CONFIDENTIAL', 'RESTRICTED', 'LEGAL'])
const MAX_PROJECTED_DOCUMENTS = 500

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function validExpiry(value: unknown, now: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > now &&
    value <= now + VDR_GUEST_SESSION_TTL_SECONDS * 1000 + 5_000
  )
}

function projectRequiredGates(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > REQUIRED_GATES.size) return null
  const gates = value.filter(
    (candidate): candidate is string =>
      typeof candidate === 'string' && REQUIRED_GATES.has(candidate)
  )
  return gates.length === value.length && new Set(gates).size === gates.length ? gates : null
}

function projectDocument(value: unknown) {
  if (!value || typeof value !== 'object') return null
  const document = value as Record<string, unknown>
  if (
    !boundedText(document.name, 500) ||
    !boundedText(document.folder, 200) ||
    typeof document.classification !== 'string' ||
    !DOCUMENT_CLASSIFICATIONS.has(document.classification) ||
    document.downloadable !== false ||
    (document.fileType !== undefined && !boundedText(document.fileType, 200)) ||
    (document.fileSize !== undefined &&
      (typeof document.fileSize !== 'number' ||
        !Number.isSafeInteger(document.fileSize) ||
        document.fileSize < 0 ||
        document.fileSize > 2_147_483_648))
  ) {
    return null
  }
  return {
    ...(typeof document.viewPath === 'string' &&
    /^\/api\/vdr\/guest\/documents\/[a-zA-Z0-9_-]+$/.test(document.viewPath)
      ? { viewPath: document.viewPath }
      : {}),
    name: document.name,
    ...(document.fileType === undefined ? {} : { fileType: document.fileType }),
    ...(document.fileSize === undefined ? {} : { fileSize: document.fileSize }),
    folder: document.folder,
    classification: document.classification,
    downloadable: false as const,
  }
}

function revokedResponse(requestId: string) {
  const response = NextResponse.json({ authenticated: false, requestId }, { status: 401 })
  clearVdrGuestSessionCookie(response)
  return secureGuestResponse(response, requestId)
}

const projectGuestRoom = Effect.fn('VdrGuestRoom.project')(function* (
  client: GuestClient,
  sessionToken: string,
  requestId: string
) {
  const result = yield* routePromise('vdrGuest.room.project', () =>
    client.mutation(getGuestRoomProjectionRef, {
      sessionToken,
      ...createVdrGuestServerProof({
        operation: 'PROJECT_ROOM',
        bindingParts: [sessionToken],
      }),
    })
  )
  if (!result.authenticated) return revokedResponse(requestId)

  const now = Date.now()
  const requiredGates = projectRequiredGates(result.requiredGates)
  if (!validExpiry(result.expiresAt, now) || !requiredGates) {
    throw new Error('INVALID_GUEST_ROOM_PROJECTION')
  }

  if (!result.roomAccessGranted) {
    if (requiredGates.length === 0) throw new Error('INVALID_GUEST_ROOM_GATES')
    return secureGuestResponse(
      NextResponse.json({
        authenticated: true,
        expiresAt: result.expiresAt,
        roomAccessGranted: false,
        requiredGates,
        requestId,
      }),
      requestId
    )
  }

  if (
    requiredGates.length !== 0 ||
    !result.room ||
    !boundedText(result.room.title, 300) ||
    !Array.isArray(result.documents) ||
    result.documents.length > MAX_PROJECTED_DOCUMENTS ||
    typeof result.documentsTruncated !== 'boolean' ||
    result.downloadDeliveryAvailable !== false
  ) {
    throw new Error('INVALID_GUEST_ROOM_PROJECTION')
  }
  const documents = result.documents.map(projectDocument)
  if (documents.some((document) => document === null)) {
    throw new Error('INVALID_GUEST_ROOM_DOCUMENT')
  }

  return secureGuestResponse(
    NextResponse.json({
      authenticated: true,
      expiresAt: result.expiresAt,
      roomAccessGranted: true,
      requiredGates: [],
      room: { title: result.room.title },
      documents,
      documentsTruncated: result.documentsTruncated,
      downloadDeliveryAvailable: false,
      requestId,
    }),
    requestId
  )
})

const getGuestRoom = Effect.fn('VdrGuestRoom.GET')(function* (
  request: NextRequest,
  requestId: string
) {
  const csrf = rejectGuestCsrf(request, requestId)
  if (csrf) return yield* respond(csrf)
  const limited = yield* routePromise('vdrGuest.room.rateLimit', () =>
    rejectGuestRateLimit(request, requestId, 'room-read')
  )
  if (limited) return yield* respond(limited)

  const sessionToken = readVdrGuestSessionToken(request)
  if (!sessionToken) return yield* respond(revokedResponse(requestId))
  const client = getUnauthenticatedConvex()
  if (!client) return yield* respond(guestUnavailable(requestId))

  return yield* Effect.catchCause(projectGuestRoom(client, sessionToken, requestId), () =>
    Effect.succeed(guestUnavailable(requestId))
  )
})

export function GET(request: NextRequest): Promise<Response> {
  const requestId = vdrGuestRequestId(request)
  return runRouteEffect(request, ROUTE, getGuestRoom(request, requestId), { requestId })
}
