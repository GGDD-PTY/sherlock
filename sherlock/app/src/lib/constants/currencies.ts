// ============================================================================
// MONEDAS SOPORTADAS
// ============================================================================
// Fuente única de verdad para monedas en toda la aplicación
// Usado en: la ficha de la empresa y el análisis financiero
// ============================================================================

import { Schema } from 'effect'

// ===== MONEDAS DISPONIBLES =====
// Cada moneda tiene: value (código ISO), label (descripción), symbol
export const CURRENCIES = [
  { value: 'USD', label: 'USD - Dólar Estadounidense', symbol: '$' },
  { value: 'MXN', label: 'MXN - Peso Mexicano', symbol: '$' },
  { value: 'COP', label: 'COP - Peso Colombiano', symbol: '$' },
  { value: 'PEN', label: 'PEN - Sol Peruano', symbol: 'S/' },
  { value: 'CLP', label: 'CLP - Peso Chileno', symbol: '$' },
  { value: 'ARS', label: 'ARS - Peso Argentino', symbol: '$' },
  { value: 'BRL', label: 'BRL - Real Brasileño', symbol: 'R$' },
] as const

// ===== TIPO DERIVADO =====
// El vocabulario sale de `CURRENCIES` y el tipo sale del schema, no de un
// `[number]['value']` paralelo.
const CurrencyCodeSchema = Schema.Literals(CURRENCIES.map((currency) => currency.value))
export type CurrencyCode = typeof CurrencyCodeSchema.Type

const isCurrencyCode = Schema.is(CurrencyCodeSchema)

// ===== HELPER: Validar si es una moneda válida =====
export function isValidCurrency(code: string): code is CurrencyCode {
  return isCurrencyCode(code)
}
