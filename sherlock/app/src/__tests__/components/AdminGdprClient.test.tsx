// ============================================================================
// ADMIN GDPR CLIENT — la cola se ve y procesar exige confirmación explícita
// ============================================================================

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockProcess = vi.fn(async () => undefined)
const mockRequests = vi.fn<(args: { status?: string }) => unknown>()

vi.mock('convex/react', () => ({
  useQuery: (_query: string, args: { status?: string }) => mockRequests(args),
  useMutation: () => mockProcess,
}))

vi.mock('../../../convex/_generated/api', () => ({
  api: {
    gdpr: {
      listDeletionRequests: 'gdpr.listDeletionRequests',
      processAccountDeletion: 'gdpr.processAccountDeletion',
    },
  },
}))

import { AdminGdprClient } from '@/components/admin/AdminGdprClient'

const PENDING_REQUEST = {
  _id: 'request_1',
  email: 'usuario@example.com',
  status: 'PENDING',
  requestedAt: 1_700_000_000_000,
}

const COMPLETED_REQUEST = {
  _id: 'request_2',
  email: '[REDACTED]',
  status: 'COMPLETED',
  requestedAt: 1_600_000_000_000,
  processedAt: 1_600_100_000_000,
}

// La pantalla hace dos consultas: las pendientes salen del filtro por estado y
// el historial de las 200 más recientes. El doble responde como el backend.
function setRequests(rows: Array<Record<string, unknown>>, recent = rows) {
  mockRequests.mockImplementation((args) =>
    args?.status === 'PENDING' ? rows.filter((row) => row.status === 'PENDING') : recent
  )
}

describe('AdminGdprClient', () => {
  it('lista pendientes con su botón y el historial con su badge', () => {
    setRequests([PENDING_REQUEST, COMPLETED_REQUEST])

    render(<AdminGdprClient />)

    expect(screen.getByText('usuario@example.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Procesar eliminación/i })).toBeInTheDocument()
    expect(screen.getByText('Completada')).toBeInTheDocument()
  })

  it('procesar pasa por el diálogo de confirmación antes de llamar la mutación', async () => {
    setRequests([PENDING_REQUEST])
    mockProcess.mockClear()

    render(<AdminGdprClient />)

    fireEvent.click(screen.getByRole('button', { name: /Procesar eliminación/i }))
    // El click solo abre el diálogo: nada se ejecuta todavía.
    expect(mockProcess).not.toHaveBeenCalled()
    expect(screen.getByText(/Es irreversible/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Eliminar definitivamente/i }))
    await waitFor(() => expect(mockProcess).toHaveBeenCalledWith({ requestId: 'request_1' }))
  })

  it('sin solicitudes muestra el estado vacío, no una tabla rota', () => {
    setRequests([])

    render(<AdminGdprClient />)

    expect(screen.getByText(/No hay solicitudes de eliminación pendientes/i)).toBeInTheDocument()
  })

  // El tope de la query es 200 filas recientes. Una pendiente vieja se cae de esa
  // ventana, y separar por estado en el cliente la borraba justo de la cola que
  // hay que atender. La consulta por estado la sigue trayendo.
  it('muestra una pendiente antigua aunque las 200 recientes no la traigan', () => {
    const recientes = Array.from({ length: 200 }, (_, index) => ({
      _id: `request_recent_${index}`,
      email: `reciente${index}@example.com`,
      status: 'COMPLETED',
      requestedAt: 1_700_000_000_000 + index,
      processedAt: 1_700_000_100_000 + index,
    }))
    const antigua = {
      _id: 'request_old',
      email: 'antigua@example.com',
      status: 'PENDING',
      requestedAt: 1_500_000_000_000,
    }
    setRequests([antigua], recientes)

    render(<AdminGdprClient />)

    expect(screen.getByText('antigua@example.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Procesar eliminación/i })).toBeInTheDocument()
    expect(
      screen.queryByText(/No hay solicitudes de eliminación pendientes/i)
    ).not.toBeInTheDocument()
  })
})
