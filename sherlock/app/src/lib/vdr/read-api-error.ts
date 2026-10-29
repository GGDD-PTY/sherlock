import { Duration, Effect, Option, Schema } from 'effect'

const ApiErrorEnvelope = Schema.Struct({
  error: Schema.String,
  requestId: Schema.optionalKey(Schema.String),
})
const decodeApiErrorEnvelope = Schema.decodeUnknownOption(ApiErrorEnvelope)

// El estado ya llegó; un cuerpo de error que no cierra no puede dejar la sala
// cargando. Vencido el plazo queda el error genérico. `json()` deja el cuerpo
// bloqueado, así que no se puede cancelar: la lectura abandonada muere con la
// conexión.
const ERROR_BODY_TIMEOUT = Duration.seconds(5)

export class ApiResponseError extends Schema.TaggedError<ApiResponseError>()('ApiResponseError', {
  error: Schema.String,
  requestId: Schema.optionalKey(Schema.String),
  status: Schema.Number,
}) {}

/** Decodes the safe envelope returned by Sherlock APIs without trusting the response body. */
export const readApiError = Effect.fn('Vdr.readApiError')(function* (
  response: Response
): Effect.fn.Return<ApiResponseError> {
  const payload = yield* Effect.promise<unknown>(() => response.json().catch(() => null)).pipe(
    Effect.timeoutOption(ERROR_BODY_TIMEOUT),
    Effect.map(Option.getOrNull)
  )
  const decoded = decodeApiErrorEnvelope(payload)

  return new ApiResponseError({
    error: Option.isSome(decoded) ? decoded.value.error : 'API request failed',
    status: response.status,
    ...(Option.isSome(decoded) && decoded.value.requestId
      ? { requestId: decoded.value.requestId }
      : {}),
  })
})

/** Keeps request correlation in telemetry and out of user-facing copy. */
export function logApiError(message: string, error: ApiResponseError) {
  const log = Effect.logError(message, { status: error.status })
  if (!error.requestId) return log

  return log.pipe(
    Effect.annotateLogs({ requestId: error.requestId }),
    Effect.annotateSpans({ requestId: error.requestId })
  )
}
