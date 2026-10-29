import { Effect, ManagedRuntime } from 'effect'

import { sherlockLoggerLayer } from '@/lib/effect/logger'

// El logger de cliente vive en su propio ManagedRuntime. El de servidor
// (`runtime.ts`) es la costura que los tests sustituyen; meter el cliente ahí
// cuelga esas pruebas. `Effect.runPromise` pelado usa defaultLogger y pierde
// el nivel.

const clientRuntime = ManagedRuntime.make(sherlockLoggerLayer)

export function runClientEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return clientRuntime.runPromise(effect)
}

export function runClientEffectExit<A, E>(effect: Effect.Effect<A, E>) {
  return clientRuntime.runPromiseExit(effect)
}

export function runClientFork<A, E>(effect: Effect.Effect<A, E>) {
  return clientRuntime.runFork(effect)
}

export function runClientSync<A, E>(effect: Effect.Effect<A, E>): A {
  return clientRuntime.runSync(effect)
}

export function runClientSyncExit<A, E>(effect: Effect.Effect<A, E>) {
  return clientRuntime.runSyncExit(effect)
}
