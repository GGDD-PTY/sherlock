import { Effect, Layer, ManagedRuntime } from 'effect'

import { sherlockLoggerLayer } from '@/lib/effect/logger'

const memoMap = Layer.makeMemoMapUnsafe()

const sherlockRuntime = ManagedRuntime.make(sherlockLoggerLayer, { memoMap })

export function runServerEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return sherlockRuntime.runPromise(effect)
}

export function runServerEffectExit<A, E>(effect: Effect.Effect<A, E>) {
  return sherlockRuntime.runPromiseExit(effect)
}

export function runServerEffectSync<A, E>(effect: Effect.Effect<A, E>): A {
  return sherlockRuntime.runSync(effect)
}

export function throwEffectError(error: unknown): never {
  if (error instanceof Error) throw error
  throw new Error('Effect failed', { cause: error })
}
