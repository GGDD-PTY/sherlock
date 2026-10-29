import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseQuery = vi.hoisted(() => vi.fn())
const mockUseMutation = vi.hoisted(() => vi.fn<(ref: unknown) => unknown>(() => vi.fn()))
const mockUseAction = vi.hoisted(() => vi.fn(() => vi.fn()))
const updateCompanySpy = vi.hoisted(() => vi.fn())
const mockNavigation = vi.hoisted(() => ({
  pathname: '/my-company/documents',
  search: '',
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('next-intl', () => ({
  useLocale: () => 'es',
  useTranslations: () => (key: string) => key,
}))
vi.mock('convex/react', () => ({
  useQuery: mockUseQuery,
  useMutation: mockUseMutation,
  useAction: mockUseAction,
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mockNavigation.search),
}))
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href, ...props }: React.ComponentProps<'a'>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => mockNavigation.pathname,
  useRouter: () => ({
    push: mockNavigation.push,
    replace: mockNavigation.replace,
    refresh: mockNavigation.refresh,
  }),
}))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user_company', role: 'COMPANY' },
    isSignedIn: true,
  }),
}))
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: { email: 'owner@example.com' },
    profile: { phone: null },
    isLoading: false,
  }),
}))
vi.mock('@/components/company/SupportThread', () => ({
  SupportThread: () => <section data-testid="support-thread">Support</section>,
}))
vi.mock('@/components/company/RoomProgressPanel', () => ({ RoomProgressPanel: () => null }))
vi.mock('@/components/vdr-guest/CompanyGuestPanel', () => ({ CompanyGuestPanel: () => null }))
vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: {
      updateCompany: 'companies.updateCompany',
    },
    deliverables: {
      listForCompany: 'deliverables.listForCompany',
    },
    financialSnapshots: {
      getForCompany: 'financialSnapshots.getForCompany',
    },
    documents: {
      getByCompany: 'documents.getByCompany',
      update: 'documents.update',
      getDownloadUrl: 'documents.getDownloadUrl',
      generateUploadUrl: 'documents.generateUploadUrl',
      registerDirectUpload: 'documents.registerDirectUpload',
      inspectAndRegisterDirectUpload: 'documents.inspectAndRegisterDirectUpload',
    },
  },
}))

describe('MyCompanyDocumentsClient company rename', () => {
  beforeEach(() => {
    mockUseQuery.mockReset()
    mockUseQuery.mockReturnValue([])
    mockUseMutation.mockReset()
    updateCompanySpy.mockReset()
    updateCompanySpy.mockResolvedValue(undefined)
    mockUseMutation.mockImplementation((ref: unknown) =>
      ref === 'companies.updateCompany' ? updateCompanySpy : vi.fn()
    )
    mockNavigation.search = ''
    mockNavigation.push.mockReset()
    mockNavigation.replace.mockReset()
    mockNavigation.refresh.mockReset()
  })

  // La sección se nombra con `aria-labelledby="room-shell-heading"`, así que el
  // h2 sigue montado durante la edición y solo se esconde en visual.
  it('swaps the cover heading for an input seeded with the current name', async () => {
    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(<MyCompanyDocumentsClient companyId="company_1" companyName="Sherlock" />)

    await userEvent.click(screen.getByTestId('room-cover-rename'))

    const input = await screen.findByTestId('room-cover-name-input')
    expect(input).toHaveValue('Sherlock')
    expect(screen.getByTestId('room-cover-name')).toHaveClass('sr-only')
    expect(screen.getByRole('region', { name: 'Sherlock' })).toBeInTheDocument()
  })

  it('commits the new name with Enter and shows it on the cover', async () => {
    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(<MyCompanyDocumentsClient companyId="company_1" companyName="Sherlock" />)

    await userEvent.click(screen.getByTestId('room-cover-rename'))
    const input = await screen.findByTestId('room-cover-name-input')
    await userEvent.clear(input)
    await userEvent.type(input, 'Sample Hydro, S.A.{Enter}')

    await waitFor(() => expect(updateCompanySpy).toHaveBeenCalledOnce())
    expect(updateCompanySpy).toHaveBeenCalledWith({
      companyId: 'company_1',
      name: 'Sample Hydro, S.A.',
    })
    await waitFor(() =>
      expect(screen.getByTestId('room-cover-name')).toHaveTextContent('Sample Hydro, S.A.')
    )
  })

  it('commits the new name with the save button', async () => {
    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(<MyCompanyDocumentsClient companyId="company_1" companyName="Sherlock" />)

    await userEvent.click(screen.getByTestId('room-cover-rename'))
    const input = await screen.findByTestId('room-cover-name-input')
    await userEvent.clear(input)
    await userEvent.type(input, 'Sample Hydro, S.A.')
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }))

    await waitFor(() => expect(updateCompanySpy).toHaveBeenCalledOnce())
    expect(updateCompanySpy).toHaveBeenCalledWith({
      companyId: 'company_1',
      name: 'Sample Hydro, S.A.',
    })
    await waitFor(() =>
      expect(screen.getByTestId('room-cover-name')).toHaveTextContent('Sample Hydro, S.A.')
    )
  })

  it('discards the draft on Escape without calling the mutation', async () => {
    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(<MyCompanyDocumentsClient companyId="company_1" companyName="Sherlock" />)

    await userEvent.click(screen.getByTestId('room-cover-rename'))
    const input = await screen.findByTestId('room-cover-name-input')
    await userEvent.clear(input)
    await userEvent.type(input, 'Sample Hydro, S.A.{Escape}')

    await waitFor(() => expect(screen.getByTestId('room-cover-name')).toHaveTextContent('Sherlock'))
    expect(screen.getByTestId('room-cover-name')).not.toHaveClass('sr-only')
    expect(screen.queryByTestId('room-cover-name-input')).not.toBeInTheDocument()
    expect(updateCompanySpy).not.toHaveBeenCalled()
  })

  it('hides the rename affordance in the demo room', async () => {
    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(<MyCompanyDocumentsClient companyId="company_1" companyName="Sherlock" isDemo />)

    expect(await screen.findByTestId('room-cover-name')).toHaveTextContent('Sherlock')
    expect(screen.queryByTestId('room-cover-rename')).not.toBeInTheDocument()
  })
})
