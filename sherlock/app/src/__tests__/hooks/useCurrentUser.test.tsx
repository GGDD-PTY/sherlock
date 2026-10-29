// ============================================================================
// HOOK: useCurrentUser - UNIT TESTS
// ============================================================================
// Tests para el hook que combina WorkOS AuthKit (auth) + Convex (data)
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useCurrentUser } from '@/hooks/useCurrentUser'

// ===== MOCKS =====
// Mock de WorkOS AuthKit useAuth
const mockUseAuthKit = vi.fn()
vi.mock('@workos-inc/authkit-nextjs/components', () => ({
  useAuth: () => mockUseAuthKit(),
}))

// Mock de Convex useQuery + estado de sesión de Convex.
// `useCurrentUserWorkOS` sólo se suscribe cuando Convex ya aceptó el token, así
// que el default de estos tests es "sesión de Convex ya establecida".
const mockUseQuery = vi.fn()
const mockUseConvexAuth = vi.fn(() => ({
  isLoading: false,
  isAuthenticated: true,
  isRefreshing: false,
}))
vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useConvexAuth: () => mockUseConvexAuth(),
}))

// Mock del API de Convex
vi.mock('../../../convex/_generated/api', () => ({
  api: {
    users: {
      getCurrentUserState: 'users:getCurrentUserState',
    },
  },
}))

// ============================================================================
// HELPERS
// ============================================================================

function mockWorkosUser(overrides = {}) {
  return {
    id: 'user_workos_123',
    email: 'test@example.com',
    firstName: 'John',
    lastName: 'Doe',
    ...overrides,
  }
}

function mockConvexUser(overrides = {}) {
  return {
    _id: 'convex_user_456',
    clerkId: 'legacy_clerk_123',
    providerUserId: 'user_workos_123',
    workosUserId: 'user_workos_123',
    email: 'test@example.com',
    role: 'COMPANY' as const,
    ...overrides,
  }
}

function mockProfile(overrides = {}) {
  return {
    _id: 'convex_profile_789',
    userId: 'convex_user_456',
    isVerified: true,
    fullName: 'John Doe',
    ...overrides,
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe('useCurrentUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ===== ESTADO: NO AUTENTICADO =====
  describe('usuario no autenticado', () => {
    it('retorna user null cuando no hay sesión', () => {
      mockUseAuthKit.mockReturnValue({
        user: null,
        loading: false,
      })
      mockUseQuery.mockReturnValue(undefined)

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.user).toBeNull()
      expect(result.current.isSignedIn).toBe(false)
      expect(result.current.isLoading).toBe(false)
    })

    it('no consulta Convex sin usuario de WorkOS', () => {
      mockUseAuthKit.mockReturnValue({
        user: null,
        loading: false,
      })
      mockUseQuery.mockReturnValue(undefined)

      renderHook(() => useCurrentUser())

      expect(mockUseQuery).toHaveBeenCalledWith('users:getCurrentUserState', 'skip')
    })
  })

  // ===== ESTADO: CARGANDO =====
  describe('estados de carga', () => {
    it('isLoading=true mientras WorkOS carga', () => {
      mockUseAuthKit.mockReturnValue({
        user: null,
        loading: true,
      })
      mockUseQuery.mockReturnValue(undefined)

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.isLoading).toBe(true)
    })

    it('isLoading=true mientras Convex carga (usuario autenticado)', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      // Convex aún no ha respondido
      mockUseQuery.mockReturnValue(undefined)

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.isLoading).toBe(true)
    })

    it('isLoading=false cuando ambos han cargado', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser(),
        profile: mockProfile(),
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.isLoading).toBe(false)
    })
  })

  // ===== ESTADO: AUTENTICADO =====
  describe('usuario autenticado', () => {
    it('combina datos de WorkOS y Convex', () => {
      const workosUser = mockWorkosUser()
      const convexUser = mockConvexUser()
      const profile = mockProfile()

      mockUseAuthKit.mockReturnValue({
        user: workosUser,
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: convexUser,
        profile,
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.user).toEqual({
        providerUserId: 'user_workos_123',
        workosUserId: 'user_workos_123',
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
        fullName: 'John Doe',
        imageUrl: '',
        convexId: 'convex_user_456',
        role: 'COMPANY',
        isVerified: true,
      })
    })

    it('expone convexUser y profile por separado', () => {
      const convexUser = mockConvexUser()
      const profile = mockProfile()

      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: convexUser,
        profile,
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.convexUser).toEqual(convexUser)
      expect(result.current.profile).toEqual(profile)
    })
  })

  // ===== HELPER: hasRole =====
  describe('hasRole()', () => {
    it('retorna true para rol correcto', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser({ role: 'COMPANY' }),
        profile: mockProfile(),
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.hasRole('COMPANY')).toBe(true)
      expect(result.current.hasRole('ADMIN')).toBe(false)
      expect(result.current.hasRole('ADMIN')).toBe(false)
    })

    it('retorna false sin usuario', () => {
      mockUseAuthKit.mockReturnValue({
        user: null,
        loading: false,
      })
      mockUseQuery.mockReturnValue(undefined)

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.hasRole('COMPANY')).toBe(false)
    })
  })

  // ===== HELPER: needsOnboarding =====
  describe('needsOnboarding', () => {
    it('true si usuario autenticado sin rol', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser({ role: undefined }),
        profile: null,
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.needsOnboarding).toBe(true)
    })

    it('false si usuario tiene rol', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser({ role: 'COMPANY' }),
        profile: mockProfile(),
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.needsOnboarding).toBe(false)
    })

    it('false si no está autenticado', () => {
      mockUseAuthKit.mockReturnValue({
        user: null,
        loading: false,
      })
      mockUseQuery.mockReturnValue(undefined)

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.needsOnboarding).toBe(false)
    })
  })

  // ===== ROLES ESPECÍFICOS =====
  describe('roles específicos', () => {
    it('maneja rol ADMIN', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser({ role: 'ADMIN' }),
        profile: mockProfile(),
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.user?.role).toBe('ADMIN')
      expect(result.current.hasRole('ADMIN')).toBe(true)
    })

    it('maneja rol COMPANY', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser({ role: 'COMPANY' }),
        profile: mockProfile(),
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.user?.role).toBe('COMPANY')
      expect(result.current.hasRole('COMPANY')).toBe(true)
    })
  })

  // ===== DATOS PARCIALES =====
  describe('datos parciales', () => {
    it('maneja usuario sin email de WorkOS', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser({ email: '' }),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser(),
        profile: mockProfile(),
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.user?.email).toBe('')
    })

    it('maneja profile null', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser(),
        profile: null,
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.user?.isVerified).toBeUndefined()
      expect(result.current.profile).toBeNull()
    })
  })

  // ===== ADMIN PROPERTIES =====
  describe('admin properties', () => {
    it('isAdmin true for ADMIN role', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser({ role: 'ADMIN' }),
        profile: mockProfile(),
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.isAdmin).toBe(true)
    })

    it('isAdmin false for non-ADMIN roles', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser({ role: 'COMPANY' }),
        profile: mockProfile(),
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.isAdmin).toBe(false)
    })

    it('hasRealRole checks realRole (not viewAs)', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser({ role: 'ADMIN' }),
        profile: mockProfile(),
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.hasRealRole('ADMIN')).toBe(true)
      expect(result.current.hasRealRole('COMPANY')).toBe(false)
      expect(result.current.hasRealRole('COMPANY')).toBe(false)
    })

    it('realRole always reflects database role', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser({ role: 'COMPANY' }),
        profile: mockProfile(),
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.realRole).toBe('COMPANY')
    })
  })

  // ===== VIEW AS INTERFACE =====
  describe('view as interface', () => {
    it('exposes view-as related properties', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser({ role: 'COMPANY' }),
        profile: mockProfile(),
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current).toHaveProperty('viewAsRole')
      expect(result.current).toHaveProperty('isViewingAs')
      expect(result.current).toHaveProperty('isImpersonating')
      expect(result.current).toHaveProperty('impersonateUserId')
      expect(result.current).toHaveProperty('setViewAs')
      expect(result.current).toHaveProperty('clearViewAs')
      expect(result.current).toHaveProperty('setImpersonateUser')
      expect(result.current).toHaveProperty('clearImpersonate')
    })

    it('isViewingAs false when not admin', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser({ role: 'COMPANY' }),
        profile: mockProfile(),
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.isViewingAs).toBe(false)
    })

    it('effectiveRole equals realRole when not viewing as', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser({ role: 'COMPANY' }),
        profile: mockProfile(),
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.effectiveRole).toBe('COMPANY')
      expect(result.current.realRole).toBe('COMPANY')
    })

    it('isImpersonating false by default', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser({ role: 'ADMIN' }),
        profile: mockProfile(),
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.isImpersonating).toBe(false)
    })
  })

  // ===== SIGNED IN STATE =====
  describe('isSignedIn', () => {
    it('returns true when user is signed in', () => {
      mockUseAuthKit.mockReturnValue({
        user: mockWorkosUser(),
        loading: false,
      })
      mockUseQuery.mockReturnValue({
        user: mockConvexUser(),
        profile: mockProfile(),
      })

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.isSignedIn).toBe(true)
    })

    it('returns false when user is not signed in', () => {
      mockUseAuthKit.mockReturnValue({
        user: null,
        loading: false,
      })
      mockUseQuery.mockReturnValue(undefined)

      const { result } = renderHook(() => useCurrentUser())

      expect(result.current.isSignedIn).toBe(false)
    })
  })
})
