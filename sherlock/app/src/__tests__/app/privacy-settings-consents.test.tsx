// ============================================================================
// PRIVACIDAD — los interruptores no se pueden tocar antes de saber su valor
// ============================================================================
// La página esperaba a `userLoading` y nada más. Con la query de consentimientos
// todavía en `undefined`, cada interruptor se pintaba apagado y usable: un clic
// ahí escribía sobre un valor que la pantalla no conocía.
// ============================================================================

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUseCurrentUser, mockUseQuery, mockConvexQuery } = vi.hoisted(() => ({
  mockUseCurrentUser: vi.fn(),
  mockUseQuery: vi.fn(),
  mockConvexQuery: vi.fn(),
}))

vi.mock('next-intl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl')>()
  const es = await import('@/messages/es.json')

  return {
    ...actual,
    useTranslations: (namespace: string) =>
      actual.createTranslator({
        locale: 'es',
        messages: es.default,
        namespace: namespace as never,
      }),
  }
})

vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mockUseCurrentUser(),
}))

vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => vi.fn(),
  useConvex: () => ({ query: mockConvexQuery }),
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    gdpr: {
      getUserConsents: 'gdpr.getUserConsents',
      getPendingDeletionRequest: 'gdpr.getPendingDeletionRequest',
      recordConsent: 'gdpr.recordConsent',
      requestAccountDeletion: 'gdpr.requestAccountDeletion',
      exportUserData: 'gdpr.exportUserData',
    },
  },
}))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

import { PrivacySettingsClient } from '@/app/[locale]/(app)/settings/privacy/PrivacySettingsClient'

function setQueries(consents: unknown, pendingDeletion: unknown) {
  mockUseQuery.mockImplementation((query: string) => {
    if (query === 'gdpr.getUserConsents') return consents
    if (query === 'gdpr.getPendingDeletionRequest') return pendingDeletion
    return undefined
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUseCurrentUser.mockReturnValue({
    profile: { _id: 'profile_1' },
    isLoading: false,
  })
})

describe('ajustes de privacidad — carga de consentimientos', () => {
  it('reuses the privacy loading skeleton while the profile loads', () => {
    mockUseCurrentUser.mockReturnValue({
      profile: null,
      isLoading: true,
    })

    const { container } = render(<PrivacySettingsClient />)

    expect(screen.queryByRole('switch')).toBeNull()
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(4)
    expect(screen.getAllByTestId('loading-skeleton-toggleRow')).toHaveLength(3)
  })

  it('deja los interruptores inertes mientras la consulta no resuelve', () => {
    setQueries(undefined, undefined)

    render(<PrivacySettingsClient />)

    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(3)
    for (const control of switches) {
      expect(control).toBeDisabled()
      expect(control).toHaveAttribute('aria-checked', 'false')
    }
    // El contenedor lo dice para quien no ve el estado deshabilitado.
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
    // Sin saber si ya hay una solicitud viva, la eliminación tampoco se abre.
    expect(screen.getByRole('button', { name: 'Solicitar eliminación de cuenta' })).toBeDisabled()
  })

  it('con la lista cargada refleja lo guardado y suelta los opcionales', () => {
    // La fila de `third_party_sharing` sigue en Convex: el interruptor salió de
    // la pantalla el 2026-09-11 pero lo ya escrito queda en custodia, así que la
    // lista que llega trae un tipo que esta pantalla ya no pinta.
    setQueries(
      [
        { consentType: 'marketing_emails', accepted: true },
        { consentType: 'third_party_sharing', accepted: false },
      ],
      null
    )

    render(<PrivacySettingsClient />)

    const switches = screen.getAllByRole('switch')
    // El orden es el del vocabulario: términos, política, marketing.
    expect(switches).toHaveLength(3)
    expect(switches[0]).toBeDisabled()
    expect(switches[1]).toBeDisabled()
    expect(switches[2]).toBeEnabled()
    expect(switches[2]).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('button', { name: 'Solicitar eliminación de cuenta' })).toBeEnabled()
  })
})

const DELETION_REASON_NAME = '¿Por qué deseas eliminar tu cuenta? (opcional)'

describe('motivo de eliminación', () => {
  it('encuentra el textarea del motivo por el rótulo de al lado', async () => {
    setQueries([], null)
    render(<PrivacySettingsClient />)
    await userEvent.click(screen.getByRole('button', { name: 'Solicitar eliminación de cuenta' }))

    expect(screen.getByRole('textbox', { name: DELETION_REASON_NAME })).toHaveValue('')
  })

  it('sigue encontrando el textarea del motivo por el rótulo después de escribir', async () => {
    setQueries([], null)
    render(<PrivacySettingsClient />)
    await userEvent.click(screen.getByRole('button', { name: 'Solicitar eliminación de cuenta' }))
    await userEvent.type(
      screen.getByRole('textbox', { name: DELETION_REASON_NAME }),
      'Cierro la empresa'
    )

    expect(screen.getByRole('textbox', { name: DELETION_REASON_NAME })).toHaveValue(
      'Cierro la empresa'
    )
  })
})

describe('exportación de datos', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('revoca el object URL en el siguiente turno, no al hacer click', async () => {
    vi.useFakeTimers()
    setQueries([], null)
    const pending = Promise.withResolvers<unknown>()
    mockConvexQuery.mockReturnValue(pending.promise)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL')

    render(<PrivacySettingsClient />)
    fireEvent.click(screen.getByRole('button', { name: 'Exportar JSON' }))

    await act(async () => {
      pending.resolve({ profileId: 'profile_1' })
    })

    expect(click).toHaveBeenCalled()
    expect(createObjectURL).toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()

    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
    click.mockRestore()
    createObjectURL.mockRestore()
    revokeObjectURL.mockRestore()
  })
})
