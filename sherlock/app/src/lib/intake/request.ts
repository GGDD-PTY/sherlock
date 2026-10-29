import { Schema } from 'effect'

import { parseJsonRequest, type JsonRequestResult } from '@/lib/api/effect-json'

const INTAKE_MAX_BODY_BYTES = 8 * 1024

export type IntakeJsonResult<T> = JsonRequestResult<T>

export function parseIntakeJson<S extends Schema.Top & { readonly DecodingServices: never }>(
  request: Request,
  schema: S
): Promise<IntakeJsonResult<S['Type']>> {
  return parseJsonRequest({
    request,
    schema,
    maxBytes: INTAKE_MAX_BODY_BYTES,
    invalidContentLengthCode: 'INVALID_JSON',
  })
}

const nonEmptyString = (maxLength: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(maxLength)))

export const intakeSessionSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(120)))),
})

export const intakeUploadIntentSchema = Schema.Struct({
  fileName: nonEmptyString(255),
  declaredMimeType: nonEmptyString(200),
  declaredByteSize: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(50 * 1024 * 1024))
  ),
  declaredSha256: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  supersedePending: Schema.optionalKey(Schema.Boolean),
})

export const intakeUploadRegistrationSchema = Schema.Struct({
  intentId: nonEmptyString(256),
  storageId: nonEmptyString(256),
})

export const intakeSupportMessageSchema = Schema.Struct({
  body: nonEmptyString(2_000),
})
