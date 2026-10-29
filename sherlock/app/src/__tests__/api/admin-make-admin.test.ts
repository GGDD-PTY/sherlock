import { createHash } from 'node:crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockRequireApiAuth = vi.fn()
let adminStepUpFresh = true
vi.mock('@/lib/api/with-auth', async () => {
  const { createWithAuthAdminMock } = await import('../mocks/admin-api-auth')
  return createWithAuthAdminMock({
    requireApiAuth: () => mockRequireApiAuth(),
    hasRecentAdminStepUp: () => adminStepUpFresh,
  })
})

const mockGetAuthenticatedConvex = vi.fn()
vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () => mockGetAuthenticatedConvex(),
}))

vi.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitDistributed: vi.fn().mockResolvedValue({
    success: true,
    remaining: 99,
    resetAt: new Date(),
    retryAfterSec: 0,
  }),
  createRateLimitResponse: () =>
    new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429 }),
  getClientIp: () => '127.0.0.1',
  RATE_LIMIT_PRESETS: {
    api: { windowMs: 60_000, maxRequests: 100 },
  },
}))

const mockLog = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => mockLog,
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    users: {
      makeAdmin: 'users.makeAdmin',
    },
  },
}))

import { POST } from '@/app/api/admin/make-admin/route'

const REQUEST_ID = 'request-make-admin-test'

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/make-admin', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-request-id': REQUEST_ID },
  })
}

function createCrossSiteRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/make-admin', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      Origin: 'https://evil.example',
    },
  })
}

function createUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'admin_profile_123',
    email: 'admin@example.com',
    role: 'ADMIN',
    ...overrides,
  }
}

describe('POST /api/admin/make-admin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    adminStepUpFresh = true
  })

  it('rejects cross-site admin mutation attempts before authentication', async () => {
    const response = await POST(createCrossSiteRequest({ email: 'target@example.com' }))
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.error).toBe('Origen no permitido')
    expect(mockRequireApiAuth).not.toHaveBeenCalled()
    expect(mockGetAuthenticatedConvex).not.toHaveBeenCalled()
  })

  it('returns the auth error when the request is unauthenticated', async () => {
    const authError = new Response(JSON.stringify({ error: 'No autorizado' }), { status: 401 })
    mockRequireApiAuth.mockResolvedValue({ user: null, error: authError })

    const response = await POST(createRequest({ email: 'target@example.com' }))

    expect(response.status).toBe(401)
    expect(mockGetAuthenticatedConvex).not.toHaveBeenCalled()
  })

  it('returns 403 for non-admin users', async () => {
    mockRequireApiAuth.mockResolvedValue({
      user: createUser({ role: 'COMPANY' }),
      error: null,
    })

    const response = await POST(createRequest({ email: 'target@example.com' }))
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.error).toBe('No autorizado')
    expect(mockGetAuthenticatedConvex).not.toHaveBeenCalled()
  })

  it('returns 403 when the admin step-up (fresh SSO/Passkey) has expired', async () => {
    adminStepUpFresh = false
    mockRequireApiAuth.mockResolvedValue({
      user: createUser(),
      error: null,
    })

    const response = await POST(createRequest({ email: 'target@example.com' }))
    const body = await response.json()

    expect(response.status).toBe(403)
    expect(body.code).toBe('ADMIN_STEP_UP_REQUIRED')
    expect(mockGetAuthenticatedConvex).not.toHaveBeenCalled()
  })

  it('returns 400 for invalid email input', async () => {
    mockRequireApiAuth.mockResolvedValue({
      user: createUser(),
      error: null,
    })

    const response = await POST(createRequest({ email: 'not-an-email' }))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toEqual({ error: 'Email inválido', requestId: REQUEST_ID })
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mockGetAuthenticatedConvex).not.toHaveBeenCalled()
  })

  it('returns 500 when an authenticated Convex client is unavailable', async () => {
    mockRequireApiAuth.mockResolvedValue({
      user: createUser(),
      error: null,
    })
    mockGetAuthenticatedConvex.mockResolvedValue({ client: null, isAuthenticated: false })

    const response = await POST(createRequest({ email: 'target@example.com' }))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({
      error: 'No se pudo verificar la sesión administrativa',
      requestId: REQUEST_ID,
    })
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('returns the generic envelope with the requestId when the promotion mutation fails', async () => {
    mockRequireApiAuth.mockResolvedValue({
      user: createUser(),
      error: null,
    })
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: { mutation: vi.fn().mockRejectedValue(new Error('convex down')) },
      isAuthenticated: true,
    })

    const response = await POST(createRequest({ email: 'target@example.com' }))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({ error: 'Error al hacer admin al usuario', requestId: REQUEST_ID })
    // El detalle del fallo se queda en el log del servidor.
    expect(JSON.stringify(body)).not.toContain('convex down')
  })

  it('normalizes target email and calls the admin promotion mutation', async () => {
    const mockMutation = vi.fn().mockResolvedValue({
      success: true,
      email: 'target@example.com',
      role: 'ADMIN',
    })
    mockRequireApiAuth.mockResolvedValue({
      user: createUser(),
      error: null,
    })
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: { mutation: mockMutation },
      isAuthenticated: true,
    })

    const response = await POST(createRequest({ email: '  TARGET@Example.COM  ' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      success: true,
      email: 'target@example.com',
      role: 'ADMIN',
      requestId: REQUEST_ID,
    })
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID)
    expect(mockMutation).toHaveBeenCalledWith('users.makeAdmin', {
      email: 'target@example.com',
    })
  })

  it('logs the promotion with the hashed target email, never the address', async () => {
    mockRequireApiAuth.mockResolvedValue({
      user: createUser(),
      error: null,
    })
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: { mutation: vi.fn().mockResolvedValue({ success: true }) },
      isAuthenticated: true,
    })

    await POST(createRequest({ email: 'target@example.com' }))

    expect(mockLog.info).toHaveBeenCalledWith('User promoted to admin', {
      adminUserId: 'admin_profile_123',
      targetEmailHash: createHash('sha256').update('target@example.com').digest('hex'),
    })
    expect(JSON.stringify(mockLog.info.mock.calls)).not.toContain('target@example.com')
  })
})
