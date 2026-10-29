// ============================================================================
// ADMIN — SALA (VDR) DE UNA EMPRESA CLIENTE
// ============================================================================
// El modelo de Sherlock es "el equipo le hace el trabajo al emisor": el backend
// ya autoriza a ADMIN sobre los documentos de cualquier empresa
// (hasOwnership → bypass ADMIN), pero no había pantalla. Esta ruta la abre.
//
// Lo que fija este test:
//  1. Nadie que no sea ADMIN entra (la puerta es requireRole, que además exige
//     el step-up MFA de admin — no se debilita con una puerta propia).
//  2. Un ADMIN ve la sala de la empresa del `[id]` de la URL, no la suya.
//  3. En pantalla queda explícito de quién es el data room.
// ============================================================================

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequireRole = vi.fn()
const mockGetAuthenticatedConvex = vi.fn()
const mockConvexQuery = vi.fn()
const mockRedirect = vi.fn(({ href }: { href: string }) => {
  throw new Error(`REDIRECT:${href}`)
})

vi.mock('next-intl/server', async () => {
  const messages = (await import('@/messages/es.json')).default
  return {
    setRequestLocale: vi.fn(),
    getTranslations: async (ns?: string | { namespace: string }) => {
      const namespace = typeof ns === 'string' ? ns : (ns?.namespace ?? '')
      return (key: string) => {
        let node: unknown = messages
        for (const part of [...namespace.split('.').filter(Boolean), ...key.split('.')]) {
          node = (node as Record<string, unknown> | undefined)?.[part]
        }
        return typeof node === 'string' ? node : key
      }
    },
  }
})

vi.mock('@/lib/auth/session', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}))

vi.mock('@/lib/convex-auth', () => ({
  getAuthenticatedConvex: () => mockGetAuthenticatedConvex(),
}))

vi.mock('@/lib/dev-auth/config', () => ({
  DEV_AUTH_ENABLED: false,
}))

vi.mock('@/i18n/navigation', () => ({
  redirect: (...args: [{ href: string; locale?: string }]) => mockRedirect(...args),
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

const mockFetchQuery = vi.fn((..._args: unknown[]) => {
  throw new Error('fetchQuery must not be used for the admin data room')
})
vi.mock('convex/nextjs', () => ({
  fetchQuery: (...args: unknown[]) => mockFetchQuery(...args),
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: {
      getAdminVdrWorkspace: 'companies.getAdminVdrWorkspace',
      getCompany: 'companies.getCompany',
      getCompanyByOwner: 'companies.getCompanyByOwner',
    },
    companyChecklist: {
      getCompanyChecklist: 'companyChecklist.getCompanyChecklist',
    },
    guestAccess: {
      listForCompany: 'guestAccess.listForCompany',
      configureCompanyNda: 'guestAccess.configureCompanyNda',
    },
  },
}))

// Las secciones plegadas leen el checklist en el cliente; acá no hay
// ConvexProvider y el resumen se prueba en AdminRoomSections.test.tsx.
vi.mock('convex/react', () => ({
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
}))

vi.mock('@/components/company/MyCompanyDocumentsClient', () => ({
  MyCompanyDocumentsClient: ({
    companyId,
    companyName,
    activityHref,
  }: {
    companyId: string
    companyName: string
    activityHref: string
  }) => (
    <div
      data-testid="vdr-client"
      data-company-id={companyId}
      data-company-name={companyName}
      data-activity-href={activityHref}
    />
  ),
}))

// Los paneles de cliente que la página compone debajo del shell leen Convex
// por su cuenta; aquí solo importa con qué props los monta la página.
vi.mock('@/components/company/RoomProgressPanel', () => ({
  RoomProgressPanel: (props: Record<string, unknown>) => (
    <section data-testid="room-progress-panel" data-props={JSON.stringify(props)} />
  ),
}))
vi.mock('@/components/vdr-guest/CompanyGuestScreen', async () => {
  const { createElement } = await import('react')
  const { useAdminVdrOperator } = await import('@/components/company/vdr/AdminVdrCapabilityContext')
  return {
    CompanyGuestScreen: () =>
      createElement('section', {
        'data-testid': 'company-guest-screen',
        'data-admin-operator': String(useAdminVdrOperator()),
      }),
  }
})
vi.mock('@/components/admin/AdminRoomActivationPanel', () => ({
  AdminRoomActivationPanel: ({ companyId, isDemo }: { companyId: string; isDemo?: boolean }) => (
    <div
      data-testid="admin-room-activation"
      data-company-id={companyId}
      data-is-demo={String(isDemo)}
    />
  ),
}))

vi.mock('@/components/admin/AdminPreparationWorkspace', () => ({
  AdminPreparationWorkspace: ({
    companyId,
    intakeSessionId,
  }: {
    companyId: string
    intakeSessionId?: string
  }) => (
    <div
      data-testid="admin-preparation-workspace"
      data-company-id={companyId}
      data-intake-session-id={intakeSessionId}
    />
  ),
}))

const CLIENT_COMPANY = {
  _id: 'company_cliente_777',
  name: 'Agroindustrias Espavé',
}
const CLIENT_WORKSPACE = {
  company: CLIENT_COMPANY,
  rooms: [{ id: 'deal_cliente_1', title: 'Raise 2027', status: 'OPEN' }],
}

async function loadPage() {
  const mod = await import('@/app/[locale]/(app)/admin/companies/[id]/documents/page')
  return mod
}

describe('admin data room de una empresa cliente', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireRole.mockResolvedValue({
      id: 'workos_admin_1',
      email: 'fixture-14e4636f@example.com',
      role: 'ADMIN',
      effectiveRole: 'ADMIN',
      profileId: 'profile_admin_1',
    })
    mockGetAuthenticatedConvex.mockResolvedValue({
      client: { query: (...args: unknown[]) => mockConvexQuery(...args) },
      isAuthenticated: true,
    })
    mockConvexQuery.mockResolvedValue(CLIENT_WORKSPACE)
  })

  it('cierra la ruta con requireRole ADMIN (que es donde vive el step-up MFA)', async () => {
    const { default: AdminCompanyDocumentsPage } = await loadPage()

    await AdminCompanyDocumentsPage({
      params: Promise.resolve({ locale: 'es', id: 'company_cliente_777' }),
    })

    expect(mockRequireRole).toHaveBeenCalledWith(
      ['ADMIN'],
      '/admin/companies/company_cliente_777/documents',
      'es'
    )
  })

  it('no consulta la empresa cuando requireRole rechaza a un no-admin', async () => {
    mockRequireRole.mockImplementation(() => {
      throw new Error('REDIRECT:/my-company/documents')
    })
    const { default: AdminCompanyDocumentsPage } = await loadPage()

    await expect(
      AdminCompanyDocumentsPage({
        params: Promise.resolve({ locale: 'es', id: 'company_cliente_777' }),
      })
    ).rejects.toThrow('REDIRECT:/my-company/documents')

    expect(mockConvexQuery).not.toHaveBeenCalled()
  })

  it('rechaza a un admin en modo "ver como" sin consultar la empresa', async () => {
    // requireRole autoriza por el rol REAL: un admin con viewAsRole activo pasa
    // la puerta. Operar la sala de un cliente no puede ocurrir bajo una vista
    // simulada — la página misma debe fallar cerrada.
    mockRequireRole.mockResolvedValue({
      id: 'workos_admin_1',
      email: 'fixture-14e4636f@example.com',
      role: 'ADMIN',
      effectiveRole: 'COMPANY',
      profileId: 'profile_admin_1',
      isViewingAs: true,
      viewAsRole: 'COMPANY',
    })
    const { default: AdminCompanyDocumentsPage } = await loadPage()

    await expect(
      AdminCompanyDocumentsPage({
        params: Promise.resolve({ locale: 'es', id: 'company_cliente_777' }),
      })
    ).rejects.toThrow('REDIRECT:/admin')

    expect(mockConvexQuery).not.toHaveBeenCalled()
  })

  it('carga la empresa del [id] de la URL con el cliente Convex autenticado', async () => {
    const { default: AdminCompanyDocumentsPage } = await loadPage()

    await AdminCompanyDocumentsPage({
      params: Promise.resolve({ locale: 'es', id: 'company_cliente_777' }),
    })

    expect(mockConvexQuery).toHaveBeenCalledWith('companies.getAdminVdrWorkspace', {
      companyId: 'company_cliente_777',
    })
    expect(mockConvexQuery).not.toHaveBeenCalledWith(
      'companies.getCompanyByOwner',
      expect.anything()
    )
    expect(mockFetchQuery).not.toHaveBeenCalled()
  })

  it('le pasa al componente existente la sala de esa empresa', async () => {
    const { default: AdminCompanyDocumentsPage } = await loadPage()

    const page = await AdminCompanyDocumentsPage({
      params: Promise.resolve({ locale: 'es', id: 'company_cliente_777' }),
    })
    render(page)

    expect(screen.getByText('Lo que ve el cliente')).toBeVisible()
    const client = screen.getByTestId('vdr-client')
    expect(client).toHaveAttribute('data-company-id', 'company_cliente_777')
    expect(client).toHaveAttribute('data-company-name', 'Agroindustrias Espavé')
    expect(client).toHaveAttribute(
      'data-activity-href',
      '/my-company/documents/activity?company=company_cliente_777'
    )
  })

  // Sin el provider, el panel ve la lista (la query deja pasar a ADMIN) pero
  // invitar y revocar salen sin adminCapability y Convex los rechaza.
  it('monta el panel de invitados dentro de la capacidad admin de esa empresa', async () => {
    const { default: AdminCompanyDocumentsPage } = await loadPage()

    const page = await AdminCompanyDocumentsPage({
      params: Promise.resolve({ locale: 'es', id: 'company_cliente_777' }),
    })
    render(page)

    expect(screen.getByTestId('company-guest-screen')).toHaveAttribute('data-admin-operator', 'true')
  })

  it('muestra el NDA de invitados de esa empresa dentro de la misma capacidad', async () => {
    const { default: AdminCompanyDocumentsPage } = await loadPage()

    const page = await AdminCompanyDocumentsPage({
      params: Promise.resolve({ locale: 'es', id: 'company_cliente_777' }),
    })
    render(page)

    const section = screen.getByTestId('admin-company-nda')
    expect(section).toHaveAttribute('data-admin-operator', 'true')
    expect(screen.queryByRole('link', { name: /\/admin\/nda/ })).not.toBeInTheDocument()
  })

  // La bitácora de accesos salió de la cara del cliente ([F] 2026-09-01) y el
  // único que la conserva es el equipo, así que esta ruta es lo que la mantiene
  // viva. Bajo dev-auth la pantalla redirige de vuelta al data room: ofrecerla
  // ahí sería un callejón sin salida, no una función.
  it('no ofrece la bitácora bajo dev-auth, donde la pantalla redirige', async () => {
    vi.resetModules()
    vi.doMock('@/lib/dev-auth/config', () => ({ DEV_AUTH_ENABLED: true }))
    try {
      const { default: AdminCompanyDocumentsPage } = await loadPage()

      const view = await AdminCompanyDocumentsPage({
        params: Promise.resolve({ locale: 'es', id: 'demo_company_001' }),
      })
      render(view)

      expect(screen.getByTestId('vdr-client')).not.toHaveAttribute('data-activity-href')
    } finally {
      vi.doUnmock('@/lib/dev-auth/config')
      vi.resetModules()
    }
  })

  it('monta el panel operativo de preparación en el scope de la empresa', async () => {
    const { default: AdminCompanyDocumentsPage } = await loadPage()

    const page = await AdminCompanyDocumentsPage({
      params: Promise.resolve({ locale: 'es', id: 'company_cliente_777' }),
      searchParams: Promise.resolve({ intake: 'intake_session_123' }),
    })
    render(page)

    const panel = screen.getByTestId('admin-preparation-workspace')
    expect(panel).toHaveAttribute('data-company-id', 'company_cliente_777')
    expect(panel).toHaveAttribute('data-intake-session-id', 'intake_session_123')
  })

  // Auditoría 2026-09-06 (F02): el equipo entra a ver documentos. El Data Room
  // va primero; preparación y activación quedan debajo, plegadas por defecto,
  // en ese orden.
  it('monta el data room antes de los dos paneles, y la preparación antes de la activación', async () => {
    const { default: AdminCompanyDocumentsPage } = await loadPage()

    const page = await AdminCompanyDocumentsPage({
      params: Promise.resolve({ locale: 'es', id: 'company_cliente_777' }),
    })
    render(page)

    const room = screen.getByTestId('vdr-client')
    const preparation = screen.getByTestId('admin-preparation-workspace')
    const activation = screen.getByTestId('admin-room-activation')
    expect(activation).toHaveAttribute('data-company-id', 'company_cliente_777')

    const precedes = (first: HTMLElement, second: HTMLElement) =>
      Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(precedes(room, preparation)).toBe(true)
    expect(precedes(room, activation)).toBe(true)
    expect(precedes(preparation, activation)).toBe(true)

    expect(screen.getByTestId('admin-room-section-preparation')).not.toHaveAttribute('open')
    expect(screen.getByTestId('admin-room-section-activation')).not.toHaveAttribute('open')
  })

  // El encabezado nombra la sala y a quién pertenece, en tono neutro: el aviso
  // de «otra empresa» sonaba a advertencia sobre trabajo legítimo del equipo
  // ([F] 2026-09-07).
  it.each([['es', 'Sala de Agroindustrias Espavé · vista del equipo']] as const)(
    'nombra en %s la sala del cliente como vista del equipo',
    async (locale, title) => {
      const { default: AdminCompanyDocumentsPage } = await loadPage()

      const page = await AdminCompanyDocumentsPage({
        params: Promise.resolve({ locale, id: 'company_cliente_777' }),
      })
      render(page)

      const banner = screen.getByRole('status')
      expect(banner).toHaveTextContent(title)
      expect(banner).toHaveTextContent(
        'Lo que subas aquí entra al Data Room de Agroindustrias Espavé.'
      )
      expect(banner).not.toHaveTextContent('otra empresa')
    }
  )

  it('no duplica el punto cuando la razón social ya termina en punto', async () => {
    mockConvexQuery.mockResolvedValue({
      ...CLIENT_WORKSPACE,
      company: { ...CLIENT_COMPANY, name: 'Logística Colón Free Zone, S. A.' },
    })
    const { default: AdminCompanyDocumentsPage } = await loadPage()

    const page = await AdminCompanyDocumentsPage({
      params: Promise.resolve({ locale: 'es', id: 'company_cliente_777' }),
    })
    render(page)

    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent(
      'Lo que subas aquí entra al Data Room de Logística Colón Free Zone, S. A.'
    )
    expect(banner.textContent).not.toContain('..')
  })

  // El encabezado dejó de enumerar acciones ([F] 2026-09-07), pero la regla que
  // protegía sigue viva: nunca promete un borrado físico que el producto no
  // hace — lo destructivo real es archivar, y vive en la sala, no acá.
  it('no promete eliminación física en el encabezado de la sala', async () => {
    const { default: AdminCompanyDocumentsPage } = await loadPage()

    const page = await AdminCompanyDocumentsPage({
      params: Promise.resolve({ locale: 'es', id: 'company_cliente_777' }),
    })
    render(page)

    const banner = screen.getByRole('status')
    expect(banner).not.toHaveTextContent('elimines')
    expect(banner).not.toHaveTextContent('eliminar')
    expect(banner).not.toHaveTextContent('borrar')
  })

  it('devuelve al listado admin cuando la empresa no existe', async () => {
    mockConvexQuery.mockResolvedValue(null)
    const { default: AdminCompanyDocumentsPage } = await loadPage()

    await expect(
      AdminCompanyDocumentsPage({
        params: Promise.resolve({ locale: 'es', id: 'company_fantasma' }),
      })
    ).rejects.toThrow('REDIRECT:/admin/companies')
  })

  it('devuelve al listado admin cuando no hay sesión Convex admin', async () => {
    mockGetAuthenticatedConvex.mockResolvedValue({ client: null, isAuthenticated: false })
    const { default: AdminCompanyDocumentsPage } = await loadPage()

    await expect(
      AdminCompanyDocumentsPage({
        params: Promise.resolve({ locale: 'es', id: 'company_cliente_777' }),
      })
    ).rejects.toThrow('REDIRECT:/admin/companies')
  })

  it('publica metadata localizada', async () => {
    const { generateMetadata } = await loadPage()

    await expect(
      generateMetadata({ params: Promise.resolve({ locale: 'es', id: 'company_cliente_777' }) })
    ).resolves.toMatchObject({ title: 'Sala del cliente | Admin' })
  })
})
