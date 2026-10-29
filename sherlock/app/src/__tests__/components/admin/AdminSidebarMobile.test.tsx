import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// `useIsMobile` decide si la barra es una columna o un Sheet. Los dos casos de
// abajo cruzan ese corte a mano, que es justo lo que un viewport de jsdom no
// hace: `matchMedia` del setup siempre responde `matches: false`.
const viewport = vi.hoisted(() => ({ isMobile: true }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => viewport.isMobile }))

const mockUseQuery = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>(() => undefined))
const mockUseMutation = vi.hoisted(() => vi.fn(() => vi.fn()))
const mockUsePaginatedQuery = vi.hoisted(() =>
  vi.fn(() => ({ results: [], status: 'LoadingFirstPage', loadMore: vi.fn() }))
)

vi.mock('convex/react', () => ({
  useQuery: mockUseQuery,
  useMutation: mockUseMutation,
  usePaginatedQuery: mockUsePaginatedQuery,
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
}))

import { AdminLayout } from '@/components/admin/AdminLayout'

function renderAdminShell() {
  // `defaultSidebarOpen={false}`: la preferencia de escritorio es «contraída»,
  // que es el estado con el que el rótulo del disparador se equivocaba.
  return render(
    <AdminLayout defaultSidebarOpen={false}>
      <p>contenido</p>
    </AdminLayout>
  )
}

/** El disparador que vive dentro del Sheet, no el de la barra de arriba. */
function sheetTrigger(): HTMLElement | undefined {
  return screen
    .getAllByRole('button')
    .find(
      (button) =>
        button.dataset.slot === 'sidebar-trigger' && button.closest('[data-mobile="true"]') !== null
    )
}

describe('AdminSidebar en móvil', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    viewport.isMobile = true
  })

  // El disparador de dentro del Sheet leía `state`, que es el estado de la
  // columna de escritorio. Con la columna contraída anunciaba «Expandir menú»
  // dentro de un Sheet ya abierto, y al activarlo lo cerraba.
  it('nombra el disparador del Sheet por el Sheet, no por la columna de escritorio', () => {
    renderAdminShell()

    fireEvent.click(screen.getByRole('button', { name: 'Menú de administración' }))

    const trigger = sheetTrigger()
    expect(trigger).toBeDefined()
    expect(trigger).toHaveAccessibleName('Contraer menú')

    fireEvent.click(trigger as HTMLElement)
    expect(screen.queryByRole('button', { name: 'Contraer menú' })).not.toBeInTheDocument()
  })

  // Abrir el Sheet, pasar a escritorio y volver a móvil lo dejaba abierto otra
  // vez, con su overlay encima, sin que el usuario tocara nada.
  it('cierra el Sheet al cruzar el corte de viewport', () => {
    const { rerender } = renderAdminShell()

    fireEvent.click(screen.getByRole('button', { name: 'Menú de administración' }))
    expect(document.querySelector('[data-mobile="true"]')).not.toBeNull()

    viewport.isMobile = false
    rerender(
      <AdminLayout defaultSidebarOpen={false}>
        <p>contenido</p>
      </AdminLayout>
    )
    expect(document.querySelector('[data-mobile="true"]')).toBeNull()

    viewport.isMobile = true
    rerender(
      <AdminLayout defaultSidebarOpen={false}>
        <p>contenido</p>
      </AdminLayout>
    )
    expect(document.querySelector('[data-mobile="true"]')).toBeNull()
  })
})
