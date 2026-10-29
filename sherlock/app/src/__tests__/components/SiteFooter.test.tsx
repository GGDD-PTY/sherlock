// ============================================================================
// SITE FOOTER — LINK LEGAL EN TODA LA APP
// ============================================================================
// El footer compartido vive en [locale]/layout.tsx (debajo de children): toda
// página, pública o autenticada, debe exponer la salida legal. Landing mínima
// ([F] 2026-09-14): un solo enlace «Legal» a /legal, que reúne las tres salidas.
// ============================================================================

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SiteFooter } from '@/components/layout/SiteFooter'
import esMessages from '@/messages/es.json'

vi.mock('next-intl/server', () => ({
  getTranslations:
    async ({ namespace }: { locale: 'es'; namespace: string }) =>
    (key: string, values?: Record<string, unknown>) => {
      const catalog = esMessages
      const path = `${namespace}.${key}`.split('.')
      let value: unknown = catalog
      for (const part of path) value = (value as Record<string, unknown>)[part]
      return String(value).replace('{year}', String(values?.year ?? '{year}'))
    },
}))

describe('SiteFooter', () => {
  it('renderiza un solo enlace de navegación: Legal a /legal', async () => {
    render(await SiteFooter({ locale: 'es' }))

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/legal')
    expect(links[0]).toHaveTextContent('Legal')
  })

  it('ya no enlaza destinos retirados ni el acceso de empresas desde el pie', async () => {
    render(await SiteFooter({ locale: 'es' }))

    const hrefs = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter(Boolean)

    for (const retired of [
      '/privacy',
      '/terms',
      '/ayuda',
      '/pricing',
      '/investors',
      '/capital-providers',
    ]) {
      expect(hrefs, `no debería enlazar ${retired}`).not.toContain(retired)
    }
    expect(screen.queryByRole('link', { name: 'Sube tus documentos' })).not.toBeInTheDocument()
    expect((esMessages.landing.footer as Record<string, unknown>).company).toBeUndefined()
    expect((esMessages.landing.footer as Record<string, unknown>).platform).toBeUndefined()
  })

  it('describe el oficio sell-side en el tagline, no el marketplace de dos lados', () => {
    expect(esMessages.landing.footer.tagline).toBe('Preparación sell-side para América Latina.')
    expect(esMessages.landing.footer.tagline).not.toMatch(/marketplace/i)
  })

  it('renderiza la marca y el copyright', async () => {
    render(await SiteFooter({ locale: 'es' }))

    expect(screen.getByText('Sherlock')).toBeInTheDocument()
    expect(screen.getByText('Esto no es asesoría de inversión.')).toBeInTheDocument()
    // El componente pasa `{ year }` a t('footer.copyright'), así que el placeholder
    // ICU se resuelve: el texto renderizado trae el año, no `{year}`.
    const year = new Date().getFullYear()
    expect(
      screen.getByText(`© ${year} Sherlock. Todos los derechos reservados.`)
    ).toBeInTheDocument()
    expect(esMessages.landing.footer.copyright).toBe(
      '© {year} Sherlock. Todos los derechos reservados.'
    )
  })

  // El caso hermano montaba el footer inglés. Retirado el locale, lo que queda
  // por pinnear es que el shell sirve el catálogo español y solo ese.
  it('renders the Spanish footer for the only localized shell', async () => {
    render(await SiteFooter({ locale: 'es' }))

    expect(screen.getByText(esMessages.landing.footer.tagline)).toBeInTheDocument()
    expect(
      screen.getByText(
        esMessages.landing.footer.copyright.replace('{year}', String(new Date().getFullYear()))
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/We prepare your company to raise capital/)).not.toBeInTheDocument()
  })

  it('no expone grupos de navegación como secciones de segundo nivel', async () => {
    render(await SiteFooter({ locale: 'es' }))

    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
  })
})
