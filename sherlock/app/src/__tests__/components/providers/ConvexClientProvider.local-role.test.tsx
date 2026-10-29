import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { DEV_USERS } from '@/lib/dev-auth/types'

const mocks = vi.hoisted(() => ({
  setAdminAuth: vi.fn(),
  clearAuth: vi.fn(),
  role: 'ADMIN' as 'ADMIN' | 'COMPANY',
}))
vi.mock('@/lib/dev-auth', () => ({ DEV_AUTH_ENABLED: true }))
vi.mock('@/lib/dev-auth/config', () => ({ DEV_AUTH_ENABLED: true }))
vi.mock('@/lib/dev-auth/context', () => ({
  useDevAuth: () => ({
    user: DEV_USERS.find((user) => user.role === 'ADMIN'),
    isLoaded: true,
    currentRole: mocks.role,
  }),
}))
vi.mock('@/stores/useViewAsStore', () => ({
  useViewAsStore: (selector: (state: { viewAsRole: null }) => unknown) =>
    selector({ viewAsRole: null }),
}))
vi.mock('convex/react', () => ({
  ConvexReactClient: class {
    setAdminAuth = mocks.setAdminAuth
    clearAuth = mocks.clearAuth
  },
  ConvexProvider: ({ children }: { children: ReactNode }) => children,
  ConvexProviderWithAuth: ({ children }: { children: ReactNode }) => children,
}))

afterEach(() => vi.unstubAllEnvs())

it('updates backend identity when an admin selects the company role', async () => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210')
  vi.stubEnv('NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY', 'local-key')
  const { ConvexClientProvider } = await import('@/components/providers/ConvexClientProvider')
  const { rerender } = render(<ConvexClientProvider>workspace</ConvexClientProvider>)
  expect(mocks.setAdminAuth).toHaveBeenLastCalledWith(
    'local-key',
    expect.objectContaining({ subject: 'dev_admin_001_workos' })
  )
  mocks.role = 'COMPANY'
  rerender(<ConvexClientProvider>workspace</ConvexClientProvider>)
  expect(mocks.setAdminAuth).toHaveBeenLastCalledWith(
    'local-key',
    expect.objectContaining({ subject: 'dev_company_001_workos' })
  )
})
