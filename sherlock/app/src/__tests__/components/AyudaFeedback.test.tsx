import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AyudaFeedback, type AyudaFeedbackLabels } from '@/components/ayuda/AyudaFeedback'
import { REQUEST_BODY_MAX_LENGTH } from '../../../convex/_roadmap/model'
import { SUPPORT_MESSAGE_MAX_LENGTH } from '../../../convex/_support/model'

const WORKSPACE = 'companies:getMyVdrWorkspace'

const mockUseQuery = vi.fn()
const mockSendCompanyMessage = vi.fn()
const mockSubmitFeatureRequest = vi.fn()
const mockHasRole = vi.fn()
const mockSession = { isLoading: false, isSignedIn: false }

vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (reference: string) =>
    reference === 'support:sendCompanyMessage' ? mockSendCompanyMessage : mockSubmitFeatureRequest,
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: { getMyVdrWorkspace: 'companies:getMyVdrWorkspace' },
    support: { sendCompanyMessage: 'support:sendCompanyMessage' },
    roadmap: { submitFeatureRequest: 'roadmap:submitFeatureRequest' },
  },
}))

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    hasRole: mockHasRole,
    isLoading: mockSession.isLoading,
    isSignedIn: mockSession.isSignedIn,
  }),
}))

const labels: AyudaFeedbackLabels = {
  heading: 'Write to the team',
  label: 'Your message to the team',
  placeholder: 'What do you need?',
  submit: 'Send',
  sending: 'Sending…',
  resolving: 'Loading your session…',
  sentCompany: 'Sent to your room thread.',
  sentAnonymous: 'Received on the board queue.',
  duplicate: 'We already have this request.',
  error: 'It could not be sent.',
  rateLimited: 'Too many messages today.',
  emailFallback: 'or email us',
  emailSubject: 'Message for the Sherlock team',
}

function asCompanyWithRoom() {
  mockSession.isLoading = false
  mockSession.isSignedIn = true
  mockHasRole.mockImplementation((role: string) => role === 'COMPANY')
  mockUseQuery.mockImplementation((reference: string, args: unknown) =>
    reference === WORKSPACE && args !== 'skip' ? { company: { _id: 'company-1' } } : undefined
  )
}

function asAnonymous() {
  mockSession.isLoading = false
  mockSession.isSignedIn = false
  mockHasRole.mockReturnValue(false)
  mockUseQuery.mockReturnValue(undefined)
}

function renderFeedback() {
  return render(<AyudaFeedback labels={labels} />)
}

beforeEach(() => {
  mockUseQuery.mockReset()
  mockSendCompanyMessage.mockReset().mockResolvedValue({ sequence: 1 })
  mockSubmitFeatureRequest.mockReset().mockResolvedValue({ stored: true, duplicate: false })
  mockHasRole.mockReset()
  asAnonymous()
})

describe('AyudaFeedback', () => {
  // El bug del 2026-08-27: la pantalla de soporte tenía DOS cajas de texto y
  // ninguna decía a quién llegaba. El hub tiene exactamente una.
  it('ships exactly one text box and one submit control', () => {
    renderFeedback()

    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('textbox')).toHaveAccessibleName(labels.label)
  })

  // El textarea admitía 2 000 caracteres y el servidor guardaba 500 en silencio
  // reportando éxito: el cliente veía "enviado" y el equipo leía media petición.
  // Los dos destinos ya no comparten límite (soporte subió a 10 000 en 8dcb1132c):
  // el textarea se queda con el menor de los dos.
  it('never lets the visitor type more than either destination stores', () => {
    renderFeedback()

    expect(screen.getByRole('textbox')).toHaveAttribute(
      'maxlength',
      String(Math.min(REQUEST_BODY_MAX_LENGTH, SUPPORT_MESSAGE_MAX_LENGTH))
    )
  })

  it('sends a signed-in company message to its own room thread', async () => {
    asCompanyWithRoom()
    renderFeedback()

    await userEvent.type(screen.getByRole('textbox'), 'Falta el modelo v2')
    await userEvent.click(screen.getByRole('button', { name: labels.submit }))

    await waitFor(() => expect(mockSendCompanyMessage).toHaveBeenCalledTimes(1))
    expect(mockSendCompanyMessage.mock.calls[0][0]).toEqual({
      companyId: 'company-1',
      body: 'Falta el modelo v2',
    })
    expect(mockSubmitFeatureRequest).not.toHaveBeenCalled()
    expect(await screen.findByText(labels.sentCompany)).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('sends an anonymous message to the public request queue', async () => {
    renderFeedback()

    await userEvent.type(screen.getByRole('textbox'), 'Quiero exportar la sala')
    await userEvent.click(screen.getByRole('button', { name: labels.submit }))

    await waitFor(() => expect(mockSubmitFeatureRequest).toHaveBeenCalledTimes(1))
    const [payload] = mockSubmitFeatureRequest.mock.calls[0]
    expect(payload.body).toBe('Quiero exportar la sala')
    expect(payload.locale).toBe('es')
    expect(payload.deviceToken).toMatch(/^[A-Za-z0-9-]{16,64}$/)
    expect(mockSendCompanyMessage).not.toHaveBeenCalled()
    expect(await screen.findByText(labels.sentAnonymous)).toBeInTheDocument()
  })

  // Antes, un COMPANY que enviaba antes de que resolviera su sala caía en la
  // cola pública y la UI le decía que había llegado al equipo: su mensaje
  // privado terminaba en un tablero que cualquiera lee. Solo un anónimo
  // confirmado va a esa cola; mientras haya sesión sin resolver, se espera.
  it('holds the message while the room has not resolved instead of leaking it', async () => {
    mockSession.isSignedIn = true
    mockHasRole.mockImplementation((role: string) => role === 'COMPANY')
    mockUseQuery.mockReturnValue(undefined)
    renderFeedback()

    await userEvent.type(screen.getByRole('textbox'), 'Hola equipo')
    const submit = screen.getByRole('button', { name: labels.resolving })
    expect(submit).toBeDisabled()

    await userEvent.click(submit)

    expect(mockSubmitFeatureRequest).not.toHaveBeenCalled()
    expect(mockSendCompanyMessage).not.toHaveBeenCalled()
  })

  it('holds the message while the session itself has not resolved', async () => {
    mockSession.isLoading = true
    mockHasRole.mockReturnValue(false)
    mockUseQuery.mockReturnValue(undefined)
    renderFeedback()

    await userEvent.type(screen.getByRole('textbox'), 'Hola equipo')
    expect(screen.getByRole('button', { name: labels.resolving })).toBeDisabled()

    expect(mockSubmitFeatureRequest).not.toHaveBeenCalled()
  })

  // Una sala resuelta en null (un COMPANY sin sala todavía) sí tiene veredicto:
  // no hay hilo privado que perder y la cola pública es el destino correcto.
  it('sends to the public queue once the room resolves to no room at all', async () => {
    mockSession.isSignedIn = true
    mockHasRole.mockImplementation((role: string) => role === 'COMPANY')
    mockUseQuery.mockReturnValue(null)
    renderFeedback()

    await userEvent.type(screen.getByRole('textbox'), 'Hola equipo')
    await userEvent.click(screen.getByRole('button', { name: labels.submit }))

    await waitFor(() => expect(mockSubmitFeatureRequest).toHaveBeenCalledTimes(1))
  })

  it('keeps the draft when the identical request is already on the list', async () => {
    mockSubmitFeatureRequest.mockResolvedValue({ stored: false, duplicate: true })
    renderFeedback()

    await userEvent.type(screen.getByRole('textbox'), 'Votacion en vivo')
    await userEvent.click(screen.getByRole('button', { name: labels.submit }))

    expect(await screen.findByText(labels.duplicate)).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('Votacion en vivo')
  })

  it('reports a rejected submission without losing the draft', async () => {
    mockSubmitFeatureRequest.mockRejectedValue(new Error('offline'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderFeedback()

    await userEvent.type(screen.getByRole('textbox'), 'Exportar la sala completa')
    await userEvent.click(screen.getByRole('button', { name: labels.submit }))

    expect(await screen.findByText(labels.error)).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('Exportar la sala completa')
  })

  it('never submits an empty message', async () => {
    renderFeedback()

    await userEvent.click(screen.getByRole('button', { name: labels.submit }))

    expect(mockSubmitFeatureRequest).not.toHaveBeenCalled()
    expect(mockSendCompanyMessage).not.toHaveBeenCalled()
  })
})
