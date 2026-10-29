import { makeFunctionReference } from 'convex/server'
import { Effect, Schema } from 'effect'
import type { Id } from '@/../convex/_generated/dataModel'
import type { NextRequest, NextResponse } from 'next/server'

import { decodeBoundary } from '@/lib/effect/external'

export const VDR_GUEST_SESSION_TTL_SECONDS = 30 * 60

export const requestGuestOtpRef = makeFunctionReference<
  'mutation',
  {
    invitationHandle: string
    email: string
    serverIssuedAt: number
    serverProof: string
  },
  { accepted: true; challengeToken: string; expiresInSeconds: number }
>('guestAccess:requestOtpChallenge')

export const verifyGuestOtpAndCreateSessionRef = makeFunctionReference<
  'mutation',
  {
    invitationHandle: string
    challengeToken: string
    code: string
    serverIssuedAt: number
    serverProof: string
  },
  | { verified: false }
  | {
      verified: true
      sessionToken: string
      expiresAt: number
      roomAccessGranted: false
    }
>('guestAccess:verifyOtpAndCreateSession')

export const resolveGuestSessionRef = makeFunctionReference<
  'mutation',
  { sessionToken: string; serverIssuedAt: number; serverProof: string },
  | { authenticated: false }
  | {
      authenticated: true
      guestInvitationId: Id<'guestInvitations'>
      guestId: string
      principalKey: string
      expiresAt: number
      roomAccessGranted: false
      requiredGates: readonly ['NDA']
    }
>('guestAccess:resolveGuestSession')

export const rotateGuestSessionRef = makeFunctionReference<
  'mutation',
  { sessionToken: string; serverIssuedAt: number; serverProof: string },
  | { rotated: false }
  | { rotated: true; sessionToken: string; expiresAt: number; roomAccessGranted: false }
>('guestAccess:rotateGuestSession')

export const revokeGuestSessionRef = makeFunctionReference<
  'mutation',
  { sessionToken: string; serverIssuedAt: number; serverProof: string },
  { revoked: true }
>('guestAccess:revokeGuestSession')

export const getGuestRoomProjectionRef = makeFunctionReference<
  'mutation',
  { sessionToken: string; serverIssuedAt: number; serverProof: string },
  | { authenticated: false }
  | {
      authenticated: true
      expiresAt: number
      roomAccessGranted: false
      requiredGates: readonly 'NDA'[]
    }
  | {
      authenticated: true
      expiresAt: number
      roomAccessGranted: true
      requiredGates: readonly []
      room: { title: string }
      documents: Array<{
        viewPath?: string
        name: string
        fileType?: string
        fileSize?: number
        folder: string
        classification: 'PUBLIC_TEASER' | 'CONFIDENTIAL' | 'RESTRICTED' | 'LEGAL'
        downloadable: false
      }>
      documentsTruncated: boolean
      downloadDeliveryAvailable: false
    }
>('guestAccess:getGuestRoomProjection')

export function getVdrGuestSessionCookieName(
  nodeEnv: string | undefined = process.env.NODE_ENV
): string {
  // __Host- exige Secure; en localhost HTTP usamos un nombre separado para no
  // debilitar la cookie de producción ni romper desarrollo.
  return nodeEnv === 'production' ? '__Host-sherlock-vdr-guest' : 'sherlock-vdr-guest-dev'
}

export function vdrGuestSessionCookieOptions(nodeEnv: string | undefined = process.env.NODE_ENV) {
  return {
    httpOnly: true,
    secure: nodeEnv === 'production',
    sameSite: 'lax' as const,
    path: '/',
  }
}

// El token de la cookie es entrada del browser: se decodifica contra el mismo
// contrato opaco que el resto de la superficie de invitados (32-256 chars,
// alfabeto base64url sin padding). Lo que no encuadra es sesión ausente.
const vdrGuestSessionTokenSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(32),
    Schema.isMaxLength(256),
    Schema.isPattern(/^[a-zA-Z0-9_-]+$/)
  )
)

const readVdrGuestSessionTokenEffect = Effect.fn('VdrGuestSession.readToken')(function* (
  request: NextRequest
) {
  const value = request.cookies.get(getVdrGuestSessionCookieName())?.value ?? null
  if (!value) return null

  return yield* decodeBoundary(
    'vdrGuestSession.cookieToken',
    vdrGuestSessionTokenSchema,
    value
  ).pipe(Effect.orElseSucceed(() => null))
})

// Puente síncrono para los handlers existentes.
export function readVdrGuestSessionToken(request: NextRequest): string | null {
  return Effect.runSync(readVdrGuestSessionTokenEffect(request))
}

export function setVdrGuestSessionCookie(
  response: NextResponse,
  sessionToken: string,
  expiresAt: number,
  now = Date.now()
): void {
  const maxAge = Math.max(
    1,
    Math.min(VDR_GUEST_SESSION_TTL_SECONDS, Math.floor((expiresAt - now) / 1000))
  )
  response.cookies.set(getVdrGuestSessionCookieName(), sessionToken, {
    ...vdrGuestSessionCookieOptions(),
    maxAge,
    expires: new Date(now + maxAge * 1000),
  })
}

export function clearVdrGuestSessionCookie(response: NextResponse): void {
  response.cookies.set(getVdrGuestSessionCookieName(), '', {
    ...vdrGuestSessionCookieOptions(),
    maxAge: 0,
    expires: new Date(0),
  })
}
