import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GET } from '@/app/logout/route'
import { defaultLocale } from '@/i18n/config'
import { ADMIN_STEP_UP_COOKIE_NAME } from '@/lib/auth/admin-step-up'

const { mockCookieDelete, mockSignOut } = vi.hoisted(() => ({
  mockCookieDelete: vi.fn(),
  mockSignOut: vi.fn(),
}))

vi.mock('@workos-inc/authkit-nextjs', () => ({ signOut: mockSignOut }))
vi.mock('next/headers', () => ({
  cookies: async () => ({ delete: mockCookieDelete }),
}))

describe('GET /logout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSignOut.mockResolvedValue(undefined)
  })

  it('clears the admin step-up and returns to the localized public home', async () => {
    await expect(GET()).resolves.toBeUndefined()

    expect(mockCookieDelete).toHaveBeenCalledWith(ADMIN_STEP_UP_COOKIE_NAME)
    expect(mockSignOut).toHaveBeenCalledWith({ returnTo: `/${defaultLocale}` })
  })
})
