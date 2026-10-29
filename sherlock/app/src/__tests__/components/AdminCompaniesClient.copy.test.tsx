import { fireEvent, render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { describe, expect, it, vi } from 'vitest'

import { AdminCompaniesClient } from '@/components/admin/AdminCompaniesClient'
import esMessages from '@/messages/es.json'

vi.unmock('next-intl')
vi.mock('@/lib/dev-auth/config', () => ({ DEV_AUTH_ENABLED: true }))
vi.mock('convex/react', () => ({
  useQuery: vi.fn(() => undefined),
  usePaginatedQuery: vi.fn(() => ({ results: [], status: 'Exhausted', loadMore: vi.fn() })),
  useMutation: vi.fn(() => vi.fn()),
}))

describe('AdminCompaniesClient isPublic copy', () => {
  it('catches the admin queue presenting approved sharing as active public teasers', () => {
    render(
      <NextIntlClientProvider locale="es" messages={esMessages} timeZone="America/Panama">
        <AdminCompaniesClient />
      </NextIntlClientProvider>
    )

    expect(screen.getAllByText('Material aprobado para compartir')).not.toHaveLength(0)
    expect(screen.getByText('Materiales aprobados')).toBeInTheDocument()
    expect(screen.queryByText('Teaser activo')).not.toBeInTheDocument()
    expect(screen.queryByText('Teasers activos')).not.toBeInTheDocument()
  })

  it('opens the row company room without a self-link disguised as record review', async () => {
    render(
      <NextIntlClientProvider locale="es" messages={esMessages} timeZone="America/Panama">
        <AdminCompaniesClient />
      </NextIntlClientProvider>
    )
    const actions = screen.getAllByRole('button', { name: 'Acciones de empresa' })[0]
    const companyId = actions.closest('tr')?.id.replace('company-', '')
    expect(companyId).toBeTruthy()
    fireEvent.pointerDown(actions, { button: 0, ctrlKey: false })

    const room = await screen.findByRole('menuitem', { name: 'Abrir sala (VDR)' })
    expect(room).toHaveAttribute('href', `/admin/companies/${companyId}/documents`)
    expect(screen.queryByRole('menuitem', { name: 'Revisar registro' })).not.toBeInTheDocument()
    expect(document.querySelector('a[href*="/admin/companies#company-"]')).toBeNull()
  })
})
