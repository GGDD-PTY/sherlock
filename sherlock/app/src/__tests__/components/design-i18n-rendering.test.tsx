import { render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { describe, expect, it, vi } from 'vitest'

import { RouteErrorBoundary } from '@/components/errors/RouteErrorBoundary'
import esMessages from '@/messages/es.json'

vi.unmock('next-intl')

vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

function renderBoundary(locale: 'es') {
  return render(
    <NextIntlClientProvider locale={locale} messages={esMessages}>
      <RouteErrorBoundary error={new Error('test')} reset={vi.fn()} />
    </NextIntlClientProvider>
  )
}

describe('localized design rendering', () => {
  // Este caso probaba la cara inglesa del boundary. [F] 2026-09-03 la retiró, así
  // que lo que se pinnea ahora es que esa cara no vuelva por la puerta de atrás.
  it('never renders the retired English copy for the shared route error boundary', () => {
    renderBoundary('es')

    expect(screen.queryByText('We could not load this page')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Return home' })).not.toBeInTheDocument()
  })

  it('renders real Spanish copy for the shared route error boundary', () => {
    renderBoundary('es')

    expect(
      screen.getByRole('heading', { name: 'No pudimos cargar esta página' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'No pudimos cargar esta página', level: 1 })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Volver al inicio' })).toBeInTheDocument()
  })
})
