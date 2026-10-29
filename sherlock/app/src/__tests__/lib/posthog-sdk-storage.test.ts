import posthog from 'posthog-js'
import { describe, expect, it, vi } from 'vitest'

vi.unmock('posthog-js')

describe('PostHog SDK storage boundary', () => {
  it('uses localStorage for sessions without setting a PostHog cookie', () => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    document.cookie = 'ph_test=; Max-Age=0; Path=/'

    const client = posthog.init(
      'phc_public_test_key',
      {
        api_host: '/ingest',
        persistence: 'localStorage',
        disable_persistence: false,
        person_profiles: 'never',
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        capture_performance: false,
        disable_session_recording: false,
        advanced_disable_flags: true,
        advanced_disable_feature_flags: true,
        advanced_disable_feature_flags_on_first_load: true,
        before_send: () => null,
      },
      'storage-boundary'
    )

    expect(client).toBeDefined()
    expect(client?.__loaded).toBe(true)
    expect(client?.config.persistence).toBe('localStorage')
    expect(client?.config.disable_persistence).toBe(false)
    expect(
      Array.from({ length: window.localStorage.length }, (_, index) =>
        window.localStorage.key(index)
      ).some((key) => /(?:posthog|ph_)/i.test(key ?? ''))
    ).toBe(true)
    expect(document.cookie).not.toMatch(/(?:posthog|ph_)/i)
  })
})
