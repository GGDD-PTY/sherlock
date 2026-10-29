// ============================================================================
// «TU EMPRESA» — el perfil de la empresa vive en la sala
// ============================================================================
// [F] 2026-09-07 09:00: campos planos debajo de los documentos y un solo
// «Guardar». El equipo directivo y la identidad se guardan juntos.
// [F] 2026-09-13: los términos financieros se retiran del formulario cliente.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Id } from '@/../convex/_generated/dataModel'
import type { CompanyProfileValues } from '@/lib/company/profile-values'

const mockUpdateCompany = vi.fn()
const mockUpdateManagementTeam = vi.fn()
const mockUpdateContactPhone = vi.fn()
const mockToast = vi.fn()

vi.mock('convex/react', () => ({
  useMutation: (reference: string) =>
    reference === 'companies.updateManagementTeam'
      ? mockUpdateManagementTeam
      : reference === 'companies.updateContactPhone'
        ? mockUpdateContactPhone
        : mockUpdateCompany,
}))

vi.mock('@/../convex/_generated/api', () => ({
  api: {
    companies: {
      updateCompany: 'companies.updateCompany',
      updateManagementTeam: 'companies.updateManagementTeam',
      updateContactPhone: 'companies.updateContactPhone',
    },
  },
}))

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: { email: 'fixture-ab70fcd4@example.com' },
    profile: { phone: '+507 6000-0000' },
    isLoading: false,
  }),
}))

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

vi.mock('next-intl', async () => {
  const es = (await import('@/messages/es.json')).default as Record<string, unknown>

  return {
    useLocale: () => 'es',
    useTranslations: (namespace: string) => {
      return (key: string, values?: Record<string, string | number>) => {
        const parts = [...namespace.split('.'), ...key.split('.')]
        let node: unknown = es
        for (const part of parts) {
          node = (node as Record<string, unknown> | undefined)?.[part]
        }
        if (typeof node !== 'string') throw new Error(`missing es.json key ${namespace}.${key}`)
        return node.replace(/\{(\w+)\}/g, (match, name) =>
          values && name in values ? String(values[name]) : match
        )
      }
    },
  }
})

// Radix Select no abre en jsdom sin polyfills de puntero: el mock lo vuelve un
// <select> nativo que conserva id, aria-* y placeholder del trigger, así los
// tests cambian el valor con fireEvent.change y el label sigue asociado.
vi.mock('@/components/ui/select', async () => {
  const React = await import('react')

  type SelectProps = {
    children?: ReactNode
    value?: string
    onValueChange?: (value: string) => void
    disabled?: boolean
  }

  const SelectItem = ({ children, value }: { children?: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  )
  const SelectTrigger = (_props: Record<string, unknown>) => null
  const SelectValue = (_props: { placeholder?: string }) => null
  const SelectContent = ({ children }: { children?: ReactNode }) => <>{children}</>

  const Select = ({ children, value, onValueChange, disabled }: SelectProps) => {
    let triggerProps: Record<string, unknown> = {}
    let placeholder = ''
    let items: ReactNode = null

    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const props = child.props as Record<string, unknown>
      if (child.type === SelectTrigger) {
        const { children: triggerChildren, ...rest } = props
        triggerProps = rest
        React.Children.forEach(triggerChildren as ReactNode, (inner) => {
          if (React.isValidElement(inner) && inner.type === SelectValue) {
            placeholder = String((inner.props as { placeholder?: string }).placeholder ?? '')
          }
        })
      }
      if (child.type === SelectContent) {
        items = props.children as ReactNode
      }
    })

    return (
      <select
        {...triggerProps}
        disabled={disabled}
        value={value ?? ''}
        onChange={(event) => onValueChange?.(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {items}
      </select>
    )
  }

  return { Select, SelectContent, SelectItem, SelectTrigger, SelectValue }
})

import { CompanyProfileForm } from '@/components/company/CompanyProfileForm'

const COMPANY_ID = 'company_samplefoods' as Id<'companies'>
const COMPONENT_SOURCE = join(
  __dirname,
  '..',
  '..',
  '..',
  'components',
  'company',
  'CompanyProfileForm.tsx'
)
const HEX_COLOR = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/
const EMOJI = /\p{Extended_Pictographic}/u

function values(overrides: Partial<CompanyProfileValues> = {}): CompanyProfileValues {
  return {
    name: 'SampleFoods Foods',
    legalName: 'SampleFoods Foods, S. A.',
    country: 'PA',
    city: 'Panamá',
    website: 'https://samplefoods.example',
    foundedYear: 2015,
    employees: '120',
    sector: 'Alimentos y bebidas',
    industry: 'Alimentos procesados y distribución',
    tagline: 'Alimentos para toda Centroamérica.',
    description: 'Producimos y distribuimos alimentos procesados.',
    seekingType: 'BOTH',
    seekingAmount: 50_000_000,
    currency: 'USD',
    debtTermYears: 7,
    debtIndicativeRate: 9.5,
    useOfFunds: 'Ampliar la planta.',
    managementTeam: [{ name: 'Ana Pérez', title: 'CEO' }],
    ...overrides,
  }
}

function renderForm(
  overrides: Partial<CompanyProfileValues> = {},
  isDemo = false,
  withContact = false
) {
  return render(
    <CompanyProfileForm
      companyId={COMPANY_ID}
      initial={values(overrides)}
      isDemo={isDemo}
      withContact={withContact}
    />
  )
}

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Guardar' }))
// Cada grupo es un <fieldset> con su <legend>: «Nombre» existe en Identidad y
// en cada persona del equipo, así que los lookups van por grupo.
const group = (name: string) => within(screen.getByRole('group', { name }))
const identity = () => group('Identidad')

describe('CompanyProfileForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateCompany.mockResolvedValue({})
    mockUpdateManagementTeam.mockResolvedValue(undefined)
    mockUpdateContactPhone.mockResolvedValue(undefined)
  })

  it('renders the stored identity and management team', () => {
    renderForm()

    expect(screen.getByRole('heading', { level: 2, name: 'Tu empresa' })).toBeInTheDocument()
    expect(identity().getByLabelText(/^Nombre/)).toHaveValue('SampleFoods Foods')
    expect(identity().getByLabelText(/^Razón social/)).toHaveValue('SampleFoods Foods, S. A.')
    expect(identity().getByLabelText(/^País/)).toHaveValue('PA')
    expect(identity().getByLabelText(/^Año de fundación/)).toHaveValue('2015')
    expect(identity().getByLabelText(/^Sector/)).toHaveValue('Alimentos y bebidas')
    expect(identity().getByLabelText(/^Industria/)).toHaveValue(
      'Alimentos procesados y distribución'
    )

    const member = screen.getByRole('listitem', { name: 'Persona 1' })
    expect(within(member).getByLabelText(/^Nombre/)).toHaveValue('Ana Pérez')
    expect(within(member).getByLabelText(/^Cargo/)).toHaveValue('CEO')
  })

  it('does not ask the client for transaction terms', () => {
    renderForm()
    expect(screen.queryByRole('group', { name: 'Qué buscas' })).not.toBeInTheDocument()
    for (const label of [
      /^Tipo$/,
      /^Monto/,
      /^Moneda/,
      /^Plazo/,
      /^Tasa indicativa/,
      /^Uso de fondos/,
    ]) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument()
    }
  })

  it.each([
    { seekingType: 'BOTH', seekingAmount: 50_000_000, debtTermYears: 7, debtIndicativeRate: 9.5 },
    { seekingType: 'DEBT', seekingAmount: -1, debtTermYears: 45, debtIndicativeRate: 150 },
    { seekingType: '', seekingAmount: null, debtTermYears: null, debtIndicativeRate: null },
  ] satisfies Partial<CompanyProfileValues>[])(
    'saves identity without sending or validating hidden financial values $seekingType',
    async (financial) => {
      renderForm(financial)
      fireEvent.change(identity().getByLabelText(/^Nombre/), {
        target: { value: 'Agroindustria Demo' },
      })
      save()
      await waitFor(() => expect(mockUpdateCompany).toHaveBeenCalledTimes(1))
      expect(mockUpdateCompany).toHaveBeenCalledWith({
        companyId: COMPANY_ID,
        name: 'Agroindustria Demo',
        legalName: 'SampleFoods Foods, S. A.',
        country: 'PA',
        city: 'Panamá',
        website: 'https://samplefoods.example',
        foundedYear: 2015,
        employees: '120',
        sector: 'Alimentos y bebidas',
        industry: 'Alimentos procesados y distribución',
        tagline: 'Alimentos para toda Centroamérica.',
        description: 'Producimos y distribuimos alimentos procesados.',
        managementTeam: undefined,
      })
      for (const key of [
        'seekingType',
        'seekingAmount',
        'currency',
        'debtTermYears',
        'debtIndicativeRate',
        'useOfFunds',
      ]) {
        expect(mockUpdateCompany.mock.calls[0]?.[0]).not.toHaveProperty(key)
      }
      expect(mockToast).toHaveBeenCalledWith({ title: 'Guardado' })
    }
  )

  it('clears optional identity text and founding year explicitly', async () => {
    renderForm()
    fireEvent.change(identity().getByLabelText(/^Ciudad/), { target: { value: '' } })
    fireEvent.change(identity().getByLabelText(/^Año de fundación/), { target: { value: '' } })
    save()
    await waitFor(() => expect(mockUpdateCompany).toHaveBeenCalledTimes(1))
    expect(mockUpdateCompany).toHaveBeenCalledWith(
      expect.objectContaining({ city: '', foundedYear: null })
    )
  })

  it('saves company and changed team in one transaction', async () => {
    renderForm()

    fireEvent.click(screen.getByRole('button', { name: 'Agregar persona' }))
    const added = screen.getByRole('listitem', { name: 'Persona 2' })
    fireEvent.change(within(added).getByLabelText(/^Nombre/), { target: { value: 'Luis Gómez' } })
    fireEvent.change(within(added).getByLabelText(/^Cargo/), { target: { value: 'CFO' } })
    fireEvent.change(within(added).getByLabelText(/^LinkedIn/), {
      target: { value: 'https://linkedin.com/in/luisgomez' },
    })
    save()

    await waitFor(() => expect(mockUpdateCompany).toHaveBeenCalledTimes(1))
    expect(mockUpdateCompany).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY_ID,
        managementTeam: [
          { name: 'Ana Pérez', title: 'CEO' },
          { name: 'Luis Gómez', title: 'CFO', linkedin: 'https://linkedin.com/in/luisgomez' },
        ],
      })
    )
    expect(mockUpdateManagementTeam).not.toHaveBeenCalled()
  })

  it('removes a person and saves the shorter list', async () => {
    renderForm()

    fireEvent.click(screen.getByRole('button', { name: 'Quitar: Persona 1' }))
    expect(screen.getByText('Todavía no has agregado a nadie.')).toBeInTheDocument()
    save()

    await waitFor(() => expect(mockUpdateCompany).toHaveBeenCalledTimes(1))
    expect(mockUpdateCompany).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY_ID,
        managementTeam: [],
      })
    )
  })

  it('validates inline in Spanish and never saves an invalid section', async () => {
    renderForm()

    fireEvent.change(identity().getByLabelText(/^Nombre/), { target: { value: '   ' } })
    fireEvent.change(identity().getByLabelText(/^Año de fundación/), { target: { value: '1800' } })
    fireEvent.click(screen.getByRole('button', { name: 'Agregar persona' }))
    const added = screen.getByRole('listitem', { name: 'Persona 2' })
    fireEvent.change(within(added).getByLabelText(/^Cargo/), { target: { value: 'COO' } })
    save()

    const currentYear = new Date().getFullYear()
    expect(screen.getByText('Escribe el nombre de tu empresa.')).toBeInTheDocument()
    expect(screen.getByText(`Escribe un año entre 1900 y ${currentYear}.`)).toBeInTheDocument()
    expect(within(added).getByText('Escribe el nombre.')).toBeInTheDocument()

    const name = identity().getByLabelText(/^Nombre/)
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveFocus()
    expect(mockUpdateCompany).not.toHaveBeenCalled()
    expect(mockUpdateManagementTeam).not.toHaveBeenCalled()

    // Corregir el campo retira su error sin esperar al próximo submit.
    fireEvent.change(name, { target: { value: 'SampleFoods Foods' } })
    expect(screen.queryByText('Escribe el nombre de tu empresa.')).not.toBeInTheDocument()
  })

  it('requires a country before the first save', () => {
    renderForm({ country: '' })

    save()

    expect(screen.getByText('Elige el país.')).toBeInTheDocument()
    expect(mockUpdateCompany).not.toHaveBeenCalled()
  })

  // [F] 2026-09-17: sector e industria pasan a texto libre. No hay lista que
  // elegir, no hay cascada, y lo que la empresa escribe se guarda tal cual.
  it('saves the sector and the industry as free text', async () => {
    renderForm()

    fireEvent.change(identity().getByLabelText(/^Sector/), {
      target: { value: 'Agroindustria, alimentos y transporte' },
    })
    fireEvent.change(identity().getByLabelText(/^Industria/), {
      target: { value: 'Molienda de arroz y flota propia' },
    })
    save()

    await waitFor(() => expect(mockUpdateCompany).toHaveBeenCalledTimes(1))
    expect(mockUpdateCompany.mock.calls[0]?.[0]).toMatchObject({
      sector: 'Agroindustria, alimentos y transporte',
      industry: 'Molienda de arroz y flota propia',
    })
    expect(identity().getByLabelText(/^Sector/).tagName).toBe('INPUT')
    expect(identity().getByLabelText(/^Industria/).tagName).toBe('INPUT')
  })

  it('keeps the entered values and says so when the save fails', async () => {
    mockUpdateCompany.mockRejectedValueOnce(new Error('offline'))
    renderForm()

    fireEvent.change(identity().getByLabelText(/^Ciudad/), { target: { value: 'David' } })
    save()

    expect(
      await screen.findByText('No pudimos guardar. Revisa tu conexión e intenta de nuevo.')
    ).toBeInTheDocument()
    expect(identity().getByLabelText(/^Ciudad/)).toHaveValue('David')
    expect(mockToast).not.toHaveBeenCalled()
  })

  it('does not write anything from the demo room', () => {
    renderForm({}, true)

    save()

    expect(mockUpdateCompany).not.toHaveBeenCalled()
    expect(mockUpdateManagementTeam).not.toHaveBeenCalled()
    expect(mockToast).toHaveBeenCalledWith({
      title: 'Los cambios no se guardan en el Data Room de demostración.',
    })
  })

  // Una pantalla, un pie, un Guardar (docs/design-system-vdr.md).
  it('keeps the only submit in the footer, with the contact group when asked', () => {
    renderForm({}, false, true)

    const footer = screen.getByTestId('company-profile-footer')
    expect(within(footer).getByRole('button', { name: 'Guardar' })).toHaveAttribute(
      'type',
      'submit'
    )
    expect(screen.getAllByRole('button', { name: /Guardar/ })).toHaveLength(1)
    const contact = group('Contacto')
    expect(contact.getByText('fixture-ab70fcd4@example.com')).toBeInTheDocument()
    expect(contact.queryByRole('textbox', { name: 'Email de la cuenta' })).not.toBeInTheDocument()
    expect(contact.getByRole('textbox', { name: 'Teléfono de contacto' })).toHaveValue(
      '+507 6000-0000'
    )
  })

  it('saves the profile and a changed phone with the same button', async () => {
    renderForm({}, false, true)

    fireEvent.change(group('Contacto').getByRole('textbox', { name: 'Teléfono de contacto' }), {
      target: { value: '+507 6111-1111' },
    })
    save()

    await waitFor(() => expect(mockUpdateContactPhone).toHaveBeenCalledTimes(1))
    expect(mockUpdateCompany).toHaveBeenCalledTimes(1)
    expect(mockUpdateContactPhone.mock.calls[0]?.[0]).toMatchObject({ companyId: COMPANY_ID })
    expect(mockToast).toHaveBeenCalledWith({ title: 'Guardado' })
  })

  it('refuses an invalid phone before saving anything', async () => {
    renderForm({}, false, true)

    fireEvent.change(group('Contacto').getByRole('textbox', { name: 'Teléfono de contacto' }), {
      target: { value: '12' },
    })
    save()

    expect(await screen.findByRole('alert')).toHaveTextContent('Escribe un teléfono')
    expect(mockUpdateCompany).not.toHaveBeenCalled()
    expect(mockUpdateContactPhone).not.toHaveBeenCalled()
  })

  it('leaves the phone untouched when it did not change', async () => {
    renderForm({}, false, true)
    save()

    await waitFor(() => expect(mockUpdateCompany).toHaveBeenCalledTimes(1))
    expect(mockUpdateContactPhone).not.toHaveBeenCalled()
  })

  it('stays inside the six-pigment contract and ships no emoji', () => {
    const source = readFileSync(COMPONENT_SOURCE, 'utf8')

    expect(source).not.toMatch(HEX_COLOR)
    expect(source).not.toMatch(EMOJI)
    expect(source).not.toMatch(/tenés|podés|\bvos\b/)
  })
})
