import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseQuery = vi.hoisted(() => vi.fn())
const mockUseMutation = vi.hoisted(() => vi.fn(() => vi.fn()))
const mockUseAction = vi.hoisted(() => vi.fn(() => vi.fn()))
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

describe('MyCompanyDocumentsClient company scope', () => {
  beforeEach(() => {
    mockUseQuery.mockReset()
    mockUseMutation.mockClear()
    mockUseQuery.mockReturnValue([])
    mockNavigation.search = ''
    mockNavigation.push.mockReset()
    mockNavigation.replace.mockReset()
    mockNavigation.refresh.mockReset()
  })

  it('normalizes a stale deal-room URL to the company library without probing the deal', async () => {
    mockNavigation.search = 'room=deal%3Adeal_1&view=access&category=financials&q=forecast'
    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(<MyCompanyDocumentsClient companyId="company_1" companyName="Example Company" />)

    expect(screen.getByRole('heading', { name: 'Data Room' })).toBeVisible()
    expect(screen.queryByText('Biblioteca corporativa')).not.toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(mockUseQuery).toHaveBeenCalledWith('documents.getByCompany', {
      companyId: 'company_1',
    })
    expect(mockUseQuery).not.toHaveBeenCalledWith(
      'documents.getByCompany',
      expect.objectContaining({ dealId: expect.anything() })
    )

    await waitFor(() => expect(mockNavigation.replace).toHaveBeenCalled())
    const [normalizedHref] = mockNavigation.replace.mock.calls.at(-1) ?? []
    expect(normalizedHref).toContain('room=company')
    expect(normalizedHref).toContain('view=documents')
    expect(normalizedHref).toContain('category=financials')
    expect(normalizedHref).toContain('q=forecast')
  })

  it('keeps the company document search state in the URL', async () => {
    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    render(<MyCompanyDocumentsClient companyId="company_1" companyName="Example Company" />)

    await userEvent.type(screen.getByRole('textbox', { name: 'Buscar documentos' }), 'f')
    expect(mockNavigation.replace).toHaveBeenCalledWith(expect.stringContaining('q=f'), {
      scroll: false,
    })
  })

  it('replaces a stalled loading skeleton with a recoverable workspace state', async () => {
    vi.useFakeTimers()
    mockUseQuery.mockReturnValue(undefined)
    const { MyCompanyDocumentsClient } =
      await import('@/components/company/MyCompanyDocumentsClient')

    try {
      render(<MyCompanyDocumentsClient companyId="company_1" companyName="Example Company" />)
      expect(screen.getByRole('status', { name: '' })).toHaveTextContent(
        'Cargando tu Data Room seguro'
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000)
      })

      expect(screen.getByRole('heading', { name: 'No pudimos cargar este espacio' })).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'Intentar de nuevo' }))
      expect(mockNavigation.refresh).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
