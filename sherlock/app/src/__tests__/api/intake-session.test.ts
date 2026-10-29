import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { ConvexError } from 'convex/values'
import { Effect } from 'effect'

const mockMutation = vi.fn()
const mockGetUnauthenticatedConvex = vi.fn()
vi.mock('@/lib/convex-auth', () => ({
  getUnauthenticatedConvex: () => mockGetUnauthenticatedConvex(),
}))

const mockRateLimit = vi.fn()
vi.mock('@/lib/utils/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/rate-limit')>()
  return {
    ...actual,
    checkRateLimitDistributed: (...args: unknown[]) => mockRateLimit(...args),
    checkRateLimitDistributedEffect: (...args: unknown[]) =>
      Effect.promise(() => mockRateLimit(...args)),
  }
})

import {
  DELETE as revokeSession,
  GET as getSession,
  POST as createOrRotateSession,
} from '@/app/api/intake/session/route'
import { DELETE as deleteIntakeData } from '@/app/api/intake/data/route'
import { getIntakeSessionCookieName, intakeSessionCookieOptions } from '@/lib/intake/session'
import {
  createIntakeCsrfToken,
  getIntakeCsrfCookieName,
  INTAKE_CSRF_HEADER,
} from '@/lib/intake/csrf'

const SECRET = 'intake-server-secret-for-api-tests-123456789'
const AUDIENCE = 'sherlock-test:intake-api'
const SESSION_TOKEN = 's'.repeat(43)
const ROTATED_TOKEN = 'r'.repeat(43)

function authorityCookies(csrfToken: string): string {
  return `${getIntakeSessionCookieName()}=${SESSION_TOKEN}; ${getIntakeCsrfCookieName()}=${csrfToken}`
}

function jsonRequest(
  path: string,
  body: unknown,
  options: { origin?: string; sessionToken?: string; csrfToken?: string } = {}
) {
  const cookies = [
    options.sessionToken ? `${getIntakeSessionCookieName()}=${options.sessionToken}` : undefined,
    options.csrfToken ? `${getIntakeCsrfCookieName()}=${options.csrfToken}` : undefined,
  ].filter(Boolean)
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: options.origin ?? 'http://localhost:3000',
      ...(cookies.length > 0 ? { Cookie: cookies.join('; ') } : {}),
      ...(options.csrfToken ? { [INTAKE_CSRF_HEADER]: options.csrfToken } : {}),
      'x-vercel-forwarded-for': '203.0.113.10',
    },
    body: JSON.stringify(body),
  })
}

describe('temporary intake session API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('INTAKE_DEMO_MODE', 'true')
    vi.stubEnv('INTAKE_SERVER_SECRET', SECRET)
    vi.stubEnv('INTAKE_SERVER_AUDIENCE', AUDIENCE)
    mockGetUnauthenticatedConvex.mockReturnValue({ mutation: mockMutation })
    mockRateLimit.mockResolvedValue({
      success: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 60_000),
      retryAfterSec: 0,
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps the no-signup mode off unless explicitly enabled and mints no session', async () => {
    vi.stubEnv('INTAKE_DEMO_MODE', 'false')
    const response = await createOrRotateSession(
      jsonRequest('/api/intake/session', {}, { csrfToken: 'invalid' })
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mockMutation).not.toHaveBeenCalled()
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('bootstraps CSRF before setting opaque cookie authority', async () => {
    const bootstrap = await getSession(
      new NextRequest('http://localhost:3000/api/intake/session', {
        headers: {
          Origin: 'http://localhost:3000',
          'x-vercel-forwarded-for': '203.0.113.10',
        },
      })
    )
    const bootstrapBody = await bootstrap.json()
    expect(bootstrapBody).toMatchObject({ authorized: false, csrfToken: expect.any(String) })
    expect(mockMutation).not.toHaveBeenCalled()

    mockMutation.mockResolvedValueOnce({
      sessionToken: SESSION_TOKEN,
      accessExpiresAt: Date.now() + 60 * 60_000,
      deletionProofExpiresAt: Date.now() + 7 * 24 * 60 * 60_000,
      workspace: { authorized: true, documents: [] },
    })
    const response = await createOrRotateSession(
      jsonRequest('/api/intake/session', { name: '' }, { csrfToken: bootstrapBody.csrfToken })
    )
    const body = await response.json()
    const setCookie = response.headers.get('set-cookie') ?? ''

    expect(response.status).toBe(201)
    expect(body).toMatchObject({ authorized: true, documents: [], csrfToken: expect.any(String) })
    expect(JSON.stringify(body)).not.toContain(SESSION_TOKEN)
    expect(setCookie).toContain(`${getIntakeSessionCookieName()}=${SESSION_TOKEN}`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=strict')
    expect(setCookie).toContain('Path=/')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mockMutation).toHaveBeenCalledWith(expect.anything(), {
      anonymousKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      identityName: undefined,
      serverIssuedAt: expect.any(Number),
      proofNonce: expect.any(String),
      serverProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
  })

  it('requires same-origin and server-issued CSRF before effects', async () => {
    const missingCsrf = await createOrRotateSession(jsonRequest('/api/intake/session', {}))
    const crossOrigin = await createOrRotateSession(
      jsonRequest(
        '/api/intake/session',
        {},
        {
          origin: 'https://attacker.example',
          csrfToken: createIntakeCsrfToken({ binding: 'BOOTSTRAP' }),
        }
      )
    )
    const staleCsrf = await createOrRotateSession(
      jsonRequest(
        '/api/intake/session',
        {},
        {
          csrfToken: createIntakeCsrfToken({
            binding: 'BOOTSTRAP',
            issuedAt: Date.now() - 11 * 60_000,
          }),
        }
      )
    )

    expect(missingCsrf.status).toBe(403)
    expect(crossOrigin.status).toBe(403)
    expect(staleCsrf.status).toBe(403)
    expect(await missingCsrf.json()).toMatchObject({ error: 'Solicitud no autorizada' })
    expect(mockMutation).not.toHaveBeenCalled()
  })

  it('projects only a bounded normalized assessment into the temporary workspace', async () => {
    mockMutation.mockResolvedValueOnce({
      authenticated: true,
      authorized: true,
      accessExpiresAt: Date.now() + 60 * 60_000,
      identityName: 'Acme Panamá',
      documents: [],
      assessment: {
        id: 'assessment_1',
        intakeSessionId: 'session_1',
        status: 'NEEDS_REVIEW',
        source: 'EXTERNAL',
        findings: [
          {
            category: 'financialStatements',
            evidenceDocumentIds: [],
            confidence: 0.82,
            reviewState: 'PENDING',
          },
        ],
        createdAt: 1_787_443_000_000,
        updatedAt: 1_787_443_000_001,
      },
    })

    const response = await getSession(
      new NextRequest('http://localhost:3000/api/intake/session', {
        headers: {
          Origin: 'http://localhost:3000',
          Cookie: `${getIntakeSessionCookieName()}=${SESSION_TOKEN}`,
          'x-vercel-forwarded-for': '203.0.113.10',
        },
      })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.assessment).toMatchObject({
      status: 'NEEDS_REVIEW',
      source: 'EXTERNAL',
      findings: [{ category: 'financialStatements', confidence: 0.82 }],
    })
  })

  it('projects every document after the retired twenty-file and aggregate limits', async () => {
    const documents = Array.from({ length: 21 }, (_, index) => ({
      id: `intake_${index}`,
      displayName: `Estados-${index}.pdf`,
      declaredMimeType: 'application/pdf',
      byteSize: 13 * 1024 * 1024,
      inspectionStatus: 'CLEAN',
      claimable: true,
      createdAt: 1_787_443_000_000 + index,
    }))
    mockMutation.mockResolvedValueOnce({ authenticated: true, authorized: true, documents })
    const response = await getSession(
      new NextRequest('http://localhost:3000/api/intake/session', {
        headers: {
          Origin: 'http://localhost:3000',
          Cookie: `${getIntakeSessionCookieName()}=${SESSION_TOKEN}`,
          'x-vercel-forwarded-for': '203.0.113.10',
        },
      })
    )
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.documents).toEqual(documents)
    expect(JSON.stringify(body)).not.toContain(SESSION_TOKEN)
  })

  it('rotates an existing cookie, binds an optional name, and returns no authority token', async () => {
    const csrfToken = createIntakeCsrfToken({ binding: SESSION_TOKEN })
    mockMutation.mockResolvedValueOnce({
      rotated: true,
      sessionToken: ROTATED_TOKEN,
      accessExpiresAt: Date.now() + 60 * 60_000,
      deletionProofExpiresAt: Date.now() + 7 * 24 * 60 * 60_000,
      workspace: { authorized: true, identityName: 'Acme Panamá', documents: [] },
    })

    const response = await createOrRotateSession(
      jsonRequest(
        '/api/intake/session',
        { name: '  Acme Panamá  ' },
        { sessionToken: SESSION_TOKEN, csrfToken }
      )
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(JSON.stringify(body)).not.toContain(SESSION_TOKEN)
    expect(JSON.stringify(body)).not.toContain(ROTATED_TOKEN)
    expect(response.headers.get('set-cookie')).toContain(ROTATED_TOKEN)
    expect(body.identityName).toBe('Acme Panamá')
    expect(mockMutation).toHaveBeenCalledWith(expect.anything(), {
      sessionToken: SESSION_TOKEN,
      identityName: 'Acme Panamá',
      serverIssuedAt: expect.any(Number),
      proofNonce: expect.any(String),
      serverProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
  })

  // Un cliente que vuelve a la landing trae la cookie de su intake anterior, ya
  // reclamado por su sala. Esa sesión no puede rotar — sus documentos ya son de
  // la empresa — y el 403 dejaba la segunda tanda sin camino temporal: la landing
  // caía al sobre de IndexedDB (prod 2026-09-03 03:25, "Sample Foods, S.A.").
  it('opens a fresh session when the cookie points at one that can no longer rotate', async () => {
    const csrfToken = createIntakeCsrfToken({ binding: SESSION_TOKEN })
    mockMutation.mockResolvedValueOnce({ rotated: false }).mockResolvedValueOnce({
      sessionToken: ROTATED_TOKEN,
      accessExpiresAt: Date.now() + 60 * 60_000,
      deletionProofExpiresAt: Date.now() + 7 * 24 * 60 * 60_000,
      workspace: { authorized: true, identityName: 'Sample Foods, S.A.', documents: [] },
    })

    const response = await createOrRotateSession(
      jsonRequest(
        '/api/intake/session',
        { name: 'Sample Foods, S.A.' },
        { sessionToken: SESSION_TOKEN, csrfToken }
      )
    )
    const body = await response.json()
    const setCookie = response.headers.get('set-cookie') ?? ''

    expect(response.status).toBe(201)
    expect(body).toMatchObject({ authorized: true, documents: [], csrfToken: expect.any(String) })
    expect(JSON.stringify(body)).not.toContain(ROTATED_TOKEN)
    expect(setCookie).toContain(`${getIntakeSessionCookieName()}=${ROTATED_TOKEN}`)
    expect(setCookie).not.toContain('Max-Age=0')
    expect(mockMutation).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        anonymousKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        identityName: 'Sample Foods, S.A.',
      })
    )
  })

  // La recuperación no relaja la prueba: una rotación que sí ocurrió pero
  // devuelve una autoridad que el servidor no puede avalar sigue cerrando.
  it('refuses a rotation whose issued authority the server cannot vouch for', async () => {
    const csrfToken = createIntakeCsrfToken({ binding: SESSION_TOKEN })
    mockMutation.mockResolvedValueOnce({
      rotated: true,
      sessionToken: 'not-an-opaque-token',
      accessExpiresAt: Date.now() + 60 * 60_000,
      deletionProofExpiresAt: Date.now() + 7 * 24 * 60 * 60_000,
      workspace: { authorized: true, documents: [] },
    })

    const response = await createOrRotateSession(
      jsonRequest('/api/intake/session', {}, { sessionToken: SESSION_TOKEN, csrfToken })
    )

    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(mockMutation).toHaveBeenCalledTimes(1)
  })

  it('separates access revocation from explicit GDPR deletion', async () => {
    const csrfToken = createIntakeCsrfToken({ binding: SESSION_TOKEN })
    const deletionProofExpiresAt = Date.now() + 7 * 24 * 60 * 60_000
    mockMutation.mockResolvedValueOnce({ revoked: true, deletionProofExpiresAt })
    const revoked = await revokeSession(
      new NextRequest('http://localhost:3000/api/intake/session', {
        method: 'DELETE',
        headers: {
          Origin: 'http://localhost:3000',
          Cookie: authorityCookies(csrfToken),
          [INTAKE_CSRF_HEADER]: csrfToken,
          'x-vercel-forwarded-for': '203.0.113.10',
        },
      })
    )
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({ revoked: true })
    const revokeSetCookie = revoked.headers.get('set-cookie') ?? ''
    expect(revokeSetCookie).not.toContain('Max-Age=0')
    expect(revoked.headers.get('set-cookie')).toBeNull()

    mockMutation.mockResolvedValueOnce({ deleted: true })
    const deleted = await deleteIntakeData(
      new NextRequest('http://localhost:3000/api/intake/data', {
        method: 'DELETE',
        headers: {
          Origin: 'http://localhost:3000',
          Cookie: authorityCookies(csrfToken),
          [INTAKE_CSRF_HEADER]: csrfToken,
          'x-vercel-forwarded-for': '203.0.113.10',
        },
      })
    )
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({ deleted: true })
  })

  it.each([
    new ConvexError({
      code: 'BUSINESS_INVALID_STATE',
      message: 'No se puede abrir otra sala temporal en este momento.',
      details: { currentState: 'INTAKE_SESSION_LIMIT' },
    }),
    new ConvexError('Rate limit exceeded'),
  ])('returns 429 for an upstream intake quota instead of reporting an outage', async (error) => {
    mockMutation.mockRejectedValueOnce(error)
    const response = await createOrRotateSession(
      jsonRequest(
        '/api/intake/session',
        { name: 'Empresa demo' },
        {
          csrfToken: createIntakeCsrfToken({ binding: 'BOOTSTRAP' }),
        }
      )
    )
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ code: 'INTAKE_SESSION_LIMIT' })
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('keeps unrelated upstream failures unavailable without exposing their content', async () => {
    mockMutation.mockRejectedValueOnce(
      new ConvexError({
        code: 'BUSINESS_INVALID_STATE',
        message: 'private-upstream-detail',
        details: { currentState: 'SOMETHING_ELSE' },
      })
    )
    const response = await createOrRotateSession(
      jsonRequest(
        '/api/intake/session',
        {},
        {
          csrfToken: createIntakeCsrfToken({ binding: 'BOOTSTRAP' }),
        }
      )
    )
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).not.toContain('private-upstream-detail')
  })

  it('uses the production __Host- cookie contract with no Domain attribute', () => {
    expect(getIntakeSessionCookieName('production')).toBe('__Host-sherlock-intake')
    expect(intakeSessionCookieOptions('production')).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    })
  })
})
