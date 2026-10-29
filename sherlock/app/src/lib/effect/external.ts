import { Duration, Effect, Schedule, Schema } from 'effect'

import { BoundaryDecodeError, describeCause, ExternalServiceError } from '@/lib/effect/errors'

export type ExternalCallOptions<A> = Readonly<{
  service: string
  operation: string
  run: (signal: AbortSignal) => PromiseLike<A>
  timeout?: Duration.Input
  retries?: number
  retryDelay?: Duration.Input
  retryable?: (cause: unknown) => boolean
}>

export function externalCall<A>(
  options: ExternalCallOptions<A>
): Effect.Effect<A, ExternalServiceError> {
  const timeout = options.timeout ?? Duration.seconds(8)
  const retries = options.retries ?? 2
  const retryDelay = options.retryDelay ?? Duration.millis(150)

  return Effect.tryPromise({
    try: options.run,
    catch: (cause) =>
      new ExternalServiceError({
        service: options.service,
        operation: options.operation,
        reason: 'transport',
        retryable: options.retryable?.(cause) ?? true,
        message: describeCause(cause),
        cause,
      }),
  }).pipe(
    Effect.timeout(timeout),
    Effect.catchTag('TimeoutError', (cause) =>
      Effect.fail(
        new ExternalServiceError({
          service: options.service,
          operation: options.operation,
          reason: 'timeout',
          retryable: true,
          message: `${options.service} no respondió en ${Duration.toSeconds(timeout)} s.`,
          cause,
        })
      )
    ),
    Effect.retry({
      schedule: Schedule.exponential(retryDelay, 2),
      times: retries,
      while: (error) => error.retryable,
    }),
    Effect.withSpan(`${options.service}.${options.operation}`)
  )
}

export function decodeBoundary<S extends Schema.Top>(
  boundary: string,
  schema: S,
  input: unknown
): Effect.Effect<S['Type'], BoundaryDecodeError, S['DecodingServices']> {
  return Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError(
      (cause) =>
        new BoundaryDecodeError({
          boundary,
          message: cause.message,
          cause,
        })
    ),
    Effect.withSpan(`${boundary}.decode`)
  )
}
