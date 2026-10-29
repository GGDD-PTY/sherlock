// ============================================================================
// SECCIONES PLEGADAS DE LA SALA ADMIN (auditoría 2026-09-06, F02 + F07)
// ============================================================================
// Lo que fija este test:
//  1. Los dos paneles van plegados por defecto y el orden es preparación,
//     después activación.
//  2. El resumen dice lo esencial sin abrir: «Revisión del equipo: N de 7
//     listos» con el primer pendiente, y el estado de acceso con una sola voz.
//  3. Abrir una sección se recuerda por empresa en localStorage; sin dato
//     guardado, cerrada.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Id } from '@/../convex/_generated/dataModel'

const mockUseQuery = vi.fn()

vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companyChecklist: {
      getCompanyChecklist: 'companyChecklist:getCompanyChecklist',
    },
  },
}))

const { AdminRoomSections } = await import('@/components/admin/AdminRoomSections')

const COMPANY_ID = 'company_1' as Id<'companies'>
const NOW = Date.UTC(2026, 8, 6, 15, 0, 0)

function checklist(overrides: { active?: boolean; complete?: boolean } = {}) {
  const complete = overrides.complete === true
  return {
    companyId: COMPANY_ID,
    items: {
      nameConfirmed: { done: true, at: NOW },
      phone: { done: complete, at: null },
      financials: { done: true, at: null, count: 4 },
      legal: { done: complete, at: null, count: 0 },
      corporate: { done: true, at: null, count: 2 },
      financialsDepth: { done: complete, at: null },
      kickoffCall: { done: complete, at: null },
    },
    completedCount: complete ? 7 : 3,
    activation: overrides.active
      ? { active: true, at: NOW, by: 'profile_admin', note: 'Arrancamos' }
      : { active: false, at: null, by: null, note: null },
    stages: [],
  }
}

function renderSections(props: { isDemo?: boolean } = {}) {
  return render(
    <AdminRoomSections
      companyId={COMPANY_ID}
      isDemo={props.isDemo}
      preparation={<div data-testid="preparation-panel" />}
      activation={<div data-testid="activation-panel" />}
    />
  )
}

describe('admin room sections', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mockUseQuery.mockReset().mockReturnValue(checklist())
  })

  it('folds both panels by default, preparation before activation', () => {
    renderSections()

    const preparation = screen.getByTestId('admin-room-section-preparation')
    const activation = screen.getByTestId('admin-room-section-activation')
    expect(preparation).not.toHaveAttribute('open')
    expect(activation).not.toHaveAttribute('open')
    expect(
      preparation.compareDocumentPosition(activation) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(preparation).toContainElement(screen.getByTestId('preparation-panel'))
    expect(activation).toContainElement(screen.getByTestId('activation-panel'))
  })

  it('summarizes preparation as N de 7 with the first pending item', () => {
    renderSections()

    const summary = screen.getByTestId('admin-room-summary-preparation')
    expect(summary).toHaveTextContent('Revisión del equipo: 3 de 7 listos')
    expect(summary).toHaveTextContent('Falta: Teléfono')
  })

  it('drops the pending line once the seven items are done', () => {
    mockUseQuery.mockReturnValue(checklist({ complete: true }))

    renderSections()

    const summary = screen.getByTestId('admin-room-summary-preparation')
    expect(summary).toHaveTextContent('Revisión del equipo: 7 de 7 listos')
    expect(summary).not.toHaveTextContent('Falta:')
  })

  it('names the access state with one voice: sin activar or disponible', () => {
    const { unmount } = renderSections()
    expect(screen.getByTestId('admin-room-summary-activation')).toHaveTextContent(
      'Sala sin activar'
    )
    expect(screen.getByTestId('admin-room-summary-activation')).toHaveTextContent(
      'El cliente ya sube y habla; activar marca que el equipo arranca'
    )
    unmount()

    mockUseQuery.mockReturnValue(checklist({ active: true }))
    renderSections()
    expect(screen.getByTestId('admin-room-summary-activation')).toHaveTextContent('Sala activada')
    expect(screen.getByTestId('admin-room-summary-activation')).toHaveTextContent(
      'El equipo ya arrancó el trabajo'
    )
    expect(screen.queryByText('Sala activa')).not.toBeInTheDocument()
  })

  it('remembers an opened section per company and forgets it when closed', () => {
    renderSections()

    const preparation = screen.getByTestId('admin-room-section-preparation') as HTMLDetailsElement
    preparation.open = true
    fireEvent(preparation, new Event('toggle'))
    expect(window.localStorage.getItem('sherlock:admin-room:company_1:preparation')).toBe('open')

    preparation.open = false
    fireEvent(preparation, new Event('toggle'))
    expect(window.localStorage.getItem('sherlock:admin-room:company_1:preparation')).toBeNull()
  })

  it('opens a section the team left open the last time', () => {
    window.localStorage.setItem('sherlock:admin-room:company_1:activation', 'open')

    renderSections()

    expect(screen.getByTestId('admin-room-section-activation')).toHaveAttribute('open')
    expect(screen.getByTestId('admin-room-section-preparation')).not.toHaveAttribute('open')
  })

  it('keeps the titles while the checklist loads', () => {
    mockUseQuery.mockReturnValue(undefined)

    renderSections()

    expect(screen.getByTestId('admin-room-summary-preparation')).toHaveTextContent(
      'Revisión del equipo'
    )
    expect(screen.getByTestId('admin-room-summary-activation')).toHaveTextContent(
      'Activación del Data Room'
    )
  })

  it('skips the checklist and the activation section in the demo room', () => {
    renderSections({ isDemo: true })

    expect(mockUseQuery).toHaveBeenCalledWith('companyChecklist:getCompanyChecklist', 'skip')
    expect(screen.getByTestId('admin-room-section-preparation')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-room-section-activation')).not.toBeInTheDocument()
  })
})
