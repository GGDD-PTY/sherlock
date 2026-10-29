// ============================================================================
// useCurrentUser — la sesión de Convex gatea la query autenticada
// ============================================================================
// AuthKit ya tiene el usuario en la hidratación, pero `ConvexProviderWithAuth`
// hace `client.setAuth` en un efecto del PADRE, que corre después del efecto de
// suscripción del HIJO. Entre esos dos momentos (y en cada refresh de token)
// la query sale sin identidad. Este test fija que la suscripción espera a que
// Convex confirme el token, no solo a que AuthKit tenga usuario.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const mockUseAuthKit = vi.fn()
vi.mock('@workos-inc/authkit-nextjs/components', () => ({
  useAuth: () => mockUseAuthKit(),
}))

const mockUseQuery = vi.fn()
const mockUseConvexAuth = vi.fn()
vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useConvexAuth: () => mockUseConvexAuth(),
}))

vi.mock('../../../convex/_generated/api', () => ({
  api: {
    users: {
      getCurrentUserState: 'users:getCurrentUserState',
    },
  },
}))

import { useCurrentUser } from '@/hooks/useCurrentUser'

const WORKOS_USER = {
  id: 'user_workos_123',
  email: 'fixture-1f46cd72@example.com',
  firstName: 'Maintainer',
  lastName: 'Gonzalez',
}

describe('useCurrentUser — compuerta de sesión de Convex', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseQuery.mockReturnValue(undefined)
  })

  it('mantiene la query en skip mientras Convex no confirma el token', () => {
    mockUseAuthKit.mockReturnValue({ user: WORKOS_USER, loading: false })
    mockUseConvexAuth.mockReturnValue({
      isLoading: false,
      isAuthenticated: false,
      isRefreshing: false,
    })

    const { result } = renderHook(() => useCurrentUser())

    expect(mockUseQuery).toHaveBeenCalledWith('users:getCurrentUserState', 'skip')
    expect(result.current.isLoading).toBe(true)
    expect(result.current.isAuthLoading).toBe(false)
    expect(result.current.isConvexSessionReady).toBe(false)
  })

  it('suscribe con args reales cuando Convex ya autenticó', () => {
    mockUseAuthKit.mockReturnValue({ user: WORKOS_USER, loading: false })
    mockUseConvexAuth.mockReturnValue({
      isLoading: false,
      isAuthenticated: true,
      isRefreshing: false,
    })
    mockUseQuery.mockReturnValue({
      user: { _id: 'convex_user_1', role: 'ADMIN' },
      profile: { _id: 'profile_1', isVerified: true },
    })

    const { result } = renderHook(() => useCurrentUser())

    expect(mockUseQuery).toHaveBeenCalledWith('users:getCurrentUserState', {})
    expect(result.current.isLoading).toBe(false)
    expect(result.current.realRole).toBe('ADMIN')
    expect(result.current.isConvexSessionReady).toBe(true)
  })

  it('vuelve a skip si Convex pierde la sesión en un refresh de token', () => {
    mockUseAuthKit.mockReturnValue({ user: WORKOS_USER, loading: false })
    mockUseConvexAuth.mockReturnValue({
      isLoading: true,
      isAuthenticated: false,
      isRefreshing: false,
    })

    renderHook(() => useCurrentUser())

    expect(mockUseQuery).toHaveBeenCalledWith('users:getCurrentUserState', 'skip')
  })

  it('sin sesión de AuthKit no queda cargando para siempre', () => {
    mockUseAuthKit.mockReturnValue({ user: null, loading: false })
    mockUseConvexAuth.mockReturnValue({
      isLoading: false,
      isAuthenticated: false,
      isRefreshing: false,
    })

    const { result } = renderHook(() => useCurrentUser())

    expect(mockUseQuery).toHaveBeenCalledWith('users:getCurrentUserState', 'skip')
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isSignedIn).toBe(false)
  })
})
