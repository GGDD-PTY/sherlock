import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockMutation = vi.fn()
const mockGetUnauthenticatedConvex = vi.fn()
const mockRateLimit = vi.fn()

vi.mock('@/lib/convex-auth', () => ({
  getUnauthenticatedConvex: () => mockGetUnauthenticatedConvex(),
}))
vi.mock('@/lib/utils/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/rate-limit')>()
  return {
    ...actual,
    checkRateLimitDistributed: (...args: unknown[]) => mockRateLimit(...args),
  }
})

import { GET, POST } from '@/app/api/intake/support/route'
import {
  createIntakeCsrfToken,
  getIntakeCsrfCookieName,
  INTAKE_CSRF_HEADER,
} from '@/lib/intake/csrf'
import { getIntakeSessionCookieName } from '@/lib/intake/session'

const SECRET = 'intake-support-api-secret-for-tests-123456'
const AUDIENCE = 'sherlock-test:intake-support-api'
const SESSION_TOKEN = 't'.repeat(43)

function request(method: 'GET' | 'POST', body?: unknown, origin = 'http://localhost:3000') {
  const csrf = createIntakeCsrfToken({ binding: SESSION_TOKEN })
  return new NextRequest('http://localhost:3000/api/intake/support', {
    method,
    headers: {
      Origin: origin,
      Cookie: `${getIntakeSessionCookieName()}=${SESSION_TOKEN}; ${getIntakeCsrfCookieName()}=${csrf}`,
      ...(method === 'POST'
        ? { 'Content-Type': 'application/json', [INTAKE_CSRF_HEADER]: csrf }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe('temporary intake support API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('INTAKE_DEMO_MODE', 'true')
    vi.stubEnv('INTAKE_SERVER_SECRET', SECRET)
    vi.stubEnv('INTAKE_SERVER_AUDIENCE', AUDIENCE)
    mockGetUnauthenticatedConvex.mockReturnValue({ mutation: mockMutation })
    mockRateLimit.mockResolvedValue({
      success: true,
      remaining: 10,
      resetAt: new Date(Date.now() + 60_000),
      retryAfterSec: 0,
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns a bounded support projection without browser authority', async () => {
    mockMutation.mockResolvedValueOnce({
      threadId: 'support_thread_1',
      truncated: false,
      messages: [
        {
          messageId: 'support_message_1',
          sequence: 1,
          authorKind: 'ADMIN',
          body: 'Hola, ¿en qué te ayudamos?',
          createdAt: 1_900_000_000_000,
        },
      ],
    })

    const response = await GET(request('GET'))
    const result = await response.json()

    expect(response.status).toBe(200)
    expect(result.messages).toEqual([expect.objectContaining({ authorKind: 'ADMIN' })])
    expect(JSON.stringify(result)).not.toContain(SESSION_TOKEN)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mockMutation).toHaveBeenCalledWith(expect.anything(), {
      sessionToken: SESSION_TOKEN,
      serverIssuedAt: expect.any(Number),
      proofNonce: expect.any(String),
      serverProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
  })

  it('normalizes and sends text through the support server-proof boundary', async () => {
    mockMutation.mockResolvedValueOnce({
      threadId: 'support_thread_1',
      message: {
        messageId: 'support_message_1',
        sequence: 1,
        authorKind: 'INTAKE',
        body: 'Necesito ayuda',
        createdAt: 1_900_000_000_000,
      },
    })

    const response = await POST(request('POST', { body: '  Necesito ayuda  ' }))

    expect(response.status).toBe(201)
    expect(mockMutation).toHaveBeenCalledWith(expect.anything(), {
      sessionToken: SESSION_TOKEN,
      body: 'Necesito ayuda',
      serverIssuedAt: expect.any(Number),
      proofNonce: expect.any(String),
      serverProof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
  })

  it('rejects cross-origin writes before Convex effects', async () => {
    const response = await POST(request('POST', { body: 'Ataque' }, 'https://attacker.example'))

    expect(response.status).toBe(403)
    expect(mockMutation).not.toHaveBeenCalled()
  })
})
