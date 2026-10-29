// Next.js llama `onRequestError` con toda excepción de servidor que llega a su
// boundary: renders de página, server actions, route handlers que revientan sin
// pasar por `apiError()` y proxy. Es el único camino que cubre lo que
// `apiError()` no ve, y manda el evento al mismo `$exception` de PostHog.
//
// De la request solo salen el `x-request-id` (correlación) y el método; la ruta
// que viaja es la plantilla de `context.routePath` (`/[locale]/my-company/[id]`),
// no el path real, así que ningún id de sala, documento ni query string sale del
// servidor. Nunca headers, cookies ni cuerpo.

import { REQUEST_ID_HEADER, getOrCreateRequestId } from '@/lib/api/response'
import {
  captureServerException,
  wasServerExceptionCaptured,
} from '@/lib/observability/posthog-server-exception'
import { settlePendingServerErrorAlerts } from '@/lib/observability/server-error-alert'

type RequestErrorHeaders = Headers | Record<string, string | string[] | undefined>

type RequestErrorRequest = {
  readonly path?: string
  readonly method?: string
  readonly headers?: RequestErrorHeaders
}

type RequestErrorContext = {
  readonly routerKind?: string
  readonly routePath?: string
  readonly routeType?: string
}

function rawRequestId(headers: RequestErrorHeaders | undefined): string | null {
  if (headers instanceof Headers) return headers.get(REQUEST_ID_HEADER)
  const value = headers?.[REQUEST_ID_HEADER]
  if (typeof value === 'string') return value
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null
}

function localeOf(path: string | undefined): 'es' | undefined {
  const segment = path?.split('?')[0]?.split('/')[1]
  return segment === 'es' ? segment : undefined
}

export async function onRequestError(
  error: unknown,
  request: RequestErrorRequest,
  context: RequestErrorContext
): Promise<void> {
  if (wasServerExceptionCaptured(error)) return

  const headers = new Headers()
  const requestId = rawRequestId(request?.headers)
  if (requestId) headers.set(REQUEST_ID_HEADER, requestId)

  await captureServerException({
    error,
    requestId: getOrCreateRequestId({ headers }),
    status: 500,
    route: context?.routePath,
    locale: localeOf(request?.path),
    method: request?.method,
    routerKind: context?.routerKind,
    routeType: context?.routeType,
  })

  // `after()` no existe en este contexto: sin esto, el aviso del camino de
  // render se pierde con el isolate. La respuesta ya salió.
  await settlePendingServerErrorAlerts()
}
