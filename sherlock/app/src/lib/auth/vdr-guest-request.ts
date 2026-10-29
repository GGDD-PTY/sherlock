import { Schema } from 'effect'

import { parseJsonRequest, type JsonRequestResult } from '@/lib/api/effect-json'

export const VDR_GUEST_MAX_BODY_BYTES = 4 * 1024

export type VdrGuestJsonResult<T> = JsonRequestResult<T>

export function parseVdrGuestJson<S extends Schema.Top & { readonly DecodingServices: never }>(
  request: Request,
  schema: S
): Promise<VdrGuestJsonResult<S['Type']>> {
  return parseJsonRequest({ request, schema, maxBytes: VDR_GUEST_MAX_BODY_BYTES })
}

const opaqueTokenSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(32),
    Schema.isMaxLength(256),
    Schema.isPattern(/^[a-zA-Z0-9_-]+$/)
  )
)

export const guestOtpRequestSchema = Schema.Struct({
  invitationHandle: opaqueTokenSchema,
  email: Schema.Trim.pipe(
    Schema.check(
      Schema.isMinLength(3),
      Schema.isMaxLength(254),
      Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
    )
  ),
})

export const guestOtpVerifySchema = Schema.Struct({
  invitationHandle: opaqueTokenSchema,
  challengeToken: opaqueTokenSchema,
  code: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{6}$/))),
})

export const emptyGuestMutationSchema = Schema.Record(Schema.String, Schema.Never)
