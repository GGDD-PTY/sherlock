// ============================================================================
// A11Y: NOMBRE DE LOS SWITCHES Y ENCABEZADOS DE LOS DOCUMENTOS LEGALES
// ============================================================================
// Los dos hallazgos de la auditoría del 2026-09-10 que el DOM puede probar:
//
// 1. Los interruptores de consentimiento salían al árbol accesible como
//    `switch` sin rótulo: el título era un `<p>` hermano, sin `aria-labelledby`.
//    Eran cuatro; «Compartir con Terceros» salió de la pantalla el 2026-09-11.
// 2. Los once títulos numerados de la Política de Privacidad se pintaban como
//    `<div>`: dentro de `main` sólo existía el h1, así que un lector de
//    pantalla no podía saltar de sección en sección.
//
// Estos dos tests fallan si el DOM vuelve a la forma vieja.
// ============================================================================

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { PrivacySettingsClient } from '@/app/[locale]/(app)/settings/privacy/PrivacySettingsClient'
import PrivacyPage from '@/app/[locale]/(public)/privacy/page'
import LegalNoticesPage from '@/app/[locale]/(public)/legal/page'
import TermsPage from '@/app/[locale]/(public)/terms/page'
import esMessages from '@/messages/es.json'

// Las páginas legales resuelven sus enlaces del pie con getTranslations
// (server); en este entorno no hay request, así que el mock lee el catálogo
// real para que los rótulos renderizados sean los del `es.json` vigente.
vi.mock('next-intl/server', () => ({
  getTranslations:
    async (arg: string | { locale?: string; namespace?: string }) => (key: string) => {
      const namespace = typeof arg === 'string' ? arg : arg.namespace
      const path = `${namespace}.${key}`.split('.')
      let value: unknown = esMessages
      for (const part of path) value = (value as Record<string, unknown>)[part]
      return typeof value === 'string' ? value : key
    },
  setRequestLocale: () => {},
}))

// La pantalla se rinde con un perfil cargado; sin él reutiliza el skeleton de
// la ruta y no llega a pintar un solo interruptor.
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    profile: { _id: 'profile_test' },
    isLoading: false,
  }),
}))

describe('interruptores de consentimiento', () => {
  it('expone los tres switches con el título de su tarjeta como nombre', () => {
    render(<PrivacySettingsClient />)

    // Los nombres son los del catálogo `es.json`, que es lo que anuncia el
    // lector de pantalla. Si el `aria-labelledby` se cae, `getByRole` no los
    // encuentra por nombre y el test va rojo.
    for (const name of ['Términos de Servicio', 'Política de Privacidad', 'Correos de marketing']) {
      expect(screen.getByRole('switch', { name })).toBeInTheDocument()
    }

    expect(screen.getAllByRole('switch')).toHaveLength(3)
    // Sherlock no comparte datos con socios: el interruptor que lo ofrecía
    // describía el marketplace borrado el 2026-08-28.
    expect(screen.queryByRole('switch', { name: 'Compartir con Terceros' })).not.toBeInTheDocument()
  })

  it('describe cada switch con el texto de su consentimiento', () => {
    render(<PrivacySettingsClient />)

    const marketing = screen.getByRole('switch', { name: 'Correos de marketing' })
    const description = screen.getByText(
      'Recibir novedades del producto y notificaciones del equipo por email'
    )

    expect(description.id).toBe('consent-marketing_emails-description')
    expect(marketing).toHaveAttribute('aria-describedby', description.id)
  })
})

describe('encabezados de los documentos legales', () => {
  it('da nivel 2 a los once títulos de la Política de Privacidad', async () => {
    render(await PrivacyPage())

    const headings = screen.getAllByRole('heading', { level: 2 })

    expect(headings).toHaveLength(11)
    expect(headings[0]).toHaveTextContent('1. Responsable del tratamiento')
    expect(headings[10]).toHaveTextContent('11. Ley aplicable')
    // El h1 del documento sigue siendo uno solo.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('no deja ningún título de sección fuera de la jerarquía en Avisos y Términos', async () => {
    for (const page of [
      await LegalNoticesPage({ params: Promise.resolve({ locale: 'es' }) }),
      await TermsPage(),
    ]) {
      const { container, unmount } = render(page)
      const titles = container.querySelectorAll('[data-slot="card-title"]')

      expect(titles.length).toBeGreaterThan(0)
      expect(container.querySelectorAll('h2[data-slot="card-title"]')).toHaveLength(titles.length)

      unmount()
    }
  })

  it('keeps legal sections readable without decorative cards', async () => {
    for (const page of [
      await PrivacyPage(),
      await LegalNoticesPage({ params: Promise.resolve({ locale: 'es' }) }),
      await TermsPage(),
    ]) {
      const { container, unmount } = render(page)
      const sections = Array.from(container.querySelectorAll('[data-slot="card"]'))
      expect(sections.length).toBeGreaterThan(0)
      for (const section of sections) {
        expect(section).toHaveClass('border-0', 'shadow-none')
        expect(section.querySelector('h2')).not.toBeNull()
      }
      unmount()
    }
  })
})
