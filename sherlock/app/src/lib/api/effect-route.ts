import { Cause, Effect, Exit, Result, Schema } from 'effect'

import { apiError, getOrCreateRequestId, withRequestIdHeader } from '@/lib/api/response'
import { requireAdminApiAuth } from '@/lib/api/with-auth'
import { describeCause } from '@/lib/effect/errors'
import { runServerEffectExit } from '@/lib/effect/runtime'
import {
  checkRateLimitDistributed,
  createRateLimitResponse,
  getClientIp,
} from '@/lib/utils/rate-limit'

type RateLimitConfig = Parameters<typeof checkRateLimitDistributed>[1]

export class RouteResponse extends Schema.TaggedError<RouteResponse>()('RouteResponse', {
  response: Schema.instanceOf(Response),
}) {}

export class RouteOperationError extends Schema.TaggedError<RouteOperationError>()(
  'RouteOperationError',
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

export type RouteFailure = RouteResponse | RouteOperationError

export function respond(response: Response): RouteResponse {
  return new RouteResponse({ response })
}

export function routePromise<A>(
  operation: string,
  run: (signal: AbortSignal) => PromiseLike<A>
): Effect.Effect<A, RouteOperationError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new RouteOperationError({ operation, message: describeCause(cause), cause }),
  }).pipe(Effect.withSpan(operation))
}

export const requireAdminRouteUser = Effect.fn('Route.requireAdmin')(function* () {
  const result = yield* routePromise('auth.requireAdmin', () => requireAdminApiAuth())
  if (result.error) return yield* respond(result.error)
  return result.user
})

export const requireRouteRateLimit: (
  request: Request,
  key: string,
  config: RateLimitConfig
) => Effect.Effect<void, RouteFailure> = Effect.fn('Route.requireRateLimit')(
  function* (request: Request, key: string, config: RateLimitConfig) {
    const result = yield* routePromise('rateLimit.check', () =>
      checkRateLimitDistributed(key, config)
    )
    if (!result.success) yield* respond(createRateLimitResponse(result))
  },
  (effect, request, key) =>
    effect.pipe(Effect.annotateLogs({ clientIp: getClientIp(request), rateLimitKey: key }))
)

// El fallo se loguea DENTRO del programa. Fuera, con `createLogger`, las
// anotaciones que la ruta va dejando (`requestId`, `route`, `clientIp`,
// `rateLimitKey`) no llegaban a ninguna línea: solo las lee el logger de la
// capa, y nada dentro del programa escribía. Por eso el payload de acá no las
// repite — `lib/effect/logger.ts` las saca del fiber y las agrega a la salida,
// y `effect-route.log-annotations.test.ts` lo pinea.
const logRouteFailure = Effect.fn('Route.logFailure')(function* (cause: Cause.Cause<RouteFailure>) {
  const typed = Cause.findError(cause)
  if (Result.isSuccess(typed)) {
    const error = typed.success
    // `RouteResponse` no es un fallo: es la respuesta que la ruta decidió
    // devolver, y viaja por el canal de error para cortar el programa.
    if (error._tag === 'RouteResponse') return
    yield* Effect.logError('Route operation failed', {
      operation: error.operation,
      error: error.cause,
    })
    return
  }
  yield* Effect.logError('Route defect', {
    error: Cause.prettyErrors(cause)[0] ?? new Error('Unknown Effect defect'),
  })
})

// El sobre (requestId, correlación, `no-store` por defecto, `nosniff`) va sobre
// toda respuesta que sale de una ruta, incluida la que la ruta devuelve por el
// canal de error (429 del rate limit, 401 de auth, redirects). Un `Response`
// que viene de `fetch` trae cabeceras inmutables: ahí el sobre va sobre una
// copia con el mismo cuerpo y estado.
function envelope(response: Response, requestId: string): Response {
  try {
    return withRequestIdHeader(response, requestId)
  } catch {
    return withRequestIdHeader(new Response(response.body, response), requestId)
  }
}

export async function runRouteEffect(
  request: Request,
  route: string,
  effect: Effect.Effect<Response, RouteFailure>,
  options: { internalErrorMessage?: string; requestId?: string } = {}
): Promise<Response> {
  const requestId = options.requestId ?? getOrCreateRequestId(request)
  const exit = await runServerEffectExit(
    effect.pipe(
      Effect.tapCause(logRouteFailure),
      Effect.annotateLogs({ requestId, route }),
      Effect.withSpan(route)
    )
  )
  if (Exit.isSuccess(exit)) return envelope(exit.value, requestId)

  const typed = Cause.findError(exit.cause)
  if (Result.isSuccess(typed) && typed.success._tag === 'RouteResponse') {
    return envelope(typed.success.response, requestId)
  }

  return apiError(
    requestId,
    500,
    { error: options.internalErrorMessage ?? 'Error interno del servidor' },
    { route }
  )
}
