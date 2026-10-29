// ============================================================================
// useCurrentUserDev — el perfil se LEE, no se fabrica (O5-04-6)
// ============================================================================
// En el primer render `getDevProfile` todavía no volvió. El hook devolvía un
// `_id` sintético (`demo_company_profile`) y `useNotifications` lo mandaba a
// tres queries con `v.id('profiles')`. Ese id no es de Convex: ArgumentValidationError
// y la sala caía a «No pudimos cargar esta página».
//
// Contrato: `profile` es el de Convex o `null`. Mientras la query está
// pendiente para un usuario con sesión, `isLoading` es true. En «ver como» el
// `_id` sigue siendo el del usuario logueado en fixtures; el backend local
// usa el perfil de la identidad seleccionada.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

import { DEMO_COMPANY_PROFILE_ID } from '@/lib/dev-auth/demo-data'

const { mockUseDevAuth, mockUseQuery, mockViewAsState } = vi.hoisted(() => ({
  mockUseDevAuth: vi.fn(),
  mockUseQuery: vi.fn(),
  mockViewAsState: {
    viewAsRole: null as 'COMPANY' | null,
    impersonateUserId: null as string | null,
    setViewAs: vi.fn(),
    clearViewAs: vi.fn(),
    setImpersonateUser: vi.fn(),
    clearImpersonate: vi.fn(),
  },
}))

vi.mock('@/lib/dev-auth/config', () => ({ DEV_AUTH_ENABLED: true }))

vi.mock('@/lib/dev-auth', () => ({
  DEV_AUTH_ENABLED: true,
  useDevAuth: () => mockUseDevAuth(),
}))

vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useConvexAuth: () => ({
    isLoading: false,
    isAuthenticated: true,
    isRefreshing: false,
  }),
}))

vi.mock('../../../convex/_generated/api', () => ({
  api: {
    users: {
      getCurrentUserState: 'users:getCurrentUserState',
    },
    devAuth: {
      getDevProfile: 'devAuth:getDevProfile',
    },
  },
}))

vi.mock('@/stores/useViewAsStore', () => ({
  useViewAsStore: (selector: (state: typeof mockViewAsState) => unknown) =>
    selector(mockViewAsState),
}))

import { useCurrentUser } from '@/hooks/useCurrentUser'

afterEach(() => vi.unstubAllEnvs())

const COMPANY_USER = {
  providerUserId: 'dev_company_001',
  email: 'company@dev.local',
  firstName: 'Sample',
  lastName: 'Investment',
  name: 'Sample Hydro, S. A.',
  imageUrl: null,
  role: 'COMPANY' as const,
}

const ADMIN_USER = {
  providerUserId: 'dev_admin_001',
  email: 'admin@dev.local',
  firstName: 'Dev',
  lastName: 'Admin',
  name: 'Dev Admin User',
  imageUrl: null,
  role: 'ADMIN' as const,
}

const REAL_COMPANY_PROFILE = {
  _id: 'profile_company_real',
  role: 'COMPANY' as const,
  isVerified: true,
  fullName: 'María Dueña',
  phone: null,
  kycStatus: 'VERIFIED' as const,
}

const REAL_ADMIN_PROFILE = {
  _id: 'profile_admin_real',
  role: 'ADMIN' as const,
  isVerified: true,
  fullName: 'Dev Admin User',
  phone: null,
  kycStatus: 'VERIFIED' as const,
}

describe('useCurrentUserDev — perfil de Convex, no sintético', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockViewAsState.viewAsRole = null
    mockViewAsState.impersonateUserId = null
    mockUseQuery.mockReset()
  })

  it('con getDevProfile pendiente y rol COMPANY, profile es null e isLoading es true', () => {
    mockUseDevAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: COMPANY_USER,
      currentRole: 'COMPANY',
    })

    const { result } = renderHook(() => useCurrentUser())

    expect(mockUseQuery).toHaveBeenCalledWith('devAuth:getDevProfile', {
      email: 'company@dev.local',
    })
    expect(result.current.profile).toBeNull()
    expect(result.current.profile?._id).not.toBe(DEMO_COMPANY_PROFILE_ID)
    expect(result.current.isLoading).toBe(true)
    expect(result.current.isAuthLoading).toBe(false)
  })

  it('en ver como, profile._id es el del usuario logueado', () => {
    mockUseDevAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: ADMIN_USER,
      currentRole: 'ADMIN',
    })
    mockViewAsState.viewAsRole = 'COMPANY'
    mockUseQuery.mockReturnValue(REAL_ADMIN_PROFILE)

    const { result } = renderHook(() => useCurrentUser())

    expect(result.current.isViewingAs).toBe(true)
    expect(result.current.effectiveRole).toBe('COMPANY')
    expect(result.current.realRole).toBe('ADMIN')
    expect(result.current.profile?._id).toBe('profile_admin_real')
    expect(result.current.profile?._id).not.toBe(DEMO_COMPANY_PROFILE_ID)
    expect(result.current.isLoading).toBe(false)
  })

  it('cuando getDevProfile resuelve, profile._id es el de Convex', () => {
    mockUseDevAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: COMPANY_USER,
      currentRole: 'COMPANY',
    })
    mockUseQuery.mockReturnValue(REAL_COMPANY_PROFILE)

    const { result } = renderHook(() => useCurrentUser())

    expect(result.current.profile?._id).toBe('profile_company_real')
    expect(result.current.isLoading).toBe(false)
  })

  it('uses the selected company profile when a local admin switches to COMPANY', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_BYPASS_AUTH', 'true')
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210')
    vi.stubEnv('NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY', 'local-key')
    mockUseDevAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
      user: ADMIN_USER,
      currentRole: 'COMPANY',
    })
    mockUseQuery.mockReturnValue(REAL_COMPANY_PROFILE)
    const { result } = renderHook(() => useCurrentUser())
    expect(mockUseQuery).toHaveBeenCalledWith('devAuth:getDevProfile', {
      email: 'company@dev.local',
    })
    expect(result.current.profile?._id).toBe('profile_company_real')
    expect(result.current.user?.email).toBe('company@dev.local')
    expect(result.current.realRole).toBe('ADMIN')
    expect(result.current.effectiveRole).toBe('COMPANY')
  })
})
