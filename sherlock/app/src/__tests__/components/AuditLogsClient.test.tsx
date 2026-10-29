import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseQuery = vi.hoisted(() => vi.fn())
const mockUsePaginatedQuery = vi.hoisted(() => vi.fn())
const mockLoadMore = vi.hoisted(() => vi.fn())
const mockDevAuth = vi.hoisted(() => ({ enabled: true }))

vi.mock('convex/react', () => ({
  useQuery: mockUseQuery,
  usePaginatedQuery: mockUsePaginatedQuery,
}))

vi.mock('@/lib/dev-auth/config', () => ({
  get DEV_AUTH_ENABLED() {
    return mockDevAuth.enabled
  },
}))

vi.mock('../../../convex/_generated/api', () => ({
  api: {
    adminAuditLogs: {
      list: 'adminAuditLogs:list',
      getStats: 'adminAuditLogs:getStats',
    },
  },
}))

describe('AuditLogsClient', () => {
  beforeEach(() => {
    mockUseQuery.mockReset()
    mockUsePaginatedQuery.mockReset()
    mockLoadMore.mockReset()
    mockDevAuth.enabled = true
    mockUsePaginatedQuery.mockReturnValue({
      results: [],
      status: 'LoadingFirstPage',
      isLoading: true,
      loadMore: mockLoadMore,
    })
  })

  it('uses local demo audit log data instead of protected Convex queries in dev-auth', async () => {
    mockUseQuery.mockReturnValue(undefined)

    const { AuditLogsClient } = await import('@/components/admin/AuditLogsClient')
    render(<AuditLogsClient />)

    expect(mockUsePaginatedQuery).toHaveBeenCalledWith('adminAuditLogs:list', 'skip', {
      initialNumItems: 50,
    })
    expect(mockUseQuery).toHaveBeenCalledWith('adminAuditLogs:getStats', 'skip')

    expect(screen.getByText('Muestra local de auditoría para dev-auth')).toBeInTheDocument()
    expect(screen.getByText('Empresa demo verificada para la revisión controlada del teaser')).toBeInTheDocument()
  })

  it('does not offer load-more for the demo snapshot (paginated query skipped)', async () => {
    mockUseQuery.mockReturnValue(undefined)

    const { AuditLogsClient } = await import('@/components/admin/AuditLogsClient')
    render(<AuditLogsClient />)

    expect(screen.queryByTestId('audit-logs-load-more')).not.toBeInTheDocument()
  })

  it('requests the next 50 audit logs when another page is available', async () => {
    mockDevAuth.enabled = false
    mockUseQuery.mockReturnValue({
      recentLogs: 1,
      byCategory: { user: 1, deal: 0, kyc: 0, nda: 0, other: 0 },
    })
    mockUsePaginatedQuery.mockReturnValue({
      results: [
        {
          _id: 'log_1',
          _creationTime: 1_700_000_000_000,
          adminName: 'Sherlock Admin',
          action: 'USER_ROLE_CHANGE',
          targetType: 'USER',
        },
      ],
      status: 'CanLoadMore',
      isLoading: false,
      loadMore: mockLoadMore,
    })

    const { AuditLogsClient } = await import('@/components/admin/AuditLogsClient')
    render(<AuditLogsClient />)

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }))

    expect(mockLoadMore).toHaveBeenCalledWith(50)
  })

  it('disables pagination while the next audit-log page is loading', async () => {
    mockDevAuth.enabled = false
    mockUseQuery.mockReturnValue({
      recentLogs: 1,
      byCategory: { user: 1, deal: 0, kyc: 0, nda: 0, other: 0 },
    })
    mockUsePaginatedQuery.mockReturnValue({
      results: [
        {
          _id: 'log_1',
          _creationTime: 1_700_000_000_000,
          adminName: 'Sherlock Admin',
          action: 'USER_ROLE_CHANGE',
          targetType: 'USER',
        },
      ],
      status: 'LoadingMore',
      isLoading: true,
      loadMore: mockLoadMore,
    })

    const { AuditLogsClient } = await import('@/components/admin/AuditLogsClient')
    render(<AuditLogsClient />)

    expect(screen.getByRole('button', { name: 'Cargando...' })).toBeDisabled()
  })

  it('muestra el nombre legible del evento canónico de actualización documental', async () => {
    mockDevAuth.enabled = false
    mockUseQuery.mockReturnValue({
      totalLogs: 1,
      totalLogsCapped: false,
      recentLogs: 1,
      byCategory: { user: 0, deal: 0, kyc: 0, nda: 0, other: 1 },
    })
    mockUsePaginatedQuery.mockReturnValue({
      results: [
        {
          _id: 'log_document_update',
          _creationTime: 1_700_000_000_000,
          adminName: 'Sherlock Admin',
          action: 'DOCUMENT_METADATA_UPDATE',
          targetType: 'DOCUMENT',
        },
      ],
      status: 'Exhausted',
      isLoading: false,
      loadMore: mockLoadMore,
    })

    const { AuditLogsClient } = await import('@/components/admin/AuditLogsClient')
    render(<AuditLogsClient />)

    expect(screen.getByText('Metadatos del documento actualizados')).toBeInTheDocument()
    expect(screen.queryByText('DOCUMENT_METADATA_UPDATE')).not.toBeInTheDocument()
  })

  it('presenta el archivo documental como acción reversible y no como eliminación', async () => {
    mockDevAuth.enabled = false
    mockUseQuery.mockReturnValue({
      totalLogs: 1,
      totalLogsCapped: false,
      recentLogs: 1,
      byCategory: { user: 0, deal: 0, kyc: 0, nda: 0, other: 1 },
    })
    mockUsePaginatedQuery.mockReturnValue({
      results: [
        {
          _id: 'log_document_archive',
          _creationTime: 1_700_000_000_000,
          adminName: 'Sherlock Admin',
          action: 'DOCUMENT_ARCHIVE',
          targetType: 'DOCUMENT',
        },
      ],
      status: 'Exhausted',
      isLoading: false,
      loadMore: mockLoadMore,
    })

    const { AuditLogsClient } = await import('@/components/admin/AuditLogsClient')
    render(<AuditLogsClient />)

    expect(screen.getByText('Documento archivado')).toBeInTheDocument()
    expect(screen.queryByText('Documento eliminado')).not.toBeInTheDocument()
  })

  // ==========================================================================
  // CAPPED STATS HONESTY (W6a UI follow-up, #211/#212)
  // ==========================================================================
  // `adminAuditLogs.getStats` bounds its historical count probe and returns
  // `totalLogsCapped` when the real total exceeds TOTAL_LOGS_CAP. The UI must
  // surface that instead of showing the capped number as an exact total.
  // ==========================================================================

  it('totalLogsCapped=true: el total muestra sufijo "+" con title/aria-label explicativo', async () => {
    mockDevAuth.enabled = false
    mockUseQuery.mockReturnValue({
      totalLogs: 5000,
      totalLogsCapped: true,
      recentLogs: 12,
      byCategory: { user: 5, deal: 4, kyc: 3, nda: 0, other: 0 },
    })
    mockUsePaginatedQuery.mockReturnValue({
      results: [],
      status: 'Exhausted',
      isLoading: false,
      loadMore: mockLoadMore,
    })

    const { AuditLogsClient } = await import('@/components/admin/AuditLogsClient')
    render(<AuditLogsClient />)

    const totalValue = screen.getByText('5000+')
    expect(totalValue).toBeInTheDocument()
    expect(totalValue).toHaveAttribute('title')
    expect(totalValue.getAttribute('title')).not.toBe('')
    expect(totalValue).toHaveAttribute('aria-label')
  })

  it('totalLogsCapped=false: el total se muestra tal cual, sin sufijo ni tooltip', async () => {
    mockDevAuth.enabled = false
    mockUseQuery.mockReturnValue({
      totalLogs: 42,
      totalLogsCapped: false,
      recentLogs: 12,
      byCategory: { user: 5, deal: 4, kyc: 3, nda: 0, other: 0 },
    })
    mockUsePaginatedQuery.mockReturnValue({
      results: [],
      status: 'Exhausted',
      isLoading: false,
      loadMore: mockLoadMore,
    })

    const { AuditLogsClient } = await import('@/components/admin/AuditLogsClient')
    render(<AuditLogsClient />)

    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('42')).not.toHaveAttribute('title')
    expect(screen.queryByText('42+')).not.toBeInTheDocument()
  })

  it('says loading instead of zero actions while the first page is unresolved', async () => {
    mockDevAuth.enabled = false
    mockUseQuery.mockImplementation(() => {})
    mockUsePaginatedQuery.mockReturnValue({
      results: undefined,
      status: 'LoadingFirstPage',
      isLoading: true,
      loadMore: mockLoadMore,
    })

    const { AuditLogsClient } = await import('@/components/admin/AuditLogsClient')
    render(<AuditLogsClient />)

    expect(screen.getByText('Cargando acciones…')).toBeVisible()
    expect(screen.queryByText('0 acciones registradas')).not.toBeInTheDocument()
  })
})
