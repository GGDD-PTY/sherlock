import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

process.env.NEXT_PUBLIC_CONVEX_URL = 'https://sherlock-test.convex.cloud'

vi.mock('@/lib/dev-auth', () => ({ DEV_AUTH_ENABLED: false }))
vi.mock('@workos-inc/authkit-nextjs/components', () => ({
  useAuth: () => ({ user: { id: 'user_test' }, loading: false }),
  useAccessToken: () => ({
    getAccessToken: vi.fn().mockResolvedValue('access-token'),
    refresh: vi.fn().mockResolvedValue('refreshed-token'),
  }),
}))
vi.mock('convex/react', () => ({
  ConvexReactClient: vi.fn(function ConvexReactClient() {}),
  ConvexProvider: ({ children }: { children: ReactNode }) => (
    <section data-convex-provider="dev">{children}</section>
  ),
  ConvexProviderWithAuth: ({
    children,
    useAuth,
  }: {
    children: ReactNode
    useAuth: () => { isAuthenticated: boolean }
  }) => {
    const auth = useAuth()
    return (
      <section data-convex-provider="workos" data-authenticated={String(auth.isAuthenticated)}>
        {children}
      </section>
    )
  },
}))

describe('ConvexClientProvider production render', () => {
  it('catches production falling back to the unauthenticated Convex provider', async () => {
    const { ConvexClientProvider } = await import('@/components/providers/ConvexClientProvider')
    render(
      <ConvexClientProvider>
        <p>Convex-backed workspace</p>
      </ConvexClientProvider>
    )

    const boundary = screen.getByText('Convex-backed workspace').closest('[data-convex-provider]')
    expect(boundary).toHaveAttribute('data-convex-provider', 'workos')
    expect(boundary).toHaveAttribute('data-authenticated', 'true')
  })
})
