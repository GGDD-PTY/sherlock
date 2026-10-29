// ============================================================================
// PAÍSES DE LATINOAMÉRICA
// ============================================================================
// Fuente única de verdad para países en toda la aplicación
// Usado en: el alta de la empresa (Onboarding) y su ficha.
// ============================================================================

import { Schema } from 'effect'

// ===== PAÍSES DISPONIBLES =====
// Cada país tiene: value (código), label (nombre ES), labelEn (nombre EN), currency (moneda default)
export const COUNTRIES = [
  { value: 'MX', label: 'México', labelEn: 'Mexico', currency: 'MXN' },
  { value: 'CO', label: 'Colombia', labelEn: 'Colombia', currency: 'COP' },
  { value: 'PE', label: 'Perú', labelEn: 'Peru', currency: 'PEN' },
  { value: 'CL', label: 'Chile', labelEn: 'Chile', currency: 'CLP' },
  { value: 'AR', label: 'Argentina', labelEn: 'Argentina', currency: 'ARS' },
  { value: 'PA', label: 'Panamá', labelEn: 'Panama', currency: 'USD' },
  { value: 'CR', label: 'Costa Rica', labelEn: 'Costa Rica', currency: 'USD' },
  { value: 'GT', label: 'Guatemala', labelEn: 'Guatemala', currency: 'USD' },
  { value: 'EC', label: 'Ecuador', labelEn: 'Ecuador', currency: 'USD' },
  { value: 'OTHER', label: 'Otro', labelEn: 'Other', currency: 'USD' },
] as const

// ===== TIPO DERIVADO =====
// Un solo vocabulario: el schema sale de `COUNTRIES`, el tipo sale del schema y
// `isValidCountry` es ese mismo schema corriendo. Agregar un país a la tabla es
// lo único que hay que hacer.
const CountryCodeSchema = Schema.Literals(COUNTRIES.map((country) => country.value))
export type CountryCode = typeof CountryCodeSchema.Type

const isCountryCode = Schema.is(CountryCodeSchema)

const COUNTRY_LABEL_ALIASES: Record<string, CountryCode> = {
  Mexico: 'MX',
  México: 'MX',
  Colombia: 'CO',
  Peru: 'PE',
  Perú: 'PE',
  Chile: 'CL',
  Argentina: 'AR',
  Panama: 'PA',
  Panamá: 'PA',
  'Costa Rica': 'CR',
  Guatemala: 'GT',
  Ecuador: 'EC',
  Other: 'OTHER',
  Otro: 'OTHER',
}

const COUNTRY_DISPLAY_ALIASES: Record<
  string,
  { readonly label: string; readonly labelEn: string }
> = {
  BR: { label: 'Brasil', labelEn: 'Brazil' },
  Brazil: { label: 'Brasil', labelEn: 'Brazil' },
  Brasil: { label: 'Brasil', labelEn: 'Brazil' },
}

function findCountry(codeOrLabel: string) {
  const normalizedCode = COUNTRY_LABEL_ALIASES[codeOrLabel] ?? codeOrLabel
  return COUNTRIES.find((c) => c.value === normalizedCode)
}

// ===== HELPER: Obtener label de un país =====
export function getCountryLabel(codeOrLabel: string): string {
  const country = findCountry(codeOrLabel)
  const displayAlias = COUNTRY_DISPLAY_ALIASES[codeOrLabel]
  if (!country) return displayAlias?.label ?? codeOrLabel
  return country.label
}

// ===== HELPER: Validar si es un país válido =====
export function isValidCountry(code: string): code is CountryCode {
  return isCountryCode(code)
}
