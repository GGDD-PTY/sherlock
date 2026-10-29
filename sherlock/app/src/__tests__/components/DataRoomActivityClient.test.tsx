import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseQuery = vi.hoisted(() => vi.fn())
const queryMounts = vi.hoisted(() => ({ current: 0 }))

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

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    documents: {
      getRoomActivity: 'documents.getRoomActivity',
    },
  },
}))

import { DataRoomActivityClient } from '@/components/company/data-room-activity/DataRoomActivityClient'

function counters(overrides: Partial<Record<string, number>> = {}) {
  return { views: 0, downloads: 0, links: 0, blocked: 0, other: 0, ...overrides }
}

const ACTIVITY = {
  windowDays: 30,
  scanCap: 500,
  scannedCount: 6,
  truncated: false,
  totals: counters({ views: 4, downloads: 2, links: 2, blocked: 1 }),
  documentCount: 2,
  counterpartyCount: 2,
  byDocument: [
    {
      documentId: 'doc_1',
      name: 'Estados financieros 2026',
      folder: 'financials',
      accessLevel: 'NDA_REQUIRED' as const,
      counters: counters({ views: 3, downloads: 2, blocked: 1 }),
      counterpartyCount: 2,
      lastAccessAt: Date.UTC(2027, 0, 15, 2, 0, 0),
    },
    {
      documentId: 'doc_2',
      name: 'Teaser',
      folder: 'teaser',
      accessLevel: 'PUBLIC' as const,
      counters: counters({ views: 1 }),
      counterpartyCount: 1,
      lastAccessAt: Date.UTC(2027, 0, 10, 2, 0, 0),
    },
  ],
  byCounterparty: [
    {
      key: 'cp_1t8w4qz9m0a3f2', // gitleaks:allow -- deterministic test fixture, not a provider credential
      code: 'A3F2',
      kind: 'UNKNOWN' as const,
      displayName: null,
      identityRevealed: false,
      counters: counters({ views: 3, downloads: 1 }),
      documentCount: 2,
      lastAccessAt: Date.UTC(2027, 0, 15, 2, 0, 0),
    },
  ],
  events: [
    {
      id: 'log_1',
      at: Date.UTC(2027, 0, 15, 2, 0, 0),
      kind: 'VIEW' as const,
      documentId: 'doc_1',
      counterpartyKey: 'cp_1t8w4qz9m0a3f2', // gitleaks:allow -- deterministic test fixture, not a provider credential
      accessLevel: 'NDA_REQUIRED' as const,
    },
    {
      id: 'log_2',
      at: Date.UTC(2027, 0, 15, 1, 0, 0),
      kind: 'DOWNLOAD' as const,
      documentId: 'doc_1',
      counterpartyKey: 'cp_1t8w4qz9m0a3f2', // gitleaks:allow -- deterministic test fixture, not a provider credential
      accessLevel: 'NDA_REQUIRED' as const,
    },
    {
      id: 'log_3',
      at: Date.UTC(2027, 0, 10, 2, 0, 0),
      kind: 'VIEW' as const,
      documentId: 'doc_2',
      counterpartyKey: 'cp_1t8w4qz9m0a3f2', // gitleaks:allow -- deterministic test fixture, not a provider credential
      accessLevel: 'PUBLIC' as const,
    },
  ],
}

describe('ActivitySkeleton', () => {
  it('caps the subtitle skeleton so it does not overflow a 320px viewport', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/company/data-room-activity/ActivitySkeleton.tsx'),
      'utf8'
    )
    expect(source).toMatch(/w-96 max-w-full/)
  })
})

describe('DataRoomActivityClient', () => {
  beforeEach(() => {
    mockUseQuery.mockReset()
    queryMounts.current = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('muestra el resumen por documento con cifras mono alineadas a la derecha', () => {
    mockUseQuery.mockReturnValue(ACTIVITY)

    render(<DataRoomActivityClient companyId="company_1" companyName="Agroindustrias Espavé" />)

    expect(screen.getByRole('heading', { name: 'Actividad del Data Room' })).toBeInTheDocument()

    const row = screen.getByTestId('activity-document-row-doc_1')
    const downloadsCell = within(row).getByTestId('activity-downloads')
    expect(downloadsCell).toHaveTextContent('2')
    expect(downloadsCell.className).toContain('font-data')
    expect(downloadsCell.className).toContain('text-right')
  })

  it('no revela el nombre de una contraparte sin conexión aceptada', async () => {
    mockUseQuery.mockReturnValue(ACTIVITY)

    render(<DataRoomActivityClient companyId="company_1" companyName="Agroindustrias Espavé" />)

    await userEvent.click(screen.getByRole('tab', { name: 'Por contraparte' }))

    expect(screen.getByText('Contraparte A3F2')).toBeInTheDocument()
    expect(screen.queryByText('Fondo Espavé')).not.toBeInTheDocument()
  })

  it('abre el cajón con los eventos de ESE documento y distingue vista de descarga', async () => {
    mockUseQuery.mockReturnValue(ACTIVITY)

    render(<DataRoomActivityClient companyId="company_1" companyName="Agroindustrias Espavé" />)

    await userEvent.click(screen.getByTestId('activity-document-row-doc_1'))

    const drawer = await screen.findByTestId('activity-events')
    const events = within(drawer).getAllByTestId('activity-event-row')
    expect(events).toHaveLength(2)
    expect(within(drawer).getByText('Vista')).toBeInTheDocument()
    expect(within(drawer).getByText('Descarga')).toBeInTheDocument()
  })

  it('el cajón distingue dos eventos del mismo día con hora, minuto y segundo', async () => {
    // `log_1` (02:00) y `log_2` (01:00) caen el MISMO día. Con fecha sola las dos
    // celdas se ven idénticas y la pantalla deja de servir como evidencia.
    mockUseQuery.mockReturnValue(ACTIVITY)

    render(<DataRoomActivityClient companyId="company_1" companyName="Agroindustrias Espavé" />)

    await userEvent.click(screen.getByTestId('activity-document-row-doc_1'))

    const drawer = await screen.findByTestId('activity-events')
    const whenCells = within(drawer)
      .getAllByTestId('activity-event-row')
      .map((row) => row.querySelectorAll('td')[0]?.textContent ?? '')

    expect(whenCells).toHaveLength(2)
    expect(whenCells[0]).not.toBe(whenCells[1])
    for (const cell of whenCells) {
      expect(cell).toMatch(/\d{2}:\d{2}:\d{2}/)
    }
  })

  // El encabezado decía «Fecha y hora (UTC)» cuando la celda se imprimía en UTC.
  // Desde [F] 2026-09-17 la celda va en hora de Panamá, así que el rótulo de
  // zona se retira en vez de mentir.
  it('rotula la columna de momento sin nombrar UTC', async () => {
    mockUseQuery.mockReturnValue(ACTIVITY)

    render(<DataRoomActivityClient companyId="company_1" companyName="Agroindustrias Espavé" />)

    await userEvent.click(screen.getByTestId('activity-document-row-doc_1'))

    const drawer = await screen.findByTestId('activity-events')
    expect(within(drawer).getByText('Fecha y hora')).toBeInTheDocument()
    expect(within(drawer).queryByText(/UTC/)).toBeNull()
  })

  it('muestra el estado vacío cuando no hubo actividad en el período', () => {
    mockUseQuery.mockReturnValue({
      ...ACTIVITY,
      totals: counters(),
      documentCount: 0,
      counterpartyCount: 0,
      byDocument: [],
      byCounterparty: [],
      events: [],
    })

    render(<DataRoomActivityClient companyId="company_1" companyName="Agroindustrias Espavé" />)

    expect(screen.getByText('Sin actividad en este período')).toBeInTheDocument()
  })

  it('returns an admin to the exact company workspace from the header and empty state', () => {
    mockUseQuery.mockReturnValue({
      ...ACTIVITY,
      totals: counters(),
      documentCount: 0,
      counterpartyCount: 0,
      byDocument: [],
      byCounterparty: [],
      events: [],
    })
    const returnHref = '/admin/companies/company_1/documents'

    render(
      <DataRoomActivityClient
        companyId="company_1"
        companyName="Agroindustrias Espavé"
        returnHref={returnHref}
      />
    )

    expect(screen.getByRole('link', { name: 'Volver al Data Room' })).toHaveAttribute(
      'href',
      returnHref
    )
    expect(screen.getByRole('link', { name: 'Ir al Data Room' })).toHaveAttribute(
      'href',
      returnHref
    )
  })

  it('ofrece reintentar cuando la actividad sigue sin resolver después de 12 segundos', async () => {
    vi.useFakeTimers()
    mockUseQuery.mockImplementation(() => {})

    render(<DataRoomActivityClient companyId="company_1" companyName="Agroindustrias Espavé" />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })

    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos cargar la actividad.')
    const mountsBeforeRetry = queryMounts.current
    const retry = screen.getByRole('button', { name: 'Intentar de nuevo' })
    fireEvent.click(retry)
    expect(queryMounts.current).toBeGreaterThan(mountsBeforeRetry)
    expect(screen.getByTestId('activity-skeleton')).toBeInTheDocument()
  })

  it('muestra el esqueleto mientras la suscripción de Convex no resuelve', () => {
    mockUseQuery.mockImplementation(() => {})

    render(<DataRoomActivityClient companyId="company_1" companyName="Agroindustrias Espavé" />)

    expect(screen.getByTestId('activity-skeleton')).toBeInTheDocument()
  })
})
