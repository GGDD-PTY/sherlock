import { ConvexError } from 'convex/values'
import { Option, Schema } from 'effect'

// El `data` de un `ConvexError` es `any`. Se decodifica; sin código queda UNKNOWN.
const decodeErrorCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))

export function extractConvexErrorCode(error: unknown): string {
  if (!(error instanceof ConvexError)) return 'UNKNOWN'
  const data = Option.getOrNull(decodeErrorCode(error.data))
  return data ? data.code : 'UNKNOWN'
}
