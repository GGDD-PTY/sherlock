// ============================================================================
// CONSTANTES - RE-EXPORT
// ============================================================================
// Este archivo re-exporta todas las constantes del directorio constants/
// para mantener compatibilidad con imports existentes.
//
// Uso: import { COUNTRIES } from '@/lib/constants'
// ============================================================================

// Compatibilidad del único consumidor legacy mientras migra al catálogo de países.

import { Schema } from 'effect'

// ===== CATÁLOGO LEGACY (14 códigos) =====
// `AdminCompaniesClient.tsx` recibe `company.country` de Convex —ahí sí hay un
// dato externo, y ya lo decodifica a mano contra
// `Schema.Literals(Object.keys(countryNames))`. Esta lista es la fuente de esa
// frontera, no la frontera misma.
//
// Esta lista y la de 10 códigos en `constants/countries.ts` ya divergieron.
// Es decisión de producto pendiente, no se unifican acá: el schema solo
// describe el catálogo que este archivo ya tenía, para que agregar o quitar
// un código sin tocarlos a los dos rompa la compilación en vez de dejar una
// fila sin nombre en alguno.
const LegacyCountryCodeSchema = Schema.Literals([
  'PA',
  'CO',
  'MX',
  'PE',
  'CL',
  'AR',
  'BR',
  'EC',
  'CR',
  'GT',
  'US',
  'ES',
  'UY',
  'DO',
])

// Tipo derivado para type safety
export type CountryCode = typeof LegacyCountryCodeSchema.Type

// ===== COUNTRY NAMES (Spanish) =====
// Map of ISO country codes to Spanish names
export const countryNames = {
  PA: 'Panamá',
  CO: 'Colombia',
  MX: 'México',
  PE: 'Perú',
  CL: 'Chile',
  AR: 'Argentina',
  BR: 'Brasil',
  EC: 'Ecuador',
  CR: 'Costa Rica',
  GT: 'Guatemala',
  US: 'Estados Unidos',
  ES: 'España',
  UY: 'Uruguay',
  DO: 'República Dominicana',
} satisfies Record<CountryCode, string>

// Recorre el catálogo en runtime: si `countryNames` alguna vez pierde una fila
// sin que `LegacyCountryCodeSchema` se actualice a la par, esto revienta al
// importar el módulo, no en el primer render que busque ese código.
for (const code of LegacyCountryCodeSchema.literals) {
  if (!(code in countryNames)) {
    throw new Error(`constants: falta el nombre en español para "${code}"`)
  }
}
