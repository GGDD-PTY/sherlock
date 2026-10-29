import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

const { mockWithAuth } = vi.hoisted(() => ({ mockWithAuth: vi.fn() }))

vi.mock('@workos-inc/authkit-nextjs', () => ({ withAuth: mockWithAuth }))
vi.mock('@workos-inc/authkit-nextjs/components', () => ({
  AuthKitProvider: ({
    children,
    initialAuth,
  }: {
    children: ReactNode
    initialAuth: Record<string, unknown>
  }) => (
    <section
      data-testid="authkit-boundary"
      data-has-user={String(Boolean(initialAuth.user))}
      data-has-access-token={String('accessToken' in initialAuth)}
    >
      {children}
    </section>
  ),
}))

import { WorkOSAuthProvider } from '@/components/providers/WorkOSAuthProvider'

describe('WorkOSAuthProvider production render', () => {
  it('catches an access-token leak into the client AuthKit bootstrap', async () => {
    mockWithAuth.mockResolvedValue({ user: { id: 'user_test' }, accessToken: 'server-only-token' })

    render(
      await WorkOSAuthProvider({
        children: <p>Signed-in workspace</p>,
      })
    )

    expect(screen.getByText('Signed-in workspace')).toBeInTheDocument()
    expect(screen.getByTestId('authkit-boundary')).toHaveAttribute('data-has-user', 'true')
    expect(screen.getByTestId('authkit-boundary')).toHaveAttribute('data-has-access-token', 'false')
  })
})
