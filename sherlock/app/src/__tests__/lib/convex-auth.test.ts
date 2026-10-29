import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockWithAuth = vi.fn()

vi.mock('@workos-inc/authkit-nextjs', () => ({
  withAuth: () => mockWithAuth(),
}))

const mockSetAuth = vi.fn()
const mockSetAdminAuth = vi.fn()
const mockCookieGet = vi.fn()
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mockCookieGet }) }))
const mockClientQuery = vi.fn()
const mockClientMutation = vi.fn()

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class MockConvexHttpClient {
    setAuth = mockSetAuth
    setAdminAuth = mockSetAdminAuth
    query = mockClientQuery
    mutation = mockClientMutation
  },
}))

describe('lib/convex-auth.ts', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_CONVEX_URL: 'https://test.convex.cloud',
    }
    mockWithAuth.mockResolvedValue({
      user: {
        id: 'user_workos_123',
        email: 'ada@example.com',
      },
      accessToken: 'workos_access_token_for_tests',
    })
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('getAuthenticatedConvex', () => {
    it('returns null when WorkOS has no signed-in user', async () => {
      mockWithAuth.mockResolvedValue({ user: null })

      const { getAuthenticatedConvex } = await import('@/lib/convex-auth')

      await expect(getAuthenticatedConvex()).resolves.toBeNull()
      expect(mockSetAuth).not.toHaveBeenCalled()
    })

    it('returns null when NEXT_PUBLIC_CONVEX_URL is missing', async () => {
      delete process.env.NEXT_PUBLIC_CONVEX_URL

      const { getAuthenticatedConvex } = await import('@/lib/convex-auth')

      await expect(getAuthenticatedConvex()).resolves.toBeNull()
      expect(mockSetAuth).not.toHaveBeenCalled()
    })

    it('sets the WorkOS access token on Convex when available', async () => {
      const { getAuthenticatedConvex } = await import('@/lib/convex-auth')

      const result = await getAuthenticatedConvex()

      expect(result?.isAuthenticated).toBe(true)
      expect(result?.token).toBe('workos_access_token_for_tests')
      expect(mockSetAuth).toHaveBeenCalledWith('workos_access_token_for_tests')
    })

    it('returns an unauthenticated client when WorkOS has a user but no access token', async () => {
      mockWithAuth.mockResolvedValue({
        user: {
          id: 'user_workos_123',
          email: 'ada@example.com',
        },
        accessToken: undefined,
      })

      const { getAuthenticatedConvex } = await import('@/lib/convex-auth')

      const result = await getAuthenticatedConvex()

      expect(result?.isAuthenticated).toBe(false)
      expect(result?.token).toBeNull()
      expect(mockSetAuth).not.toHaveBeenCalled()
    })

    it('returns null when WorkOS session lookup throws outside proxy coverage', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockWithAuth.mockRejectedValue(new Error('missing AuthKit proxy headers'))

      const { getAuthenticatedConvex } = await import('@/lib/convex-auth')

      await expect(getAuthenticatedConvex()).resolves.toBeNull()
      expect(warnSpy).toHaveBeenCalled()

      warnSpy.mockRestore()
    })
  })

  describe('getCurrentAuthenticatedUserState', () => {
    it('queries Convex current user state when WorkOS Convex auth is available', async () => {
      mockClientQuery.mockResolvedValue({
        user: { _id: 'user_convex_123', email: 'ada@example.com' },
        profile: { _id: 'profile_123', role: 'COMPANY' },
      })

      const { getCurrentAuthenticatedUserState } = await import('@/lib/convex-auth')

      const result = await getCurrentAuthenticatedUserState({
        requireConvexAuth: true,
      })

      expect(result).toEqual({
        user: { _id: 'user_convex_123', email: 'ada@example.com' },
        profile: { _id: 'profile_123', role: 'COMPANY' },
      })
      expect(mockClientQuery).toHaveBeenCalledTimes(1)
    })

    it('does not query user state when Convex auth is required but no access token exists', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockWithAuth.mockResolvedValue({
        user: {
          id: 'user_workos_123',
          email: 'ada@example.com',
        },
        accessToken: undefined,
      })

      const { getCurrentAuthenticatedUserState } = await import('@/lib/convex-auth')

      await expect(
        getCurrentAuthenticatedUserState({
          requireConvexAuth: true,
        })
      ).resolves.toBeNull()
      expect(mockClientQuery).not.toHaveBeenCalled()

      warnSpy.mockRestore()
    })
  })

  describe('getUnauthenticatedConvex', () => {
    it('returns a Convex client without setting auth', async () => {
      const { getUnauthenticatedConvex } = await import('@/lib/convex-auth')

      const client = getUnauthenticatedConvex()

      expect(client).not.toBeNull()
      expect(mockSetAuth).not.toHaveBeenCalled()
    })

    it('returns null when NEXT_PUBLIC_CONVEX_URL is empty', async () => {
      process.env.NEXT_PUBLIC_CONVEX_URL = ''
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { getUnauthenticatedConvex } = await import('@/lib/convex-auth')

      expect(getUnauthenticatedConvex()).toBeNull()
      expect(errorSpy).toHaveBeenCalledWith(
        '[getUnauthenticatedConvex] NEXT_PUBLIC_CONVEX_URL not set'
      )

      errorSpy.mockRestore()
    })
  })

  it('uses the selected company identity and profile when an admin switches roles locally', async () => {
    process.env = {
      ...process.env,
      NODE_ENV: 'development',
      NEXT_PUBLIC_BYPASS_AUTH: 'true',
      NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210',
      NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: 'local-key',
    }
    mockCookieGet.mockImplementation((name: string) => {
      if (name === 'sherlock_dev_user') return { value: 'dev_admin_001' }
      if (name === 'sherlock_dev_role') return { value: 'COMPANY' }
      return undefined
    })
    mockClientQuery.mockResolvedValue({
      user: { _id: 'company_user' },
      profile: { _id: 'company_profile', role: 'COMPANY' },
    })
    const { getCurrentAuthenticatedUserState } = await import('@/lib/convex-auth')
    const state = await getCurrentAuthenticatedUserState({ requireConvexAuth: true })
    expect(mockSetAdminAuth).toHaveBeenCalledWith(
      'local-key',
      expect.objectContaining({
        subject: 'dev_company_001_workos',
        email: 'company@dev.local',
      })
    )
    expect(state?.profile?._id).toBe('company_profile')
    expect(mockWithAuth).not.toHaveBeenCalled()
  })
})
