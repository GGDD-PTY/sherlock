// ============================================================================
// SERIES DIARIAS — la superficie autorizada
// ============================================================================
// Solo perfiles ADMIN. `requireAuthAdmin` corre ANTES de cualquier lectura, por
// la misma razón que en `adminOverview.ts`: un guard después del primer
// `ctx.db` ya leyó lo que no debía. En Effect el orden es estructural — el
// `yield*` de la lectura no se alcanza si el guard no resolvió.
//
// Los conteos son agregados por día: no sale ni un nombre de archivo, ni un
// correo, ni un id de empresa.
// ============================================================================

import { Effect } from 'effect'

import { query, type QueryCtx } from './_generated/server'
import { requireAuthAdmin } from './_helpers/auth'
import { convexPromise, runConvex } from './_helpers/effect'
import { buildDailySeries, type SeriesTable } from './_analytics/series'

const seriesProgram = (span: string, table: SeriesTable) =>
  Effect.fn(span)(function* (ctx: QueryCtx) {
    yield* convexPromise(() => requireAuthAdmin(ctx))
    return yield* buildDailySeries(ctx, table)
  })

const documentsDaily = seriesProgram('AnalyticsSeries.documents', 'documents')
const intakeDaily = seriesProgram('AnalyticsSeries.intake', 'intakeSessions')
const activityDaily = seriesProgram('AnalyticsSeries.activity', 'activityLogs')

export const getDocumentsDaily = query({
  args: {},
  handler: (ctx) => runConvex(documentsDaily(ctx)),
})

export const getIntakeDaily = query({
  args: {},
  handler: (ctx) => runConvex(intakeDaily(ctx)),
})

export const getActivityDaily = query({
  args: {},
  handler: (ctx) => runConvex(activityDaily(ctx)),
})
