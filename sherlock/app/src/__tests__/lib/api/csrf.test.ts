// ============================================================================
// TESTS: CSRF origin validation
// ============================================================================

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { validateOrigin } from '@/lib/api/csrf'
import { NextRequest } from 'next/server'

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest('https://app.example.com/api/test', { headers })
}

describe('validateOrigin', () => {
  const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
  })

  afterEach(() => {
    if (savedAppUrl !== undefined) {
      process.env.NEXT_PUBLIC_APP_URL = savedAppUrl
    } else {
      delete process.env.NEXT_PUBLIC_APP_URL
    }
  })

  it('allows requests with no origin or referer outside production (dev/test harnesses)', () => {
    expect(validateOrigin(makeRequest())).toBe(true)
  })

  it('allows requests from https://app.example.com', () => {
    expect(validateOrigin(makeRequest({ origin: 'https://app.example.com' }))).toBe(true)
  })

  it('allows requests from https://app.example.com', () => {
    expect(validateOrigin(makeRequest({ origin: 'https://app.example.com' }))).toBe(true)
  })

  it('allows requests from http://localhost:3000', () => {
    expect(validateOrigin(makeRequest({ origin: 'http://localhost:3000' }))).toBe(true)
  })

  it('allows requests from http://localhost:3015', () => {
    expect(validateOrigin(makeRequest({ origin: 'http://localhost:3015' }))).toBe(true)
  })

  it('rejects requests from unknown origins', () => {
    expect(validateOrigin(makeRequest({ origin: 'https://evil.com' }))).toBe(false)
  })

  it('allows referer from allowed origin when no origin header', () => {
    expect(validateOrigin(makeRequest({ referer: 'https://app.example.com/deals/123' }))).toBe(true)
  })

  it('rejects referer from unknown origin', () => {
    expect(validateOrigin(makeRequest({ referer: 'https://attacker.com/phishing' }))).toBe(false)
  })

  it('rejects invalid referer URL', () => {
    expect(validateOrigin(makeRequest({ referer: 'not-a-valid-url' }))).toBe(false)
  })

  it('includes NEXT_PUBLIC_APP_URL in allowed origins', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://staging.example.com'
    expect(validateOrigin(makeRequest({ origin: 'https://staging.example.com' }))).toBe(true)
  })

  it('handles invalid NEXT_PUBLIC_APP_URL gracefully', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'not-a-valid-url'
    expect(validateOrigin(makeRequest({ origin: 'https://app.example.com' }))).toBe(false)
  })

  it('rejects an application URL with a path', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com/some/path'
    expect(validateOrigin(makeRequest({ origin: 'https://app.example.com' }))).toBe(false)
  })

  it('origin header takes precedence over referer', () => {
    expect(
      validateOrigin(
        makeRequest({
          origin: 'https://evil.com',
          referer: 'https://app.example.com/page',
        })
      )
    ).toBe(false)
  })

  describe('fail-closed sin Origin/Referer', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('rejects cross-site per Sec-Fetch-Site even without origin/referer', () => {
      expect(validateOrigin(makeRequest({ 'sec-fetch-site': 'cross-site' }))).toBe(false)
    })

    it('allows same-origin per Sec-Fetch-Site without origin/referer', () => {
      expect(validateOrigin(makeRequest({ 'sec-fetch-site': 'same-origin' }))).toBe(true)
    })

    it('allows direct navigation (Sec-Fetch-Site: none) without origin/referer', () => {
      expect(validateOrigin(makeRequest({ 'sec-fetch-site': 'none' }))).toBe(true)
    })

    it('rejects requests with zero browser signals in production (fail-closed)', () => {
      vi.stubEnv('NODE_ENV', 'production')
      expect(validateOrigin(makeRequest())).toBe(false)
    })

    it('honors Sec-Fetch-Site same-origin in production', () => {
      vi.stubEnv('NODE_ENV', 'production')
      expect(validateOrigin(makeRequest({ 'sec-fetch-site': 'same-origin' }))).toBe(true)
    })

    it('rejects "null" origin (cross-site form post with opaque origin)', () => {
      expect(validateOrigin(makeRequest({ origin: 'null' }))).toBe(false)
    })
  })
})
