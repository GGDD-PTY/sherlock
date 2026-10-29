import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockWithAuth = vi.fn()
const mockRedirect = vi.fn()
const mockGetCurrentAuthenticatedUserState = vi.fn()
const mockGetAuthenticatedConvex = vi.fn()
const mockCookieGet = vi.fn()

vi.mock('@workos-inc/authkit-nextjs', () => ({
  withAuth: () => mockWithAuth(),
}))

vi.mock('@/i18n/navigation', () => ({
  redirect: (opts: { href: string; locale: string }) => {
    mockRedirect(opts)
    throw new Error('REDIRECT')
  },
}))

vi.mock('@/i18n/config', () => ({
  defaultLocale: 'es',
}))

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => mockCookieGet(name),
    }),
}))

vi.mock('@/lib/convex-auth', () => ({
  getCurrentAuthenticatedUserState: (...args: unknown[]) =>
    mockGetCurrentAuthenticatedUserState(...args),
  getAuthenticatedConvex: (...args: unknown[]) => mockGetAuthenticatedConvex(...args),
}))

describe('lib/auth/session.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    process.env.WORKOS_COOKIE_PASSWORD = 'test-cookie-password-with-enough-entropy'
    mockCookieGet.mockReturnValue(undefined)
    mockWithAuth.mockResolvedValue({
      sessionId: 'session_workos_123',
      user: {
        id: 'user_workos_123',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      },
    })
    mockGetCurrentAuthenticatedUserState.mockResolvedValue({
      user: { _id: 'user_convex_123', email: 'test@example.com' },
      profile: { _id: 'profile_123', role: 'COMPANY' },
    })
    mockGetAuthenticatedConvex.mockResolvedValue(null)
  })

  describe('requireAuth', () => {
    it('redirects to sign-in when WorkOS has no user', async () => {
      mockWithAuth.mockResolvedValue({ user: null })

      const { requireAuth } = await import('@/lib/auth/session')

      await expect(requireAuth()).rejects.toThrow('REDIRECT')
      expect(mockRedirect).toHaveBeenCalledWith({ href: '/sign-in', locale: 'es' })
    })

    it('redirects to custom path when specified', async () => {
      mockWithAuth.mockResolvedValue({ user: null })

      const { requireAuth } = await import('@/lib/auth/session')

      await expect(requireAuth('/custom-signin')).rejects.toThrow('REDIRECT')
      expect(mockRedirect).toHaveBeenCalledWith({ href: '/custom-signin', locale: 'es' })
    })

    it('redirects to sign-in when WorkOS withAuth throws', async () => {
      mockWithAuth.mockRejectedValue(new Error('AuthKit unavailable'))

      const { requireAuth } = await import('@/lib/auth/session')

      await expect(requireAuth()).rejects.toThrow('REDIRECT')
      expect(mockRedirect).toHaveBeenCalledWith({ href: '/sign-in', locale: 'es' })
    })

    it('uses redirectTo when WorkOS withAuth throws', async () => {
      mockWithAuth.mockRejectedValue(new Error('AuthKit unavailable'))

      const { requireAuth } = await import('@/lib/auth/session')

      await expect(requireAuth('/custom-signin')).rejects.toThrow('REDIRECT')
      expect(mockRedirect).toHaveBeenCalledWith({ href: '/custom-signin', locale: 'es' })
    })

    it('redirects to sign-in with no-email when the WorkOS user has no email', async () => {
      mockWithAuth.mockResolvedValue({
        sessionId: 'session_workos_123',
        user: {
          id: 'user_workos_123',
          email: '',
          firstName: 'Test',
          lastName: 'User',
        },
      })

      const { requireAuth } = await import('@/lib/auth/session')

      await expect(requireAuth()).rejects.toThrow('REDIRECT')
      expect(mockRedirect).toHaveBeenCalledWith({
        href: '/sign-in?error=no-email',
        locale: 'es',
      })
    })

    it('redirects to onboarding when Convex auth state cannot be resolved', async () => {
      mockGetCurrentAuthenticatedUserState.mockResolvedValue(null)

      const { requireAuth } = await import('@/lib/auth/session')

      await expect(requireAuth()).rejects.toThrow('REDIRECT')
      expect(mockRedirect).toHaveBeenCalledWith({
        href: '/onboarding?error=profile-fetch-failed',
        locale: 'es',
      })
    })

    it('returns AuthUser when WorkOS and Convex profile are available', async () => {
      const { requireAuth } = await import('@/lib/auth/session')

      const user = await requireAuth()

      expect(user).toMatchObject({
        id: 'user_workos_123',
        email: 'test@example.com',
        name: 'Test User',
        profileId: 'profile_123',
        role: 'COMPANY',
        effectiveRole: 'COMPANY',
      })
    })

    it('redirects when the Convex profile is inactive', async () => {
      mockGetCurrentAuthenticatedUserState.mockResolvedValue({
        user: { _id: 'user_convex_123', email: 'test@example.com' },
        profile: { _id: 'profile_123', role: 'COMPANY', isActive: false },
      })

      const { requireAuth } = await import('@/lib/auth/session')

      await expect(requireAuth()).rejects.toThrow('REDIRECT')
      expect(mockRedirect).toHaveBeenCalledWith({
        href: '/sign-in?error=account-inactive',
        locale: 'es',
      })
    })

    it.each([
      [
        '/my-company/documents?handoff=938c27d4-b16f-4087-b191-4fcb7c348959',
        '&handoff=938c27d4-b16f-4087-b191-4fcb7c348959',
      ],
      ['/my-company/documents?handoff=invalid', ''],
      ['/admin?handoff=938c27d4-b16f-4087-b191-4fcb7c348959', ''],
    ])('preserves only a documents intake nonce during first login: %s', async (path, suffix) => {
      mockGetCurrentAuthenticatedUserState.mockResolvedValue({ user: null, profile: null })
      const { requireAuth } = await import('@/lib/auth/session')
      await expect(requireAuth(path)).rejects.toThrow('REDIRECT')
      expect(mockRedirect).toHaveBeenCalledWith({
        href: `/onboarding?error=needs-profile${suffix}`,
        locale: 'es',
      })
    })

    it('redirects to onboarding when WorkOS session has no local Convex profile', async () => {
      mockGetCurrentAuthenticatedUserState.mockResolvedValue({
        user: null,
        profile: null,
      })

      const { requireAuth } = await import('@/lib/auth/session')

      await expect(requireAuth()).rejects.toThrow('REDIRECT')
      expect(mockRedirect).toHaveBeenCalledWith({
        href: '/onboarding?error=needs-profile',
        locale: 'es',
      })
    })
  })

  describe('requireWorkosSession', () => {
    it('returns needsProfile:true without redirecting when the local profile is missing', async () => {
      mockGetCurrentAuthenticatedUserState.mockResolvedValue({
        user: null,
        profile: null,
      })

      const { requireWorkosSession } = await import('@/lib/auth/session')

      const user = await requireWorkosSession('es')

      expect(mockRedirect).not.toHaveBeenCalled()
      expect(user).toMatchObject({
        id: 'user_workos_123',
        email: 'test@example.com',
        profileId: null,
        role: null,
        effectiveRole: null,
        needsProfile: true,
        isViewingAs: false,
        viewAsRole: null,
        impersonateUserId: null,
      })
    })

    it('returns the populated active user when a Convex profile already exists', async () => {
      const { requireWorkosSession } = await import('@/lib/auth/session')

      const user = await requireWorkosSession('es')

      expect(mockRedirect).not.toHaveBeenCalled()
      expect(user).toMatchObject({
        id: 'user_workos_123',
        email: 'test@example.com',
        profileId: 'profile_123',
        role: 'COMPANY',
        effectiveRole: 'COMPANY',
        needsProfile: false,
      })
    })

    it('redirects to sign-in with account-inactive when the profile is inactive', async () => {
      mockGetCurrentAuthenticatedUserState.mockResolvedValue({
        user: { _id: 'user_convex_123', email: 'test@example.com' },
        profile: { _id: 'profile_123', role: 'COMPANY', isActive: false },
      })

      const { requireWorkosSession } = await import('@/lib/auth/session')

      await expect(requireWorkosSession('es')).rejects.toThrow('REDIRECT')
      expect(mockRedirect).toHaveBeenCalledWith({
        href: '/sign-in?error=account-inactive',
        locale: 'es',
      })
    })

    it('keeps the existing onboarding recovery redirect when the backend profile fetch fails', async () => {
      mockGetCurrentAuthenticatedUserState.mockResolvedValue(null)

      const { requireWorkosSession } = await import('@/lib/auth/session')

      await expect(requireWorkosSession('es')).rejects.toThrow('REDIRECT')
      expect(mockRedirect).toHaveBeenCalledWith({
        href: '/onboarding?error=profile-fetch-failed',
        locale: 'es',
      })
    })
  })

  describe('requireRole', () => {
    it('allows user with matching role', async () => {
      const { requireRole } = await import('@/lib/auth/session')

      const user = await requireRole(['COMPANY'])

      expect(user.role).toBe('COMPANY')
    })

    it('redirects when role is not allowed', async () => {
      const { requireRole } = await import('@/lib/auth/session')

      // La casa del rol, sin query: `/dashboard?error=unauthorized` se fue con
      // la ruta y nadie leía ese parámetro ([F] 2026-09-07 09:00).
      await expect(requireRole(['ADMIN'])).rejects.toThrow('REDIRECT')
      expect(mockRedirect).toHaveBeenCalledWith({
        href: '/my-company/documents',
        locale: 'es',
      })
    })

    it('redirects admin when WorkOS has no recent step-up marker', async () => {
      mockGetCurrentAuthenticatedUserState.mockResolvedValue({
        user: { _id: 'user_convex_123', email: 'admin@example.com' },
        profile: { _id: 'profile_admin', role: 'ADMIN' },
      })

      const { requireRole } = await import('@/lib/auth/session')

      await expect(requireRole(['ADMIN'])).rejects.toThrow('REDIRECT')
      expect(mockRedirect).toHaveBeenCalledWith({
        href: '/settings?error=admin-mfa-required',
        locale: 'es',
      })
    })

    it('allows admin when WorkOS has a recent step-up marker', async () => {
      mockGetCurrentAuthenticatedUserState.mockResolvedValue({
        user: { _id: 'user_convex_123', email: 'admin@example.com' },
        profile: { _id: 'profile_admin', role: 'ADMIN' },
      })
      const { ADMIN_STEP_UP_COOKIE_NAME, createAdminStepUpCookieValue } =
        await import('@/lib/auth/admin-step-up')
      const marker = createAdminStepUpCookieValue('SSO', {
        subject: 'user_workos_123',
        sessionId: 'session_workos_123',
      })
      mockCookieGet.mockImplementation((name: string) =>
        name === ADMIN_STEP_UP_COOKIE_NAME ? { value: marker } : undefined
      )

      const { requireRole } = await import('@/lib/auth/session')

      const user = await requireRole(['ADMIN'])

      expect(user.role).toBe('ADMIN')
    })

    it('keeps view-as effectiveRole after admin step-up in requireRole', async () => {
      mockGetCurrentAuthenticatedUserState.mockResolvedValue({
        user: { _id: 'user_convex_123', email: 'admin@example.com' },
        profile: { _id: 'profile_admin', role: 'ADMIN' },
      })
      const { ADMIN_STEP_UP_COOKIE_NAME, createAdminStepUpCookieValue } =
        await import('@/lib/auth/admin-step-up')
      const { VIEW_AS_COOKIE_NAME } = await import('@/stores/useViewAsStore')
      const marker = createAdminStepUpCookieValue('SSO', {
        subject: 'user_workos_123',
        sessionId: 'session_workos_123',
      })
      mockCookieGet.mockImplementation((name: string) => {
        if (name === ADMIN_STEP_UP_COOKIE_NAME) return { value: marker }
        if (name === VIEW_AS_COOKIE_NAME) return { value: 'COMPANY' }
        return undefined
      })

      const { requireRole } = await import('@/lib/auth/session')

      const user = await requireRole(['ADMIN'])

      expect(user.role).toBe('ADMIN')
      expect(user.effectiveRole).toBe('COMPANY')
      expect(user.isViewingAs).toBe(true)
      expect(user.viewAsRole).toBe('COMPANY')
    })
  })

  describe('view-as boundary', () => {
    // ES: Las cookies sherlock_view_as / sherlock_impersonate SOLO deben tener
    // efecto para un ADMIN real y solo permiten la vista de empresa.
    function mockViewAsCookies(values: Record<string, string>) {
      mockCookieGet.mockImplementation((name: string) =>
        name in values ? { value: values[name] } : undefined
      )
    }

    function mockProfileRole(role: 'COMPANY' | 'ADMIN') {
      mockGetCurrentAuthenticatedUserState.mockResolvedValue({
        user: { _id: 'user_convex_123', email: 'test@example.com' },
        profile: { _id: 'profile_123', role },
      })
    }

    it('uses the cookie names the store writes (guards against silent drift)', async () => {
      const { VIEW_AS_COOKIE_NAME, IMPERSONATE_COOKIE_NAME } =
        await import('@/stores/useViewAsStore')

      expect(VIEW_AS_COOKIE_NAME).toBe('sherlock_view_as')
      expect(IMPERSONATE_COOKIE_NAME).toBe('sherlock_impersonate')
    })

    it('ignores a forged view-as cookie for a COMPANY user', async () => {
      mockProfileRole('COMPANY')
      mockViewAsCookies({ sherlock_view_as: 'INVESTOR' })

      const { requireAuth } = await import('@/lib/auth/session')

      const user = await requireAuth()

      expect(user.role).toBe('COMPANY')
      expect(user.effectiveRole).toBe('COMPANY')
      expect(user.isViewingAs).toBe(false)
      expect(user.viewAsRole).toBeNull()
    })

    it('ignores a forged view-as cookie for a COMPANY user', async () => {
      mockProfileRole('COMPANY')
      mockViewAsCookies({ sherlock_view_as: 'ADMIN' })

      const { requireAuth } = await import('@/lib/auth/session')

      const user = await requireAuth()

      expect(user.role).toBe('COMPANY')
      expect(user.effectiveRole).toBe('COMPANY')
      expect(user.isViewingAs).toBe(false)
      expect(user.viewAsRole).toBeNull()
    })

    it('ignores a forged impersonate cookie for a non-admin user', async () => {
      mockProfileRole('COMPANY')
      mockViewAsCookies({ sherlock_impersonate: 'profile_victim' })

      const { requireAuth } = await import('@/lib/auth/session')

      const user = await requireAuth()

      expect(user.effectiveRole).toBe('COMPANY')
      expect(user.impersonateUserId).toBeNull()
    })

    it('honors the view-as cookie for a real ADMIN without overwriting the real role', async () => {
      mockProfileRole('ADMIN')
      mockViewAsCookies({ sherlock_view_as: 'COMPANY', sherlock_impersonate: 'profile_target' })

      const { requireAuth } = await import('@/lib/auth/session')

      const user = await requireAuth()

      expect(user.role).toBe('ADMIN')
      expect(user.effectiveRole).toBe('COMPANY')
      expect(user.isViewingAs).toBe(true)
      expect(user.viewAsRole).toBe('COMPANY')
      expect(user.impersonateUserId).toBe('profile_target')
    })

    it.each(['ADMIN', 'INVESTOR', '../', '', 'investor', 'INVESTOR;COMPANY'])(
      'rejects the unsupported view-as cookie value %j for an ADMIN',
      async (value) => {
        mockProfileRole('ADMIN')
        mockViewAsCookies({ sherlock_view_as: value })

        const { requireAuth } = await import('@/lib/auth/session')

        const user = await requireAuth()

        expect(user.effectiveRole).toBe('ADMIN')
        expect(user.viewAsRole).toBeNull()
        expect(user.isViewingAs).toBe(false)
      }
    )

    it('applies the same boundary in getCurrentUser', async () => {
      mockProfileRole('COMPANY')
      mockViewAsCookies({ sherlock_view_as: 'INVESTOR' })

      const { getCurrentUser } = await import('@/lib/auth/session')

      const user = await getCurrentUser()

      expect(user?.effectiveRole).toBe('COMPANY')
      expect(user?.isViewingAs).toBe(false)
    })
  })

  describe('getCurrentUser', () => {
    it('returns null when WorkOS has no user', async () => {
      mockWithAuth.mockResolvedValue({ user: null })

      const { getCurrentUser } = await import('@/lib/auth/session')

      await expect(getCurrentUser()).resolves.toBeNull()
    })

    it('returns AuthUser when authenticated with profile', async () => {
      const { getCurrentUser } = await import('@/lib/auth/session')

      const user = await getCurrentUser()

      expect(user?.id).toBe('user_workos_123')
      expect(user?.role).toBe('COMPANY')
    })

    it('returns null when the Convex profile is inactive', async () => {
      mockGetCurrentAuthenticatedUserState.mockResolvedValue({
        user: { _id: 'user_convex_123', email: 'test@example.com' },
        profile: { _id: 'profile_123', role: 'COMPANY', isActive: false },
      })

      const { getCurrentUser } = await import('@/lib/auth/session')

      await expect(getCurrentUser()).resolves.toBeNull()
    })
  })

  it('resolves the fixed company login to its real profile when using a local backend', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_BYPASS_AUTH', 'true')
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210')
    vi.stubEnv('NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY', 'local-only-key')
    mockCookieGet.mockImplementation((name: string) => {
      if (name === 'sherlock_dev_user') return { value: 'dev_company_001' }
      if (name === 'sherlock_dev_role') return { value: 'COMPANY' }
      return undefined
    })
    try {
      const { requireAuth } = await import('@/lib/auth/session')
      const user = await requireAuth()
      expect(user.profileId).toBe('profile_123')
      expect(user.email).toBe('company@dev.local')
      expect(mockGetCurrentAuthenticatedUserState).toHaveBeenCalledWith({ requireConvexAuth: true })
      expect(mockWithAuth).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('pairs the company profile with the selected role for a local admin cookie', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_BYPASS_AUTH', 'true')
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210')
    vi.stubEnv('NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY', 'local-key')
    mockCookieGet.mockImplementation((name: string) => {
      if (name === 'sherlock_dev_user') return { value: 'dev_admin_001' }
      if (name === 'sherlock_dev_role') return { value: 'COMPANY' }
      return undefined
    })
    mockGetCurrentAuthenticatedUserState.mockResolvedValue({
      user: { _id: 'company_user' },
      profile: { _id: 'company_profile', role: 'COMPANY' },
    })
    try {
      const { requireAuth } = await import('@/lib/auth/session')
      const user = await requireAuth()
      expect(user).toMatchObject({
        id: 'dev_company_001',
        email: 'company@dev.local',
        profileId: 'company_profile',
        role: 'ADMIN',
        effectiveRole: 'COMPANY',
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
