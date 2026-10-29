import { assert, it as itEffect } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from 'vitest'

import { ApiResponseError, readApiError } from '@/lib/vdr/read-api-error'

describe('readApiError', () => {
  it('decodes the safe API envelope and preserves its request ID', async () => {
    const error = await Effect.runPromise(
      readApiError(
        new Response(JSON.stringify({ error: 'Request denied', requestId: 'req-123' }), {
          status: 403,
        })
      )
    )

    expect(error).toBeInstanceOf(ApiResponseError)
    expect(error).toMatchObject({ error: 'Request denied', requestId: 'req-123', status: 403 })
  })

  it('returns a typed fallback for an empty body', async () => {
    const error = await Effect.runPromise(readApiError(new Response(null, { status: 500 })))

    expect(error).toBeInstanceOf(ApiResponseError)
    expect(error).toMatchObject({ error: 'API request failed', status: 500 })
    expect(error.requestId).toBeUndefined()
  })

  it('returns a typed fallback for an HTML body', async () => {
    const error = await Effect.runPromise(
      readApiError(
        new Response('<!doctype html><title>Upstream failure</title>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        })
      )
    )

    expect(error).toBeInstanceOf(ApiResponseError)
    expect(error).toMatchObject({ error: 'API request failed', status: 502 })
    expect(error.requestId).toBeUndefined()
  })

  itEffect.effect('returns the fallback when the error body never closes', () =>
    Effect.gen(function* () {
      const body = new ReadableStream<Uint8Array>()

      const fiber = yield* Effect.forkChild(readApiError(new Response(body, { status: 503 })))
      yield* TestClock.adjust('6 seconds')
      const error = yield* Fiber.join(fiber)

      assert.instanceOf(error, ApiResponseError)
      assert.strictEqual(error.error, 'API request failed')
      assert.strictEqual(error.status, 503)
      assert.isUndefined(error.requestId)
    })
  )
})
