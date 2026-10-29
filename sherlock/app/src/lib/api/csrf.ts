// ============================================================================
// CSRF PROTECTION - ORIGIN VALIDATION
// ============================================================================
// Validates that mutation requests come from allowed origins.
// Prevents cross-site request forgery by checking Origin/Referer headers.
//
// El núcleo es un Effect: la URL que llega en Origin/Referer (y la que trae la
// variable de entorno) se decodifica con Schema en vez de un try/catch mudo.
// Los callers siguen viendo funciones síncronas.
// ============================================================================

import { Effect, Schema } from 'effect'
import { NextRequest, NextResponse } from 'next/server'

import { decodeBoundary } from '@/lib/effect/external'
import { parseAppOrigin } from '@/lib/site/app-url'

// Orígenes de las corridas locales: `next dev` en el 3000 y Playwright en el
// 3015 (el 3100 de `dev:local` entra por `NEXT_PUBLIC_APP_URL`). En producción
// no existen y un `Origin: http://localhost:3000` no puede venir de este sitio,
// así que la lista solo se suma fuera de producción (A14-S5).
const LOCAL_ALLOWED_ORIGINS = ['http://localhost:3000', 'http://localhost:3015']

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

/** URL decodificada de un texto, o null si el texto no es una URL. */
const urlOfEffect = Effect.fn('Csrf.urlOf')(function* (value: string) {
  return yield* decodeBoundary('csrf.url', Schema.URLFromString, value).pipe(
    Effect.orElseSucceed(() => null)
  )
})

/** Origen de una URL de texto, o null si el texto no es una URL. */
const originOfEffect = Effect.fn('Csrf.originOf')(function* (value: string) {
  const url = yield* urlOfEffect(value)
  return url?.origin ?? null
})

const allowedOriginsEffect = Effect.fn('Csrf.allowedOrigins')(function* () {
  const origins = isProduction() ? [] : [...LOCAL_ALLOWED_ORIGINS]

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (appUrl) {
    // Una variable mal formada se ignora: el resto de la lista sigue mandando.
    const configured = parseAppOrigin(appUrl, isProduction())
    if (configured && !origins.includes(configured)) {
      origins.push(configured)
    }
  }

  return origins
})

const validateOriginEffect = Effect.fn('Csrf.validateOrigin')(function* (request: NextRequest) {
  const origin = request.headers.get('origin')
  const referer = request.headers.get('referer')

  if (!origin && !referer) {
    // Tercera señal: Fetch Metadata. Todo browser moderno la manda aunque
    // Origin/Referer vengan suprimidos por políticas de privacidad.
    const secFetchSite = request.headers.get('sec-fetch-site')
    if (secFetchSite) {
      return secFetchSite !== 'cross-site'
    }
    // Cero señales de browser: en producción fail-closed — el producto no
    // tiene clientes no-browser legítimos en rutas con CSRF (webhooks van
    // firmados por rutas propias). Dev/test permiten curl y harnesses.
    return !isProduction()
  }

  const allowed = yield* allowedOriginsEffect()

  if (origin) {
    return allowed.some((a) => origin === a)
  }

  if (referer) {
    const refererOrigin = yield* originOfEffect(referer)
    return refererOrigin !== null && allowed.some((a) => refererOrigin === a)
  }

  return false
})

// Puente síncrono para los handlers existentes.
export function validateOrigin(request: NextRequest): boolean {
  return Effect.runSync(validateOriginEffect(request))
}

export function rejectInvalidOrigin(request: NextRequest): NextResponse | null {
  if (validateOrigin(request)) {
    return null
  }

  return NextResponse.json({ error: 'Origen no permitido' }, { status: 403 })
}
