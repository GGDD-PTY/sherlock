/**
 * Callback route onError: WorkOS-initiated flows (dashboard impersonation,
 * AuthKit hosted UI reached directly) hit /callback without the PKCE `state`
 * param. The route must restart the flow once through /login instead of
 * returning a raw 500, and must not redirect-loop on persistent failures.
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

type HandleAuthOptions = {
  onError?: (params: { error?: unknown; request: NextRequest }) => Response | Promise<Response>
  onSuccess?: (data: unknown) => void | Promise<void>
  returnPathname?: string
  baseURL?: string
}

let capturedOptions: HandleAuthOptions | undefined
const {
  mockCookieSet,
  mockCookieDelete,
  mockCookieGet,
  mockClaimAfterAuthentication,
  mockScheduleClaimConversion,
  mockRequestHeaders,
  mockAuthHandler,
  mockLogWarn,
  mockLogError,
} = vi.hoisted(() => {
  const mockHeaderGet = vi.fn()
  return {
    mockAuthHandler: vi.fn(),
    mockLogWarn: vi.fn(),
    mockLogError: vi.fn(),
    mockCookieSet: vi.fn(),
    mockCookieDelete: vi.fn(),
    mockCookieGet: vi.fn(),
    mockClaimAfterAuthentication: vi.fn(),
    mockScheduleClaimConversion: vi.fn(),
    mockRequestHeaders: { get: mockHeaderGet },
  }
})

vi.mock('@workos-inc/authkit-nextjs', () => ({
  handleAuth: (options: HandleAuthOptions) => {
    capturedOptions = options
    return mockAuthHandler
  },
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLogWarn,
    error: mockLogError,
  }),
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: mockCookieGet, set: mockCookieSet, delete: mockCookieDelete }),
  headers: async () => mockRequestHeaders,
}))

vi.mock('@/lib/intake/claim', () => ({
  claimIntakeAfterAuthentication: (...args: unknown[]) => mockClaimAfterAuthentication(...args),
}))
vi.mock('@/lib/analytics/server', () => ({
  scheduleIntakeClaimConversion: (...args: unknown[]) => mockScheduleClaimConversion(...args),
}))

async function loadRoute() {
  vi.resetModules()
  capturedOptions = undefined
  await import('@/app/callback/route')
  if (!capturedOptions) throw new Error('handleAuth was not called')
  return capturedOptions as HandleAuthOptions
}

describe('callback route onError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.NEXT_PUBLIC_APP_URL
    delete process.env.INTAKE_DEMO_MODE
    mockCookieGet.mockReturnValue(undefined)
    mockClaimAfterAuthentication.mockResolvedValue({ status: 'SUCCEEDED' })
    mockScheduleClaimConversion.mockReturnValue(undefined)
    mockRequestHeaders.get.mockReturnValue(null)
    process.env.WORKOS_ADMIN_STEP_UP_COOKIE_SECRET =
      'test-admin-step-up-callback-secret-with-strong-entropy'
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('registers an onError handler', async () => {
    const options = await loadRoute()
    expect(typeof options.onError).toBe('function')
  })

  it('redirects a first failure to /login to restart the flow', async () => {
    const options = await loadRoute()
    const request = new NextRequest('https://www.sherlock.capital/callback?code=abc')

    const response = await options.onError!({
      error: new Error('Missing required auth parameter'),
      request,
    })

    expect(response.status).toBeGreaterThanOrEqual(300)
    expect(response.status).toBeLessThan(400)
    const location = response.headers.get('location')
    expect(location).toBe('https://www.sherlock.capital/login')
    // Sets the retry marker so the next failure does not loop
    expect(response.headers.get('set-cookie')).toContain('sherlock-auth-retry=1')
  })

  it('redirects a callback without OAuth parameters instead of surfacing a 500', async () => {
    const options = await loadRoute()
    const request = new NextRequest('https://www.sherlock.capital/callback')

    const response = await options.onError!({
      error: new Error('Missing required auth parameter'),
      request,
    })

    expect(response.status).toBeGreaterThanOrEqual(300)
    expect(response.status).toBeLessThan(400)
    expect(response.headers.get('location')).toBe('https://www.sherlock.capital/login')
  })

  it('redirects a repeated failure to the localized home instead of looping', async () => {
    const options = await loadRoute()
    const request = new NextRequest('https://www.sherlock.capital/callback?code=abc', {
      headers: { cookie: 'sherlock-auth-retry=1' },
    })

    const response = await options.onError!({ error: new Error('OAuth state mismatch'), request })

    expect(response.status).toBeGreaterThanOrEqual(300)
    expect(response.status).toBeLessThan(400)
    expect(response.headers.get('location')).toBe('https://www.sherlock.capital/es')
    // Clears the retry marker
    expect(response.headers.get('set-cookie')).toContain('sherlock-auth-retry=;')
  })

  it('uses NEXT_PUBLIC_APP_URL as redirect origin when set', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.sherlock.capital'
    const options = await loadRoute()
    const request = new NextRequest('https://sherlock-abc123.vercel.app/callback?code=abc')

    const response = await options.onError!({
      error: new Error('Missing required auth parameter'),
      request,
    })

    expect(response.headers.get('location')).toBe('https://www.sherlock.capital/login')
  })

  it('onSuccess writes a v2 HttpOnly marker bound to the exact WorkOS subject and session', async () => {
    const options = await loadRoute()
    const subject = 'workos_admin_callback'
    const sessionId = 'session_admin_callback_001'
    const claims = Buffer.from(JSON.stringify({ sub: subject, sid: sessionId })).toString(
      'base64url'
    )

    await options.onSuccess!({
      authenticationMethod: 'SSO',
      accessToken: `header.${claims}.signature`,
      user: { id: subject },
    })

    expect(mockCookieDelete).not.toHaveBeenCalled()
    expect(mockCookieSet).toHaveBeenCalledTimes(1)
    const [cookieName, cookieValue, cookieOptions] = mockCookieSet.mock.calls[0]
    expect(cookieName).toBe('sherlock_admin_step_up')
    expect(cookieValue).toMatch(/^v2\./)
    expect(cookieOptions).toMatchObject({
      httpOnly: true,
      maxAge: 43_200,
      path: '/',
      sameSite: 'lax',
    })

    const { isRecentAdminStepUpCookie } = await import('@/lib/auth/admin-step-up')
    expect(isRecentAdminStepUpCookie(cookieValue, { subject, sessionId })).toBe(true)
    expect(isRecentAdminStepUpCookie(cookieValue, { subject, sessionId: 'session_other' })).toBe(
      false
    )
  })

  it('durably claims pending intake without creating an analytics cookie', async () => {
    process.env.INTAKE_DEMO_MODE = 'true'
    const intakeToken = 'i'.repeat(43)
    mockCookieGet.mockImplementation((name: string) => {
      if (name === 'sherlock-intake-dev') return { value: intakeToken }
      if (name === 'NEXT_LOCALE') return { value: 'es' }
      return undefined
    })
    const options = await loadRoute()
    const subject = 'workos_company_callback'
    const claims = Buffer.from(
      JSON.stringify({ sub: subject, sid: 'session_company_callback_001' })
    ).toString('base64url')
    const accessToken = `header.${claims}.signature`
    mockClaimAfterAuthentication.mockResolvedValueOnce({
      status: 'SUCCEEDED',
      claimDigest: 'd'.repeat(64),
      claimedDocumentCount: 2,
    })

    await options.onSuccess!({
      authenticationMethod: 'Password',
      accessToken,
      user: { id: subject },
    })

    expect(mockClaimAfterAuthentication).toHaveBeenCalledWith({
      accessToken,
      sessionToken: intakeToken,
      workosSubject: subject,
    })
    expect(mockCookieSet).toHaveBeenCalledWith(
      'sherlock-intake-dev',
      '',
      expect.objectContaining({ maxAge: 0, path: '/' })
    )
    expect(mockCookieSet).toHaveBeenCalledWith(
      'sherlock-intake-csrf-dev',
      '',
      expect.objectContaining({ maxAge: 0, path: '/' })
    )
    expect(mockCookieDelete).toHaveBeenCalledWith('sherlock_intake_claim_retry')
    expect(mockCookieSet).not.toHaveBeenCalledWith(
      'sherlock_intake_claimed',
      expect.anything(),
      expect.anything()
    )
    expect(mockScheduleClaimConversion).toHaveBeenCalledWith({
      claimDigest: 'd'.repeat(64),
      claimedDocumentCount: 2,
      locale: 'es',
      requestHeaders: mockRequestHeaders,
    })
  })

  // En producción las cookies del intake llevan el prefijo `__Host-`, y el
  // navegador rechaza cualquier Set-Cookie de ese nombre que no traiga `Secure`
  // y `Path=/`. `cookieStore.delete(name)` emite justo eso — sin Secure ni
  // Path — así que el borrado no ocurría: el navegador conservaba la cookie de
  // una sesión ya reclamada y la siguiente tanda de la landing chocaba con ella
  // (prod 2026-09-03 03:25).
  it('clears the __Host- intake cookies with the attributes their prefix requires', async () => {
    process.env.INTAKE_DEMO_MODE = 'true'
    vi.stubEnv('NODE_ENV', 'production')
    const intakeToken = 'i'.repeat(43)
    mockCookieGet.mockImplementation((name: string) =>
      name === '__Host-sherlock-intake' ? { value: intakeToken } : undefined
    )
    mockClaimAfterAuthentication.mockResolvedValueOnce({
      status: 'SUCCEEDED',
      claimDigest: 'd'.repeat(64),
      claimedDocumentCount: 1,
    })
    const options = await loadRoute()
    const claims = Buffer.from(
      JSON.stringify({ sub: 'workos_company_prod', sid: 'session_company_prod_001' })
    ).toString('base64url')

    await options.onSuccess!({
      authenticationMethod: 'Password',
      accessToken: `header.${claims}.signature`,
      user: { id: 'workos_company_prod' },
    })

    for (const name of ['__Host-sherlock-intake', '__Host-sherlock-intake-csrf']) {
      expect(mockCookieDelete).not.toHaveBeenCalledWith(name)
      expect(mockCookieSet).toHaveBeenCalledWith(
        name,
        '',
        expect.objectContaining({ maxAge: 0, path: '/', secure: true })
      )
      const [, , clearOptions] = mockCookieSet.mock.calls.find(
        ([cookieName]) => cookieName === name
      )!
      expect(clearOptions).not.toHaveProperty('domain')
    }
  })

  it('completes authentication and retains intake authority when claim reconciliation fails', async () => {
    process.env.INTAKE_DEMO_MODE = 'true'
    const intakeToken = 'i'.repeat(43)
    mockCookieGet.mockImplementation((name: string) =>
      name === 'sherlock-intake-dev' ? { value: intakeToken } : undefined
    )
    mockClaimAfterAuthentication.mockRejectedValue(new Error('convex unavailable'))
    const options = await loadRoute()
    const subject = 'workos_company_callback'
    const claims = Buffer.from(
      JSON.stringify({ sub: subject, sid: 'session_company_callback_001' })
    ).toString('base64url')

    await options.onSuccess!({
      authenticationMethod: 'SSO',
      accessToken: `header.${claims}.signature`,
      user: { id: subject },
    })

    expect(mockCookieDelete).not.toHaveBeenCalledWith('sherlock-intake-dev')
    expect(mockCookieDelete).not.toHaveBeenCalledWith('sherlock-intake-csrf-dev')
    expect(mockCookieSet).toHaveBeenCalledWith(
      'sherlock_intake_claim_retry',
      '1',
      expect.objectContaining({ httpOnly: false, maxAge: 300, path: '/', sameSite: 'lax' })
    )
    expect(mockCookieSet).not.toHaveBeenCalledWith(
      'sherlock_intake_claimed',
      expect.anything(),
      expect.anything()
    )
    expect(mockCookieSet).toHaveBeenCalledWith(
      'sherlock_admin_step_up',
      expect.stringMatching(/^v2\./),
      expect.objectContaining({ httpOnly: true })
    )
  })

  it('onSuccess deletes the marker when access-token subject and WorkOS user drift', async () => {
    const options = await loadRoute()
    const claims = Buffer.from(
      JSON.stringify({ sub: 'workos_other', sid: 'session_admin_callback_001' })
    ).toString('base64url')

    await options.onSuccess!({
      authenticationMethod: 'SSO',
      accessToken: `header.${claims}.signature`,
      user: { id: 'workos_admin_callback' },
    })

    expect(mockCookieSet).not.toHaveBeenCalled()
    expect(mockCookieDelete).toHaveBeenCalledWith('sherlock_admin_step_up')
  })
})

// QA post-deploy de #776: un /callback pelado dejaba «[AuthKit callback error]
// Missing required auth parameter» con stack como error de runtime. Es entrada
// del cliente: misma redirección que `onError`, registrada a nivel warn y sin
// pasar por `handleAuth`.
describe('callback route without state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.NEXT_PUBLIC_APP_URL
  })

  it.each([
    'https://www.sherlock.capital/callback',
    'https://www.sherlock.capital/callback?code=abc',
  ])('restarts %s through /login and logs at warn without calling AuthKit', async (url) => {
    vi.resetModules()
    const { GET } = await import('@/app/callback/route')

    const response = await GET(new NextRequest(url))

    expect(mockAuthHandler).not.toHaveBeenCalled()
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://www.sherlock.capital/login')
    expect(response.headers.get('set-cookie')).toContain('sherlock-auth-retry=1')
    expect(response.headers.get('cache-control')).toBe(
      'private, no-cache, no-store, must-revalidate, max-age=0'
    )
    expect(response.headers.get('vary')).toContain('Cookie')
    expect(mockLogWarn).toHaveBeenCalledWith('AuthKit callback without required auth parameter', {
      hasCode: url.includes('code='),
    })
    expect(mockLogError).not.toHaveBeenCalled()
  })

  it('hands a callback with state to AuthKit', async () => {
    vi.resetModules()
    mockAuthHandler.mockResolvedValueOnce(new Response(null, { status: 307 }))
    const { GET } = await import('@/app/callback/route')
    const request = new NextRequest('https://www.sherlock.capital/callback?code=abc&state=xyz')

    await GET(request)

    expect(mockAuthHandler).toHaveBeenCalledWith(request)
    expect(mockLogWarn).not.toHaveBeenCalled()
  })
})
