'use client'

import { useEffect, useState } from 'react'
import { Duration, Effect } from 'effect'

import { runClientFork } from '@/lib/effect/client-runtime'

export function useConvexLoadTimeout(loading: boolean, ms: number, requestKey: string) {
  const [state, setState] = useState({ attempt: 0, timedOut: false, requestKey })

  if (state.requestKey !== requestKey) {
    setState({ attempt: 0, timedOut: false, requestKey })
  }

  useEffect(() => {
    const program = loading
      ? Effect.sleep(Duration.millis(ms)).pipe(
          Effect.andThen(Effect.sync(() => setState((current) => ({ ...current, timedOut: true }))))
        )
      : Effect.sync(() =>
          setState((current) => (current.timedOut ? { ...current, timedOut: false } : current))
        )
    const tracedProgram = program.pipe(
      Effect.withSpan('Vdr.waitForConvexLoad', {
        attributes: { attempt: state.attempt, requestKey },
      })
    )
    const fiber = runClientFork(tracedProgram)
    return () => fiber.interruptUnsafe()
  }, [loading, ms, requestKey, state.attempt])

  return {
    timedOut: loading && state.timedOut,
    attempt: state.attempt,
    retry: () =>
      setState((current) => ({ ...current, attempt: current.attempt + 1, timedOut: false })),
  }
}
