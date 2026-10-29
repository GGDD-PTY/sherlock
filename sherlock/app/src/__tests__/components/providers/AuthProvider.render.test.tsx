import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/dev-auth/config', () => ({ DEV_AUTH_ENABLED: false }))
vi.mock('@/lib/dev-auth/context', () => ({
  DevAuthProvider: ({ children }: { children: ReactNode }) => (
    <section data-auth-provider="dev">{children}</section>
  ),
}))
vi.mock('@/components/providers/WorkOSAuthProvider', () => ({
  WorkOSAuthProvider: ({ children }: { children: ReactNode }) => (
    <section data-auth-provider="workos">{children}</section>
  ),
}))

import { AuthProvider } from '@/components/providers/AuthProvider'

describe('AuthProvider production render', () => {
  it('catches a production regression that selects the dev-auth boundary', () => {
    render(
      <AuthProvider>
        <p>Protected workspace</p>
      </AuthProvider>
    )

    const child = screen.getByText('Protected workspace')
    expect(child.closest('[data-auth-provider]')).toHaveAttribute('data-auth-provider', 'workos')
  })
})
