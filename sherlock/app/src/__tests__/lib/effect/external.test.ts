import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { decodeBoundary, externalCall } from '@/lib/effect/external'

describe('Effect external boundary', () => {
  it.effect('retries only the configured number of times and then succeeds', () =>
    Effect.gen(function* () {
      let attempts = 0
      const fiber = yield* Effect.forkChild(
        externalCall({
          service: 'Fixture',
          operation: 'retry',
          retryDelay: '1 second',
          timeout: '10 seconds',
          retries: 2,
          run: () => {
            attempts += 1
            return attempts < 3 ? Promise.reject(new Error('transient')) : Promise.resolve('ok')
          },
        })
      )

      yield* TestClock.adjust('3 seconds')
      assert.strictEqual(yield* Fiber.join(fiber), 'ok')
      assert.strictEqual(attempts, 3)
    })
  )

  it.effect('does not retry a failure classified as permanent', () =>
    Effect.gen(function* () {
      let attempts = 0
      const error = yield* externalCall({
        service: 'Fixture',
        operation: 'permanent',
        retries: 5,
        retryable: () => false,
        run: () => {
          attempts += 1
          return Promise.reject(new Error('permanent'))
        },
      }).pipe(Effect.flip)

      assert.strictEqual(error.reason, 'transport')
      assert.strictEqual(error.retryable, false)
      assert.strictEqual(attempts, 1)
    })
  )

  it.effect('interrupts each timed-out attempt and reports a typed timeout', () =>
    Effect.gen(function* () {
      let attempts = 0
      let aborts = 0
      const fiber = yield* Effect.forkChild(
        externalCall({
          service: 'Fixture',
          operation: 'timeout',
          timeout: '1 second',
          retryDelay: '100 millis',
          retries: 2,
          run: (signal) => {
            attempts += 1
            return new Promise<never>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  aborts += 1
                  reject(signal.reason)
                },
                { once: true }
              )
            })
          },
        }).pipe(Effect.flip)
      )

      yield* TestClock.adjust('5 seconds')
      const error = yield* Fiber.join(fiber)
      assert.strictEqual(error.reason, 'timeout')
      assert.strictEqual(error.retryable, true)
      assert.strictEqual(attempts, 3)
      assert.strictEqual(aborts, 3)
    })
  )

  it.effect('decodes unknown data once and rejects excess properties', () =>
    Effect.gen(function* () {
      const schema = Schema.Struct({ id: Schema.String })
      const decoded = yield* decodeBoundary('Fixture.input', schema, { id: 'ok' })
      const error = yield* decodeBoundary('Fixture.input', schema, {
        id: 'ok',
        secret: 'no',
      }).pipe(Effect.flip)

      assert.deepStrictEqual(decoded, { id: 'ok' })
      assert.strictEqual(error._tag, 'BoundaryDecodeError')
      assert.strictEqual(error.boundary, 'Fixture.input')
    })
  )
})
