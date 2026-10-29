// ============================================================================
// VDR GUEST REQUEST PARSER
// ============================================================================
// Shared gate for every public guest mutation (OTP request/verify, rotate,
// logout). The API suite covers happy-path JSON; these cases pin the bounds
// that keep oversized, wrong-typed, or extra-field bodies off Convex.
// ============================================================================

import { Exit, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  VDR_GUEST_MAX_BODY_BYTES,
  emptyGuestMutationSchema,
  guestOtpRequestSchema,
  guestOtpVerifySchema,
  parseVdrGuestJson,
} from '@/lib/auth/vdr-guest-request'

const VALID_HANDLE = 'c'.repeat(64)
const VALID_EMAIL = 'fixture-bff21e9f@example.com'
const decodeOtpRequest = Schema.decodeUnknownExit(guestOtpRequestSchema, {
  onExcessProperty: 'error',
})
const decodeOtpVerify = Schema.decodeUnknownExit(guestOtpVerifySchema, {
  onExcessProperty: 'error',
})
const decodeEmptyMutation = Schema.decodeUnknownExit(emptyGuestMutationSchema, {
  onExcessProperty: 'error',
})

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/vdr/guest/otp/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function headerOnlyRequest(headers: Record<string, string>, body: ReadableStream | null = null) {
  return {
    headers: new Headers(headers),
    body,
  } as Request
}

function oversizedBodyStream(): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(VDR_GUEST_MAX_BODY_BYTES + 32)
  chunk.fill(120)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(chunk)
      controller.close()
    },
  })
}

describe('parseVdrGuestJson', () => {
  it('accepts application/json with an optional charset parameter', async () => {
    const parsed = await parseVdrGuestJson(
      jsonRequest(
        { invitationHandle: VALID_HANDLE, email: VALID_EMAIL },
        { 'content-type': 'application/json; charset=utf-8' }
      ),
      guestOtpRequestSchema
    )

    expect(parsed).toEqual({
      ok: true,
      data: { invitationHandle: VALID_HANDLE, email: VALID_EMAIL },
    })
  })

  it('treats Content-Type as case-insensitive', async () => {
    const parsed = await parseVdrGuestJson(
      jsonRequest(
        { invitationHandle: VALID_HANDLE, email: VALID_EMAIL },
        { 'content-type': 'Application/JSON' }
      ),
      guestOtpRequestSchema
    )

    expect(parsed.ok).toBe(true)
  })

  it('rejects a missing or non-JSON content type before reading the body', async () => {
    const missing = await parseVdrGuestJson(
      new Request('http://localhost:3000/api/vdr/guest/otp/request', {
        method: 'POST',
        body: JSON.stringify({ invitationHandle: VALID_HANDLE, email: VALID_EMAIL }),
      }),
      guestOtpRequestSchema
    )
    const plain = await parseVdrGuestJson(
      jsonRequest(
        { invitationHandle: VALID_HANDLE, email: VALID_EMAIL },
        { 'content-type': 'text/plain' }
      ),
      guestOtpRequestSchema
    )

    expect(missing).toEqual({ ok: false, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' })
    expect(plain).toEqual({ ok: false, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' })
  })

  it('fails closed on a non-finite or negative Content-Length', async () => {
    const invalid = await parseVdrGuestJson(
      headerOnlyRequest({
        'content-type': 'application/json',
        'content-length': 'not-a-number',
      }),
      guestOtpRequestSchema
    )
    const negative = await parseVdrGuestJson(
      headerOnlyRequest({
        'content-type': 'application/json',
        'content-length': '-1',
      }),
      guestOtpRequestSchema
    )

    expect(invalid).toEqual({ ok: false, status: 400, code: 'INVALID_CONTENT_LENGTH' })
    expect(negative).toEqual({ ok: false, status: 400, code: 'INVALID_CONTENT_LENGTH' })
  })

  it('rejects a declared body larger than the guest limit without reading it', async () => {
    const parsed = await parseVdrGuestJson(
      headerOnlyRequest({
        'content-type': 'application/json',
        'content-length': String(VDR_GUEST_MAX_BODY_BYTES + 1),
      }),
      guestOtpRequestSchema
    )

    expect(parsed).toEqual({ ok: false, status: 413, code: 'PAYLOAD_TOO_LARGE' })
  })

  it('rejects a streamed body that crosses the guest limit mid-read', async () => {
    const parsed = await parseVdrGuestJson(
      headerOnlyRequest({ 'content-type': 'application/json' }, oversizedBodyStream()),
      guestOtpRequestSchema
    )

    expect(parsed).toEqual({ ok: false, status: 413, code: 'PAYLOAD_TOO_LARGE' })
  })

  it('rejects invalid JSON with a generic 400', async () => {
    const parsed = await parseVdrGuestJson(jsonRequest('{'), guestOtpRequestSchema)

    expect(parsed).toEqual({ ok: false, status: 400, code: 'INVALID_JSON' })
  })

  it('rejects schema failures without leaking field details', async () => {
    const parsed = await parseVdrGuestJson(
      jsonRequest({ invitationHandle: 'short', email: 'not-an-email' }),
      guestOtpRequestSchema
    )

    expect(parsed).toEqual({ ok: false, status: 400, code: 'INVALID_REQUEST' })
  })
})

describe('guest OTP request schema', () => {
  it('rejects a challenge token on the request', () => {
    const parsed = decodeOtpRequest({
      invitationHandle: VALID_HANDLE,
      email: VALID_EMAIL,
      challengeToken: 'd'.repeat(64),
    })

    expect(Exit.isFailure(parsed)).toBe(true)
  })

  it('accepts a trimmed email and a 32-character handle', () => {
    const parsed = decodeOtpRequest({
      invitationHandle: 'a'.repeat(32),
      email: `  ${VALID_EMAIL}  `,
    })

    expect(Exit.isSuccess(parsed)).toBe(true)
    if (Exit.isSuccess(parsed)) {
      expect(parsed.value.email).toBe(VALID_EMAIL)
    }
  })

  it.each([
    { invitationHandle: 'a'.repeat(31), email: VALID_EMAIL },
    { invitationHandle: `${'a'.repeat(31)}.`, email: VALID_EMAIL },
    { invitationHandle: VALID_HANDLE, email: 'guest' },
    { invitationHandle: VALID_HANDLE, email: VALID_EMAIL, extra: true },
  ])('rejects %j', (body) => {
    expect(Exit.isFailure(decodeOtpRequest(body))).toBe(true)
  })
})

describe('guest OTP verify schema', () => {
  const valid = {
    invitationHandle: VALID_HANDLE,
    challengeToken: 'd'.repeat(64),
    code: '481516',
  }

  it('accepts a six-digit code and opaque tokens', () => {
    expect(Exit.isSuccess(decodeOtpVerify(valid))).toBe(true)
  })

  it.each(['48151', '4815167', 'abcdef', '48151a'])('rejects code %s', (code) => {
    expect(Exit.isFailure(decodeOtpVerify({ ...valid, code }))).toBe(true)
  })

  it('rejects unknown properties', () => {
    expect(Exit.isFailure(decodeOtpVerify({ ...valid, locale: 'es' }))).toBe(true)
  })
})

describe('empty guest mutation schema', () => {
  it('accepts an empty object and rejects extras', () => {
    expect(Exit.isSuccess(decodeEmptyMutation({}))).toBe(true)
    expect(Exit.isFailure(decodeEmptyMutation({ sessionToken: 'x' }))).toBe(true)
  })

  it('parses an empty JSON object through the shared reader', async () => {
    const parsed = await parseVdrGuestJson(jsonRequest({}), emptyGuestMutationSchema)

    expect(parsed).toEqual({ ok: true, data: {} })
  })
})
