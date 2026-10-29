// ============================================================================
// TOPES DE LECTURA QUE VIENEN DEL CLIENTE
// ============================================================================
// Un `limit` o un `hoursBack` que llega como argumento lo fija quien llama, y
// sin techo una query reactiva paga la tabla entera por suscripción. Este es el
// patrón de `getManualReviewQueue`, escrito una sola vez: entero, al menos 1,
// nunca más que `max`; sin valor (o con basura) cae a `fallback`.
// ============================================================================

import { Schema } from 'effect'

const isFiniteNumber = Schema.is(Schema.Finite)

export type LimitBounds = Readonly<{ fallback: number; max: number }>

export function clampLimit(value: number | undefined, bounds: LimitBounds): number {
  const candidate = isFiniteNumber(value) ? Math.floor(value) : bounds.fallback
  return Math.min(Math.max(candidate, 1), bounds.max)
}
