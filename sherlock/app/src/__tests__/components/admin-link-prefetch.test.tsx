// Cada Link de /admin que entra al viewport hace que Next pida esa URL y el
// proxy corra users:getCurrentUserState. Estos renders fijan prefetch={false}
// en la barra, el encabezado del panel, la tabla de salas, las empresas, los
// avisos y soporte. La barra de arriba se fija en Navbar.test.tsx, que ya
// monta el menú compacto.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import esMessages from '@/messages/es.json'
import { ADMIN_ROUTES } from '@/lib/product/admin-routes'

const mockUseQuery = vi.hoisted(() => vi.fn<(query: unknown) => unknown>(() => undefined))

vi.mock('convex/react', () => ({
  useQuery: (query: unknown) => mockUseQuery(query),
  useMutation: vi.fn(() => vi.fn()),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    adminOverview: { getAdminOverview: 'adminOverview:getAdminOverview' },
    analyticsSeries: {
      getDocumentsDaily: 'analyticsSeries:getDocumentsDaily',
      getIntakeDaily: 'analyticsSeries:getIntakeDaily',
      getActivityDaily: 'analyticsSeries:getActivityDaily',
    },
    users: { getCurrentUserState: 'users:getCurrentUserState' },
  },
}))

vi.mock('@/lib/auth/session', () => ({
  requireRole: vi.fn(async () => ({ role: 'ADMIN' })),
}))

vi.mock('next-intl/server', () => ({
  setRequestLocale: vi.fn(),
  getTranslations: async ({ namespace }: { namespace: string }) => {
    return (key: string) => {
      let node: unknown = esMessages
      for (const part of [...namespace.split('.'), ...key.split('.')]) {
        node = (node as Record<string, unknown> | undefined)?.[part]
      }
      return typeof node === 'string' ? node : `${namespace}.${key}`
    }
  },
}))

import { AdminSidebar } from '@/components/admin/AdminSidebar'
import { SidebarProvider } from '@/components/ui/sidebar'

const OVERVIEW_QUERY = 'adminOverview:getAdminOverview'

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

function expectPrefetchOff(link: HTMLElement) {
  expect(link).toHaveAttribute('data-prefetch', 'false')
}

describe('admin links skip prefetch', () => {
  beforeEach(() => {
    mockUseQuery.mockReset()
    mockUseQuery.mockReturnValue(undefined)
  })

  it('keeps prefetch off on every sidebar destination', () => {
    render(
      <SidebarProvider>
        <AdminSidebar />
      </SidebarProvider>
    )

    for (const route of ADMIN_ROUTES) {
      const links = screen.getAllByRole('link', { name: route.nav.label })
      expect(links.length).toBeGreaterThan(0)
      for (const link of links) {
        expect(link).toHaveAttribute('href', route.paths[0])
        expectPrefetchOff(link)
      }
    }
  })

  it('keeps prefetch off on room, company, alert and support links', async () => {
    mockUseQuery.mockImplementation((query: unknown) =>
      query === OVERVIEW_QUERY ? OVERVIEW : undefined
    )
    const { AdminDashboardClient } = await import('@/components/admin/AdminDashboardClient')

    render(<AdminDashboardClient />)

    const table = screen.getByRole('table', { name: 'Empresas con Data Room en Sherlock' })
    const roomLink = within(table).getByRole('link', { name: 'Sample Hydro' })
    expect(roomLink).toHaveAttribute('href', '/admin/companies/company_1/documents')
    expectPrefetchOff(roomLink)

    const companiesLink = screen.getByRole('link', { name: /sala/ })
    expect(companiesLink).toHaveAttribute('href', '/admin/companies')
    expectPrefetchOff(companiesLink)

    const alerts = screen.getByTestId('admin-overview-alerts')
    const alertLink = within(alerts).getByRole('link', { name: 'Sample Hydro' })
    expect(alertLink).toHaveAttribute('href', '/admin/companies/company_1/documents')
    expectPrefetchOff(alertLink)

    const supportLink = screen.getByRole('link', { name: 'Abrir soporte' })
    expect(supportLink).toHaveAttribute('href', '/admin/support')
    expectPrefetchOff(supportLink)
  })

  it('keeps prefetch off on the panel header security link', async () => {
    const { default: AdminDashboardPage } = await import('@/app/[locale]/(app)/admin/page')

    render(await AdminDashboardPage({ params: Promise.resolve({ locale: 'es' }) }))

    const link = within(screen.getByRole('banner')).getByRole('link', {
      name: 'Controles de seguridad',
    })
    expect(link).toHaveAttribute('href', '/admin/security')
    expectPrefetchOff(link)
  })
})
