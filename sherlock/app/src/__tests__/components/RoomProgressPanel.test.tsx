import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Id } from '@/../convex/_generated/dataModel'

const mockUseQuery = vi.fn()
const mockSavePhone = vi.fn()
const mockUseLocale = vi.fn(() => 'es')
const queryMounts = vi.hoisted(() => ({ current: 0 }))

vi.mock('convex/react', async () => {
  const { useRef } = await import('react')
  return {
    useQuery: (...args: unknown[]) => {
      const isMounted = useRef(false)
      if (!isMounted.current) {
        isMounted.current = true
        queryMounts.current += 1
      }
      return mockUseQuery(...args)
    },
    useMutation: () => mockSavePhone,
  }
})

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: { updateContactPhone: 'companies.updateContactPhone' },
    companyChecklist: { getCompanyChecklist: 'companyChecklist.getCompanyChecklist' },
    deliverables: { listForCompany: 'deliverables.listForCompany' },
  },
}))

vi.mock('next-intl', async () => {
  const es = (await import('@/messages/es.json')).default as Record<string, unknown>

  return {
    useLocale: () => mockUseLocale(),
    useTranslations: (namespace: string) => {
      const messages = es
      return (key: string, values?: Record<string, string | number>) => {
        const parts = [...namespace.split('.'), ...key.split('.')]
        let node: unknown = messages
        for (const part of parts) {
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

import { RoomProgressPanel } from '@/components/company/RoomProgressPanel'
import { computeRoomProgress } from '@/lib/vdr/room-progress'

const COMPANY_ID = 'company_1' as Id<'companies'>
const NOW = Date.UTC(2026, 7, 28)
const COMPONENT_SOURCE = join(
  __dirname,
  '..',
  '..',
  'components',
  'company',
  'RoomProgressPanel.tsx'
)

const STAGE_KEYS = [
  'MODEL_V1',
  'MODEL_V2',
  'TEASER',
  'CIM',
  'MGMT_PRESENTATION',
  'DECKS',
  'QA',
  'IRL',
] as const

const STAGE_LABELS = [
  'Modelo v1',
  'Modelo v2',
  'Teaser',
  'CIM',
  'Management presentation',
  'Decks de deuda y equity',
  'Preguntas y respuestas',
  'Lista de pedidos (IRL)',
] as const

const HEX_COLOR = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/
const EMOJI = /\p{Extended_Pictographic}/u

function item(done: boolean) {
  return { done, at: done ? NOW : null }
}

function checklistFiveOfSeven() {
  return {
    companyId: COMPANY_ID,
    items: {
      nameConfirmed: item(true),
      phone: item(false),
      financials: item(true),
      legal: item(false),
      corporate: item(true),
      financialsDepth: item(true),
      kickoffCall: item(true),
    },
    completedCount: 5,
    activation: { active: true, at: NOW },
    stages: [
      { key: 'MODEL_V1', status: 'DELIVERED', updatedAt: NOW },
      { key: 'MODEL_V2', status: 'IN_PROGRESS', updatedAt: NOW },
      { key: 'TEASER', status: 'NEEDS_INPUT', updatedAt: NOW },
      { key: 'CIM', status: 'REQUESTED', updatedAt: NOW },
      { key: 'MGMT_PRESENTATION', status: 'PENDING', updatedAt: null },
      {
        key: 'DECKS',
        status: 'PENDING',
        updatedAt: null,
        items: [
          { kind: 'DEBT_DECK', status: 'PENDING' },
          { kind: 'EQUITY_DECK', status: 'PENDING' },
        ],
      },
      { key: 'QA', status: 'PENDING', updatedAt: null },
      { key: 'IRL', status: 'PENDING', updatedAt: null },
    ],
  }
}

function deliverablesFiveOfSeven() {
  return [
    {
      deliverableId: 'deliverable_model',
      kind: 'MODEL',
      status: 'DELIVERED',
      renditions: [{ format: 'XLSX', documentId: 'document_model' }],
      sources: [],
      deliveryNote: 'Modelo v1 listo para revisión.',
      updatedAt: NOW,
    },
    {
      deliverableId: 'deliverable_teaser',
      kind: 'TEASER',
      status: 'NEEDS_INPUT',
      renditions: [],
      sources: [],
      updatedAt: NOW,
    },
  ]
}

describe('RoomProgressPanel', () => {
  beforeEach(() => {
    mockSavePhone.mockReset().mockResolvedValue({ saved: true })
    mockUseLocale.mockReset().mockReturnValue('es')
    queryMounts.current = 0
    mockUseQuery.mockReset().mockImplementation((reference: unknown) => {
      if (reference === 'companyChecklist.getCompanyChecklist') return checklistFiveOfSeven()
      if (reference === 'deliverables.listForCompany') return deliverablesFiveOfSeven()
      return undefined
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers retry when deliverables hang even if the checklist has loaded', async () => {
    vi.useFakeTimers()
    const resolvedChecklist = new Map<unknown, unknown>([
      ['companyChecklist.getCompanyChecklist', checklistFiveOfSeven()],
    ])
    mockUseQuery.mockImplementation((reference: unknown) => resolvedChecklist.get(reference))
    render(<RoomProgressPanel companyId={COMPANY_ID} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })

    expect(screen.getByTestId('room-progress-load-failure')).toHaveTextContent(
      'No pudimos cargar esta sección.'
    )
  })

  it('offers retry when the preparation checklist does not resolve in 12 seconds', async () => {
    vi.useFakeTimers()
    mockUseQuery.mockImplementation(() => {})
    render(<RoomProgressPanel companyId={COMPANY_ID} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })

    expect(screen.getByTestId('room-progress-load-failure')).toHaveTextContent(
      'No pudimos cargar esta sección.'
    )
    const mountsBeforeRetry = queryMounts.current
    fireEvent.click(screen.getByRole('button', { name: 'Intentar de nuevo' }))
    expect(queryMounts.current).toBeGreaterThan(mountsBeforeRetry)
    expect(screen.getByTestId('room-progress-panel')).toHaveAttribute('aria-busy', 'true')
  })

  it('with 3 of 5 client items ready shows the two missing items and hides the completed ones', () => {
    const progress = computeRoomProgress({
      folders: [
        { folder: 'room_financial', count: 1 },
        { folder: 'room_corporate', count: 1 },
      ],
      nameConfirmed: true,
      phonePresent: false,
      deliverables: [],
      lastMovement: null,
    })
    render(<RoomProgressPanel companyId={COMPANY_ID} />)

    expect(progress.percent).toBe(60)
    expect(progress.siguientePaso).toBe('items.phone')
    expect(screen.getByRole('heading', { level: 2, name: 'Tu preparación' })).toBeVisible()
    expect(screen.getByText('3 de 5 listos')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Te falta' })).toHaveClass(
      'text-sm',
      'font-semibold'
    )
    expect(screen.getByRole('heading', { name: 'Entregables' })).toHaveClass(
      'text-sm',
      'font-semibold'
    )
    expect(screen.queryByRole('heading', { level: 2, name: 'Entregables' })).not.toBeInTheDocument()

    const missing = screen.getByTestId('room-progress-missing')
    expect(within(missing).getAllByRole('listitem')).toHaveLength(2)
    expect(within(missing).getByText('Dejar un teléfono de contacto')).toBeVisible()
    expect(
      within(missing).getByText('Subir los contratos relevantes: clientes, proveedores y crédito')
    ).toBeVisible()
    expect(within(missing).getByRole('button', { name: 'Agregar' })).toBeEnabled()
    expect(within(missing).getByRole('link', { name: 'Subir' })).toHaveAttribute(
      'href',
      '/my-company/documents'
    )

    expect(within(missing).queryByText('Confirmar el nombre de tu empresa')).not.toBeInTheDocument()
    expect(
      within(missing).queryByText('Subir los estados financieros de los últimos 3 a 5 años')
    ).not.toBeInTheDocument()
    expect(within(missing).queryByText(/Subir el pacto social/)).not.toBeInTheDocument()
  })

  it('opens an inline phone form, validates input and preserves it after a safe server error', async () => {
    render(<RoomProgressPanel companyId={COMPANY_ID} />)
    const trigger = screen.getByRole('button', { name: 'Agregar' })
    expect(trigger).toHaveAttribute('aria-controls')
    fireEvent.click(trigger)
    const input = screen.getByRole('textbox', { name: 'Teléfono de contacto' })
    expect(input.closest('form')).toHaveAttribute('id', trigger.getAttribute('aria-controls'))
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar teléfono' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Escribe un teléfono de 7 a 15 dígitos')
    expect(mockSavePhone).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '+507 6000-1234' } })
    mockSavePhone.mockRejectedValueOnce(new Error('private provider payload'))
    fireEvent.click(screen.getByRole('button', { name: 'Guardar teléfono' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos guardar el teléfono')
    expect(screen.queryByText(/private provider payload/)).not.toBeInTheDocument()
    expect(input).toHaveValue('+507 6000-1234')
    expect(screen.getByRole('button', { name: 'Guardar teléfono' })).toBeEnabled()
  })

  it('waits for persistence, prevents duplicate saves and follows the refreshed checklist', async () => {
    let finishSave: (() => void) | undefined
    mockSavePhone.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishSave = resolve
      })
    )
    const { rerender } = render(<RoomProgressPanel companyId={COMPANY_ID} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Teléfono de contacto' }), {
      target: { value: '+507 6000-1234' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar teléfono' }))
    expect(mockSavePhone).toHaveBeenCalledWith({ companyId: COMPANY_ID, phone: '+507 6000-1234' })
    expect(screen.getByRole('button', { name: 'Guardando…' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Teléfono de contacto' })).toBeDisabled()
    expect(screen.getByText('3 de 5 listos')).toBeVisible()
    await act(async () => {
      finishSave?.()
    })
    expect(screen.getByRole('status')).toHaveTextContent('Teléfono guardado')
    mockUseQuery.mockImplementation((reference: unknown) =>
      reference === 'companyChecklist.getCompanyChecklist'
        ? {
            ...checklistFiveOfSeven(),
            completedCount: 6,
            items: { ...checklistFiveOfSeven().items, phone: item(true) },
          }
        : deliverablesFiveOfSeven()
    )
    rerender(<RoomProgressPanel companyId={COMPANY_ID} />)
    expect(screen.getByText('4 de 5 listos')).toBeVisible()
    expect(
      within(screen.getByTestId('room-progress-missing')).queryByText(
        'Dejar un teléfono de contacto'
      )
    ).not.toBeInTheDocument()
  })

  it('cancels without saving and never writes a phone from the demo room', async () => {
    const { rerender } = render(<RoomProgressPanel companyId={COMPANY_ID} />)
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(mockSavePhone).not.toHaveBeenCalled()
    rerender(<RoomProgressPanel companyId={COMPANY_ID} isDemo />)
    expect(screen.getByRole('button', { name: 'Agregar' })).toBeDisabled()
  })

  it('links Entregado to the first rendition without a version (au-02)', () => {
    render(<RoomProgressPanel companyId={COMPANY_ID} />)

    expect(screen.getByRole('link', { name: 'Entregado' })).toHaveAttribute(
      'href',
      '/my-company/documents?source=document_model'
    )
  })

  it('pins the version on Entregado when the rendition carries one (au-02)', () => {
    const responses = new Map<unknown, unknown>([
      ['companyChecklist.getCompanyChecklist', checklistFiveOfSeven()],
      [
        'deliverables.listForCompany',
        [
          {
            ...deliverablesFiveOfSeven()[0],
            renditions: [
              {
                format: 'XLSX',
                documentId: 'document_model',
                versionId: 'version_model',
              },
            ],
          },
          deliverablesFiveOfSeven()[1],
        ],
      ],
    ])
    mockUseQuery.mockImplementation((reference: unknown) => responses.get(reference))
    render(<RoomProgressPanel companyId={COMPANY_ID} />)

    expect(screen.getByRole('link', { name: 'Entregado' })).toHaveAttribute(
      'href',
      '/my-company/documents?source=document_model:version_model'
    )
  })

  it('keeps Entregado as text when the delivered slot has no rendition (au-02)', () => {
    const responses = new Map<unknown, unknown>([
      ['companyChecklist.getCompanyChecklist', checklistFiveOfSeven()],
      [
        'deliverables.listForCompany',
        [{ ...deliverablesFiveOfSeven()[0], renditions: [] }, deliverablesFiveOfSeven()[1]],
      ],
    ])
    mockUseQuery.mockImplementation((reference: unknown) => responses.get(reference))
    render(<RoomProgressPanel companyId={COMPANY_ID} />)

    expect(screen.queryByRole('link', { name: 'Entregado' })).not.toBeInTheDocument()
    expect(
      within(screen.getByTestId('room-progress-stage-MODEL_V1')).getByText('Entregado')
    ).toBeVisible()
  })

  it('renders NEEDS_INPUT as Falta información linking to the support thread', () => {
    render(<RoomProgressPanel companyId={COMPANY_ID} />)

    const needsInput = screen.getByRole('link', { name: 'Falta información' })
    expect(needsInput).toBeVisible()
    expect(needsInput).toHaveAttribute('href', '/my-company/team')
    expect(needsInput.closest('[data-testid="room-progress-stage-TEASER"]')).not.toBeNull()
  })

  it('routes admin support actions to the selected company inbox', () => {
    const checklist = checklistFiveOfSeven()
    checklist.items.financialsDepth = item(false)
    checklist.items.kickoffCall = item(false)
    checklist.completedCount = 3
    mockUseQuery.mockImplementation((reference: unknown) =>
      reference === 'companyChecklist.getCompanyChecklist' ? checklist : deliverablesFiveOfSeven()
    )
    const href = '/es/admin/support?company=company_1'
    const documentsHref = '/admin/companies/company_1/documents#room-shell'
    render(
      <RoomProgressPanel
        companyId={COMPANY_ID}
        supportHref={href}
        documentsHref={documentsHref}
        phoneEditable={false}
      />
    )

    // El equipo no edita el teléfono (la mutation solo admite al dueño) y
    // «Subir» se queda en su propia sala administrativa.
    expect(screen.queryByRole('button', { name: 'Agregar' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Subir' })).toHaveAttribute('href', documentsHref)

    // Los dos ítems manuales («que el equipo confirme…», llamada de arranque)
    // ya no se le muestran al cliente: solo la línea de arranque y el estado
    // «Falta información» apuntan a soporte.
    expect(screen.queryByRole('link', { name: 'Ver soporte' })).not.toBeInTheDocument()
    expect(
      within(screen.getByTestId('room-progress-missing')).getAllByRole('listitem')
    ).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Escríbenos' })).toHaveAttribute('href', href)
    expect(screen.getByRole('link', { name: 'Falta información' })).toHaveAttribute('href', href)
  })

  // La nota del equipo viaja en la versión que el slot cita y se lee bajo la
  // etapa entregada; una etapa sin entrega no inventa nota.
  it('shows the team note under the delivered stage only', () => {
    render(<RoomProgressPanel companyId={COMPANY_ID} />)

    const note = screen.getByTestId('room-progress-note-MODEL_V1')
    expect(note).toHaveTextContent('Modelo v1 listo para revisión.')
    expect(note.closest('details')?.querySelector('summary')).toHaveTextContent(
      'Ver nota del equipo'
    )
    expect(note.closest('[data-testid="room-progress-stage-MODEL_V1"]')).not.toBeNull()
    expect(screen.queryByTestId('room-progress-note-MODEL_V2')).not.toBeInTheDocument()
    expect(screen.queryByTestId('room-progress-note-TEASER')).not.toBeInTheDocument()
  })

  // v1 y v2 comparten el slot MODEL, que solo cita la entrega vigente. Con v2
  // entregado, v1 enlazaba al archivo de v2 y mostraba su nota.
  it('leaves Modelo v1 without link or note once Modelo v2 is delivered', () => {
    const checklist = checklistFiveOfSeven()
    checklist.stages[1] = { key: 'MODEL_V2', status: 'DELIVERED', updatedAt: NOW }
    mockUseQuery.mockImplementation((reference: unknown) =>
      reference === 'companyChecklist.getCompanyChecklist' ? checklist : deliverablesFiveOfSeven()
    )
    render(<RoomProgressPanel companyId={COMPANY_ID} />)

    const v1 = screen.getByTestId('room-progress-stage-MODEL_V1')
    const v2 = screen.getByTestId('room-progress-stage-MODEL_V2')
    expect(within(v1).queryByRole('link')).not.toBeInTheDocument()
    expect(within(v1).getByText('Entregado')).toBeInTheDocument()
    expect(screen.queryByTestId('room-progress-note-MODEL_V1')).not.toBeInTheDocument()
    expect(within(v2).getByRole('link', { name: 'Entregado' })).toHaveAttribute(
      'href',
      expect.stringContaining('source=document_model')
    )
    expect(screen.getByTestId('room-progress-note-MODEL_V2')).toBeInTheDocument()
  })

  it('lists only stages with status and names the pending ones in order', () => {
    render(<RoomProgressPanel companyId={COMPANY_ID} />)

    const liveKeys = ['MODEL_V1', 'MODEL_V2', 'TEASER', 'CIM'] as const
    const pendingKeys = ['MGMT_PRESENTATION', 'DECKS', 'QA', 'IRL'] as const
    const rail = screen.getByTestId('room-progress-stages')
    expect(within(rail).getAllByRole('listitem')).toHaveLength(liveKeys.length)
    for (const [index, key] of liveKeys.entries()) {
      const stage = screen.getByTestId(`room-progress-stage-${key}`)
      expect(stage).toBeVisible()
      expect(within(stage).getByText(STAGE_LABELS[index])).toBeVisible()
    }
    for (const key of pendingKeys) {
      expect(screen.queryByTestId(`room-progress-stage-${key}`)).not.toBeInTheDocument()
    }
    expect(
      screen.getByText(
        'Después vienen Management presentation, Decks de deuda y equity, Preguntas y respuestas y Lista de pedidos (IRL).'
      )
    ).toBeVisible()
    expect(screen.getByTestId('room-progress-seal')).toHaveTextContent(/^Data Room activado\. /)
  })

  it('omits the upcoming line when every stage has been delivered', () => {
    mockUseQuery.mockImplementation((reference: unknown) =>
      reference === 'companyChecklist.getCompanyChecklist'
        ? {
            ...checklistFiveOfSeven(),
            stages: STAGE_KEYS.map((key) => ({
              key,
              status: 'DELIVERED',
              updatedAt: NOW,
            })),
          }
        : deliverablesFiveOfSeven()
    )
    render(<RoomProgressPanel companyId={COMPANY_ID} />)

    expect(
      within(screen.getByTestId('room-progress-stages')).getAllByRole('listitem')
    ).toHaveLength(STAGE_KEYS.length)
    for (const key of STAGE_KEYS) {
      expect(screen.getByTestId(`room-progress-stage-${key}`)).toBeVisible()
    }
    expect(screen.queryByText(/Después vienen/)).not.toBeInTheDocument()
  })

  it('skips the queries in the demo room and draws the panel at zero', () => {
    mockUseQuery.mockClear()

    render(<RoomProgressPanel companyId={COMPANY_ID} isDemo />)

    for (const call of mockUseQuery.mock.calls) expect(call[1]).toBe('skip')
    expect(screen.getByText('0 de 5 listos')).toBeVisible()
    expect(
      within(screen.getByTestId('room-progress-missing')).getAllByRole('listitem')
    ).toHaveLength(5)
    expect(screen.queryByTestId('room-progress-stages')).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'Después vienen Modelo v1, Modelo v2, Teaser, CIM, Management presentation, Decks de deuda y equity, Preguntas y respuestas y Lista de pedidos (IRL).'
      )
    ).toBeVisible()
    expect(screen.queryByTestId('room-progress-seal')).not.toBeInTheDocument()
  })

  it('renders no emoji and the component source has no literal hex', () => {
    const { container } = render(<RoomProgressPanel companyId={COMPANY_ID} />)
    expect(container.textContent ?? '').not.toMatch(EMOJI)

    const source = readFileSync(COMPONENT_SOURCE, 'utf8')
    expect(source).not.toMatch(HEX_COLOR)
    expect(source).not.toMatch(EMOJI)
  })
})
