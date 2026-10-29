import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockClientQuery = vi.fn()
const mockRedirect = vi.fn()
const mockCookiesGet = vi.fn()

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: mockCookiesGet,
  }),
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

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: {
      getCompanyByOwner: 'companies:getCompanyByOwner',
    },
    _demoSeed: { roomForDevCompany: '_demoSeed:roomForDevCompany' },
  },
}))

vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: vi.fn(),
  getCurrentAuthenticatedUserState: vi.fn(),
  getUnauthenticatedConvex: () => ({
    query: (...args: unknown[]) => mockClientQuery(...args),
  }),
}))

vi.mock('@/lib/dev-auth/config', () => ({
  DEV_AUTH_ENABLED: true,
}))

describe('lib/auth/session.ts demo auth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()

    mockCookiesGet.mockImplementation((name: string) => {
      if (name === 'sherlock_dev_user') {
        return { value: 'dev_company_001' }
      }
      if (name === 'sherlock_dev_role') {
        return { value: 'COMPANY' }
      }
      return undefined
    })
  })

  it('uses the local demo profileId for the selected demo user', async () => {
    const { requireAuth } = await import('@/lib/auth/session')
    const user = await requireAuth(undefined, 'en')

    expect(user.email).toBe('company@dev.local')
    expect(user.role).toBe('COMPANY')
    expect(user.profileId).toBe('demo_company_profile')
    expect(mockRedirect).not.toHaveBeenCalled()
    expect(mockClientQuery).not.toHaveBeenCalled()
  })
})
