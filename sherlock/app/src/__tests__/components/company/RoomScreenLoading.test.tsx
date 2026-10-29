// El esqueleto de la sala nombraba «Data Room» en las cuatro pantallas, así
// que quien esperaba 1,2 s no sabía a dónde iba ([F] 2026-09-17, hallazgos del
// E2E). Ahora nombra la pantalla que está cargando, con la misma copia que usa
// la barra de secciones.

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { RoomScreenLoading } from '@/components/company/RoomScreenLoading'
import type { RoomScreen } from '@/components/company/roomScreens'

const EXPECTED_TITLE: Record<Exclude<RoomScreen, 'documents'>, string> = {
  company: 'Tu empresa',
  preparation: 'Preparación',
  team: 'Equipo',
  guests: 'Invitados',
}

describe('RoomScreenLoading', () => {
  it.each(Object.entries(EXPECTED_TITLE))('names %s while it loads', (screenName, title) => {
    render(<RoomScreenLoading screen={screenName as RoomScreen} />)

    const identity = screen.getByRole('heading', { level: 1 })
    expect(identity).toHaveTextContent(title)
    expect(identity).not.toHaveTextContent('Data Room')
  })

  it('stays an announced busy region', () => {
    render(<RoomScreenLoading screen="team" />)

    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-busy', 'true')
    expect(region).toHaveAttribute('aria-live', 'polite')
  })
})
