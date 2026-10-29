// ============================================================================
// useNotifications — las tres queries esperan la sesión de Convex
// ============================================================================
// `getNotifications`, `getUnreadCount` y `getPreferences` llaman `requireAuth`.
// Estaban gateadas solo por `profile._id`, que ya existe mientras Convex todavía
// no aplicó el token: `ConvexProviderWithAuth` hace `client.setAuth` en un
// efecto del PADRE, que corre después del efecto de suscripción del HIJO, y
// vuelve a hacerlo en cada refresh. En esa ventana las tres salen sin identidad
// y tiran AUTH_NOT_AUTHENTICATED; el throw se pintaba en el navbar, porque el
// NotificationBell vive ahí.
//
// La compuerta llega por `useCurrentUser().isConvexSessionReady` y no por
// `useConvexAuth()` directo: ese hook tira si no hay `ConvexProviderWithAuth`
// arriba, y el árbol de dev-auth monta un `ConvexProvider` pelado.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const { mockUseCurrentUser, mockUseQuery, mockLocale, devAuth } = vi.hoisted(() => ({
  mockUseCurrentUser: vi.fn(),
  mockUseQuery: vi.fn(),
  mockLocale: vi.fn(() => 'es'),
  devAuth: { enabled: false },
}))

// `DEV_AUTH_ENABLED` se resuelve al cargar el módulo; el getter deja que cada
// caso elija el modo sin recargar el hook.
vi.mock('@/lib/dev-auth', () => ({
  get DEV_AUTH_ENABLED() {
    return devAuth.enabled
  },
}))

vi.mock('next-intl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl')>()
  const es = await import('@/messages/es.json')

  return {
    ...actual,
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: mockLocale(),
        messages: es.default,
        namespace: namespace as never,
      }),
  }
})

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mockUseCurrentUser(),
}))

vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => vi.fn(),
}))

vi.mock('../../../convex/_generated/api', () => ({
  api: {
    notifications: {
      getNotifications: 'notifications:getNotifications',
      getUnreadCount: 'notifications:getUnreadCount',
      getPreferences: 'notifications:getPreferences',
      markAsRead: 'notifications:markAsRead',
      markAllAsRead: 'notifications:markAllAsRead',
      updatePreferences: 'notifications:updatePreferences',
    },
  },
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

import { useNotifications } from '@/hooks/useNotifications'

const AUTHENTICATED_QUERIES = [
  'notifications:getNotifications',
  'notifications:getUnreadCount',
  'notifications:getPreferences',
] as const

function argsFor(queryName: string): unknown {
  const call = mockUseQuery.mock.calls.find(([name]) => name === queryName)
  expect(call, `useQuery nunca se llamó con ${queryName}`).toBeDefined()
  return call?.[1]
}

describe('useNotifications — compuerta de sesión de Convex', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    devAuth.enabled = false
    mockUseQuery.mockReturnValue(undefined)
  })

  it('deja las tres queries en skip mientras Convex no confirma el token', () => {
    mockUseCurrentUser.mockReturnValue({
      profile: { _id: 'profile_1', userId: 'user_1', isVerified: true },
      isLoading: false,
      isConvexSessionReady: false,
    })

    renderHook(() => useNotifications())

    for (const queryName of AUTHENTICATED_QUERIES) {
      expect(argsFor(queryName)).toBe('skip')
    }
  })

  it('suscribe con args reales cuando Convex ya autenticó', () => {
    mockUseCurrentUser.mockReturnValue({
      profile: { _id: 'profile_1', userId: 'user_1', isVerified: true },
      isLoading: false,
      isConvexSessionReady: true,
    })

    renderHook(() => useNotifications())

    expect(argsFor('notifications:getNotifications')).toEqual({ userId: 'profile_1', limit: 20 })
    expect(argsFor('notifications:getUnreadCount')).toEqual({ userId: 'profile_1' })
    expect(argsFor('notifications:getPreferences')).toEqual({ userId: 'profile_1' })
  })

  it('sigue en skip sin perfil aunque Convex esté autenticado', () => {
    mockUseCurrentUser.mockReturnValue({
      profile: null,
      isLoading: false,
      isConvexSessionReady: true,
    })

    renderHook(() => useNotifications())

    for (const queryName of AUTHENTICATED_QUERIES) {
      expect(argsFor(queryName)).toBe('skip')
    }
  })

  // En dev-auth `isConvexSessionReady` viene en `true` fijo. Eso solo es cierto
  // con la impersonación montada: sin la admin key del backend local el cliente
  // llama sin la identidad de `/dev-login`, `requireAuth` cae al admin del
  // bypass y `markAllAsRead` marcaría los avisos del admin.
  it('en dev-auth sin admin key local deja las tres queries en skip', () => {
    devAuth.enabled = true
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://acolyte-123.convex.cloud')
    vi.stubEnv('NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY', '')
    mockUseCurrentUser.mockReturnValue({
      profile: { _id: 'profile_1', userId: 'user_1', isVerified: true },
      isLoading: false,
      isConvexSessionReady: true,
    })

    renderHook(() => useNotifications())

    for (const queryName of AUTHENTICATED_QUERIES) {
      expect(argsFor(queryName)).toBe('skip')
    }
  })

  it('en dev-auth con backend local y admin key suscribe con el perfil elegido', () => {
    devAuth.enabled = true
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210')
    vi.stubEnv('NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY', 'convex-self-hosted|clave-local')
    mockUseCurrentUser.mockReturnValue({
      profile: { _id: 'profile_1', userId: 'user_1', isVerified: true },
      isLoading: false,
      isConvexSessionReady: true,
    })

    renderHook(() => useNotifications())

    expect(argsFor('notifications:getNotifications')).toEqual({ userId: 'profile_1', limit: 20 })
    expect(argsFor('notifications:getUnreadCount')).toEqual({ userId: 'profile_1' })
  })

  it('no se queda en isLoading cuando la sesión de Convex todavía no llega', () => {
    mockUseCurrentUser.mockReturnValue({
      profile: { _id: 'profile_1', userId: 'user_1', isVerified: true },
      isLoading: true,
      isConvexSessionReady: false,
    })

    const { result } = renderHook(() => useNotifications())

    expect(result.current.unreadCount).toBe(0)
    expect(result.current.notifications).toEqual([])
  })
})
