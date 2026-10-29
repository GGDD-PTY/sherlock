import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import { PublicNavbar } from '@/components/layout/PublicNavbar'

vi.mock('next-intl', async () => {
  const catalog = (await import('@/messages/es.json')).default as unknown

  const translate = (path: string): string => {
    const message = path
      .split('.')
      .reduce<unknown>(
        (node, segment) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined,
        catalog
      )

    if (typeof message !== 'string') {
      throw new TypeError(`Missing message in src/messages/es.json: ${path}`)
    }

    return message
  }

  return {
    useTranslations: (namespace: string) => (key: string) => translate(`${namespace}.${key}`),
    useLocale: () => 'es',
  }
})

let mockPathname = '/'

vi.mock('@/i18n/navigation', () => ({
  Link: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode
    href: string
    [key: string]: unknown
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => mockPathname,
}))

vi.mock('@/components/ui/theme-toggle', () => ({
  ThemeToggle: ({ showLabel = false }: { showLabel?: boolean }) => (
    <button data-testid="theme-toggle">{showLabel ? 'Tema' : 'Theme'}</button>
  ),
}))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="sheet-content">{children}</div>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetClose: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

describe('PublicNavbar', () => {
  beforeEach(() => {
    mockPathname = '/'
  })

  it('shows the compact public items and a session-blind sign-in link', () => {
    render(<PublicNavbar />)

    const desktopNavigation = screen.getByTestId('landing-primary-navigation')
    expect(
      within(desktopNavigation).getByRole('link', { name: 'Ayuda y cómo funciona' })
    ).toHaveAttribute('href', '/ayuda')
    expect(within(desktopNavigation).getByRole('button', { name: 'Tema' })).toBeInTheDocument()
    // La puerta de auth es un ancla nativa con el locale a mano: `/sign-in`
    // redirige a `/login` y de ahí a WorkOS, otro origen, así que una
    // navegación de cliente pediría un payload RSC que no existe.
    expect(within(desktopNavigation).getByRole('link', { name: 'Iniciar sesión' })).toHaveAttribute(
      'href',
      '/es/sign-in'
    )
    // Landing mínima ([F] 2026-09-14): ni «Cómo funciona» ni «Empieza tu Data
    // Room» en el header; el único CTA lleno vive en la capa de subida.
    expect(screen.queryByRole('link', { name: 'Cómo funciona' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Empieza tu Data Room' })).not.toBeInTheDocument()
    for (const link of screen.getAllByRole('link', { name: /iniciar sesión/i })) {
      expect(link).toHaveAttribute('href', '/es/sign-in')
      expect(link).not.toHaveAttribute('data-prefetch')
    }
    expect(screen.queryByTestId('notification-bell')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Data Room' })).not.toBeInTheDocument()
  })

  it('hides itself on the sign-in door', () => {
    mockPathname = '/sign-in'
    const { container } = render(<PublicNavbar />)
    expect(container.firstChild).toBeNull()
  })
})
