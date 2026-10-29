import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import esMessages from '@/messages/es.json'

vi.mock('@/lib/auth/session', () => ({ requireRole: vi.fn(async () => ({ role: 'ADMIN' })) }))
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))
vi.mock('@/components/admin/AdminGdprClient', () => ({ AdminGdprClient: () => null }))
vi.mock('@/components/lazy', () => ({ LazyAdminSecurity: () => null }))
vi.mock('@/components/admin/WorkOSAdminPortalClient', () => ({
  WorkOSAdminPortalClient: () => <div data-testid="workos-body" />,
}))
vi.mock('next-intl/server', () => ({
  setRequestLocale: vi.fn(),
  getTranslations: async ({ namespace }: { namespace: string }) => {
    const messages = esMessages
    return (key: string) => {
      let node: unknown = messages
      for (const part of [...namespace.split('.'), ...key.split('.')]) {
        node = (node as Record<string, unknown> | undefined)?.[part]
      }
      return typeof node === 'string' ? node : `${namespace}.${key}`
    }
  },
}))

import AdminGdprPage from '@/app/[locale]/(app)/admin/gdpr/page'
import AdminSecurityPage from '@/app/[locale]/(app)/admin/security/page'
import AdminWorkOSPage from '@/app/[locale]/(app)/admin/workos/page'

describe('visited admin page headers', () => {
  it.each([
    [
      'es',
      'Eliminación de cuentas',
      'Procesa solicitudes de eliminación y conserva el rastro de auditoría requerido.',
    ],
  ] as const)('renders the GDPR page in %s', async (locale, title, subtitle) => {
    render(await AdminGdprPage({ params: Promise.resolve({ locale }) }))

    expect(screen.getByRole('heading', { level: 1, name: title })).toBeVisible()
    expect(screen.getByText(subtitle)).toBeVisible()
  })

  // El h1 nombra la pantalla entera, no la pestaña por defecto: `/admin/security`
  // trae «Eventos» y «Auditoría» desde D2 ([F] 2026-09-11).
  it.each([
    [
      'es',
      'Seguridad',
      'Monitorea los eventos de seguridad y el registro de las acciones del equipo.',
    ],
  ] as const)('renders the security page in %s', async (locale, title, subtitle) => {
    render(await AdminSecurityPage({ params: Promise.resolve({ locale }) }))

    expect(screen.getByRole('heading', { level: 1, name: title })).toBeVisible()
    expect(screen.getByText(subtitle)).toBeVisible()
  })

  // Sin botón «volver»: la barra lateral es la que navega ([F] 2026-09-11,
  // tarjeta O1-05).
  it.each([
    ['es', 'Accesos', 'AuthKit, webhooks y Enterprise SSO para el equipo de Sherlock.'],
  ] as const)('renders the WorkOS page body in %s', async (locale, title, subtitle) => {
    render(await AdminWorkOSPage({ params: Promise.resolve({ locale }) }))

    expect(screen.getByRole('heading', { level: 1, name: title })).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Volver al panel' })).toBeNull()
    expect(screen.getByText(subtitle)).toBeVisible()
    expect(screen.getByTestId('workos-body')).toBeVisible()
  })
})
