// ============================================================================
// POSTHOG ANALYTICS - UNIT TESTS
// ============================================================================
// Contracts for public keys and the narrow, personless event API.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

// MOCK SETUP
// ============================================================================

// Mock posthog-js module
const mockCapture = vi.fn()

vi.mock('posthog-js', () => ({
  default: {
    __loaded: true,
    capture: mockCapture,
  },
}))

// ============================================================================
// TESTS: NO SECRET KEY IN CLIENT BUNDLE
// ============================================================================

describe('PostHog: No secret key exposed in client bundle', () => {
  it('should only use NEXT_PUBLIC_POSTHOG_KEY environment variable', async () => {
    // Read the PostHogProvider source to verify only public key is used
    const fs = await import('fs')
    const path = await import('path')

    const providerPath = path.resolve(process.cwd(), 'src/components/providers/PostHogProvider.tsx')
    const providerContent = fs.readFileSync(providerPath, 'utf-8')

    // Assert: NEXT_PUBLIC_POSTHOG_KEY is used for the API key
    expect(providerContent).toContain('NEXT_PUBLIC_POSTHOG_KEY')

    // Note: POSTHOG_HOST is now hardcoded as "/ingest" proxy path to avoid ad blockers
    // This is the recommended approach per PostHog docs
    expect(providerContent).toContain('/ingest')

    // Assert: No secret/private keys are referenced
    // Secret keys would NOT have NEXT_PUBLIC_ prefix
    expect(providerContent).not.toContain('POSTHOG_API_KEY')
    expect(providerContent).not.toContain('POSTHOG_SECRET')
    expect(providerContent).not.toContain('POSTHOG_PRIVATE')

    // Find all env var references like process.env.SOMETHING
    // and verify they only use NEXT_PUBLIC_ prefixed vars for PostHog
    const envVarMatches = providerContent.match(/process\.env\.[A-Z_]+/g) || []
    const posthogEnvVars = envVarMatches.filter((v: string) => v.includes('POSTHOG'))

    // All PostHog env vars should be prefixed with NEXT_PUBLIC_
    for (const envVar of posthogEnvVars) {
      expect(envVar).toContain('NEXT_PUBLIC_')
    }
  })

  it('should only use NEXT_PUBLIC_ prefixed env vars in analytics utility', async () => {
    const fs = await import('fs')
    const path = await import('path')

    const posthogPath = path.resolve(process.cwd(), 'src/lib/analytics/posthog.ts')
    const posthogContent = fs.readFileSync(posthogPath, 'utf-8')

    // This file doesn't directly reference env vars (uses posthog-js),
    // but verify no secrets are hardcoded
    expect(posthogContent).not.toContain('phc_') // PostHog API key prefix
    expect(posthogContent).not.toContain('secret')
    expect(posthogContent).not.toContain('private')
    expect(posthogContent).not.toContain('POSTHOG_API_KEY')
  })
})

// ============================================================================
// TESTS: EVENT QUEUE FOR OFFLINE SUPPORT
// ============================================================================
// NOTE: These tests were removed because they used vi.mock() inside tests,
// which gets hoisted by Vitest and corrupts the mock state for ALL tests.
// The correct approach would be to use vi.doMock() (not hoisted) or change
// mock behavior via mockImplementation() instead.
//
// Offline queue behavior is covered in posthog-queue.test.ts.
// ============================================================================

// ============================================================================
// TESTS: EVENT TYPE SAFETY
// ============================================================================

// ============================================================================
// Type-safe event tracking tests
// Uses the exact same pattern as the working tests above
// ============================================================================

describe('PostHog: personless event tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('tracks a safe manual event without reading consent state', async () => {
    const storageRead = vi.spyOn(Storage.prototype, 'getItem')
    const { track } = await import('@/lib/analytics/posthog')

    track({ event: 'intake_started', properties: { locale: 'es', mode: 'TEMPORARY' } })

    await vi.waitFor(() => {
      expect(mockCapture).toHaveBeenCalledWith('intake_started', {
        locale: 'es',
        mode: 'TEMPORARY',
      })
    })
    expect(storageRead).not.toHaveBeenCalled()
  })

  it('does not expose identity, pageview, replay, alias, group, or feature-flag helpers', async () => {
    const analytics = await import('@/lib/analytics/posthog')

    expect(Object.keys(analytics).sort()).toEqual(['track'])
  })
})
