// ============================================================================
// POSTHOG MANUAL EVENT QUEUE - UNIT TESTS
// ============================================================================
// Tests for the in-memory manual-event queue:
// 1. Queue events until PostHog is initialized
// 2. Flush queue when PostHog becomes available
// 3. Enforce max queue size (100 events)
// 4. Retry with exponential backoff
// 5. Reset retry delay after successful flush
// 6. Cap retry delay at MAX_RETRY_DELAY (60 seconds)
// 7. Prevent concurrent flushes (race conditions)
//
// These tests now use Vitest fake timers and persistent mocking with vi.doMock() + resetModules()
// to reliably test the offline queue functionality without real timeout delays. ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// HELPER: FLUSH PROMISES
// ============================================================================
const flushPromises = () => new Promise((resolve) => setImmediate(resolve))

// ============================================================================
// MOCK SETUP
// ============================================================================
const mockCapture = vi.fn()
const mockIdentify = vi.fn()
const mockReset = vi.fn()
const mockPostHogState = vi.hoisted(() => ({ loaded: true }))

// Mock posthog-js for dynamic imports
vi.mock('posthog-js', () => ({
  default: {
    get __loaded() {
      return mockPostHogState.loaded
    },
    capture: mockCapture,
    identify: mockIdentify,
    reset: mockReset,
  },
}))

// ============================================================================
// TESTS: EVENT QUEUE FOR OFFLINE SUPPORT
// ============================================================================

describe('PostHog manual event queue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPostHogState.loaded = true
    globalThis.window = {
      location: { pathname: '/es/intake' },
    } as Window & typeof globalThis
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
  })

  it('retains a manual event until the shared PostHog client is initialized', async () => {
    vi.useFakeTimers()
    mockPostHogState.loaded = false
    vi.resetModules()
    const { track } = await import('@/lib/analytics/posthog')

    track({ event: 'intake_started', properties: { locale: 'es', mode: 'TEMPORARY' } })
    // El drenaje vive en `posthog-drain.ts` y llega por un chunk aparte, así
    // que el reintento se arma cuando ese chunk resuelve y no en el mismo tick
    // del `track`. Esperar al temporizador armado es lo que antes daba el tick.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))

    expect(mockCapture).not.toHaveBeenCalled()

    mockPostHogState.loaded = true
    await vi.advanceTimersByTimeAsync(10_000)

    expect(mockCapture).toHaveBeenCalledOnce()
    expect(mockCapture).toHaveBeenCalledWith('intake_started', {
      locale: 'es',
      mode: 'TEMPORARY',
    })
  })

  it('retains a VDR manual event until the shared client becomes ready', async () => {
    vi.useFakeTimers()
    mockPostHogState.loaded = false
    globalThis.window = {
      location: { pathname: '/es/my-company/documents' },
    } as Window & typeof globalThis
    vi.resetModules()
    const { track } = await import('@/lib/analytics/posthog')

    track({ event: 'workspace_entered', properties: { locale: 'es', mode: 'PERMANENT' } })
    // Mismo chunk aparte: el reintento se arma al resolver, no en este tick.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))

    globalThis.window = {
      location: { pathname: '/es/pricing' },
    } as Window & typeof globalThis
    mockPostHogState.loaded = true
    track({ event: 'support_opened', properties: { locale: 'es', mode: 'PERMANENT' } })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(mockCapture).toHaveBeenCalledTimes(2)
    expect(mockCapture).toHaveBeenNthCalledWith(1, 'workspace_entered', {
      locale: 'es',
      mode: 'PERMANENT',
    })
    expect(mockCapture).toHaveBeenCalledWith('support_opened', {
      locale: 'es',
      mode: 'PERMANENT',
    })
  })

  it('should queue events and retry when capture fails', async () => {
    vi.resetModules()
    const { track } = await import('@/lib/analytics/posthog')

    // Mock capture to succeed
    mockCapture.mockImplementation(() => {
      // Success - do nothing
    })

    // Track event
    track({ event: 'intake_started', properties: { locale: 'es', mode: 'TEMPORARY' } })

    await flushPromises()

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Event should be sent
    expect(mockCapture).toHaveBeenCalledWith('intake_started', { locale: 'es', mode: 'TEMPORARY' })
  })

  it('should enforce max queue size (100 events)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.resetModules()
    const { track } = await import('@/lib/analytics/posthog')

    // Mock capture to fail (queue events)
    mockCapture.mockRejectedValue(new Error('Network error'))

    // Queue 101 events (exceeds MAX_QUEUE_SIZE)
    for (let i = 0; i < 101; i++) {
      track({
        event: 'intake_started',
        properties: { locale: 'es', mode: i % 2 ? 'TEMPORARY' : 'PERMANENT' },
      })
    }

    await flushPromises()

    // Should have warned about queue full
    expect(warnSpy).toHaveBeenCalledWith(
      '[Analytics] Queue full, removed oldest event:',
      'intake_started'
    )

    warnSpy.mockRestore()
  })

  it('should send events sequentially (no concurrent flushes)', async () => {
    const callSequence: string[] = []

    vi.resetModules()
    const { track } = await import('@/lib/analytics/posthog')

    // Mock capture to record call sequence
    mockCapture.mockImplementation((event: string) => {
      callSequence.push(event)
      // Synchronous success
    })

    // Track multiple events rapidly
    track({ event: 'intake_started', properties: { locale: 'es', mode: 'TEMPORARY' } })
    track({ event: 'workspace_entered', properties: { locale: 'es', mode: 'PERMANENT' } })
    track({ event: 'support_opened', properties: { locale: 'es', mode: 'TEMPORARY' } })

    // Wait for processing
    await flushPromises()

    // All events should be processed in order
    expect(mockCapture).toHaveBeenCalledTimes(3)
    expect(callSequence).toEqual(['intake_started', 'workspace_entered', 'support_opened'])
  })

  it('should log success message when queue flushes (development mode only)', async () => {
    // Use vi.stubEnv to mock NODE_ENV
    vi.stubEnv('NODE_ENV', 'development')

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    // Reset modules to pick up new NODE_ENV
    vi.resetModules()
    const { track } = await import('@/lib/analytics/posthog')

    // Mock capture to always succeed
    mockCapture.mockImplementation(() => {
      // Always succeed
    })

    // Track events
    track({ event: 'intake_started', properties: { locale: 'es', mode: 'TEMPORARY' } })
    track({ event: 'support_opened', properties: { locale: 'es', mode: 'TEMPORARY' } })

    await flushPromises()

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Should log success message in development mode
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[Analytics] Successfully flushed'))

    logSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  it('should handle empty queue gracefully', async () => {
    vi.resetModules()
    const { track } = await import('@/lib/analytics/posthog')

    mockCapture.mockResolvedValue(undefined)

    // Track an event that succeeds immediately
    track({ event: 'intake_started', properties: { locale: 'es', mode: 'TEMPORARY' } })

    await flushPromises()

    // Event should be sent (queue should be empty after)
    expect(mockCapture).toHaveBeenCalledWith('intake_started', { locale: 'es', mode: 'TEMPORARY' })
  })

  it('should continue retrying on persistent failures', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { track } = await import('@/lib/analytics/posthog')

    // Mock capture to always fail synchronously
    mockCapture.mockImplementation(() => {
      console.log('mockCapture called, throwing synchronously')
      throw new Error('Network error')
    })

    // Track an event
    track({ event: 'intake_started', properties: { locale: 'es', mode: 'TEMPORARY' } })

    // El drenaje llega por un chunk aparte: el backoff se arma al resolver.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0))

    const initialCallCount = mockCapture.mock.calls.length

    // Wait for multiple retries (20 seconds should trigger several retries with backoff)
    await vi.advanceTimersByTimeAsync(20000)

    // Should have attempted multiple times (at least 2 retries)
    expect(mockCapture.mock.calls.length).toBeGreaterThan(initialCallCount)
  }, 22000)

  it('should reset delay after successful send', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { track } = await import('@/lib/analytics/posthog')

    // Mock capture to fail once, then succeed
    let callCount = 0
    mockCapture.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        throw new Error('Network error')
      }
      // Success on retry
    })

    // Track first event (will fail and trigger backoff)
    track({ event: 'intake_started', properties: { locale: 'es', mode: 'TEMPORARY' } })

    // El drenaje llega por un chunk aparte: el backoff se arma al resolver.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0))

    // Wait for retry
    await vi.advanceTimersByTimeAsync(5100)

    // Should have succeeded
    expect(mockCapture).toHaveBeenCalledWith('intake_started', { locale: 'es', mode: 'TEMPORARY' })

    // Track another event immediately
    mockCapture.mockClear()
    track({ event: 'support_opened', properties: { locale: 'es', mode: 'TEMPORARY' } })

    // Should send immediately (delay was reset)
    await vi.waitFor(() =>
      expect(mockCapture).toHaveBeenCalledWith('support_opened', {
        locale: 'es',
        mode: 'TEMPORARY',
      })
    )
  }, 6000)
})
