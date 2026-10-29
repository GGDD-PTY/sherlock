import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { rejectNonExactSameOrigin } from '@/lib/api/exact-same-origin'

function requestFrom(url: string, origin?: string) {
  const headers = new Headers()
  if (origin !== undefined) headers.set('origin', origin)
  return new NextRequest(url, { headers })
}

describe('rejectNonExactSameOrigin', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('allows an exact configured origin in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://www.sherlock.capital')

    expect(
      rejectNonExactSameOrigin(
        requestFrom(
          'https://www.sherlock.capital/api/admin/vdr-capability',
          'https://www.sherlock.capital'
        )
      )
    ).toBeNull()
  })

  it('rejects a missing Origin even when the request host matches the canonical origin', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://www.sherlock.capital')

    const response = rejectNonExactSameOrigin(
      requestFrom('https://www.sherlock.capital/api/admin/vdr-capability')
    )

    expect(response?.status).toBe(403)
  })

  it('rejects an attacker origin that is not the configured canonical origin', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://www.sherlock.capital')

    const response = rejectNonExactSameOrigin(
      requestFrom('https://www.sherlock.capital/api/admin/vdr-capability', 'https://evil.example')
    )

    expect(response?.status).toBe(403)
  })

  it('rejects a production alias or preview host that is not the configured origin', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://www.sherlock.capital')

    const response = rejectNonExactSameOrigin(
      requestFrom(
        'https://dev.sherlock.capital/api/admin/vdr-capability',
        'https://dev.sherlock.capital'
      )
    )

    expect(response?.status).toBe(403)
  })

  it('rejects Origin values that parse but are not an exact origin string', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://www.sherlock.capital')

    const response = rejectNonExactSameOrigin(
      requestFrom(
        'https://www.sherlock.capital/api/admin/vdr-capability',
        'https://www.sherlock.capital/phishing'
      )
    )

    expect(response?.status).toBe(403)
  })

  it('allows localhost:3000 only when the app URL is unset and the process is not production', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')

    expect(
      rejectNonExactSameOrigin(
        requestFrom('http://localhost:3000/api/admin/vdr-capability', 'http://localhost:3000')
      )
    ).toBeNull()
  })

  it('never treats a matching localhost Origin as authoritative in production without NEXT_PUBLIC_APP_URL', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')

    const response = rejectNonExactSameOrigin(
      requestFrom('http://localhost:3000/api/admin/vdr-capability', 'http://localhost:3000')
    )

    expect(response?.status).toBe(403)
  })
})
