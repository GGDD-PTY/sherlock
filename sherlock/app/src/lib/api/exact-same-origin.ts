import { Effect, Schema } from 'effect'
import { NextRequest, NextResponse } from 'next/server'

import { decodeBoundary } from '@/lib/effect/external'

/**
 * Un origen exacto: el texto tiene que ser la URL completa y nada más. Un
 * `https://host/phishing` parsea, pero su `origin` no es el texto — y aquí eso
 * es un rechazo, no una normalización.
 */
const exactOriginEffect = Effect.fn('ExactSameOrigin.parse')(function* (value: string) {
  return yield* decodeBoundary('exactSameOrigin.url', Schema.URLFromString, value).pipe(
    Effect.map((parsed) => (parsed.origin === value ? parsed.origin : null)),
    Effect.orElseSucceed(() => null)
  )
})

const expectedRequestOriginEffect = Effect.fn('ExactSameOrigin.expected')(function* (
  request: NextRequest
) {
  const requestOrigin = yield* exactOriginEffect(request.nextUrl.origin)
  if (!requestOrigin) return null

  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!configuredUrl) {
    // Local test/dev is the only legitimate unconfigured browser surface. A
    // production adapter may derive request.nextUrl from Host/forwarded Host,
    // so a matching attacker-controlled Origin must never become authoritative.
    return process.env.NODE_ENV !== 'production' && requestOrigin === 'http://localhost:3000'
      ? requestOrigin
      : null
  }

  const configuredOrigin = yield* decodeBoundary(
    'exactSameOrigin.appUrl',
    Schema.URLFromString,
    configuredUrl
  ).pipe(
    Effect.map((parsed) => parsed.origin),
    Effect.orElseSucceed(() => null)
  )

  // This endpoint mints a bearer. It must not accept an otherwise allowed
  // alias, preview host, development host, or forwarded host that differs
  // from the deployment's one canonical browser origin.
  return configuredOrigin === requestOrigin ? configuredOrigin : null
})

const rejectNonExactSameOriginEffect = Effect.fn('ExactSameOrigin.reject')(function* (
  request: NextRequest
) {
  const browserOrigin = request.headers.get('origin')
  const expectedOrigin = yield* expectedRequestOriginEffect(request)
  const parsedBrowserOrigin = browserOrigin ? yield* exactOriginEffect(browserOrigin) : null

  if (!browserOrigin || !expectedOrigin || parsedBrowserOrigin !== expectedOrigin) {
    return NextResponse.json({ error: 'Origen no permitido' }, { status: 403 })
  }

  return null
})

// Puente síncrono para los handlers existentes.
export function rejectNonExactSameOrigin(request: NextRequest): NextResponse | null {
  return Effect.runSync(rejectNonExactSameOriginEffect(request))
}
