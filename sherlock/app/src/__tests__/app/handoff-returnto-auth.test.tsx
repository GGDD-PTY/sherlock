// ============================================================================
// LA LLAVE DEL SOBRE SOBREVIVE EL ALTA
// ============================================================================
// El sobre de la landing se reclama con un nonce que viaja DENTRO del returnTo
// (`/sign-up?returnTo=/my-company/documents?handoff=<nonce>`). Entre la landing
// y la sala hay dos saltos que pueden partirlo: la página de sign-up, que arma
// el `/signup?returnTo=` (o el `/dev-login?returnTo=` bajo dev-auth), y
// `/dev-login`, que quita el prefijo de locale antes de navegar. Si cualquiera
// de los dos se come la query, la sala aterriza sin llave y el sobre se queda
// sin nadie que lo reclame.

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { redirect } from 'next/navigation'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const HANDOFF_NONCE = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const ROOM_WITH_KEY = `/my-company/documents?handoff=${HANDOFF_NONCE}`

const mockIsDevAuthEnabled = vi.hoisted(() => vi.fn(() => false))
const mockSearchParams = vi.hoisted(() => ({ value: new URLSearchParams() }))
const mockDevRouter = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }))
const mockSignIn = vi.hoisted(() => vi.fn(() => true))
const mockPrepareLogin = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/app/[locale]/dev-login/actions', () => ({ prepareLocalDevLogin: mockPrepareLogin }))

vi.mock('@/lib/dev-auth/config', () => ({
  isDevAuthEnabled: () => mockIsDevAuthEnabled(),
  DEV_AUTH_ENABLED: true,
}))

vi.mock('@/lib/dev-auth', () => ({
  DEV_AUTH_ENABLED: true,
  DEV_USERS: [
    { id: 'dev_company', email: 'company@dev.local', name: 'Empresa Demo', role: 'COMPANY' },
  ],
  useDevAuth: () => ({ signIn: mockSignIn }),
}))

vi.mock('@/i18n/navigation', () => ({
  useRouter: () => mockDevRouter,
}))

vi.mock('next/navigation', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    redirect: vi.fn(),
    useSearchParams: () => mockSearchParams.value,
  }
})

describe('handoff key across sign-up', () => {
  beforeEach(() => {
    vi.mocked(redirect).mockReset()
    mockIsDevAuthEnabled.mockReturnValue(false)
  })

  // El returnTo entero se percent-encodea: su `?` y su `=` no pueden partir la
  // query de /signup ni convertir `handoff` en un parámetro de la ruta de auth.
  it('percent-encodes the room returnTo with its handoff key into /signup', async () => {
    const { default: SignUpPage } = await import('@/app/[locale]/sign-up/[[...sign-up]]/page')

    await SignUpPage({
      searchParams: Promise.resolve({ returnTo: `/es${ROOM_WITH_KEY}` }),
      params: Promise.resolve({ locale: 'es' }),
    })

    expect(redirect).toHaveBeenCalledWith(
      `/signup?returnTo=${encodeURIComponent(`/es${ROOM_WITH_KEY}`)}`
    )
    const target = new URL(
      String(vi.mocked(redirect).mock.calls[0]?.[0]),
      'https://sherlock.capital'
    )
    expect(target.searchParams.get('handoff')).toBeNull()
    expect(target.searchParams.get('returnTo')).toBe(`/es${ROOM_WITH_KEY}`)
  })

  it('keeps the handoff key when dev-auth reroutes sign-up to /dev-login', async () => {
    mockIsDevAuthEnabled.mockReturnValue(true)
    const { default: SignUpPage } = await import('@/app/[locale]/sign-up/[[...sign-up]]/page')

    await SignUpPage({
      searchParams: Promise.resolve({ returnTo: `/es${ROOM_WITH_KEY}` }),
      params: Promise.resolve({ locale: 'es' }),
    })

    expect(redirect).toHaveBeenCalledWith(
      `/es/dev-login?returnTo=${encodeURIComponent(`/es${ROOM_WITH_KEY}`)}`
    )
  })
})

describe('handoff key across dev-login', () => {
  beforeEach(() => {
    mockDevRouter.push.mockReset()
    mockSignIn.mockReset().mockReturnValue(true)
    mockPrepareLogin.mockReset().mockResolvedValue(true)
    mockSearchParams.value = new URLSearchParams()
  })

  // `resolveDestination` quita el prefijo de locale para no anteponerlo dos
  // veces. La query no es parte de ese prefijo: sale intacta o la sala pierde
  // la llave.
  it('strips the locale prefix from returnTo and keeps its query', async () => {
    mockSearchParams.value = new URLSearchParams({ returnTo: `/es${ROOM_WITH_KEY}` })
    const { default: DevLoginPage } = await import('@/app/[locale]/dev-login/page')

    render(<DevLoginPage />)
    await userEvent.click(screen.getByText('company@dev.local'))

    await waitFor(() =>
      expect(mockDevRouter.push).toHaveBeenCalledWith(ROOM_WITH_KEY, { locale: 'es' })
    )
  })

  it('refuses an off-site returnTo and lands on the onboarding router instead', async () => {
    mockSearchParams.value = new URLSearchParams({ returnTo: 'https://evil.example/phish' })
    const { default: DevLoginPage } = await import('@/app/[locale]/dev-login/page')

    render(<DevLoginPage />)
    await userEvent.click(screen.getByText('company@dev.local'))

    await waitFor(() =>
      expect(mockDevRouter.push).toHaveBeenCalledWith('/onboarding', { locale: 'es' })
    )
  })

  it('does not sign in or navigate when local identity preparation fails', async () => {
    mockPrepareLogin.mockResolvedValue(false)
    const { default: DevLoginPage } = await import('@/app/[locale]/dev-login/page')
    render(<DevLoginPage />)
    await userEvent.click(screen.getByText('company@dev.local'))
    await waitFor(() =>
      expect(screen.getByText(/No pudimos preparar el acceso local/)).toBeInTheDocument()
    )
    expect(mockSignIn).not.toHaveBeenCalled()
    expect(mockDevRouter.push).not.toHaveBeenCalled()
  })
})
