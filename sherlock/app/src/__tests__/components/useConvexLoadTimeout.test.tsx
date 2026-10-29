import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useConvexLoadTimeout } from '@/components/company/vdr/useConvexLoadTimeout'
import * as clientRuntime from '@/lib/effect/client-runtime'

describe('useConvexLoadTimeout', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('times out and restarts on retry', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useConvexLoadTimeout(true, 1_000, 'room-a'))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999)
    })
    expect(result.current.timedOut).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(result.current.timedOut).toBe(true)

    act(() => result.current.retry())
    expect(result.current.timedOut).toBe(false)
    expect(result.current.attempt).toBe(1)
  })

  it('interrupts the in-flight wait on unmount without retry', async () => {
    vi.useFakeTimers()
    const interruptUnsafe = vi.fn()
    const original = clientRuntime.runClientFork
    vi.spyOn(clientRuntime, 'runClientFork').mockImplementation((effect) => {
      const fiber = original(effect)
      return new Proxy(fiber, {
        get(target, prop, receiver) {
          if (prop === 'interruptUnsafe') {
            return () => {
              interruptUnsafe()
              target.interruptUnsafe()
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
    })

    const { unmount } = renderHook(() => useConvexLoadTimeout(true, 1_000, 'room-a'))
    interruptUnsafe.mockClear()
    unmount()
    expect(interruptUnsafe).toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
  })

  it('resets a timed-out wait when the request key changes', async () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ requestKey }) => useConvexLoadTimeout(true, 1_000, requestKey),
      { initialProps: { requestKey: 'room-a' } }
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(result.current.timedOut).toBe(true)

    rerender({ requestKey: 'room-b' })
    expect(result.current.timedOut).toBe(false)
    expect(result.current.attempt).toBe(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999)
    })
    expect(result.current.timedOut).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(result.current.timedOut).toBe(true)
  })
})
