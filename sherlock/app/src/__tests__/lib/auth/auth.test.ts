import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockWithAuth = vi.fn()

vi.mock('@workos-inc/authkit-nextjs', () => ({
  withAuth: () => mockWithAuth(),
}))

describe('lib/auth/auth.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    mockWithAuth.mockResolvedValue({
      user: {
        id: 'user_workos_123',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      },
      organizationId: undefined,
      role: undefined,
    })
  })

  describe('auth()', () => {
    it('returns null when WorkOS has no signed-in user', async () => {
      mockWithAuth.mockResolvedValue({ user: null })

      const { auth } = await import('@/lib/auth/auth')

      await expect(auth()).resolves.toBeNull()
    })

    it('returns session with WorkOS user data when authenticated', async () => {
      const { auth } = await import('@/lib/auth/auth')

      const session = await auth()

      expect(session).toEqual({
        user: {
          id: 'user_workos_123',
          email: 'test@example.com',
          name: 'Test User',
          image: null,
        },
      })
    })

    it('builds a null display name when WorkOS first and last name are missing', async () => {
      mockWithAuth.mockResolvedValue({
        user: {
          id: 'user_workos_123',
          email: 'test@example.com',
          firstName: null,
          lastName: null,
        },
      })

      const { auth } = await import('@/lib/auth/auth')

      const session = await auth()

      expect(session?.user?.name).toBeNull()
    })

    // A1-03: un fallo de WorkOS no es una sesión ausente. Antes ambos salían
    // `null` y `requireApiAuth` respondía 401 durante una caída del proveedor.
    it('rejects with the typed transport error on WorkOS auth errors', async () => {
      mockWithAuth.mockRejectedValue(new Error('WorkOS error'))

      const { auth } = await import('@/lib/auth/auth')

      await expect(auth()).rejects.toMatchObject({
        _tag: 'ExternalServiceError',
        service: 'WorkOS',
        operation: 'authkit.withAuth',
        reason: 'transport',
      })
    })
  })

  describe('Session interface', () => {
    it('supports a populated user object', () => {
      const session = {
        user: {
          id: 'user_123',
          email: 'test@example.com',
          name: 'Test User',
          image: null,
        },
      }

      expect(session.user.id).toBe('user_123')
    })

    it('supports null user when unauthenticated', () => {
      expect({ user: null }.user).toBeNull()
    })
  })
})
