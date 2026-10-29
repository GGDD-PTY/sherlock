// ============================================================================
// PERFIL DE LA EMPRESA — lo que la sala edita
// ============================================================================
// Proyección de `companies` a los campos que el formulario «Tu empresa» edita
// en el Data Room ([F] 2026-09-07 09:00): solo lo que el equipo usa en el
// teaser, el CIM y el modelo. Vive fuera del componente cliente para que la
// página (server) pueda construirla a partir de la fila.
// ============================================================================

import { Schema } from 'effect'

import type { Doc } from '@/../convex/_generated/dataModel'

// `BRIDGE` sigue en el schema para filas viejas, pero salió del formulario:
// una empresa que lo tenga ve el tipo vacío hasta que elija uno de estos.
const SeekingTypeSchema = Schema.Literals(['DEBT', 'EQUITY', 'BOTH'])
type SeekingType = typeof SeekingTypeSchema.Type

const isSeekingType = Schema.is(SeekingTypeSchema)

export type TeamMember = {
  name: string
  title: string
  bio?: string
  linkedin?: string
}

export type CompanyProfileValues = {
  name: string
  legalName: string
  country: string
  city: string
  website: string
  foundedYear: number | null
  employees: string
  sector: string
  industry: string
  tagline: string
  description: string
  seekingType: SeekingType | ''
  seekingAmount: number | null
  currency: string
  debtTermYears: number | null
  debtIndicativeRate: number | null
  useOfFunds: string
  managementTeam: TeamMember[]
}

type CompanyProfileSource = Pick<
  Doc<'companies'>,
  | 'name'
  | 'legalName'
  | 'country'
  | 'city'
  | 'website'
  | 'foundedYear'
  | 'employees'
  | 'sector'
  | 'industry'
  | 'tagline'
  | 'description'
  | 'seekingType'
  | 'seekingAmount'
  | 'currency'
  | 'debtTermYears'
  | 'debtIndicativeRate'
  | 'useOfFunds'
  | 'managementTeam'
>

export function toCompanyProfileValues(company: CompanyProfileSource): CompanyProfileValues {
  const seekingType = isSeekingType(company.seekingType) ? company.seekingType : ''
  return {
    name: company.name,
    legalName: company.legalName ?? '',
    country: company.country,
    city: company.city ?? '',
    website: company.website ?? '',
    foundedYear: company.foundedYear ?? null,
    employees: company.employees ?? '',
    sector: company.sector ?? '',
    industry: company.industry ?? '',
    tagline: company.tagline ?? '',
    description: company.description ?? '',
    seekingType,
    seekingAmount: company.seekingAmount ?? null,
    currency: company.currency ?? 'USD',
    debtTermYears: company.debtTermYears ?? null,
    debtIndicativeRate: company.debtIndicativeRate ?? null,
    useOfFunds: company.useOfFunds ?? '',
    managementTeam: (company.managementTeam ?? []).map((member) => ({
      name: member.name,
      title: member.title,
      ...(member.bio ? { bio: member.bio } : {}),
      ...(member.linkedin ? { linkedin: member.linkedin } : {}),
    })),
  }
}
