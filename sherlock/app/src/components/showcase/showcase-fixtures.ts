import { Schema } from 'effect'

// Cada fila dice qué es. Antes la vitrina lo deducía de su posición en el
// arreglo (`index === 0`), así que reordenarlas o agregar una tercera cambiaba
// en silencio la etiqueta y el color con los que se pintaban.
const ShowcaseCompanySchema = Schema.Struct({
  id: Schema.String,
  isSynthetic: Schema.Literals([true]),
})

const ShowcaseMandateSchema = Schema.Struct({
  id: Schema.String,
  isSynthetic: Schema.Literals([true]),
  amount: Schema.Finite,
  currency: Schema.Literals(['USD']),
})

const ShowcaseTableRowSchema = Schema.Struct({
  id: Schema.String,
  amount: Schema.Finite,
  labelKey: Schema.Literals(['seniorFacility', 'sponsorEquity']),
  statusKey: Schema.Literals(['pending', 'confirmed']),
})

const ShowcaseChartRowSchema = Schema.Struct({
  id: Schema.String,
  value: Schema.Finite,
  tone: Schema.Literals(['primary', 'accent']),
})

const ShowcaseFixturesSchema = Schema.Struct({
  company: ShowcaseCompanySchema,
  mandate: ShowcaseMandateSchema,
  tableRows: Schema.Array(ShowcaseTableRowSchema).pipe(Schema.check(Schema.isNonEmpty())),
  chartRows: Schema.Array(ShowcaseChartRowSchema).pipe(Schema.check(Schema.isNonEmpty())),
  invalidReference: Schema.String,
})

const decodeShowcaseFixtures = Schema.decodeUnknownSync(ShowcaseFixturesSchema)

export const SYNTHETIC_SHOWCASE_FIXTURES = decodeShowcaseFixtures({
  company: {
    id: 'SYN-COMPANY-001.example',
    isSynthetic: true,
  },
  mandate: {
    id: 'SYN-MANDATE-001.example',
    isSynthetic: true,
    amount: 2_400_000,
    currency: 'USD',
  },
  tableRows: [
    {
      id: 'SYN-TRANCHE-001.example',
      amount: 1_500_000,
      labelKey: 'seniorFacility',
      statusKey: 'pending',
    },
    {
      id: 'SYN-TRANCHE-002.example',
      amount: 900_000,
      labelKey: 'sponsorEquity',
      statusKey: 'confirmed',
    },
  ],
  chartRows: [
    { id: 'SYN-SERIES-001.example', value: 63, tone: 'primary' },
    { id: 'SYN-SERIES-002.example', value: 37, tone: 'accent' },
  ],
  invalidReference: 'SYN-INCOMPLETE.example',
})

// El vocabulario de estados de la vitrina: una sola definición, recorrible por
// quien tenga que enumerarla.
const ShowcaseStateSchema = Schema.Literals([
  'default',
  'hover',
  'focus',
  'active',
  'disabled',
  'loading',
  'empty',
  'error',
  'denied',
  'pending',
  'success',
])

export const SHOWCASE_STATES = ShowcaseStateSchema.literals
