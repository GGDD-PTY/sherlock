import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDevAuthState = vi.hoisted(() => ({ enabled: true }))
const mockUsePaginatedQuery = vi.hoisted(() => vi.fn())

vi.mock('@/lib/dev-auth', () => ({
  get DEV_AUTH_ENABLED() {
    return mockDevAuthState.enabled
  },
}))

vi.mock('convex/react', () => ({
  usePaginatedQuery: mockUsePaginatedQuery,
  // ES: AdminCompaniesClient usa useMutation (setCompanyVisibility, #12).
  useMutation: vi.fn(() => vi.fn(async () => null)),
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: {
      listAdminCompaniesPaginated: 'companies.listAdminCompaniesPaginated',
    },
  },
}))

describe('Admin pipeline clients', () => {
  beforeEach(() => {
    mockDevAuthState.enabled = true
    mockUsePaginatedQuery.mockReset()
    mockUsePaginatedQuery.mockReturnValue({
      results: [],
      status: 'LoadingFirstPage',
      loadMore: vi.fn(),
    })
  })

  it('renders a demo issuer review queue in dev-auth mode', async () => {
    const { AdminCompaniesClient } = await import('@/components/admin/AdminCompaniesClient')

    render(<AdminCompaniesClient />)

    expect(screen.getByText(/En modo dev-auth se muestran empresas de ejemplo/)).toBeVisible()
    expect(screen.getByText('Sample Hydro, S. A.')).toBeInTheDocument()
    expect(screen.getByText('AgroFinance Demo')).toBeInTheDocument()
    expect(screen.getByText(/Pipeline de empresas/)).toBeInTheDocument()
    expect(mockUsePaginatedQuery).toHaveBeenCalledWith(
      'companies.listAdminCompaniesPaginated',
      'skip',
      { initialNumItems: 20 }
    )
  })
})
