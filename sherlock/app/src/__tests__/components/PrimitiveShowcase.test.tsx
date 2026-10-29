import { render, screen, within } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/components/providers/ThemeProvider'
import { PrimitiveShowcase } from '@/components/showcase/PrimitiveShowcase'
import { SYNTHETIC_SHOWCASE_FIXTURES } from '@/components/showcase/showcase-fixtures'
import esMessages from '@/messages/es.json'

vi.unmock('next-intl')

vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
  usePathname: () => '/design-system',
  useRouter: () => ({ replace: vi.fn() }),
}))

function renderShowcase(locale: 'es') {
  return render(
    <NextIntlClientProvider locale={locale} messages={esMessages}>
      <ThemeProvider>
        <PrimitiveShowcase />
      </ThemeProvider>
    </NextIntlClientProvider>
  )
}

describe('PrimitiveShowcase', () => {
  it.each([['es', 'Sistema de diseño', 'Fundamentos']] as const)(
    'renders six contract families in %s',
    (locale, title, foundations) => {
      renderShowcase(locale)

      expect(screen.getByRole('heading', { name: title, level: 1 })).toBeInTheDocument()
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
      expect(screen.getByRole('heading', { name: foundations, level: 2 })).toBeInTheDocument()
      expect(screen.getAllByTestId('showcase-family')).toHaveLength(6)
    }
  )

  it('exposes the full interaction and async state vocabulary', () => {
    renderShowcase('es')

    expect(document.querySelector('#showcase-theme-menu-trigger')).toBeInTheDocument()
    // El selector de idioma se retiró con el locale `en`: la vitrina no puede
    // volver a ofrecer un control que la ruta deshace.
    expect(document.querySelector('#showcase-language-menu-trigger')).not.toBeInTheDocument()
    const stateMatrix = screen.getByTestId('showcase-state-matrix')
    for (const state of [
      'Predeterminado',
      'Al pasar el puntero',
      'Foco',
      'Activo',
      'Deshabilitado',
      'Cargando',
      'Vacío',
      'Error',
      'Denegado',
      'Pendiente',
      'Éxito',
    ]) {
      expect(within(stateMatrix).getByText(state)).toBeInTheDocument()
    }
  })

  it('renders deterministic route loading and shared error-boundary representations', () => {
    renderShowcase('es')

    expect(screen.getByTestId('route-loading-company')).toBeInTheDocument()
    expect(screen.getByTestId('route-loading-admin')).toBeInTheDocument()
    expect(screen.getByTestId('route-error-company')).toBeInTheDocument()
    expect(screen.getByTestId('route-error-admin')).toBeInTheDocument()
  })

  it('uses access-request language instead of social matching or connections', () => {
    renderShowcase('es')

    expect(screen.getByText('Todavía no hay solicitudes de acceso aprobadas')).toBeInTheDocument()
    expect(screen.getAllByText('Acceso aprobado').length).toBeGreaterThan(0)
    expect(screen.queryByText('Todavía no hay coincidencias aprobadas')).not.toBeInTheDocument()
    expect(screen.queryByText('Conexión aprobada')).not.toBeInTheDocument()
  })

  it('sets human amounts in font-figure and keeps Fraunces off h3', () => {
    renderShowcase('es')

    expect(document.querySelector('h3.font-display')).not.toBeInTheDocument()
    expect(document.querySelector('.font-figure.text-3xl')).toBeInTheDocument()
    const syntheticId = SYNTHETIC_SHOWCASE_FIXTURES.mandate.id
    const idNode = screen
      .getAllByText(syntheticId)
      .find((node) => node.classList.contains('font-mono'))
    expect(idNode).toBeDefined()
    expect(idNode).not.toHaveClass('font-figure')
  })

  it('keeps the rendered heading outline free of skipped levels', () => {
    renderShowcase('es')

    const headingLevels = screen.getAllByRole('heading').map((heading) => {
      const explicitLevel = heading.getAttribute('aria-level')
      return explicitLevel === null ? Number(heading.tagName.slice(1)) : Number(explicitLevel)
    })

    expect(
      headingLevels.every(
        (level, index) => index === 0 || level <= (headingLevels[index - 1] ?? level) + 1
      )
    ).toBe(true)
  })
})
