import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockDevAuthState = vi.hoisted(() => ({ enabled: true }))
const mockUsePaginatedQuery = vi.hoisted(() => vi.fn())

vi.mock('@/lib/dev-auth', () => ({
  get DEV_AUTH_ENABLED() {
    return mockDevAuthState.enabled
  },
}))

vi.mock('convex/react', () => ({
  usePaginatedQuery: mockUsePaginatedQuery,
  useMutation: vi.fn(() => vi.fn()),
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: {
      listAdminCompaniesPaginated: 'companies.listAdminCompaniesPaginated',
    },
  },
}))

const SEEDED_COMPANIES = [
  {
    _id: 'seed_company_1',
    _creationTime: 1_700_000_000_000,
    name: 'Sintética Uno, S. A.',
    country: 'PA',
    industry: 'renewable_utilities',
    isPublic: true,
    ownerEmail: 'company@dev.local',
  },
  {
    _id: 'seed_company_2',
    _creationTime: 1_700_100_000_000,
    name: 'Sintética Dos, S. A.',
    country: 'PA',
    industry: 'Logística y transporte marítimo',
    isPublic: false,
    ownerEmail: 'company2@dev.local',
  },
]

describe('AdminCompaniesClient local Convex', () => {
  beforeEach(() => {
    mockDevAuthState.enabled = true
    mockUsePaginatedQuery.mockReset()
    mockUsePaginatedQuery.mockReturnValue({
      results: SEEDED_COMPANIES,
      status: 'Exhausted',
      loadMore: vi.fn(),
    })
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3300')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('renders useQuery rows when the local admin key is present', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY', 'anonymous-agent|local-admin-key')
    const { AdminCompaniesClient } = await import('@/components/admin/AdminCompaniesClient')

    render(<AdminCompaniesClient />)

    expect(screen.getByText('Sintética Uno, S. A.')).toBeInTheDocument()
    expect(screen.getByText('company@dev.local')).toBeInTheDocument()
    expect(screen.getByText('Sintética Dos, S. A.')).toBeInTheDocument()
    expect(screen.getByText('company2@dev.local')).toBeInTheDocument()
    expect(screen.getAllByText('Panamá')).toHaveLength(2)
    // [F] 2026-09-17: la industria es texto libre y la tabla pinta lo guardado
    // tal cual. La primera fila trae un código de antes del corte: se muestra
    // como está, sin traducirlo a una etiqueta que ya no existe.
    expect(screen.getByText('renewable_utilities')).toBeInTheDocument()
    expect(screen.getByText('Logística y transporte marítimo')).toBeInTheDocument()
    expect(screen.queryByText('PA')).not.toBeInTheDocument()
    expect(screen.queryByText('AgroFinance Demo')).not.toBeInTheDocument()
    expect(screen.queryByText(/En modo dev-auth se muestran empresas de ejemplo/)).toBeNull()
    expect(mockUsePaginatedQuery).toHaveBeenCalledWith(
      'companies.listAdminCompaniesPaginated',
      {},
      { initialNumItems: 20 }
    )
  })

  it('renders demo fixtures when the local admin key is missing', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY', '')
    const { AdminCompaniesClient } = await import('@/components/admin/AdminCompaniesClient')

    render(<AdminCompaniesClient />)

    expect(screen.getByText(/En modo dev-auth se muestran empresas de ejemplo/)).toBeVisible()
    expect(screen.getByText('AgroFinance Demo')).toBeInTheDocument()
    expect(screen.queryByText('Sintética Uno, S. A.')).not.toBeInTheDocument()
    expect(mockUsePaginatedQuery).toHaveBeenCalledWith(
      'companies.listAdminCompaniesPaginated',
      'skip',
      { initialNumItems: 20 }
    )
  })
  // ==========================================================================
  // La cola pagina por cursor: el filtro de texto corre sobre lo cargado, así
  // que buscar tiene que arrastrar las páginas siguientes, y las cifras no
  // pueden presentar la página como si fuera la tabla entera.
  // ==========================================================================

  it('arrastra las páginas siguientes mientras el equipo busca', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY', 'anonymous-agent|local-admin-key')
    mockDevAuthState.enabled = false
    const loadMore = vi.fn(() => {})
    mockUsePaginatedQuery.mockReturnValue({
      results: SEEDED_COMPANIES,
      status: 'CanLoadMore',
      loadMore,
    })
    const { AdminCompaniesClient } = await import('@/components/admin/AdminCompaniesClient')

    render(<AdminCompaniesClient />)
    expect(loadMore).not.toHaveBeenCalled()

    await userEvent.type(screen.getByPlaceholderText(/Buscar por nombre/), 'sintética')

    await waitFor(() => {
      expect(loadMore).toHaveBeenCalledWith(20)
    })
  })

  it('marca las cifras con «+» mientras el cursor tenga más páginas', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY', 'anonymous-agent|local-admin-key')
    mockDevAuthState.enabled = false
    mockUsePaginatedQuery.mockReturnValue({
      results: SEEDED_COMPANIES,
      status: 'CanLoadMore',
      loadMore: vi.fn(() => {}),
    })
    const { AdminCompaniesClient } = await import('@/components/admin/AdminCompaniesClient')

    const { unmount } = render(<AdminCompaniesClient />)
    expect(screen.getByText('2+')).toBeInTheDocument()
    expect(screen.getByText(/Pipeline de empresas \(2\+\)/)).toBeInTheDocument()
    unmount()

    mockUsePaginatedQuery.mockReturnValue({
      results: SEEDED_COMPANIES,
      status: 'Exhausted',
      loadMore: vi.fn(() => {}),
    })
    render(<AdminCompaniesClient />)
    expect(screen.queryByText('2+')).not.toBeInTheDocument()
    expect(screen.getByText(/Pipeline de empresas \(2\)/)).toBeInTheDocument()
  })

  it('distinguishes two companies with the same name by owner email', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY', 'anonymous-agent|local-admin-key')
    mockDevAuthState.enabled = false
    mockUsePaginatedQuery.mockReturnValue({
      results: [
        {
          _id: 'samplefoods_a',
          _creationTime: 1_700_200_000_000,
          name: 'Sample Foods, S.A.',
          country: 'PA',
          ownerEmail: 'sample-foods-a@dev.local',
        },
        {
          _id: 'samplefoods_b',
          _creationTime: 1_700_200_000_001,
          name: 'Sample Foods, S.A.',
          country: 'PA',
          ownerEmail: 'sample-foods-b@dev.local',
        },
      ],
      status: 'Exhausted',
      loadMore: vi.fn(() => {}),
    })
    const { AdminCompaniesClient } = await import('@/components/admin/AdminCompaniesClient')

    render(<AdminCompaniesClient />)

    expect(screen.getAllByText('Sample Foods, S.A.')).toHaveLength(2)
    expect(screen.getByText('sample-foods-a@dev.local')).toBeVisible()
    expect(screen.getByText('sample-foods-b@dev.local')).toBeVisible()

    await userEvent.type(screen.getByPlaceholderText(/Buscar por nombre/), 'sample-foods-b@')
    expect(screen.getByText('sample-foods-b@dev.local')).toBeVisible()
    expect(screen.queryByText('sample-foods-a@dev.local')).not.toBeInTheDocument()
  })
})
