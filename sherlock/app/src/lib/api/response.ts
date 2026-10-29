import { NextResponse } from 'next/server'
import { Schema } from 'effect'

import { captureServerException } from '@/lib/observability/posthog-server-exception'

export const REQUEST_ID_HEADER = 'x-request-id'
const CORRELATION_ID_HEADER = 'x-correlation-id'

const MAX_REQUEST_ID_LENGTH = 128

// La forma que un requestId puede tener, escrita una sola vez: el saneo la
// produce y el guardia la verifica. Antes el largo, el alfabeto y el «no quedó
// nada» estaban repartidos entre un `replace`, un `slice` y un `||`.
const RequestIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_.:-]+$/), Schema.isMaxLength(MAX_REQUEST_ID_LENGTH))
)
const isRequestId = Schema.is(RequestIdSchema)

// El `x-request-id` lo pone el CLIENTE y de acá sale al cuerpo de la respuesta,
// a dos cabeceras, a cada línea de log y a la fila del aviso de 5xx. Se sanea
// en la frontera —forma conocida y largo acotado— para que ninguna de esas
// superficies reciba texto arbitrario; si no queda nada, se genera uno propio.
export function getOrCreateRequestId(request: { headers: Headers }): string {
  const provided = request.headers
    .get(REQUEST_ID_HEADER)
    ?.replace(/[^A-Za-z0-9_.:-]/g, '')
    .slice(0, MAX_REQUEST_ID_LENGTH)

  return isRequestId(provided)
    ? provided
    : `request-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

const NO_STORE = 'no-store, no-cache, must-revalidate'

export function withRequestIdHeader<T extends Response>(response: T, requestId: string): T {
  response.headers.set(REQUEST_ID_HEADER, requestId)
  response.headers.set(CORRELATION_ID_HEADER, requestId)
  // Un `Cache-Control` que la ruta ya puso manda (los streams de documentos
  // llevan `private, no-store`). Sin uno, el sobre niega la caché.
  if (!response.headers.has('Cache-Control')) response.headers.set('Cache-Control', NO_STORE)
  response.headers.set('X-Content-Type-Options', 'nosniff')
  return response
}

export function apiError(
  requestId: string,
  status: number,
  body: Record<string, unknown>,
  context?: { error?: unknown; route?: string; locale?: string; synthetic?: boolean }
): Response {
  // Un 5xx es una falla nuestra: se reporta a PostHog sin bloquear la respuesta
  // y sin llevar nada del request más allá de la ruta.
  if (status >= 500) {
    void captureServerException({ ...context, requestId, status })
  }

  // `requestId` va DESPUÉS del cuerpo: el que sale en la respuesta es siempre
  // el saneado, no uno que un caller haya metido en `body` por accidente.
  return withRequestIdHeader(
    NextResponse.json(
      {
        ...body,
        requestId,
      },
      { status }
    ),
    requestId
  )
}

export function apiSuccess<T extends Record<string, unknown> | Record<string, never>>(
  body: T,
  requestId: string,
  init?: ResponseInit
): Response {
  return withRequestIdHeader(
    NextResponse.json(
      {
        ...body,
        requestId,
      },
      init
    ),
    requestId
  )
}
