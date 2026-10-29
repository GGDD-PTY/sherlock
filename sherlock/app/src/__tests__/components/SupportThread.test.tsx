import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Id } from '@/../convex/_generated/dataModel'

const mockUseQuery = vi.fn()
const mockUsePaginatedQuery = vi.fn()
const mockUseMutation = vi.fn()
const mockUseLocale = vi.fn(() => 'es')
const mockSend = vi.fn()
const mockMarkRead = vi.fn()
const mockReadAdminMessages = vi.fn()
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
    usePaginatedQuery: (...args: unknown[]) => {
      const isMounted = useRef(false)
      if (!isMounted.current) {
        isMounted.current = true
        queryMounts.current += 1
      }
      return mockUsePaginatedQuery(...args)
    },
    useMutation: (...args: unknown[]) => mockUseMutation(...args),
  }
})

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

import { AdminIntakeQueue } from '@/components/admin/AdminIntakeQueue'
import { AdminSupportInbox } from '@/components/admin/AdminSupportInbox'
import { SupportThread } from '@/components/company/SupportThread'

const COMPANY_ID = 'company_one' as Id<'companies'>

const CLIENT_MESSAGES = [
  {
    messageId: 'message_1',
    sequence: 1,
    authorKind: 'ADMIN',
    body: '<img src=x onerror=alert(1)>',
    createdAt: 1_900_000_000_000,
  },
]

function paginated(messages = CLIENT_MESSAGES) {
  return {
    results: messages,
    status: 'Exhausted',
    loadMore: vi.fn(),
  }
}

function auditedPage(messages = CLIENT_MESSAGES) {
  return {
    page: messages,
    isDone: true,
    continueCursor: String(messages.length),
  }
}

describe('SupportThread', () => {
  beforeEach(() => {
    mockUseQuery.mockReset().mockReturnValue({
      threadId: 'thread_1',
      canSend: true,
      unreadCount: 0,
      lastSequence: 1,
    })
    mockUsePaginatedQuery.mockReset().mockReturnValue(paginated())
    mockUseMutation
      .mockReset()
      .mockImplementation(() =>
        mockUseMutation.mock.calls.length % 2 === 1 ? mockSend : mockMarkRead
      )
    mockSend.mockReset().mockResolvedValue({ sequence: 2 })
    mockMarkRead.mockReset().mockResolvedValue({ marked: true })
    mockUseLocale.mockReset().mockReturnValue('es')
    queryMounts.current = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers retry when the live summary hangs even if messages have loaded', async () => {
    vi.useFakeTimers()
    mockUseQuery.mockReturnValue(undefined)
    mockUsePaginatedQuery.mockReturnValue(paginated())

    render(<SupportThread companyId={COMPANY_ID} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })

    expect(screen.getByTestId('support-thread-load-failure')).toHaveTextContent(
      'No pudimos cargar esta sección.'
    )
  })

  it('offers retry when the first page of messages does not resolve in 12 seconds', async () => {
    vi.useFakeTimers()
    mockUsePaginatedQuery.mockReturnValue({
      results: [],
      status: 'LoadingFirstPage',
      loadMore: vi.fn(),
    })

    render(<SupportThread companyId={COMPANY_ID} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000)
    })

    expect(screen.getByTestId('support-thread-load-failure')).toHaveTextContent(
      'No pudimos cargar esta sección.'
    )
    const mountsBeforeRetry = queryMounts.current
    fireEvent.click(screen.getByRole('button', { name: 'Intentar de nuevo' }))
    expect(queryMounts.current).toBeGreaterThan(mountsBeforeRetry)
    expect(screen.getByText('Cargando la conversación…')).toBeVisible()
  })

  it('renders markup payloads as inert text', () => {
    const { container } = render(<SupportThread companyId={COMPANY_ID} />)

    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeVisible()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
  })

  it('fecha cada mensaje con el formateador compartido, no con el default de es-PA', () => {
    render(<SupportThread companyId={COMPANY_ID} />)

    // `toLocaleString('es-PA')` imprimía «03/17/2030, 12:46 p. m.»: una fecha
    // que se lee como estadounidense. El helper compartido fija día, mes corto,
    // reloj de 24 h y hora de Panamá, igual que la tabla de actividad del Data
    // Room.
    expect(screen.getByText('17 mar 2030, 12:46:40')).toBeVisible()
    expect(screen.queryByText(/03\/17\/2030/)).toBeNull()
  })

  it('dice bajo el campo qué pasa al enviar', () => {
    render(<SupportThread companyId={COMPANY_ID} />)

    expect(
      screen.getByText('Tu mensaje llega al equipo de Sherlock y te respondemos aquí mismo.')
    ).toBeVisible()
  })

  it('sends bounded text through the company mutation', async () => {
    render(<SupportThread companyId={COMPANY_ID} />)

    fireEvent.change(screen.getByLabelText('Mensaje para el equipo'), {
      target: { value: 'Necesito ayuda con la lista.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))

    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith({
        companyId: COMPANY_ID,
        body: 'Necesito ayuda con la lista.',
      })
    })
  })

  it('keeps demo messages local and labels the fixture boundary', () => {
    render(<SupportThread companyId={COMPANY_ID} isDemo />)

    expect(
      screen.getByText('Demostración local: los mensajes de esta vista no se envían ni se guardan.')
    ).toBeVisible()
    fireEvent.change(screen.getByLabelText('Mensaje para el equipo'), {
      target: { value: 'Mensaje local de prueba' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))

    expect(screen.getByText('Mensaje local de prueba')).toBeVisible()
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockUseQuery).toHaveBeenCalledWith(expect.anything(), 'skip')
  })

  it('shows the central read-only decision and removes the send control', () => {
    mockUseQuery.mockReturnValue({
      threadId: 'thread_1',
      canSend: false,
      unreadCount: 0,
      lastSequence: 1,
    })

    render(<SupportThread companyId={COMPANY_ID} />)

    expect(
      screen.getByText('Puedes leer esta conversación, pero no enviar mensajes.')
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Enviar' })).not.toBeInTheDocument()
  })
})

describe('AdminSupportInbox', () => {
  beforeEach(() => {
    mockUseLocale.mockReset().mockReturnValue('es')
    mockUseMutation.mockReset().mockImplementation(() => {
      const position = (mockUseMutation.mock.calls.length - 1) % 3
      return position === 0 ? mockReadAdminMessages : position === 1 ? mockSend : mockMarkRead
    })
    mockReadAdminMessages.mockReset().mockResolvedValue(
      auditedPage([
        {
          messageId: 'message_2',
          sequence: 2,
          authorKind: 'COMPANY',
          body: '<script>alert("no")</script>',
          createdAt: 1_900_000_000_000,
        },
      ])
    )
    mockSend.mockReset().mockResolvedValue({ sequence: 3 })
    mockMarkRead.mockReset().mockResolvedValue({ marked: true })
    mockUseQuery.mockReset().mockReturnValue({
      threadId: 'thread_1',
      roomLabel: 'Compañía Uno',
      scopeKind: 'COMPANY',
      companyId: COMPANY_ID,
      intakeSessionId: null,
      canSend: true,
      unreadCount: 1,
      lastSequence: 2,
    })
    mockUsePaginatedQuery.mockReset()
    mockUsePaginatedQuery.mockReturnValue({
      results: [
        {
          threadId: 'thread_1',
          roomLabel: 'Compañía Uno',
          scopeKind: 'COMPANY',
          companyId: COMPANY_ID,
          intakeSessionId: null,
          unreadCount: 1,
          lastMessageAt: 1_900_000_000_000,
        },
      ],
      status: 'Exhausted',
      loadMore: vi.fn(),
    })
  })

  it('shows the selected room without interpreting client markup', async () => {
    const { container } = render(<AdminSupportInbox selectedThreadId="thread_1" />)

    const conversation = screen.getByTestId('admin-support-conversation')
    expect(await within(conversation).findByText('<script>alert("no")</script>')).toBeVisible()
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByRole('link', { name: /Compañía Uno/ })).toHaveAttribute(
      'href',
      '/admin/support?thread=thread_1'
    )
  })

  it('selects an intake room from the URL and keeps the reply scoped to that session', async () => {
    mockUseQuery.mockReturnValue({
      threadId: 'thread_intake',
      roomLabel: null,
      scopeKind: 'INTAKE',
      companyId: null,
      intakeSessionId: 'intake_session_one',
      canSend: true,
      unreadCount: 0,
      lastSequence: 1,
    })
    mockReadAdminMessages.mockResolvedValue(auditedPage())
    mockUsePaginatedQuery.mockReset()
    mockUsePaginatedQuery.mockReturnValue({
      results: [
        {
          threadId: 'thread_intake',
          roomLabel: null,
          scopeKind: 'INTAKE',
          companyId: null,
          intakeSessionId: 'intake_session_one',
          unreadCount: 0,
          lastMessageAt: 1_900_000_000_000,
        },
      ],
      status: 'Exhausted',
      loadMore: vi.fn(),
    })

    render(<AdminSupportInbox selectedIntakeId="intake_session_one" />)

    fireEvent.change(screen.getByLabelText('Respuesta del equipo'), {
      target: { value: 'Te respondemos desde esta sala.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar respuesta' }))

    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith({
        intakeSessionId: 'intake_session_one',
        body: 'Te respondemos desde esta sala.',
      })
    })
  })
})

describe('AdminIntakeQueue', () => {
  beforeEach(() => {
    mockUseLocale.mockReset().mockReturnValue('es')
    mockUseQuery.mockReset().mockReturnValue({
      items: [
        {
          scopeKey: 'company:company_one',
          scopeKind: 'COMPANY',
          roomLabel: 'Compañía Uno',
          companyId: COMPANY_ID,
          intakeSessionId: null,
          supportThreadId: 'thread_1',
          actionAt: 1_900_000_000_000,
          readiness: { available: true, missingCount: 5, completedCount: 2, totalCount: 7 },
          missingEvidence: { available: true, count: 1 },
          unreadSupport: { available: true, count: 1 },
          assessmentReview: { available: false, count: 0 },
          draftReview: { available: true, count: 1, deliverableId: 'deliverable_1' },
        },
      ],
      truncated: false,
      temporaryIntakeSupportAvailable: false,
    })
  })

  it('links each real signal to the scoped support thread or company room', () => {
    render(<AdminIntakeQueue />)

    const item = screen.getByTestId('admin-intake-queue-item')
    expect(
      within(item).getByText('Revisión del equipo: 2 de 7 listos · 5 pendientes')
    ).toBeVisible()
    expect(within(item).getByText('1 entregable necesita información')).toBeVisible()
    expect(within(item).queryByText(/70%/)).not.toBeInTheDocument()
    expect(within(item).getByText('1 mensaje sin leer')).toBeVisible()
    expect(within(item).getByText('1 borrador por revisar')).toBeVisible()
    expect(within(item).getByRole('link', { name: 'Abrir soporte' })).toHaveAttribute(
      'href',
      '/admin/support?thread=thread_1'
    )
    expect(within(item).getByRole('link', { name: 'Abrir Data Room' })).toHaveAttribute(
      'href',
      '/admin/companies/company_one/documents?deliverable=deliverable_1#deliverables-heading'
    )
  })

  it.each([
    [0, 'Revisión del equipo: 7 de 7 listos · 0 pendientes'],
    [1, 'Revisión del equipo: 6 de 7 listos · 1 pendiente'],
    [5, 'Revisión del equipo: 2 de 7 listos · 5 pendientes'],
  ])('renders the pending checklist count grammatically for %s', (missingCount, label) => {
    const queue = mockUseQuery.getMockImplementation()!()
    queue.items[0].readiness = {
      available: true,
      completedCount: 7 - missingCount,
      totalCount: 7,
      missingCount,
    }
    render(<AdminIntakeQueue />)

    expect(screen.getByText(label)).toBeVisible()
  })

  it('does not turn queue rows into interactive document content', () => {
    render(<AdminIntakeQueue />)
    fireEvent.click(screen.getByText('Compañía Uno'))

    expect(screen.queryByText(/\.pdf$/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /descargar/i })).not.toBeInTheDocument()
  })

  it('labels temporary assessment signals as a review action', () => {
    mockUseQuery.mockReturnValue({
      items: [
        {
          scopeKey: 'intake:intake_session_1',
          scopeKind: 'INTAKE',
          roomLabel: null,
          companyId: null,
          intakeSessionId: 'intake_session_1',
          supportThreadId: 'thread_intake',
          actionAt: 1_900_000_000_000,
          readiness: { available: false, missingCount: 0, completedCount: 0, totalCount: 0 },
          missingEvidence: { available: false, count: 0 },
          unreadSupport: { available: false, count: 0 },
          assessmentReview: { available: true, count: 1, assessmentId: 'assessment_1' },
          draftReview: { available: false, count: 0, deliverableId: null },
        },
      ],
      truncated: false,
      temporaryIntakeSupportAvailable: false,
    })

    render(<AdminIntakeQueue />)

    expect(screen.getByRole('link', { name: 'Revisar evaluación' })).toHaveAttribute(
      'href',
      '/admin/support?intake=intake_session_1#admin-intake-assessment'
    )
    expect(screen.getByRole('link', { name: 'Abrir soporte' })).toHaveAttribute(
      'href',
      '/admin/support?thread=thread_intake'
    )
  })
})
