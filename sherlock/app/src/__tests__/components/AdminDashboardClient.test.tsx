// ============================================================================
// VISTA GENERAL DEL EQUIPO (AdminDashboardClient)
// ============================================================================
// Contratos: (1) la vista general sale de UNA consulta, y las tres series
// diarias de la tarjeta O1-04 de las suyas; (2) cada empresa rinde una fila con
// su desglose por carpeta y un enlace directo a su sala; (3) los avisos y la
// bandeja de soporte se ven sin salir de la pantalla; (4) cuando la consulta
// trunca, la pantalla lo dice en vez de mentir; (5) una serie sin suficientes
// días con datos se muestra como tabla, nunca como gráfico.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

const mockUseQuery = vi.fn()
vi.mock('convex/react', () => ({ useQuery: mockUseQuery }))

const OVERVIEW_QUERY = 'adminOverview:getAdminOverview'
const SERIES_QUERIES = new Set([
  'analyticsSeries:getDocumentsDaily',
  'analyticsSeries:getIntakeDaily',
  'analyticsSeries:getActivityDaily',
])

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    adminOverview: { getAdminOverview: 'adminOverview:getAdminOverview' },
    analyticsSeries: {
      getDocumentsDaily: 'analyticsSeries:getDocumentsDaily',
      getIntakeDaily: 'analyticsSeries:getIntakeDaily',
      getActivityDaily: 'analyticsSeries:getActivityDaily',
    },
  },
}))

const DAY = 24 * 60 * 60 * 1000
const WINDOW_START = Date.UTC(2026, 7, 13)

/** Ventana de 30 días con los últimos `diasConDatos` días poblados. */
function serie(diasConDatos: number) {
  const dias = Array.from({ length: 30 }, (_, index) => ({
    fecha: new Date(WINDOW_START + index * DAY).toISOString().slice(0, 10),
    valor: index >= 30 - diasConDatos ? index + 1 : 0,
  }))
  return { dias, diasConDatos, truncado: false }
}

/** Overview con `total` salas, cada una con una última subida distinta. */
function overviewWithRooms(total: number) {
  const [first] = OVERVIEW.companies
  const companies = Array.from({ length: total }, (_, index) => ({
    ...first,
    companyId: `company_${index}`,
    name: `Empresa ${index}`,
    lastUploadAt: 1_756_000_000_000 + index * 1000,
  }))
  return { ...OVERVIEW, companies, usage: { ...OVERVIEW.usage, companies: total } }
}

function mockQueries({ overview = OVERVIEW, series = serie(0) } = {}) {
  mockUseQuery.mockImplementation((query: string) =>
    SERIES_QUERIES.has(query) ? series : overview
  )
}

const OVERVIEW = {
  companies: [
    {
      companyId: 'company_1',
      name: 'Sample Hydro',
      ownerEmail: 'fixture-13520a4f@example.com',
      documentsTotal: 13,
      documentsByFolder: {
        room_legal: 3,
        room_corporate: 2,
        room_financial: 6,
        room_operations: 1,
        room_marketing: 1,
      },
      storageBytes: 18_400_000,
      lastUploadAt: 1_756_000_000_000,
      deliverableVersions: 2,
      supportUnread: 3,
      truncated: false,
    },
  ],
  alerts: [
    {
      alertId: 'alert_1',
      kind: 'COMPANY_DOCUMENTS_UPLOADED',
      companyId: 'company_1',
      companyName: 'Sample Hydro',
      link: '/admin/companies/company_1/documents',
      fileCount: 4,
      folders: ['room_financial'],
      openedAt: 1_756_000_000_000,
      lastEventAt: 1_756_000_000_000,
      isRead: false,
    },
  ],
  support: {
    threads: [
      {
        threadId: 'thread_1',
        companyId: 'company_1',
        roomLabel: 'Sample Hydro',
        scopeKind: 'COMPANY',
        unreadCount: 3,
        lastMessageAt: 1_756_000_000_000,
      },
    ],
    unreadThreads: 1,
    unreadMessages: 3,
  },
  usage: {
    companies: 1,
    documents: 13,
    storageBytes: 18_400_000,
    storageCapBytes: 1024 * 1024 * 1024,
    usersByRole: { ADMIN: 2, COMPANY: 1 },
    truncated: false,
  },
  coverage: { truncated: false, companyCap: 50 },
  generatedAt: 1_756_000_000_000,
}

describe('AdminDashboardClient', () => {
  beforeEach(() => mockUseQuery.mockReset())

  it('shows a loading state while the overview is unresolved', async () => {
    mockUseQuery.mockReturnValue(undefined)
    const { AdminDashboardClient } = await import('@/components/admin/AdminDashboardClient')

    const { container } = render(<AdminDashboardClient />)

    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument()
    expect(
      screen.getByRole('status', { name: 'Cargando operaciones de preparación' })
    ).toBeInTheDocument()
  })

  it('renders every company as one row that links to its own room', async () => {
    mockQueries()
    const { AdminDashboardClient } = await import('@/components/admin/AdminDashboardClient')

    render(<AdminDashboardClient />)

    const table = screen.getByRole('table', { name: 'Empresas con Data Room en Sherlock' })
    const roomLink = within(table).getByRole('link', { name: 'Sample Hydro' })
    expect(roomLink).toHaveAttribute('href', '/admin/companies/company_1/documents')
    expect(roomLink).not.toHaveAttribute('title')
    expect(within(table).getByText('fixture-13520a4f@example.com')).toBeVisible()
    // Desglose por carpeta del shell, en el orden de la sala.
    const cells = screen
      .getAllByRole('cell')
      .map((cell) => cell.textContent?.trim())
      .filter((text): text is string => text !== undefined)
    expect(cells).toEqual(expect.arrayContaining(['13', '3', '2', '6', '1', '17.5 MB']))
    // Una sola lectura alimenta la vista general. Las tres series diarias de la
    // tarjeta O1-04 son consultas aparte y se cuentan aparte.
    expect(mockUseQuery.mock.calls.filter(([query]) => query === OVERVIEW_QUERY)).toHaveLength(1)
  })

  it('surfaces team alerts and the support inbox on the same screen', async () => {
    mockQueries()
    const { AdminDashboardClient } = await import('@/components/admin/AdminDashboardClient')

    render(<AdminDashboardClient />)

    expect(screen.getByText('Notificaciones al equipo')).toBeInTheDocument()
    expect(screen.getByText(/4 archivos/)).toBeInTheDocument()
    expect(screen.getByText(/sin leer/)).toBeInTheDocument()
    expect(screen.getByText(/3 mensajes/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Abrir soporte' })).toHaveAttribute(
      'href',
      '/admin/support'
    )
  })

  it('reports Convex plan usage against the Starter storage cap', async () => {
    mockQueries()
    const { AdminDashboardClient } = await import('@/components/admin/AdminDashboardClient')

    render(<AdminDashboardClient />)

    expect(screen.getByText('de 1.00 GB')).toBeInTheDocument()
    expect(screen.getByText('2 del equipo')).toBeInTheDocument()
    expect(screen.getByText('1 cliente')).toBeInTheDocument()
  })

  // La barra lateral ya lista esos destinos: el bloque «Resto del panel» los
  // repetía debajo del tablero (docs/design-system.md, «Screens and canvas»).
  it('does not repeat the sidebar destinations under the overview', async () => {
    mockQueries()
    const { AdminDashboardClient } = await import('@/components/admin/AdminDashboardClient')

    render(<AdminDashboardClient />)

    expect(screen.queryByTestId('admin-overview-links')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'WorkOS' })).not.toBeInTheDocument()
  })

  it('does not render marketplace-era control tower language', async () => {
    mockQueries()
    const { AdminDashboardClient } = await import('@/components/admin/AdminDashboardClient')

    const { container } = render(<AdminDashboardClient />)

    expect(container.textContent).not.toMatch(/match|teaser activo|enola|proveedor de capital/i)
  })

  it('discloses when the overview truncated its reads', async () => {
    mockQueries({ overview: { ...OVERVIEW, coverage: { truncated: true, companyCap: 50 } } })
    const { AdminDashboardClient } = await import('@/components/admin/AdminDashboardClient')

    render(<AdminDashboardClient />)

    expect(screen.getByRole('status')).toHaveTextContent('hasta 50 empresas')
  })

  // Tres días de datos no son una tendencia: veintisiete barras en cero
  // dibujarían un valle que nadie midió (tarjeta O1-04).
  it('shows the figures as a table, not a chart, while a series is too short', async () => {
    mockQueries({ series: serie(3) })
    const { AdminDashboardClient } = await import('@/components/admin/AdminDashboardClient')

    const { container } = render(<AdminDashboardClient />)

    const series = screen.getByTestId('admin-overview-series')
    expect(within(series).getAllByRole('table')).toHaveLength(3)
    expect(within(series).getAllByText('Todavía no hay serie: 3 días con datos.')).toHaveLength(3)
    expect(container.querySelectorAll('[data-slot="chart"]')).toHaveLength(0)
  })

  // El tablero enseña las salas que se movieron; la lista entera vive en
  // `/admin/companies` (tarjeta O1-04, altura de la ruta).
  it('caps the room table at four rows and links to the full list', async () => {
    mockQueries({ overview: overviewWithRooms(7) })
    const { AdminDashboardClient } = await import('@/components/admin/AdminDashboardClient')

    render(<AdminDashboardClient />)

    const table = screen.getByRole('table', { name: 'Empresas con Data Room en Sherlock' })
    // Cuatro salas más la fila de encabezados.
    expect(within(table).getAllByRole('row')).toHaveLength(5)
    expect(within(table).getByRole('link', { name: 'Empresa 6' })).toBeInTheDocument()
    expect(within(table).queryByRole('link', { name: 'Empresa 2' })).not.toBeInTheDocument()
    expect(within(table).getByRole('link', { name: 'Empresa 6' })).not.toHaveAttribute('title')
    expect(within(table).getAllByText('fixture-13520a4f@example.com').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'Ver las 7 salas' })).toHaveAttribute(
      'href',
      '/admin/companies'
    )
  })

  it('says when a series was cut at the read cap', async () => {
    mockQueries({ series: { ...serie(3), truncado: true } })
    const { AdminDashboardClient } = await import('@/components/admin/AdminDashboardClient')

    render(<AdminDashboardClient />)

    expect(screen.getByText('Serie recortada a las últimas 5000 filas.')).toBeInTheDocument()
  })

  it('draws one chart per series once the whole window has data', async () => {
    mockQueries({ series: serie(30) })
    const { AdminDashboardClient } = await import('@/components/admin/AdminDashboardClient')

    const { container } = render(<AdminDashboardClient />)

    const series = screen.getByTestId('admin-overview-series')
    expect(container.querySelectorAll('[data-slot="chart"]')).toHaveLength(3)
    expect(within(series).queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByText(/Todavía no hay serie/)).not.toBeInTheDocument()
  })
})
