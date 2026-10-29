// ============================================================================
// TESTS FOR ONBOARDING ANALYTICS HOOK
// ============================================================================
// Verifica que el hook de onboarding analytics funcione correctamente
// sin efectos secundarios en el flujo de la app.
// ============================================================================

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useOnboardingAnalytics } from '../useOnboardingAnalytics'
import * as posthog from '@/lib/analytics/posthog'

vi.mock('@/lib/analytics/posthog')

describe('useOnboardingAnalytics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Limpiar sessionStorage
    sessionStorage.clear()
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  describe('trackStarted', () => {
    it('tracks onboarding in memory without reading or writing sessionStorage', () => {
      const getItem = vi.spyOn(Storage.prototype, 'getItem')
      const setItem = vi.spyOn(Storage.prototype, 'setItem')
      const { result } = renderHook(() => useOnboardingAnalytics('COMPANY'))

      act(() => {
        result.current.trackStarted()
      })

      expect(posthog.track).toHaveBeenCalledWith({
        event: 'onboarding_started',
        properties: { role: 'COMPANY' },
      })
      expect(getItem).not.toHaveBeenCalled()
      expect(setItem).not.toHaveBeenCalled()
    })
  })

  describe('trackStepViewed', () => {
    it('tracks the safe step number without forwarding free-form step copy', () => {
      const { result } = renderHook(() => useOnboardingAnalytics('COMPANY'))

      act(() => {
        result.current.trackStepViewed(1, 'Basic Information')
      })

      expect(posthog.track).toHaveBeenCalledWith({
        event: 'onboarding_step_viewed',
        properties: {
          role: 'COMPANY',
          step: 1,
        },
      })
    })

    it('should handle multiple step views', () => {
      const { result } = renderHook(() => useOnboardingAnalytics('COMPANY'))

      act(() => {
        result.current.trackStepViewed(1, 'Step 1')
        result.current.trackStepViewed(2, 'Step 2')
      })

      expect(posthog.track).toHaveBeenCalledTimes(2)
      const calls = vi.mocked(posthog.track).mock.calls

      expect(calls[0][0]).toEqual({
        event: 'onboarding_step_viewed',
        properties: expect.objectContaining({ step: 1 }),
      })

      expect(calls[1][0]).toEqual({
        event: 'onboarding_step_viewed',
        properties: expect.objectContaining({ step: 2 }),
      })
    })
  })

  describe('trackStepCompleted', () => {
    it('should track step_completed with timing', () => {
      const { result } = renderHook(() => useOnboardingAnalytics('COMPANY'))

      // Start first
      act(() => {
        result.current.trackStarted()
      })

      // View step
      act(() => {
        result.current.trackStepViewed(1, 'Basic Info')
      })

      // Wait a bit to simulate user filling form
      act(() => {
        vi.useFakeTimers()
        vi.advanceTimersByTime(5000) // 5 seconds
        result.current.trackStepCompleted(1, 'Basic Info')
        vi.useRealTimers()
      })

      const calls = vi.mocked(posthog.track).mock.calls
      const completedCall = calls.find((call) => call[0].event === 'onboarding_step_completed')

      expect(completedCall).toBeDefined()
      expect(completedCall![0]).toEqual({
        event: 'onboarding_step_completed',
        properties: expect.objectContaining({
          role: 'COMPANY',
          step: 1,
          timeSpentMs: expect.any(Number),
        }),
      })
    })
  })

  describe('trackCompleted', () => {
    it('should track onboarding_completed with total time', () => {
      const { result } = renderHook(() => useOnboardingAnalytics('COMPANY'))

      act(() => {
        result.current.trackStarted()
      })

      act(() => {
        vi.useFakeTimers()
        vi.advanceTimersByTime(30000) // 30 seconds total
        result.current.trackCompleted(5, 5)
        vi.useRealTimers()
      })

      const calls = vi.mocked(posthog.track).mock.calls
      const completedCall = calls.find((call) => call[0].event === 'onboarding_completed')

      expect(completedCall).toBeDefined()
      expect(completedCall![0]).toEqual({
        event: 'onboarding_completed',
        properties: {
          role: 'COMPANY',
          totalSteps: 5,
          stepsCompleted: 5,
          totalTimeMs: expect.any(Number),
        },
      })
    })

    it('should clear session storage after completion', () => {
      const { result } = renderHook(() => useOnboardingAnalytics('COMPANY'))

      act(() => {
        result.current.trackStarted()
        result.current.trackCompleted(5, 5)
      })

      const stored = sessionStorage.getItem('onboarding_session')
      expect(stored).toBeNull()
    })
  })

  describe('memory-only session', () => {
    it('reports the last step reached when the onboarding is abandoned', () => {
      const { result, unmount } = renderHook(() => useOnboardingAnalytics('COMPANY'))

      act(() => {
        result.current.trackStepViewed(3, 'Step 3')
      })

      unmount()

      const abandonedCall = vi
        .mocked(posthog.track)
        .mock.calls.find((call) => call[0].event === 'onboarding_abandoned')

      expect(abandonedCall).toBeDefined()
      expect(abandonedCall![0].properties).toEqual(
        expect.objectContaining({ role: 'COMPANY', lastStepReached: 3 })
      )
    })
  })

  describe('error handling', () => {
    it('should handle track errors gracefully', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn')
      vi.mocked(posthog.track).mockImplementation(() => {
        throw new Error('PostHog error')
      })

      const { result } = renderHook(() => useOnboardingAnalytics('COMPANY'))

      // Should not throw
      expect(() => {
        act(() => {
          result.current.trackStarted()
        })
      }).not.toThrow()

      // Should log warning
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[OnboardingAnalytics]'),
        expect.any(Error)
      )

      consoleWarnSpy.mockRestore()
    })

    it('avisa con el error etiquetado y conserva la causa original', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const rechazo = new Error('PostHog error')
      vi.mocked(posthog.track).mockImplementation(() => {
        throw rechazo
      })

      const { result } = renderHook(() => useOnboardingAnalytics('COMPANY'))

      act(() => {
        result.current.trackStepCompleted(2, 'Paso 2')
      })

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[OnboardingAnalytics] Failed to track step completed:',
        expect.objectContaining({
          _tag: 'OnboardingTrackError',
          event: 'onboarding_step_completed',
          cause: rechazo,
        })
      )

      consoleWarnSpy.mockRestore()
    })

    it('no propaga el fallo de PostHog cuando el abandono sale en el cleanup', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.mocked(posthog.track).mockImplementation(() => {
        throw new Error('PostHog error')
      })

      const { result, unmount } = renderHook(() => useOnboardingAnalytics('COMPANY'))

      act(() => {
        result.current.trackStepViewed(2, 'Paso 2')
      })

      expect(() => unmount()).not.toThrow()
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[OnboardingAnalytics] Failed to track abandoned:',
        expect.objectContaining({ _tag: 'OnboardingTrackError' })
      )

      consoleWarnSpy.mockRestore()
    })

    it('should handle missing PostHog gracefully', () => {
      vi.mocked(posthog.track).mockImplementation(undefined as unknown as () => void)

      const { result } = renderHook(() => useOnboardingAnalytics('COMPANY'))

      // Should not throw even without PostHog
      expect(() => {
        act(() => {
          result.current.trackStarted()
          result.current.trackStepViewed(1, 'Step 1')
          result.current.trackStepCompleted(1, 'Step 1')
        })
      }).not.toThrow()
    })
  })

  describe('non-blocking behavior', () => {
    it('should use fire-and-forget pattern', () => {
      const { result } = renderHook(() => useOnboardingAnalytics('COMPANY'))

      // Should return immediately without awaiting
      const start = Date.now()
      act(() => {
        result.current.trackStarted()
      })
      const elapsed = Date.now() - start

      // Should complete in <100ms (fire-and-forget)
      // Vitest can be slower, so we use a more generous timeout
      expect(elapsed).toBeLessThan(100)
    })
  })
})
