import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

import {
  createIntakeCsrfToken,
  getIntakeCsrfCookieName,
  setIntakeCsrfCookie,
  validateIntakeCsrfToken,
} from '@/lib/intake/csrf'
import {
  getIntakeSessionCookieName,
  intakeSessionCookieOptions,
  setIntakeSessionCookie,
} from '@/lib/intake/session'

const SECRET = 'intake-server-secret-for-tests-1234567890'
const AUDIENCE = 'sherlock-test:intake'
const SESSION_A = 'a'.repeat(43)
const SESSION_B = 'b'.repeat(43)

function cookieHeader(response: NextResponse, name: string): string {
  const headers = response.headers.getSetCookie?.() ?? []
  const match = headers.find((header) => header.startsWith(`${name}=`))
  if (match) return match
  return response.headers.get('set-cookie') ?? ''
}

describe('intake CSRF binding and cookie contract', () => {
  beforeEach(() => {
    vi.stubEnv('INTAKE_SERVER_SECRET', SECRET)
    vi.stubEnv('INTAKE_SERVER_AUDIENCE', AUDIENCE)
    vi.useFakeTimers()
    vi.setSystemTime(1_900_000_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('rejects a bootstrap token against session authority and the reverse', () => {
    const bootstrap = createIntakeCsrfToken({ binding: 'BOOTSTRAP' })
    const session = createIntakeCsrfToken({ binding: SESSION_A })

    expect(validateIntakeCsrfToken(bootstrap, 'BOOTSTRAP')).toBe(true)
    expect(validateIntakeCsrfToken(session, SESSION_A)).toBe(true)
    expect(validateIntakeCsrfToken(bootstrap, SESSION_A)).toBe(false)
    expect(validateIntakeCsrfToken(session, 'BOOTSTRAP')).toBe(false)
    expect(validateIntakeCsrfToken(session, SESSION_B)).toBe(false)
  })

  it('keeps bootstrap TTL at 10 minutes and session TTL at 65 minutes', () => {
    const issuedAt = Date.now()
    const bootstrap = createIntakeCsrfToken({ binding: 'BOOTSTRAP', issuedAt })
    const session = createIntakeCsrfToken({ binding: SESSION_A, issuedAt })

    const elevenMinutes = issuedAt + 11 * 60_000
    expect(validateIntakeCsrfToken(bootstrap, 'BOOTSTRAP', elevenMinutes)).toBe(false)
    expect(validateIntakeCsrfToken(session, SESSION_A, elevenMinutes)).toBe(true)

    const sixtySixMinutes = issuedAt + 66 * 60_000
    expect(validateIntakeCsrfToken(session, SESSION_A, sixtySixMinutes)).toBe(false)
    expect(validateIntakeCsrfToken(session, SESSION_A, issuedAt - 31_000)).toBe(false)
  })

  it('keeps the session cookie Lax+httpOnly and the CSRF cookie Strict+readable', () => {
    expect(intakeSessionCookieOptions('production')).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
    })
    expect(getIntakeCsrfCookieName('production')).toBe('__Host-sherlock-intake-csrf')
    expect(getIntakeSessionCookieName('production')).toBe('__Host-sherlock-intake')

    const response = new NextResponse(null, { status: 204 })
    const csrfToken = createIntakeCsrfToken({ binding: SESSION_A })
    setIntakeSessionCookie(response, SESSION_A, Date.now() + 7 * 24 * 60 * 60 * 1000)
    setIntakeCsrfCookie(response, csrfToken)

    const sessionCookie = cookieHeader(response, getIntakeSessionCookieName())
    const csrfCookie = cookieHeader(response, getIntakeCsrfCookieName())

    expect(sessionCookie.toLowerCase()).toContain('httponly')
    expect(sessionCookie.toLowerCase()).toContain('samesite=lax')
    expect(csrfCookie.toLowerCase()).not.toContain('httponly')
    expect(csrfCookie.toLowerCase()).toContain('samesite=strict')
  })
})
