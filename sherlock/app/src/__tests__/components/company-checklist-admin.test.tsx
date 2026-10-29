import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Id } from '@/../convex/_generated/dataModel'

const mockUseQuery = vi.fn()
const mockUseMutation = vi.fn()
const mockSetChecklistItem = vi.fn()
const mockSetActivation = vi.fn()
const mockUseLocale = vi.fn(() => 'es')

vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companyChecklist: {
      getCompanyChecklist: 'companyChecklist:getCompanyChecklist',
      setChecklistItem: 'companyChecklist:setChecklistItem',
      setActivation: 'companyChecklist:setActivation',
    },
  },
}))

vi.mock('next-intl', async () => {
  const es = (await import('@/messages/es.json')).default as Record<string, unknown>

  return {
    useLocale: () => mockUseLocale(),
    useTranslations: (namespace: string) => {
      const messages = es
      return (key: string, values?: Record<string, string | number>) => {
        let node: unknown = messages
        for (const part of [...namespace.split('.'), ...key.split('.')]) {
          node = (node as Record<string, unknown> | undefined)?.[part]
        }
        if (typeof node !== 'string') return `${namespace}.${key}`
        return node.replace(/\{(\w+)\}/g, (match, name) =>
          values && name in values ? String(values[name]) : match
        )
      }
    },
  }
})

const { AdminRoomActivationPanel } = await import('@/components/admin/AdminRoomActivationPanel')

const COMPANY_ID = 'company_1' as Id<'companies'>
const NOW = Date.UTC(2026, 7, 28, 15, 0, 0)

const COMPONENT_SOURCE = join(
  process.cwd(),
  'src',
  'components',
  'admin',
  'AdminRoomActivationPanel.tsx'
)

const HEX_COLOR = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/
const EMOJI = /\p{Extended_Pictographic}/u

function checklist(overrides: { active?: boolean } = {}) {
  return {
    companyId: COMPANY_ID,
    items: {
      nameConfirmed: { done: true, at: NOW },
      phone: { done: false, at: null },
      financials: { done: true, at: null, count: 4 },
      legal: { done: false, at: null, count: 0 },
      corporate: { done: true, at: null, count: 2 },
      financialsDepth: { done: false, at: null },
      kickoffCall: { done: false, at: null },
    },
    completedCount: 3,
    activation: overrides.active
      ? { active: true, at: NOW, by: 'profile_admin', note: 'Arrancamos' }
      : { active: false, at: null, by: null, note: null },
    stages: [],
  }
}

describe('admin room activation block', () => {
  beforeEach(() => {
    mockUseLocale.mockReset().mockReturnValue('es')
    mockSetChecklistItem.mockReset().mockResolvedValue(undefined)
    mockSetActivation.mockReset().mockResolvedValue(undefined)
    mockUseQuery.mockReset().mockReturnValue(checklist())
    mockUseMutation
      .mockReset()
      .mockImplementation((reference: unknown) =>
        reference === 'companyChecklist:setChecklistItem' ? mockSetChecklistItem : mockSetActivation
      )
  })

  it('lists the seven items with their folder counts and marks only the two manual ones', () => {
    render(<AdminRoomActivationPanel companyId={COMPANY_ID} />)

    const list = screen.getByTestId('admin-checklist-items')
    expect(within(list).getAllByRole('listitem')).toHaveLength(7)
    expect(within(list).getByText('Financieros (4)')).toBeVisible()
    expect(within(list).getByText('Legales (0)')).toBeVisible()
    expect(
      within(screen.getByTestId('admin-checklist-item-financialsDepth')).getByText('Solo equipo')
    ).toBeVisible()
    expect(
      within(screen.getByTestId('admin-checklist-item-kickoffCall')).getByText('Solo equipo')
    ).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'Marcar' })).toHaveLength(2)
  })

  it('marks the kickoff call through the admin mutation', async () => {
    render(<AdminRoomActivationPanel companyId={COMPANY_ID} />)

    const kickoff = screen.getByTestId('admin-checklist-item-kickoffCall')
    fireEvent.click(within(kickoff).getByRole('button', { name: 'Marcar' }))

    await waitFor(() => {
      expect(mockSetChecklistItem).toHaveBeenCalledWith({
        companyId: COMPANY_ID,
        item: 'kickoffCall',
        done: true,
      })
    })
  })

  it('activates the room below 100% with the short note the team writes', async () => {
    render(<AdminRoomActivationPanel companyId={COMPANY_ID} />)

    // Una sola voz para el acceso (auditoría 2026-09-06, F07): el panel dice
    // «Sala sin activar» y qué significa; el «N de 7» vive en el resumen de
    // preparación (AdminRoomSections), no acá.
    expect(screen.getByTestId('admin-activation-state')).toHaveTextContent('Sala sin activar')
    expect(
      screen.getByText('El cliente ya sube y habla; activar marca que el equipo arranca')
    ).toBeVisible()
    expect(screen.queryByText(/de 7 listos/)).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Nota de activación'), {
      target: { value: 'Arrancamos con lo que hay' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Activar Data Room' }))

    await waitFor(() => {
      expect(mockSetActivation).toHaveBeenCalledWith({
        companyId: COMPANY_ID,
        active: true,
        note: 'Arrancamos con lo que hay',
      })
    })
  })

  it('replaces the button with the dated seal once the room is active', () => {
    mockUseQuery.mockReturnValue(checklist({ active: true }))

    render(<AdminRoomActivationPanel companyId={COMPANY_ID} />)

    expect(screen.getByTestId('admin-activation-state')).toHaveTextContent(/^Sala activada/)
    expect(screen.getByText('El equipo ya arrancó el trabajo')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Activar Data Room' })).not.toBeInTheDocument()
  })

  it('renders no emoji and the component source has no literal hex', () => {
    const { container } = render(<AdminRoomActivationPanel companyId={COMPANY_ID} />)
    expect(container.textContent ?? '').not.toMatch(EMOJI)

    const source = readFileSync(COMPONENT_SOURCE, 'utf8')
    expect(source).not.toMatch(HEX_COLOR)
    expect(source).not.toMatch(EMOJI)
  })
})
