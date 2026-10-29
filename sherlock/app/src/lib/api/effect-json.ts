import { Effect, Schema } from 'effect'

import { runServerEffect } from '@/lib/effect/runtime'

const JsonRequestErrorCodeSchema = Schema.Literals([
  'UNSUPPORTED_MEDIA_TYPE',
  'INVALID_CONTENT_LENGTH',
  'PAYLOAD_TOO_LARGE',
  'INVALID_JSON',
  'INVALID_REQUEST',
])

type JsonRequestErrorCode = typeof JsonRequestErrorCodeSchema.Type

class JsonRequestError extends Schema.TaggedError<JsonRequestError>()('JsonRequestError', {
  status: Schema.Literals([400, 413, 415]),
  code: JsonRequestErrorCodeSchema,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export type JsonRequestResult<A> =
  { ok: true; data: A } | { ok: false; status: 400 | 413 | 415; code: JsonRequestErrorCode }

function fail(
  status: 400 | 413 | 415,
  code: JsonRequestErrorCode,
  message: string,
  cause?: unknown
): JsonRequestError {
  return new JsonRequestError({ status, code, message, ...(cause === undefined ? {} : { cause }) })
}

const readBoundedText = Effect.fn('JsonRequest.readBoundedText')(function* (
  request: Request,
  maxBytes: number,
  invalidContentLengthCode: 'INVALID_CONTENT_LENGTH' | 'INVALID_JSON'
) {
  const declared = request.headers.get('content-length')
  if (declared) {
    const size = Number(declared)
    if (!Number.isSafeInteger(size) || size < 0) {
      return yield* fail(400, invalidContentLengthCode, 'El Content-Length no es válido.')
    }
    if (size > maxBytes) {
      return yield* fail(413, 'PAYLOAD_TOO_LARGE', 'El cuerpo excede el límite permitido.')
    }
  }
  if (!request.body) return ''

  const reader = yield* Effect.acquireRelease(
    Effect.sync(() => request.body!.getReader()),
    (acquiredReader) => Effect.promise(() => acquiredReader.cancel()).pipe(Effect.ignore)
  )
  const decoder = new TextDecoder()
  let size = 0
  let text = ''

  while (true) {
    const chunk = yield* Effect.tryPromise({
      try: () => reader.read(),
      catch: (cause) => fail(400, 'INVALID_JSON', 'No se pudo leer el cuerpo.', cause),
    })
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > maxBytes) {
      return yield* fail(413, 'PAYLOAD_TOO_LARGE', 'El cuerpo excede el límite permitido.')
    }
    text += decoder.decode(chunk.value, { stream: true })
  }

  return text + decoder.decode()
})

const parseJsonRequestEffect = Effect.fn('JsonRequest.parse')(
  function* <S extends Schema.Top>(options: {
    request: Request
    schema: S
    maxBytes: number
    invalidContentLengthCode?: 'INVALID_CONTENT_LENGTH' | 'INVALID_JSON'
  }) {
    const contentType = options.request.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase()
    if (contentType !== 'application/json') {
      return yield* fail(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'El Content-Type debe ser application/json.'
      )
    }

    const text = yield* readBoundedText(
      options.request,
      options.maxBytes,
      options.invalidContentLengthCode ?? 'INVALID_CONTENT_LENGTH'
    )
    const input = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) => fail(400, 'INVALID_JSON', 'El cuerpo no contiene JSON válido.', cause),
    })

    return yield* Schema.decodeUnknownEffect(options.schema, {
      onExcessProperty: 'error',
    })(input).pipe(
      Effect.mapError((cause) =>
        fail(400, 'INVALID_REQUEST', 'El cuerpo no cumple el contrato esperado.', cause)
      )
    )
  },
  Effect.scoped
)

export async function parseJsonRequest<
  S extends Schema.Top & { readonly DecodingServices: never },
>(options: {
  request: Request
  schema: S
  maxBytes: number
  invalidContentLengthCode?: 'INVALID_CONTENT_LENGTH' | 'INVALID_JSON'
}): Promise<JsonRequestResult<S['Type']>> {
  return runServerEffect(
    parseJsonRequestEffect(options).pipe(
      Effect.match({
        onSuccess: (data) => ({ ok: true as const, data }),
        onFailure: (error) => ({
          ok: false as const,
          status: error.status,
          code: error.code,
        }),
      })
    )
  )
}
