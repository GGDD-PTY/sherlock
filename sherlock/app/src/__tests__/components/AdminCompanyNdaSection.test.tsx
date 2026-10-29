import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

const query = vi.fn()
const configure = vi.fn()
vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => query(...args),
  useMutation: () => configure,
}))

import { AdminCompanyNdaSection } from '@/components/admin/AdminCompanyNdaSection'
import { AdminVdrCapabilityProvider } from '@/components/company/vdr/AdminVdrCapabilityContext'

const CAPABILITY = 'cap_admin_nda_test'

function renderSection(ndaConfigured: boolean) {
  query.mockReturnValue({
    ndaConfigured,
    capabilities: { canInvite: true },
    hasMore: false,
    invitations: [],
  })
  return render(
    <AdminVdrCapabilityProvider companyId="company_1">
      <AdminCompanyNdaSection companyId={'company_1' as never} />
    </AdminVdrCapabilityProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('empieza vacío y pide pegar el NDA aprobado cuando no hay uno activo', () => {
  renderSection(false)

  expect(query).toHaveBeenCalledWith(expect.anything(), {
    companyId: 'company_1',
    locale: 'es',
  })
  expect(screen.getByRole('heading', { name: 'NDA de invitados' })).toBeInTheDocument()
  expect(screen.getByText(/No hay un NDA activo en español/)).toBeInTheDocument()
  const field = screen.getByLabelText('Texto del NDA')
  expect(field).toHaveValue('')
  expect(field).toHaveAttribute('placeholder', 'Pega el NDA que el equipo aprobó.')
  expect(screen.getByLabelText('Título')).toHaveValue('')
  expect(screen.getByLabelText('Versión')).toHaveValue('')
  expect(screen.getByRole('button', { name: 'Confirmar NDA' })).toBeDisabled()
})

it('avisa que ya hay un NDA activo en español y el campo sigue vacío', () => {
  renderSection(true)

  expect(screen.getByText(/Hay un NDA activo en español/)).toBeInTheDocument()
  expect(screen.getByLabelText('Texto del NDA')).toHaveValue('')
  expect(screen.getByLabelText('Texto del NDA')).toHaveAttribute(
    'placeholder',
    'Pega el NDA que el equipo aprobó.'
  )
})

it('confirma el texto pegado con configureCompanyNda y la capacidad admin', async () => {
  const user = userEvent
  configure.mockResolvedValue({ templateId: 'template_1' })
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ capability: CAPABILITY }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  )
  vi.stubGlobal('fetch', fetchMock)
  renderSection(false)

  await user.type(screen.getByLabelText('Título'), 'NDA de la sala')
  await user.type(screen.getByLabelText('Versión'), '2026-09')
  await user.type(screen.getByLabelText('Texto del NDA'), 'Texto aprobado por el equipo.')
  await user.click(screen.getByRole('button', { name: 'Confirmar NDA' }))

  expect(await screen.findByText('NDA guardado.')).toBeInTheDocument()
  expect(configure).toHaveBeenCalledWith({
    companyId: 'company_1',
    title: 'NDA de la sala',
    content: 'Texto aprobado por el equipo.',
    version: '2026-09',
    locale: 'es',
    adminCapability: CAPABILITY,
  })
  expect(screen.getByLabelText('Texto del NDA')).toHaveValue('')
  const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
  expect(body).toMatchObject({
    action: 'GUEST_INVITE',
    target: 'COMPANY_NDA:company_1',
    companyId: 'company_1',
  })
  expect(body.input).toMatchObject({
    content: 'Texto aprobado por el equipo.',
    locale: 'es',
  })
})
