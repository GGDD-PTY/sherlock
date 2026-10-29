import { Schema } from 'effect'

const ExternalFailureReasonSchema = Schema.Literals([
  'transport',
  'timeout',
  'rate_limited',
  'rejected',
])

export class ExternalServiceError extends Schema.TaggedError<ExternalServiceError>()(
  'ExternalServiceError',
  {
    service: Schema.String,
    operation: Schema.String,
    reason: ExternalFailureReasonSchema,
    retryable: Schema.Boolean,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

export class BoundaryDecodeError extends Schema.TaggedError<BoundaryDecodeError>()(
  'BoundaryDecodeError',
  {
    boundary: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

export class UnexpectedAppError extends Schema.TaggedError<UnexpectedAppError>()(
  'UnexpectedAppError',
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

export function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
