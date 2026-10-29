// ============================================================================
// API WITH-AUTH WRAPPER UNIT TESTS
// ============================================================================
// Tests for API authentication wrapper functions
// Covers: requireApiAuth, requireApiAuthWithRole, admin step-up
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Id } from '@/../convex/_generated/dataModel'

// ===== MOCK AUTH =====
const mockAuth = vi.fn()
vi.mock('@/lib/auth/auth', () => ({
  auth: () => mockAuth(),
}))

// ===== MOCK AUTHENTICATED CONVEX USER STATE =====
const mockGetCurrentAuthenticatedUserState = vi.fn()
vi.mock('@/lib/convex-auth', () => ({
  getCurrentAuthenticatedUserState: (...args: unknown[]) =>
    mockGetCurrentAuthenticatedUserState(...args),
}))

// ===== MOCK NEXT COOKIES (step-up de admin) =====
const mockCookieJar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = mockCookieJar.get(name)
      return value === undefined ? undefined : { name, value }
    },
  }),
}))

// ===== MOCK NEXT RESPONSE =====
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => ({
      body,
      status: init?.status || 200,
    }),
  },
}))

function createCurrentUserState(
  overrides?: Partial<{
    user: { _id: string; email: string }
    profile: {
      _id: string
      role: 'COMPANY' | 'ADMIN'
      isActive?: boolean
    }
  }>
) {
  return {
    user: {
      _id: 'db_user_id',
      email: 'test@example.com',
      ...(overrides?.user || {}),
    },
    profile: {
      _id: 'profile_id',
      role: 'COMPANY' as const,
      ...(overrides?.profile || {}),
    },
  }
}

describe('lib/api/with-auth.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    mockCookieJar.clear()
  })

  // ============================================================================
  // requireApiAuth TESTS
  // ============================================================================
  describe('requireApiAuth', () => {
    // ===== TEST: RETURNS USER WHEN AUTHENTICATED =====
    it('returns user when session is valid', async () => {
      mockAuth.mockResolvedValue({
        user: {
          id: 'user_123',
          email: 'test@example.com',
          name: 'Test User',
        },
      })
      mockGetCurrentAuthenticatedUserState.mockResolvedValue(createCurrentUserState())

      const { requireApiAuth } = await import('@/lib/api/with-auth')

      const result = await requireApiAuth()

      expect(result.user).not.toBeNull()
      expect(result.error).toBeNull()
      expect(result.user?.id).toBe('user_123')
      expect(result.user?.email).toBe('test@example.com')
      expect(result.user?.role).toBe('COMPANY')
    })

    // ===== TEST: RETURNS ERROR WHEN NO SESSION =====
    it('returns 401 error when no session', async () => {
      mockAuth.mockResolvedValue(null)

      const { requireApiAuth } = await import('@/lib/api/with-auth')

      const result = await requireApiAuth()

      expect(result.user).toBeNull()
      expect(result.error).not.toBeNull()
      expect(result.error?.status).toBe(401)
    })

    // ===== TEST: RETURNS ERROR WHEN NO USER ID =====
    it('returns 401 error when session has no user id', async () => {
      mockAuth.mockResolvedValue({ user: null })

      const { requireApiAuth } = await import('@/lib/api/with-auth')

      const result = await requireApiAuth()

      expect(result.user).toBeNull()
      expect(result.error?.status).toBe(401)
    })

    // ===== TEST: FAILS CLOSED WHEN PROFILE IS MISSING =====
    it('returns 403 when profile is not synchronized', async () => {
      mockAuth.mockResolvedValue({
        user: {
          id: 'user_123',
          email: 'test@example.com',
        },
      })
      mockGetCurrentAuthenticatedUserState.mockResolvedValue({
        user: { _id: 'db_user_id', email: 'test@example.com' },
        profile: null,
      })

      const { requireApiAuth } = await import('@/lib/api/with-auth')

      const result = await requireApiAuth()

      expect(result.user).toBeNull()
      expect(result.error?.status).toBe(403)
    })

    // ===== TEST: FAILS CLOSED WHEN AUTH STATE CANNOT BE VERIFIED =====
    it('returns 500 when authenticated user state cannot be resolved', async () => {
      mockAuth.mockResolvedValue({
        user: {
          id: 'user_123',
          email: 'test@example.com',
        },
      })
      mockGetCurrentAuthenticatedUserState.mockResolvedValue(null)

      const { requireApiAuth } = await import('@/lib/api/with-auth')

      const result = await requireApiAuth()

      expect(result.user).toBeNull()
      expect(result.error?.status).toBe(500)
    })

    // ===== TEST: RETURNS 500 ON AUTH ERROR =====
    it('returns 500 error on auth exception', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockAuth.mockRejectedValue(new Error('Auth service down'))

      const { requireApiAuth } = await import('@/lib/api/with-auth')

      const result = await requireApiAuth()

      expect(result.user).toBeNull()
      expect(result.error?.status).toBe(500)

      errorSpy.mockRestore()
    })

    // ===== TEST: INCLUDES PROFILE ID =====
    it('includes profileId when profile is found', async () => {
      mockAuth.mockResolvedValue({
        user: {
          id: 'user_123',
          email: 'test@example.com',
        },
      })
      mockGetCurrentAuthenticatedUserState.mockResolvedValue(
        createCurrentUserState({
          profile: { _id: 'profile_abc', role: 'ADMIN' },
        })
      )

      const { requireApiAuth } = await import('@/lib/api/with-auth')

      const result = await requireApiAuth()

      expect(result.user?.profileId).toBe('profile_abc')
    })

    it('returns 403 when the profile is inactive', async () => {
      mockAuth.mockResolvedValue({
        user: {
          id: 'user_123',
          email: 'test@example.com',
        },
      })
      mockGetCurrentAuthenticatedUserState.mockResolvedValue(
        createCurrentUserState({
          profile: { _id: 'profile_abc', role: 'COMPANY', isActive: false },
        })
      )

      const { requireApiAuth } = await import('@/lib/api/with-auth')

      const result = await requireApiAuth()

      expect(result.user).toBeNull()
      expect(result.error?.status).toBe(403)
      expect(result.error?.body).toEqual({ error: 'Cuenta desactivada' })
    })
  })

  // ============================================================================
  // requireApiAuthWithRole TESTS
  // ============================================================================
  describe('requireApiAuthWithRole', () => {
    // ===== TEST: ALLOWS MATCHING ROLE =====
    it('allows user with matching role', async () => {
      mockAuth.mockResolvedValue({
        user: {
          id: 'admin_123',
          email: 'admin@example.com',
        },
      })
      mockGetCurrentAuthenticatedUserState.mockResolvedValue(
        createCurrentUserState({
          user: { _id: 'db_user_id', email: 'admin@example.com' },
          profile: { _id: 'profile_id', role: 'ADMIN' },
        })
      )

      const { requireApiAuthWithRole } = await import('@/lib/api/with-auth')

      const result = await requireApiAuthWithRole(['ADMIN'])

      expect(result.user).not.toBeNull()
      expect(result.error).toBeNull()
    })

    // ===== TEST: ALLOWS ONE OF MULTIPLE ROLES =====
    it('allows user when role is in allowed list', async () => {
      mockAuth.mockResolvedValue({
        user: {
          id: 'company_123',
          email: 'company@example.com',
        },
      })
      mockGetCurrentAuthenticatedUserState.mockResolvedValue(
        createCurrentUserState({
          user: { _id: 'db_user_id', email: 'company@example.com' },
          profile: { _id: 'profile_id', role: 'COMPANY' },
        })
      )

      const { requireApiAuthWithRole } = await import('@/lib/api/with-auth')

      const result = await requireApiAuthWithRole(['ADMIN', 'COMPANY'])

      expect(result.user).not.toBeNull()
      expect(result.error).toBeNull()
    })

    // ===== TEST: REJECTS NON-MATCHING ROLE =====
    it('returns 403 when role is not in allowed list', async () => {
      mockAuth.mockResolvedValue({
        user: {
          id: 'investor_123',
          email: 'guest@example.com',
        },
      })
      mockGetCurrentAuthenticatedUserState.mockResolvedValue(
        createCurrentUserState({
          user: { _id: 'db_user_id', email: 'guest@example.com' },
          profile: { _id: 'profile_id', role: 'COMPANY' },
        })
      )

      const { requireApiAuthWithRole } = await import('@/lib/api/with-auth')

      const result = await requireApiAuthWithRole(['ADMIN'])

      expect(result.user).toBeNull()
      expect(result.error?.status).toBe(403)
    })

    // ===== TEST: PROPAGATES 401 ERROR =====
    it('propagates 401 error when not authenticated', async () => {
      mockAuth.mockResolvedValue(null)

      const { requireApiAuthWithRole } = await import('@/lib/api/with-auth')

      const result = await requireApiAuthWithRole(['ADMIN'])

      expect(result.user).toBeNull()
      expect(result.error?.status).toBe(401)
    })
  })

  // ============================================================================
  // requireAdminApiAuth TESTS (rol ADMIN + step-up fresco)
  // ============================================================================
  describe('requireAdminApiAuth', () => {
    const ADMIN_STEP_UP_SECRET = 'admin-step-up-secret-for-tests-0123456789'
    const ADMIN_SESSION = { subject: 'admin_123', sessionId: 'session_admin_123' }

    async function setAdminSession() {
      mockAuth.mockResolvedValue({
        sessionId: ADMIN_SESSION.sessionId,
        user: { id: 'admin_123', email: 'admin@example.com' },
      })
      mockGetCurrentAuthenticatedUserState.mockResolvedValue(
        createCurrentUserState({
          user: { _id: 'db_user_id', email: 'admin@example.com' },
          profile: { _id: 'profile_id', role: 'ADMIN' },
        })
      )
    }

    async function setStepUpCookie(issuedAtMs: number, method = 'SSO') {
      const { ADMIN_STEP_UP_COOKIE_NAME, createAdminStepUpCookieValue } =
        await import('@/lib/auth/admin-step-up')
      const value = createAdminStepUpCookieValue(method, ADMIN_SESSION, issuedAtMs)
      expect(value).not.toBeNull()
      mockCookieJar.set(ADMIN_STEP_UP_COOKIE_NAME, value as string)
    }

    beforeEach(() => {
      process.env.WORKOS_ADMIN_STEP_UP_COOKIE_SECRET = ADMIN_STEP_UP_SECRET
      delete process.env.WORKOS_ADMIN_STEP_UP_METHODS
    })

    afterEach(() => {
      delete process.env.WORKOS_ADMIN_STEP_UP_COOKIE_SECRET
      delete process.env.WORKOS_ADMIN_STEP_UP_METHODS
    })

    // ===== TEST: ADMIN CON STEP-UP FRESCO =====
    it('returns the admin user when the step-up cookie is fresh', async () => {
      await setAdminSession()
      await setStepUpCookie(Date.now())

      const { requireAdminApiAuth } = await import('@/lib/api/with-auth')

      const result = await requireAdminApiAuth()

      expect(result.error).toBeNull()
      expect(result.user?.role).toBe('ADMIN')
    })

    // ===== TEST: STEP-UP VENCIDO =====
    // La edad se deriva de la ventana vigente: un número fijo aquí se pone rojo
    // (o, peor, verde por accidente) cada vez que la ventana se mueve.
    it('returns 403 ADMIN_STEP_UP_REQUIRED when the step-up cookie expired', async () => {
      await setAdminSession()
      const { ADMIN_STEP_UP_MAX_AGE_SECONDS } = await import('@/lib/auth/admin-step-up')
      await setStepUpCookie(Date.now() - (ADMIN_STEP_UP_MAX_AGE_SECONDS * 1000 + 60_000))

      const { requireAdminApiAuth } = await import('@/lib/api/with-auth')

      const result = await requireAdminApiAuth()

      expect(result.user).toBeNull()
      expect(result.error?.status).toBe(403)
      expect((result.error as unknown as { body: { code: string } }).body.code).toBe(
        'ADMIN_STEP_UP_REQUIRED'
      )
    })

    // ===== TEST: SIN COOKIE DE STEP-UP =====
    it('returns 403 when no step-up cookie is present', async () => {
      await setAdminSession()

      const { requireAdminApiAuth } = await import('@/lib/api/with-auth')

      const result = await requireAdminApiAuth()

      expect(result.user).toBeNull()
      expect(result.error?.status).toBe(403)
      expect((result.error as unknown as { body: { code: string } }).body.code).toBe(
        'ADMIN_STEP_UP_REQUIRED'
      )
    })

    // ===== TEST: MÉTODO DE AUTENTICACIÓN NO PERMITIDO =====
    it('returns 403 when the step-up cookie was issued by a weak method', async () => {
      await setAdminSession()
      const { createAdminStepUpCookieValue, ADMIN_STEP_UP_COOKIE_NAME } =
        await import('@/lib/auth/admin-step-up')
      // Cookie firmada para "Password", método fuera de la lista permitida.
      process.env.WORKOS_ADMIN_STEP_UP_METHODS = 'Password'
      const weakCookie = createAdminStepUpCookieValue('Password', ADMIN_SESSION, Date.now())
      process.env.WORKOS_ADMIN_STEP_UP_METHODS = 'SSO,Passkey'
      mockCookieJar.set(ADMIN_STEP_UP_COOKIE_NAME, weakCookie as string)

      const { requireAdminApiAuth } = await import('@/lib/api/with-auth')

      const result = await requireAdminApiAuth()

      expect(result.user).toBeNull()
      expect(result.error?.status).toBe(403)
    })

    // ===== TEST: NO-ADMIN NUNCA LLEGA AL STEP-UP =====
    it('returns 403 for non-admin roles even with a fresh step-up cookie', async () => {
      mockAuth.mockResolvedValue({
        user: { id: 'investor_123', email: 'investor@example.com' },
      })
      mockGetCurrentAuthenticatedUserState.mockResolvedValue(
        createCurrentUserState({
          user: { _id: 'db_user_id', email: 'guest@example.com' },
          profile: { _id: 'profile_id', role: 'COMPANY' },
        })
      )
      await setStepUpCookie(Date.now())

      const { requireAdminApiAuth } = await import('@/lib/api/with-auth')

      const result = await requireAdminApiAuth()

      expect(result.user).toBeNull()
      expect(result.error?.status).toBe(403)
      expect((result.error as unknown as { body: { error: string } }).body.error).toBe(
        'No autorizado'
      )
    })

    // ===== TEST: SESIÓN INVÁLIDA SE PROPAGA =====
    it('propagates the 401 from requireApiAuth when unauthenticated', async () => {
      mockAuth.mockResolvedValue(null)

      const { requireAdminApiAuth } = await import('@/lib/api/with-auth')

      const result = await requireAdminApiAuth()

      expect(result.user).toBeNull()
      expect(result.error?.status).toBe(401)
    })

    it('requires step-up only when a mixed-role route caller is an admin', async () => {
      await setAdminSession()
      const { requireAdminApiStepUp } = await import('@/lib/api/with-auth')
      const admin = {
        id: 'admin_123',
        email: 'admin@example.com',
        role: 'ADMIN' as const,
        profileId: 'profile_id' as Id<'profiles'>,
        sessionId: ADMIN_SESSION.sessionId,
      }
      const company = { ...admin, role: 'COMPANY' as const }

      expect((await requireAdminApiStepUp(admin))?.status).toBe(403)
      expect(await requireAdminApiStepUp(company)).toBeNull()

      await setStepUpCookie(Date.now())
      expect(await requireAdminApiStepUp(admin)).toBeNull()
    })
  })

  // ============================================================================
  // TYPE EXPORTS
  // ============================================================================
  describe('Type exports', () => {
    // ===== TEST: EXPORTS ApiUser TYPE =====
    it('exports ApiUser interface', async () => {
      const withAuth = await import('@/lib/api/with-auth')

      // Type check via function result
      const result = await withAuth.requireApiAuth()

      if (result.user) {
        // These should all be valid properties
        expect(typeof result.user.id).toBe('string')
        expect(typeof result.user.email).toBe('string')
        expect(typeof result.user.role).toBe('string')
      }
    })
  })
})
