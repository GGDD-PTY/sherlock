import { render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import AdminLoading from '@/app/[locale]/(app)/admin/loading'
import DocumentsLoading from '@/app/[locale]/(app)/my-company/documents/loading'
import MyCompanyLoading from '@/app/[locale]/(app)/my-company/loading'
import esMessages from '@/messages/es.json'

vi.unmock('next-intl')

const CASES = [
  ['admin', AdminLoading, 'Cargando operaciones de preparación'],
  ['documents', DocumentsLoading, 'Data Room'],
  ['company', MyCompanyLoading, 'Data Room'],
] as const

function renderWithLocale(locale: 'es', children: ReactNode) {
  return render(
    <NextIntlClientProvider locale={locale} messages={esMessages}>
      {children}
    </NextIntlClientProvider>
  )
}

describe('localized route loading states', () => {
  // El caso hermano corría el mismo render en inglés. Retirado el locale, lo que
  // queda por pinnear es que el anuncio no traiga una segunda región viva.
  it.each(CASES)('announces the %s loading state through a single live region', (_, Loading) => {
    renderWithLocale('es', <Loading />)

    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.queryByText(/^Loading /)).not.toBeInTheDocument()
  })

  it.each(CASES)('announces the %s loading state once in Spanish', (_, Loading, label) => {
    renderWithLocale('es', <Loading />)

    const statuses = screen.getAllByRole('status')
    const status = screen.getByRole('status')

    expect(statuses).toHaveLength(1)
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(status).toHaveTextContent(label)
  })
})
