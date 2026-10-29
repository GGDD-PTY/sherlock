import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CompanyAuthorizationRolloutClient } from '@/components/admin/CompanyAuthorizationRolloutClient'

const mockUseQuery = vi.hoisted(() => vi.fn())
const mockUseMutation = vi.hoisted(() => vi.fn())
const mockBackfill = vi.hoisted(() => vi.fn())
const mockResolve = vi.hoisted(() => vi.fn())
const mockActivate = vi.hoisted(() => vi.fn())
const mockPause = vi.hoisted(() => vi.fn())

const API = vi.hoisted(() => ({
  inventory: 'companyAuthorizationRollout:getInventory',
  candidates: 'companyAuthorizationRollout:getCandidates',
  backfill: 'companyAuthorizationRollout:backfill',
  resolve: 'companyAuthorizationRollout:resolve',
  activate: 'companyAuthorizationRollout:activate',
  pause: 'companyAuthorizationRollout:pause',
}))

vi.mock('convex/react', () => ({
  useQuery: mockUseQuery,
  useMutation: mockUseMutation,
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companyAuthorizationRollout: {
      getCompanyOrganizationBindingInventory: API.inventory,
      getCompanyOrganizationBindingCandidates: API.candidates,
      backfillCompanyOrganizationBindings: API.backfill,
      resolveCompanyOrganizationBinding: API.resolve,
      activateCompanyOrganizationBindingCutover: API.activate,
      pauseCompanyOrganizationBindingCutover: API.pause,
    },
  },
}))

const unresolvedRow = {
  companyId: 'company_one',
  companyName: 'Empresa Uno',
  workosOwned: true,
  status: 'UNRESOLVED',
  candidateCount: 1,
  membershipCapExceeded: false,
  bindingCount: 0,
  inventoryRecorded: true,
  inventoryRecordCount: 1,
  inventoryStatus: 'UNRESOLVED',
  inventoryObservedAt: 1_700_000_000_000,
  inventoryDrift: false,
  createdAfterInventoryStart: false,
}

function inventory(overrides: Record<string, unknown> = {}) {
  return {
    enforcementStatus: 'PREPARING',
    inventoryComplete: false,
    inventoryNextCursor: 'durable-cursor-2',
    isDone: false,
    continueCursor: 'display-cursor-2',
    pageHasDrift: false,
    pageHasCreationDrift: false,
    summary: {
      totalCompanies: 1,
      workosOwned: 1,
      bound: 0,
      unresolved: 1,
      ambiguous: 0,
      invalid: 0,
      legacy: 0,
    },
    rows: [unresolvedRow],
    ...overrides,
  }
}

describe('CompanyAuthorizationRolloutClient', () => {
  let currentInventory: ReturnType<typeof inventory>
  let currentCandidateIds: string[]

  beforeEach(() => {
    currentInventory = inventory()
    currentCandidateIds = ['org_owner']
    mockBackfill.mockReset().mockResolvedValue({
      inserted: 0,
      unchanged: 0,
      unresolved: 1,
      ambiguous: 0,
      isDone: false,
      continueCursor: 'durable-cursor-2',
    })
    mockResolve.mockReset().mockResolvedValue({ companyId: 'company_one', status: 'BOUND' })
    mockActivate.mockReset().mockResolvedValue({ status: 'ENFORCED', workosOwned: 1 })
    mockPause.mockReset().mockResolvedValue({
      status: 'UNENFORCED',
      inventoryReset: true,
      bindingsPreserved: true,
    })
    mockUseQuery.mockReset().mockImplementation((reference: string, args: unknown) => {
      if (reference === API.inventory) return currentInventory
      if (reference === API.candidates && args !== 'skip') {
        return {
          companyId: 'company_one',
          status: 'UNRESOLVED',
          candidateProviderOrgIds: currentCandidateIds,
        }
      }
    })
    mockUseMutation.mockReset().mockImplementation((reference: string) => {
      if (reference === API.backfill) return mockBackfill
      if (reference === API.resolve) return mockResolve
      if (reference === API.activate) return mockActivate
      if (reference === API.pause) return mockPause
      return vi.fn()
    })
  })

  it('does not mutate on mount and states that inventory never assigns organizations', () => {
    render(<CompanyAuthorizationRolloutClient />)

    expect(mockBackfill).not.toHaveBeenCalled()
    expect(mockResolve).not.toHaveBeenCalled()
    expect(mockActivate).not.toHaveBeenCalled()
    expect(mockPause).not.toHaveBeenCalled()
    expect(
      screen.getByText(/El inventario no asigna organizaciones: confirma cada vínculo/i)
    ).toBeInTheDocument()
  })

  it('uses the durable server cursor only after the admin requests the next inventory page', async () => {
    render(<CompanyAuthorizationRolloutClient />)

    expect(mockBackfill).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Procesar siguiente página' }))

    await waitFor(() => {
      expect(mockBackfill).toHaveBeenCalledWith({
        cursor: 'durable-cursor-2',
        numItems: 25,
      })
    })
  })

  it('keeps display pagination separate from the durable inventory cursor', () => {
    render(<CompanyAuthorizationRolloutClient />)

    fireEvent.click(screen.getByRole('button', { name: 'Siguiente' }))

    expect(mockUseQuery).toHaveBeenCalledWith(API.inventory, {
      cursor: 'display-cursor-2',
      numItems: 25,
    })
    expect(mockBackfill).not.toHaveBeenCalled()
  })

  it('requires an explicit candidate and reason before resolving a company', async () => {
    render(<CompanyAuthorizationRolloutClient />)

    fireEvent.click(screen.getByRole('button', { name: 'Resolver' }))
    const save = screen.getByRole('button', { name: 'Guardar vínculo' })
    expect(save).toBeDisabled()

    fireEvent.click(screen.getByRole('combobox', { name: 'Organización de WorkOS' }))
    fireEvent.click(screen.getByRole('option', { name: 'org_owner' }))
    fireEvent.change(screen.getByLabelText('Razón de la resolución'), {
      target: { value: 'Membresía owner vigente confirmada.' },
    })
    fireEvent.click(save)

    await waitFor(() => {
      expect(mockResolve).toHaveBeenCalledWith({
        companyId: 'company_one',
        providerOrgId: 'org_owner',
        reason: 'Membresía owner vigente confirmada.',
      })
    })
  })

  it('does not offer a manual organization when the owner has no valid candidate', () => {
    currentCandidateIds = []
    render(<CompanyAuthorizationRolloutClient />)

    fireEvent.click(screen.getByRole('button', { name: 'Resolver' }))
    fireEvent.change(screen.getByLabelText('Razón de la resolución'), {
      target: { value: 'Revisión sin membresía owner válida.' },
    })

    expect(
      screen.queryByRole('combobox', { name: 'Organización de WorkOS' })
    ).not.toBeInTheDocument()
    expect(screen.getByText('No hay una organización válida para seleccionar.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Guardar vínculo' })).toBeDisabled()
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('requires confirmation before activating a completed inventory', async () => {
    currentInventory = inventory({
      enforcementStatus: 'PREPARING',
      inventoryComplete: true,
      inventoryNextCursor: undefined,
      isDone: true,
      continueCursor: '',
      summary: { ...inventory().summary, bound: 1, unresolved: 0 },
      rows: [{ ...unresolvedRow, status: 'BOUND', bindingCount: 1 }],
    })
    render(<CompanyAuthorizationRolloutClient />)

    fireEvent.click(screen.getByRole('button', { name: 'Activar control' }))
    expect(mockActivate).not.toHaveBeenCalled()
    expect(screen.getByText(/cada dueño deberá tener una membresía vigente/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Activar' }))
    await waitFor(() => expect(mockActivate).toHaveBeenCalledWith({}))
  })

  it('confirms that pausing preserves exact bindings before sending the recorded reason', async () => {
    currentInventory = inventory({
      enforcementStatus: 'ENFORCED',
      inventoryComplete: true,
      inventoryNextCursor: undefined,
      isDone: true,
      continueCursor: '',
      summary: { ...inventory().summary, bound: 1, unresolved: 0 },
      rows: [{ ...unresolvedRow, status: 'BOUND', bindingCount: 1 }],
    })
    render(<CompanyAuthorizationRolloutClient />)

    fireEvent.change(screen.getByLabelText('Razón de la pausa'), {
      target: { value: 'Revisar membresías antes del nuevo inventario.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pausar y reiniciar' }))

    expect(mockPause).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        /Los vínculos existentes y sus controles de organización exacta seguirán activos/i
      )
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }))
    await waitFor(() => {
      expect(mockPause).toHaveBeenCalledWith({
        reason: 'Revisar membresías antes del nuevo inventario.',
      })
    })
  })

  it('keeps activation and pause unavailable while rollout prerequisites are pending', () => {
    currentInventory = inventory({
      enforcementStatus: 'UNENFORCED',
      inventoryComplete: false,
      inventoryNextCursor: undefined,
    })
    render(<CompanyAuthorizationRolloutClient />)

    expect(screen.getByRole('button', { name: 'Activar control' })).toBeDisabled()
    expect(screen.getByLabelText('Razón de la pausa')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Pausar y reiniciar' })).toBeDisabled()
  })
})
