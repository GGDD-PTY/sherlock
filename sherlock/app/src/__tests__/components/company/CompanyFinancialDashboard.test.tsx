import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Id } from '@/../convex/_generated/dataModel'
import { CompanyFinancialDashboard } from '@/components/company/CompanyFinancialDashboard'

const mockUseQuery = vi.hoisted(() => vi.fn())
const queryMounts = vi.hoisted(() => ({ current: 0 }))
const prefetchXlsxSidecar = vi.hoisted(() => vi.fn())

vi.mock('@/components/documents/viewers/xlsxSidecarPrefetch', () => ({
  prefetchXlsxSidecar,
}))

vi.mock('convex/react', async () => {
  const { useRef } = await import('react')
  return {
    useQuery: (...args: unknown[]) => {
      const isMounted = useRef(false)
      if (!isMounted.current) {
        isMounted.current = true
        queryMounts.current += 1
      }
      return mockUseQuery(...args)
    },
  }
})

describe('CompanyFinancialDashboard empty state', () => {
  beforeEach(() => {
    mockUseQuery.mockReset().mockReturnValue(null)
    queryMounts.current = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing and reports unavailable when no view is published', () => {
    const onAvailabilityChange = vi.fn()
    const { container } = render(
      <CompanyFinancialDashboard
        companyId={'company_1' as Id<'companies'>}
        isDemo
        onOpenSource={() => {}}
        onAvailabilityChange={onAvailabilityChange}
      />
    )

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText(/vista financiera/)).not.toBeInTheDocument()
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(false)
  })

  it('offers retry when the financial snapshot does not resolve in 12 seconds', async () => {
    vi.useFakeTimers()
    mockUseQuery.mockImplementation(() => {})
    render(
      <CompanyFinancialDashboard
        companyId={'company_1' as Id<'companies'>}
        isDemo={false}
        onOpenSource={() => {}}
      />
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })

    expect(screen.getByTestId('financial-dashboard-load-failure')).toHaveTextContent(
      'No pudimos cargar esta sección.'
    )
    const mountsBeforeRetry = queryMounts.current
    fireEvent.click(screen.getByRole('button', { name: 'Intentar de nuevo' }))
    expect(queryMounts.current).toBeGreaterThan(mountsBeforeRetry)
    expect(screen.getByRole('status')).toHaveTextContent('Cargando la vista financiera…')
  })
})

// El tablero de Preparación es el camino por el que el cliente llega a un libro
// sin pasar por la lista del Data Room: una cifra citada con hoja y rango abre
// el visor XLSX en la sala, y su sidecar son 17 MB de primera vez.
describe('CompanyFinancialDashboard sidecar prefetch', () => {
  // El `IntersectionObserver` global del setup es una `vi.fn()` con
  // `mockReturnValue`, y llamarla con `new` revienta en Vitest 4. La sección
  // publicada sí observa su propio nodo, así que acá se usa una clase de
  // verdad que no hace nada.
  class NoopIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }

  beforeEach(() => {
    mockUseQuery.mockReset()
    prefetchXlsxSidecar.mockReset()
    queryMounts.current = 0
    vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  type Locator = { kind: 'PAGE'; page: number } | { kind: 'CELL'; sheet: string; range: string }

  function snapshot(locator: Locator) {
    return {
      status: 'READY' as const,
      publishedAt: 1_757_000_000_000,
      reviewedBy: 'Equipo de Sherlock' as const,
      reviewNote: 'Cifras revisadas.',
      metrics: [
        {
          metric: 'REVENUE' as const,
          period: '2024',
          periodEnd: '2024-12-31',
          value: 1000,
          currency: 'USD' as const,
          source: {
            documentId: 'document_1' as Id<'documents'>,
            versionId: 'version_1' as Id<'documentVersions'>,
            documentName: 'Modelo financiero.xlsx',
            versionNumber: 1,
            locator,
          },
        },
      ],
    }
  }

  function renderDashboard() {
    render(
      <CompanyFinancialDashboard
        companyId={'company_1' as Id<'companies'>}
        isDemo={false}
        onOpenSource={() => {}}
      />
    )
  }

  it('warms the sidecar cache when a published figure cites a workbook', () => {
    mockUseQuery.mockReturnValue(snapshot({ kind: 'CELL', sheet: 'P&L', range: 'B12' }))

    renderDashboard()

    expect(prefetchXlsxSidecar).toHaveBeenCalledTimes(1)
  })

  it('does not warm it when every figure cites a page of a PDF', () => {
    mockUseQuery.mockReturnValue(snapshot({ kind: 'PAGE', page: 3 }))

    renderDashboard()

    expect(prefetchXlsxSidecar).not.toHaveBeenCalled()
  })
})
