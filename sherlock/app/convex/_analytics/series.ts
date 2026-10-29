// ============================================================================
// SERIES DIARIAS — la forma del último mes, no un número suelto
// ============================================================================
// Tres tablas se leen igual: cuántas filas nacieron cada día de los últimos 30.
// El módulo empieza con `_`, así que Convex no lo direcciona: la superficie
// pública (y el guard de admin) vive en `convex/analyticsSeries.ts`.
//
// La ventana la resuelve la base por el índice implícito `by_creation_time`,
// no un `.filter()` en memoria: sin eso, la lectura escanearía la tabla entera
// para descartar casi todo (misma lección que `activityLogs.getStats`). El
// `take` es el techo de seguridad, no el filtro, y cuando se alcanza la serie
// lo dice con `truncado`: lo que se pierde son los días más viejos de la
// ventana, que se contarían como cero sin avisar.
//
// Los días van completos, con cero donde no hubo filas: una serie con huecos
// se lee como un valle que no ocurrió.
// ============================================================================

import { Effect } from 'effect'

import type { QueryCtx } from '../_generated/server'
import { convexPromise } from '../_helpers/effect'
import { dayKey, startOfDay } from './shared'

const DAY_MS = 24 * 60 * 60 * 1000

/** Hoy y los 29 días anteriores. */
const SERIES_DAYS = 30

/** Techo de lectura por serie. */
export const SERIES_SCAN_CAP = 5000

/** Las tres tablas que el tablero grafica por día. */
export type SeriesTable = 'documents' | 'intakeSessions' | 'activityLogs'

type DailyPoint = { readonly fecha: string; readonly valor: number }

type DailySeries = {
  readonly dias: readonly DailyPoint[]
  readonly diasConDatos: number
  // La lectura llegó al techo: los días más viejos de la ventana quedaron
  // cortos. La serie sigue siendo un mínimo verificable, no el total.
  readonly truncado: boolean
}

function bucketByDay(
  rows: readonly { _creationTime: number }[],
  from: number,
  truncado: boolean
): DailySeries {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = dayKey(row._creationTime)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const dias = Array.from({ length: SERIES_DAYS }, (_, index) => {
    const fecha = dayKey(from + index * DAY_MS)
    return { fecha, valor: counts.get(fecha) ?? 0 }
  })
  return { dias, diasConDatos: dias.filter((dia) => dia.valor > 0).length, truncado }
}

export const buildDailySeries = Effect.fn('Analytics.dailySeries')(function* (
  ctx: QueryCtx,
  table: SeriesTable
) {
  const from = startOfDay(Date.now()) - (SERIES_DAYS - 1) * DAY_MS
  const rows = yield* convexPromise(() =>
    ctx.db
      .query(table)
      .withIndex('by_creation_time', (q) => q.gte('_creationTime', from))
      .order('desc')
      // Una fila de más que el techo: es la única forma de distinguir «leí
      // todo» de «me quedé corto» sin una segunda lectura.
      .take(SERIES_SCAN_CAP + 1)
  )
  return bucketByDay(rows.slice(0, SERIES_SCAN_CAP), from, rows.length > SERIES_SCAN_CAP)
})
