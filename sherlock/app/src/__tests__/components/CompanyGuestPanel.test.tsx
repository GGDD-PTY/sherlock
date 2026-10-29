import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
const query = vi.fn()
const mutation = vi.fn()
vi.mock('convex/react', () => ({ useQuery: () => query(), useMutation: () => mutation }))
import { CompanyGuestPanel } from '@/components/vdr-guest/CompanyGuestPanel'
import { GuestCompanyNda } from '@/components/vdr-guest/GuestCompanyNda'
const roster = {
  ndaConfigured: true,
  capabilities: { canInvite: true },
  hasMore: false,
  invitations: [],
}
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
it('renders nothing and reports unavailable until an approved NDA exists', () => {
  query.mockReturnValue({ ...roster, ndaConfigured: false })
  const onAvailabilityChange = vi.fn()
  const { container } = render(
    <CompanyGuestPanel
      companyId={'company_1' as never}
      documents={[{ _id: 'doc_1' as never, name: 'Finanzas.pdf' }]}
      locale="es"
      onAvailabilityChange={onAvailabilityChange}
    />
  )
  expect(screen.queryByRole('button', { name: 'Enviar invitación' })).not.toBeInTheDocument()
  expect(screen.queryByText(/NDA aprobado/)).not.toBeInTheDocument()
  expect(container).toBeEmptyDOMElement()
  expect(onAvailabilityChange).toHaveBeenLastCalledWith(false)
})
it('sends the explicit document selection and clears the form only after success', async () => {
  query.mockReturnValue(roster)
  mutation.mockResolvedValue({ invitationId: 'invite_1' })
  const user = userEvent
  render(
    <CompanyGuestPanel
      companyId={'company_1' as never}
      documents={[
        { _id: 'doc_1' as never, name: 'Finanzas.pdf' },
        { _id: 'doc_2' as never, name: 'Plan.pdf' },
      ]}
      locale="es"
    />
  )
  await user.type(screen.getByLabelText('Email del invitado'), 'guest@example.com')
  await user.click(screen.getByLabelText('Finanzas.pdf'))
  await user.click(screen.getByRole('button', { name: 'Enviar invitación' }))
  expect(mutation).toHaveBeenCalledWith({
    companyId: 'company_1',
    documentIds: ['doc_1'],
    email: 'guest@example.com',
    expiresInDays: 7,
    locale: 'es',
  })
  expect(await screen.findByText('Invitación enviada.')).toBeInTheDocument()
})
it('keeps invitation disabled when the access duration is outside one to thirty days', async () => {
  query.mockReturnValue(roster)
  const user = userEvent
  render(
    <CompanyGuestPanel
      companyId={'company_1' as never}
      documents={[{ _id: 'doc_1' as never, name: 'Finanzas.pdf' }]}
      locale="es"
    />
  )
  await user.type(screen.getByLabelText('Email del invitado'), 'guest@example.com')
  await user.click(screen.getByLabelText('Finanzas.pdf'))
  const days = screen.getByLabelText('Días de acceso')
  await user.clear(days)
  expect(screen.getByRole('button', { name: 'Enviar invitación' })).toBeDisabled()
  await user.type(days, '31')
  expect(screen.getByRole('button', { name: 'Enviar invitación' })).toBeDisabled()
})
function approvedNdaResponse() {
  return new Response(
    JSON.stringify({
      nda: {
        title: 'Test NDA',
        content: 'TEST ONLY <script>text</script>',
        contentHash: 'a'.repeat(64),
        version: '1',
        locale: 'es',
      },
    })
  )
}

it('focuses the NDA region when the approved text loads', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(approvedNdaResponse()))
  render(<GuestCompanyNda onAccepted={() => {}} />)
  const region = await screen.findByText('TEST ONLY <script>text</script>')
  expect(region).toHaveAttribute('role', 'region')
  expect(region).toHaveAttribute('tabindex', '0')
  await waitFor(() => expect(region).toHaveFocus())
})

it('does not steal focus when the guest already left the loading state', async () => {
  let resolveFetch: (value: Response) => void = () => {}
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
    )
  )
  render(
    <>
      <button type="button">Cerrar sesión segura</button>
      <GuestCompanyNda onAccepted={() => {}} />
    </>
  )
  expect(await screen.findByRole('status')).toHaveTextContent('Cargando NDA aprobado…')
  const logout = screen.getByRole('button', { name: 'Cerrar sesión segura' })
  logout.focus()
  expect(logout).toHaveFocus()
  resolveFetch(approvedNdaResponse())
  const region = await screen.findByText('TEST ONLY <script>text</script>')
  expect(region).toHaveAttribute('role', 'region')
  expect(logout).toHaveFocus()
})

it('shows the approved NDA as text and requires a deliberate signed acceptance', async () => {
  const contentHash = 'a'.repeat(64)
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          nda: {
            title: 'Test NDA',
            content: 'TEST ONLY <script>text</script>',
            contentHash,
            version: '1',
            locale: 'es',
          },
        })
      )
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true })))
  vi.stubGlobal('fetch', fetchMock)
  const accepted = vi.fn()
  const user = userEvent
  render(<GuestCompanyNda onAccepted={accepted} />)
  expect(await screen.findByText('TEST ONLY <script>text</script>')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Aceptar NDA y abrir el Data Room' })).toBeDisabled()
  await user.type(screen.getByLabelText('Nombre completo del firmante'), 'Test Guest')
  await user.click(screen.getByLabelText('He leído y acepto este NDA.'))
  await user.click(screen.getByRole('button', { name: 'Aceptar NDA y abrir el Data Room' }))
  expect(fetchMock.mock.calls[1][1].body).toBe(
    JSON.stringify({ contentHash, signatoryName: 'Test Guest' })
  )
  expect(accepted).toHaveBeenCalledOnce()
})

it('explains sharing approval instead of showing an empty invite form', () => {
  query.mockReturnValue(roster)
  render(<CompanyGuestPanel companyId={'company_1' as never} documents={[]} locale="es" />)
  expect(screen.queryByLabelText('Email del invitado')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Enviar invitación' })).not.toBeInTheDocument()
  expect(
    screen.getByText(/Editar documento.*Nivel de acceso.*NDA de invitado\/contraparte/)
  ).toBeInTheDocument()
})

it.each([
  { count: 1, label: 'Email pendiente · 1 documento' },
  { count: 3, label: 'Email pendiente · 3 documentos' },
])('renders the roster document count as $label', ({ count, label }) => {
  query.mockReturnValue({
    ...roster,
    invitations: [
      {
        invitationId: 'invite_1',
        maskedEmail: 'g***@example.com',
        status: 'PENDING',
        expiresAt: Date.now() + 86_400_000,
        documentCount: count,
      },
    ],
  })
  render(
    <CompanyGuestPanel
      companyId={'company_1' as never}
      documents={[{ _id: 'doc_1' as never, name: 'Finanzas.pdf' }]}
      locale="es"
    />
  )
  expect(screen.getByText(label)).toBeInTheDocument()
})
