// El cromo salió de `[locale]/layout.tsx` y se partió en dos shells (tarjeta
// O2-06): la región de Sonner y el salto al contenido viven ahora en
// `AppShell`, y el salto también en `PublicShell`. Este archivo se llamaba
// `locale-layout-a11y.test.tsx` y pinneaba lo mismo sobre el layout raíz.

import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { AppShell } from '@/components/providers/AppShell'
import { PublicShell } from '@/components/providers/PublicShell'

vi.mock('@/i18n/config', () => ({ locales: ['es'], defaultLocale: 'es' }))
vi.mock('next-intl', () => ({
  NextIntlClientProvider: ({ children }: { readonly children: ReactNode }) => children,
}))
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'es',
  getMessages: async () => ({}),
  getTranslations: async () => (key: string) =>
    key === 'notifications' ? 'Notificaciones' : key === 'skipToContent' ? 'Ir al contenido' : key,
}))

vi.mock('@/components/layout/Navbar', () => ({ Navbar: () => null }))
vi.mock('@/components/layout/PublicNavbar', () => ({ PublicNavbar: () => null }))
vi.mock('@/components/layout/FooterGate', () => ({ FooterGate: () => null }))
vi.mock('@/components/layout/SiteFooter', () => ({ SiteFooter: () => null }))
vi.mock('@/components/layout/ProductFooter', () => ({ ProductFooter: () => null }))
vi.mock('@/components/admin/AdminChrome', () => ({ AdminChrome: () => null }))
vi.mock('@/components/providers/AuthProvider', () => ({
  AuthProvider: ({ children }: { readonly children: ReactNode }) => children,
}))
vi.mock('@/components/providers/ConvexClientProvider', () => ({
  ConvexClientProvider: ({ children }: { readonly children: ReactNode }) => children,
}))
vi.mock('@/components/providers/PostHogProvider', () => ({
  PostHogProvider: ({ children }: { readonly children: ReactNode }) => children,
}))
vi.mock('@/components/ui/sonner', () => ({
  Toaster: ({ containerAriaLabel }: { readonly containerAriaLabel?: string }) => (
    <section data-testid="sonner-region" aria-label={containerAriaLabel} />
  ),
}))

describe('live regions and skip link of the shells', () => {
  it('labels the Sonner region in the app shell', async () => {
    const shell = await AppShell({ children: <div /> })

    const document = new DOMParser().parseFromString(renderToStaticMarkup(shell), 'text/html')
    const region = document.querySelector('[data-testid="sonner-region"]')

    expect(region?.getAttribute('aria-label')).toBe('Notificaciones')
  })

  it.each([
    ['app', AppShell],
    ['public', PublicShell],
  ] as const)('opens the %s shell with the skip link to #main-content', async (_name, Shell) => {
    const shell = await Shell({ children: <div /> })

    const document = new DOMParser().parseFromString(renderToStaticMarkup(shell), 'text/html')

    expect(document.querySelector('a[href="#main-content"]')?.textContent).toBe('Ir al contenido')
    expect(document.querySelector('main')?.getAttribute('id')).toBe('main-content')
  })
})
