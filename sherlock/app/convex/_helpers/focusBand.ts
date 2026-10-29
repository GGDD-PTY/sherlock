// ============================================================================
// BANDA DE ENFOQUE DE MERCADO (USD 250K-5MM) — POLÍTICA COMPARTIDA
// ============================================================================
// Doctrina v3: "$250K-$5M es el sweet spot de marketing, no un cap"; decisión
// firmada 2026-07-31. Estas constantes existen para
// dejar rastro de revisión manual, nunca para rechazar un monto. Espejo del
// helper de la app en `src/lib/constants/fundraising.ts` (Convex no puede
// importar código de `src/`): si cambia la banda, cambia en ambos lados.
// ============================================================================

import { Schema } from 'effect'

export const FOCUS_BAND_MIN_USD = 250_000
export const FOCUS_BAND_MAX_USD = 5_000_000

// La banda, como schema: sus dos extremos se declaran juntos una sola vez, en
// vez de vivir en dos comparaciones sueltas que pueden quedar invertidas sin
// que nada avise.
const isInsideFocusBand = Schema.is(
  Schema.Finite.pipe(
    Schema.check(
      Schema.isGreaterThanOrEqualTo(FOCUS_BAND_MIN_USD),
      Schema.isLessThanOrEqualTo(FOCUS_BAND_MAX_USD)
    )
  )
)

// Un monto solo es clasificable si es un número finito y positivo: lo demás es
// una ficha incompleta, no un monto fuera de banda.
const isClassifiableAmount = Schema.is(Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0))))

// La banda está denominada en dólares y no hay fuente de FX en el producto.
const isFocusBandCurrency = Schema.is(Schema.Literals(['USD']))

/**
 * ¿El monto queda fuera del enfoque inicial declarado (por abajo O por arriba)?
 *
 * Solo se evalúa en USD: no hay fuente de FX en el producto, así que comparar
 * un monto en COP o MXN contra una banda en dólares daría un falso positivo.
 *
 * Moneda ausente = USD: el schema documenta `currency` como opcional con
 * default "USD". Sin esta normalización, una fila legacy sin moneda
 * clasificaría como "dentro de banda" y evitaría la marca de revisión.
 */
export function isOutsideUsdFocusBand(
  amount: number | null | undefined,
  currency: string | null | undefined
): boolean {
  if (!isFocusBandCurrency(currency || 'USD')) return false
  if (!isClassifiableAmount(amount)) return false

  return !isInsideFocusBand(amount)
}
