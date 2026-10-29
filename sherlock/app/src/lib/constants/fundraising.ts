// ============================================================================
// FUNDRAISING CONSTANTS
// ============================================================================
// Constantes compartidas para formularios de levantamiento de capital.
// Las usa el formulario «Tu empresa» de la sala (CompanyProfileForm).
// ============================================================================

import { Schema } from 'effect'

// ===== BANDA DE ENFOQUE DE MERCADO (NO ES UN LÍMITE) =====
// Doctrina v3: "$250K–$5M es el sweet spot de marketing, no un cap"; M&A (venta
// del 100%) es un tipo de mandato y vive por encima de la banda. Decisión firmada
// 2026-07-31: el techo del formulario pasa de bloqueo
// duro a advertencia + marca de revisión manual. Estas constantes existen para
// AVISAR y para dejar rastro, nunca para rechazar un monto.
export const FOCUS_BAND_MIN_USD = 250_000
export const FOCUS_BAND_MAX_USD = 5_000_000

/**
 * ¿El monto queda fuera del enfoque inicial declarado?
 *
 * Solo se evalúa en USD: no hay fuente de FX en el producto, así que comparar
 * un monto en COP o MXN contra una banda en dólares daría un aviso falso. Para
 * el resto de las monedas la revisión la hace el equipo (follow-up: bandas por
 * moneda o FX declarado).
 *
 * Moneda ausente = USD: el schema de Convex documenta `currency` como opcional
 * con default "USD" — espejo del helper de Convex (`_helpers/focusBand.ts`).
 */
// La regla se escribe una vez, como schema: un monto declarado es un número
// finito y positivo, y la banda es el intervalo cerrado entre las dos
// constantes de arriba. `isOutsideUsdFocusBand` es la negación de eso.
const DeclaredUsdAmountSchema = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)))
const InsideFocusBandSchema = DeclaredUsdAmountSchema.pipe(
  Schema.check(Schema.isBetween({ minimum: FOCUS_BAND_MIN_USD, maximum: FOCUS_BAND_MAX_USD }))
)

const isDeclaredUsdAmount = Schema.is(DeclaredUsdAmountSchema)
const isInsideFocusBand = Schema.is(InsideFocusBandSchema)

export function isOutsideUsdFocusBand(
  amount: number | null | undefined,
  currency: string | null | undefined
): boolean {
  if ((currency || 'USD') !== 'USD') return false
  if (!isDeclaredUsdAmount(amount)) return false

  return !isInsideFocusBand(amount)
}
