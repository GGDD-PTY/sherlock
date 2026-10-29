import { afterEach, describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { validateOrigin } from '@/lib/api/csrf'

afterEach(() => vi.unstubAllEnvs())

function requestFrom(origin: string) {
  return new NextRequest('https://app.example.com/api/test', { headers: { origin } })
}

describe('installation CSRF origins', () => {
  it('allows only the configured installation in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com')
    expect(validateOrigin(requestFrom('https://app.example.com'))).toBe(true)
    for (const origin of [
      'https://sherlock.capital',
      'https://www.sherlock.capital',
      'https://dev.sherlock.capital',
      'https://other.example.com',
      'http://localhost:3000',
    ]) {
      expect(validateOrigin(requestFrom(origin))).toBe(false)
    }
  })

  it.each([
    '',
    'not-a-url',
    'http://localhost:3000',
    'https://localhost:3000',
    'https://app.example.com/path',
    'https://app.example.com?redirect=1',
  ])('fails closed in production with invalid configuration %s', (appUrl) => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl)
    expect(validateOrigin(requestFrom('https://app.example.com'))).toBe(false)
    expect(validateOrigin(requestFrom('http://localhost:3000'))).toBe(false)
  })

  it('allows local development and a configured local port', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3100')
    for (const port of [3000, 3015, 3100]) {
      expect(validateOrigin(requestFrom(`http://localhost:${port}`))).toBe(true)
    }
  })
})
