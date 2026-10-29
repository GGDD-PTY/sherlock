import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseQuery = vi.hoisted(() => vi.fn())
const mockUsePaginatedQuery = vi.hoisted(() => vi.fn())
const mockUseMutation = vi.hoisted(() => vi.fn())
const mockReadMessages = vi.hoisted(() => vi.fn())
const mockSendMessage = vi.hoisted(() => vi.fn())
const mockMarkRead = vi.hoisted(() => vi.fn())

vi.mock('convex/react', () => ({
  useQuery: mockUseQuery,
  usePaginatedQuery: mockUsePaginatedQuery,
  useMutation: mockUseMutation,
}))

vi.mock('convex/server', () => ({
  makeFunctionReference: (name: string) => name,
}))

describe('AdminSupportInbox audited message reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseQuery.mockReturnValue({
      threadId: 'thread_one',
      roomLabel: 'Compañía Uno',
      scopeKind: 'COMPANY',
      companyId: 'company_one',
      intakeSessionId: null,
      canSend: true,
      unreadCount: 0,
      lastSequence: 2,
    })
    mockUsePaginatedQuery.mockReturnValue({
      results: [
        {
          threadId: 'thread_one',
          roomLabel: 'Compañía Uno',
          scopeKind: 'COMPANY',
          companyId: 'company_one',
          intakeSessionId: null,
          unreadCount: 0,
          lastMessageAt: 1_700_000_000_002,
          messageId: 'message_two',
          sequence: 2,
          authorKind: 'ADMIN',
          body: 'Mensaje reciente',
          createdAt: 1_700_000_000_002,
        },
      ],
      status: 'Exhausted',
      loadMore: vi.fn(),
    })
    mockReadMessages.mockResolvedValue({
      page: [
        {
          messageId: 'message_two',
          sequence: 2,
          authorKind: 'ADMIN',
          body: 'Mensaje reciente',
          createdAt: 1_700_000_000_002,
        },
        {
          messageId: 'message_one',
          sequence: 1,
          authorKind: 'COMPANY',
          body: 'Mensaje inicial',
          createdAt: 1_700_000_000_001,
        },
      ],
      isDone: false,
      continueCursor: 'next-cursor',
    })
    mockSendMessage.mockResolvedValue({ sequence: 3 })
    mockMarkRead.mockResolvedValue({ marked: true })
    mockUseMutation.mockImplementation((reference: string) => {
      if (reference === 'support:listAdminMessages') return mockReadMessages
      if (reference === 'support:sendAdminMessage') return mockSendMessage
      if (reference === 'support:markAdminThreadRead') return mockMarkRead
      return vi.fn()
    })
  })

  it('loads the initial and next message pages through the audited mutation, not a body-returning query', async () => {
    const { AdminSupportInbox } = await import('@/components/admin/AdminSupportInbox')
    render(<AdminSupportInbox selectedThreadId="thread_one" />)

    await waitFor(() => {
      expect(mockReadMessages).toHaveBeenCalledWith({
        threadId: 'thread_one',
        paginationOpts: { cursor: null, numItems: 30 },
      })
    })
    expect(
      mockUsePaginatedQuery.mock.calls.every(([, , options]) => options?.initialNumItems === 20)
    ).toBe(true)
    expect(screen.getByText('Mensaje inicial')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cargar mensajes anteriores' }))

    await waitFor(() => {
      expect(mockReadMessages).toHaveBeenCalledWith({
        threadId: 'thread_one',
        paginationOpts: { cursor: 'next-cursor', numItems: 30 },
      })
    })
  })

  it('keeps the existing unread marker mutation on the exact selected thread', async () => {
    mockUseQuery.mockReturnValue({
      threadId: 'thread_one',
      roomLabel: 'Compañía Uno',
      scopeKind: 'COMPANY',
      companyId: 'company_one',
      intakeSessionId: null,
      canSend: true,
      unreadCount: 2,
      lastSequence: 2,
    })

    const { AdminSupportInbox } = await import('@/components/admin/AdminSupportInbox')
    render(<AdminSupportInbox selectedThreadId="thread_one" />)

    await waitFor(() => {
      expect(mockMarkRead).toHaveBeenCalledWith({
        threadId: 'thread_one',
        throughSequence: 2,
      })
    })
  })

  it('reloads once when the selected thread sequence advances, without reacting to mark-read updates', async () => {
    let summary = {
      threadId: 'thread_one',
      roomLabel: 'Compañía Uno',
      scopeKind: 'COMPANY' as const,
      companyId: 'company_one',
      intakeSessionId: null,
      canSend: true,
      unreadCount: 0,
      lastSequence: 2,
    }
    mockUseQuery.mockImplementation(() => summary)
    mockReadMessages
      .mockResolvedValueOnce({
        page: [
          {
            messageId: 'message_two',
            sequence: 2,
            authorKind: 'ADMIN',
            body: 'Mensaje anterior',
            createdAt: 1_700_000_000_002,
          },
        ],
        isDone: true,
        continueCursor: '1',
      })
      .mockResolvedValueOnce({
        page: [
          {
            messageId: 'message_three',
            sequence: 3,
            authorKind: 'COMPANY',
            body: 'Nuevo mensaje del cliente',
            createdAt: 1_700_000_000_003,
          },
        ],
        isDone: true,
        continueCursor: '2',
      })

    const { AdminSupportInbox } = await import('@/components/admin/AdminSupportInbox')
    const view = render(<AdminSupportInbox selectedThreadId="thread_one" />)
    await screen.findByText('Mensaje anterior')
    expect(mockReadMessages).toHaveBeenCalledTimes(1)

    summary = { ...summary, unreadCount: 1, lastSequence: 3 }
    view.rerender(<AdminSupportInbox selectedThreadId="thread_one" />)

    await waitFor(() => {
      expect(mockReadMessages).toHaveBeenCalledTimes(2)
      expect(mockReadMessages).toHaveBeenLastCalledWith({
        threadId: 'thread_one',
        paginationOpts: { cursor: null, numItems: 30 },
      })
    })
    expect(await screen.findByText('Nuevo mensaje del cliente')).toBeVisible()

    summary = { ...summary, unreadCount: 0 }
    view.rerender(<AdminSupportInbox selectedThreadId="thread_one" />)
    await waitFor(() => {
      expect(mockMarkRead).toHaveBeenCalledWith({
        threadId: 'thread_one',
        throughSequence: 3,
      })
    })
    expect(mockReadMessages).toHaveBeenCalledTimes(2)
  })

  it('reloads the audited message page after sending so the reply becomes visible', async () => {
    mockReadMessages
      .mockResolvedValueOnce({
        page: [
          {
            messageId: 'message_one',
            sequence: 1,
            authorKind: 'COMPANY',
            body: 'Mensaje inicial',
            createdAt: 1_700_000_000_001,
          },
        ],
        isDone: true,
        continueCursor: '1',
      })
      .mockResolvedValueOnce({
        page: [
          {
            messageId: 'message_three',
            sequence: 3,
            authorKind: 'ADMIN',
            body: 'Respuesta visible',
            createdAt: 1_700_000_000_003,
          },
          {
            messageId: 'message_one',
            sequence: 1,
            authorKind: 'COMPANY',
            body: 'Mensaje inicial',
            createdAt: 1_700_000_000_001,
          },
        ],
        isDone: true,
        continueCursor: '2',
      })

    const { AdminSupportInbox } = await import('@/components/admin/AdminSupportInbox')
    render(<AdminSupportInbox selectedThreadId="thread_one" />)
    await screen.findByText('Mensaje inicial')

    fireEvent.change(screen.getByLabelText('Respuesta del equipo'), {
      target: { value: 'Respuesta visible' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar respuesta' }))

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith({
        threadId: 'thread_one',
        body: 'Respuesta visible',
      })
      expect(mockReadMessages).toHaveBeenCalledTimes(2)
    })
    expect(await screen.findByText('Respuesta visible')).toBeVisible()
  })

  it('keeps loaded messages visible when a load-more request fails', async () => {
    mockReadMessages
      .mockResolvedValueOnce({
        page: [
          {
            messageId: 'message_one',
            sequence: 1,
            authorKind: 'COMPANY',
            body: 'Mensaje conservado',
            createdAt: 1_700_000_000_001,
          },
        ],
        isDone: false,
        continueCursor: 'next-cursor',
      })
      .mockRejectedValueOnce(new Error('PAGE_UNAVAILABLE'))

    const { AdminSupportInbox } = await import('@/components/admin/AdminSupportInbox')
    render(<AdminSupportInbox selectedThreadId="thread_one" />)
    await screen.findByText('Mensaje conservado')

    fireEvent.click(screen.getByRole('button', { name: 'Cargar mensajes anteriores' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No pudimos enviar la respuesta. Intenta nuevamente.'
    )
    expect(screen.getByText('Mensaje conservado')).toBeVisible()
  })
})
