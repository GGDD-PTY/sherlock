import { render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { describe, expect, it, vi } from 'vitest'

import esMessages from '@/messages/es.json'

const mockUseQuery = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>(() => undefined))
const mockMutation = vi.hoisted(() => vi.fn())
const mockUseMutation = vi.hoisted(() => vi.fn(() => mockMutation))
const mockUsePaginatedQuery = vi.hoisted(() =>
  vi.fn(() => ({ results: [], status: 'LoadingFirstPage', loadMore: vi.fn() }))
)

vi.unmock('next-intl')
vi.mock('convex/react', () => ({
  useQuery: mockUseQuery,
  useMutation: mockUseMutation,
  usePaginatedQuery: mockUsePaginatedQuery,
}))
vi.mock('@/lib/dev-auth/config', () => ({ DEV_AUTH_ENABLED: true }))
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

import { AuditLogsClient } from '@/components/admin/AuditLogsClient'
import { AdminGdprClient } from '@/components/admin/AdminGdprClient'
import { AdminSidebar } from '@/components/admin/AdminSidebar'
import { AdminSecurityClient } from '@/components/admin/AdminSecurityClient'
import { WorkOSAdminPortalClient } from '@/components/admin/WorkOSAdminPortalClient'
import { SidebarProvider } from '@/components/ui/sidebar'

function provider(locale: 'es', child: React.ReactNode) {
  return (
    <NextIntlClientProvider locale={locale} messages={esMessages}>
      {child}
    </NextIntlClientProvider>
  )
}

describe('visited admin client headers', () => {
  // El h1 de `/admin/security` cubre sus dos pestañas ([F] 2026-09-11): este
  // panel declara la muestra local y nada más, para no ser el segundo h1.
  it.each([['es', 'Muestra local de auditoría para dev-auth']] as const)(
    'renders the audit-log panel without its own h1 in %s',
    (locale, demoSnapshot) => {
      render(provider(locale, <AuditLogsClient />))

      expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
      expect(screen.getByText(demoSnapshot)).toBeVisible()
    }
  )

  it('stacks audit-log filters before they can overflow a 375px viewport', () => {
    render(provider('es', <AuditLogsClient />))

    const filters = screen.getAllByRole('combobox')
    expect(filters).toHaveLength(2)
    for (const filter of filters) {
      expect(filter.parentElement).toHaveClass('w-full')
    }
    expect(filters[0].parentElement?.parentElement).toHaveClass('flex-col', 'sm:flex-row')
  })

  it.each([
    [
      'es',
      'Últimos 7 días',
      'Todas las acciones',
      'Historial de acciones',
      'Empresa verificada',
      'Empresa demo verificada para la revisión controlada del teaser',
    ],
  ] as const)(
    'renders the audit-log body and demo snapshot in %s',
    (locale, recent, allActions, history, action, demoNote) => {
      render(provider(locale, <AuditLogsClient />))

      expect(screen.getByText(recent)).toBeVisible()
      expect(screen.getByText(allActions)).toBeVisible()
      expect(screen.getByText(history)).toBeVisible()
      expect(screen.getByText(action)).toBeVisible()
      expect(screen.getByText(demoNote)).toBeVisible()
    }
  )

  it.each([['es', /21 may 2026/]] as const)(
    'renders deterministic demo audit dates in %s',
    (locale, expectedDate) => {
      render(provider(locale, <AuditLogsClient />))

      expect(screen.getAllByText(expectedDate).length).toBeGreaterThan(0)
    }
  )

  // El aviso de dev-auth perdió su título de tarjeta y quedó en una línea
  // ([F] 2026-09-11, tarjeta O1-05).
  it.each([
    [
      'es',
      /Se muestran datos demo locales/,
      'Total sin resolver',
      'Cola de revisión documental',
      'Inicio de sesión fallido',
      'Resolver',
    ],
  ] as const)(
    'renders the security body and actions in %s',
    (locale, snapshot, unresolved, reviewQueue, failedLogin, resolve) => {
      render(provider(locale, <AdminSecurityClient />))

      expect(screen.getByText(snapshot)).toBeVisible()
      expect(screen.getByText(unresolved)).toBeVisible()
      expect(screen.getByText(reviewQueue)).toBeVisible()
      expect(screen.getByText(failedLogin)).toBeVisible()
      expect(screen.getAllByRole('button', { name: resolve }).length).toBeGreaterThan(0)
    }
  )

  it.each([
    ['es', 'Solicitudes pendientes', 'No hay solicitudes de eliminación pendientes.', 'Historial'],
  ] as const)('renders the GDPR empty body in %s', (locale, pending, empty, history) => {
    // Dos consultas: las pendientes por estado y las 200 recientes del historial.
    mockUseQuery.mockReturnValueOnce([]).mockReturnValueOnce([])
    render(provider(locale, <AdminGdprClient />))

    expect(screen.getByText(pending)).toBeVisible()
    expect(screen.getByText(empty)).toBeVisible()
    expect(screen.getByText(history)).toBeVisible()
  })

  it.each([
    [
      'es',
      'Configuración del servidor para AuthKit, webhooks y el portal administrativo.',
      'Configurado',
      'Abrir SSO',
      'Verificar dominio',
    ],
  ] as const)(
    'renders the WorkOS body and actions in %s',
    (locale, description, configured, openSso, verifyDomain) => {
      render(
        provider(
          locale,
          <WorkOSAdminPortalClient
            envStatus={{
              apiKey: true,
              clientId: true,
              cookiePassword: true,
              webhookSecret: true,
              redirectUri: true,
            }}
          />
        )
      )

      expect(screen.getByText(description)).toBeVisible()
      expect(screen.getAllByText(configured)).toHaveLength(5)
      expect(screen.getByRole('button', { name: openSso })).toBeVisible()
      expect(screen.getByRole('button', { name: verifyDomain })).toBeVisible()
    }
  )

  // O1-02: el menú móvil dejó de ser un componente aparte. La misma
  // `AdminSidebar` se pinta dentro de un Sheet debajo de `md`, así que lo que
  // se prueba es la lista única, montada sobre su provider.
  it.each([['es', 'Principal', 'Empresas']] as const)(
    'renders the admin sidebar sections in %s',
    (locale, section, companies) => {
      render(
        provider(
          locale,
          <SidebarProvider>
            <AdminSidebar />
          </SidebarProvider>
        )
      )

      expect(screen.getByRole('heading', { level: 3, name: section })).toBeVisible()
      expect(screen.getByRole('link', { name: companies })).toBeVisible()
    }
  )

  // «Hacer admin» llegó de `/admin/users` con D2 ([F] 2026-09-11): la fila vive
  // al final de Accesos y llama la misma API route.
  it.each([['es', 'Hacer admin', 'Escribe el email de una cuenta que ya existe.']] as const)(
    'renders the make-admin row on the access screen in %s',
    (locale, action, help) => {
      render(
        provider(
          locale,
          <WorkOSAdminPortalClient
            envStatus={{
              apiKey: true,
              clientId: true,
              cookiePassword: true,
              webhookSecret: true,
              redirectUri: true,
            }}
          />
        )
      )

      expect(screen.getByText(help)).toBeVisible()
      expect(screen.getByLabelText('Email')).toBeVisible()
      expect(screen.getByRole('button', { name: action })).toBeVisible()
    }
  )
})
