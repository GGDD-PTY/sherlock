import { getSignUpUrl, withAuth } from '@workos-inc/authkit-nextjs'
import { redirect } from 'next/navigation'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GET } from '@/app/signup/route'

describe('signup route returnTo', () => {
  beforeEach(() => {
    vi.mocked(getSignUpUrl).mockReset()
    vi.mocked(redirect).mockReset()
    vi.mocked(getSignUpUrl).mockResolvedValue('https://auth.workos.test/signup')
    vi.mocked(withAuth).mockReset()
    vi.mocked(withAuth).mockResolvedValue({ user: null } as never)
  })

  it('sends an already-authenticated session straight to returnTo without WorkOS', async () => {
    vi.mocked(withAuth).mockResolvedValue({ user: { id: 'user_123' } } as never)

    await GET(
      new NextRequest('http://localhost:3000/signup?returnTo=%2Fes%2Fmy-company%2Fdocuments')
    )

    expect(redirect).toHaveBeenCalledWith('/es/my-company/documents')
    expect(getSignUpUrl).not.toHaveBeenCalled()
  })

  it('keeps the WorkOS flow when reading the session fails', async () => {
    vi.mocked(withAuth).mockRejectedValue(new Error('no middleware'))

    await GET(
      new NextRequest('http://localhost:3000/signup?returnTo=%2Fes%2Fmy-company%2Fdocuments')
    )

    expect(getSignUpUrl).toHaveBeenCalledWith({ returnTo: '/es/my-company/documents' })
    expect(redirect).toHaveBeenCalledWith('https://auth.workos.test/signup')
  })

  it('forwards a safe Mycroft VDR returnTo to WorkOS', async () => {
    await GET(
      new NextRequest('http://localhost:3000/signup?returnTo=%2Fes%2Fmy-company%2Fdocuments')
    )

    expect(getSignUpUrl).toHaveBeenCalledWith({ returnTo: '/es/my-company/documents' })
    expect(redirect).toHaveBeenCalledWith('https://auth.workos.test/signup')
  })

  // La llave del sobre viaja DENTRO del returnTo, así que el returnTo llega
  // percent-encodeado y su `?handoff=` no puede leerse como otro parámetro de
  // /signup. WorkOS lo devuelve entero en el callback: si esta ruta lo partiera,
  // la sala aterrizaría sin llave y el sobre quedaría sin nadie que lo reclame.
  it('forwards a returnTo carrying the handoff key without splitting its query', async () => {
    const returnTo = '/es/my-company/documents?handoff=7c9e6679-7425-40de-944b-e07fc1f90ae7'

    await GET(
      new NextRequest(`http://localhost:3000/signup?returnTo=${encodeURIComponent(returnTo)}`)
    )

    expect(getSignUpUrl).toHaveBeenCalledWith({ returnTo })
    expect(redirect).toHaveBeenCalledWith('https://auth.workos.test/signup')
  })

  it('sends an already-authenticated session to the room with its handoff key intact', async () => {
    vi.mocked(withAuth).mockResolvedValue({ user: { id: 'user_123' } } as never)
    const returnTo = '/es/my-company/documents?handoff=7c9e6679-7425-40de-944b-e07fc1f90ae7'

    await GET(
      new NextRequest(`http://localhost:3000/signup?returnTo=${encodeURIComponent(returnTo)}`)
    )

    expect(redirect).toHaveBeenCalledWith(returnTo)
    expect(getSignUpUrl).not.toHaveBeenCalled()
  })

  it('falls back to localized onboarding when returnTo is missing', async () => {
    await GET(new NextRequest('http://localhost:3000/signup'))

    expect(getSignUpUrl).toHaveBeenCalledWith({ returnTo: '/es/onboarding' })
  })

  it.each(['https://evil.example/phish', '//evil.example', 'vdr', '/\\/evil.example'])(
    'rejects open-redirect payload %s and falls back to onboarding',
    async (returnTo) => {
      await GET(
        new NextRequest(`http://localhost:3000/signup?returnTo=${encodeURIComponent(returnTo)}`)
      )

      expect(getSignUpUrl).toHaveBeenCalledWith({ returnTo: '/es/onboarding' })
    }
  )
})
