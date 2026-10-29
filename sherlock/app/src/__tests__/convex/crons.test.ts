// ============================================================================
// CATÁLOGO DE TAREAS PROGRAMADAS (convex/crons.ts)
// ============================================================================
// La suite anterior declaraba cinco jobs en una copia local y afirmaba sobre esa
// copia: producción registra once y el test seguía verde igual, con o sin crons.
//
// Este archivo importa el módulo de producción y lee `crons.crons`, el registro
// que `cronJobs()` arma en cada llamada a `crons.daily/hourly/weekly/interval`
// (`Crons.schedule`, node_modules/convex/src/server/cron.ts): cada entrada trae
// el nombre de la función programada —resuelto por `getFunctionName`— y la
// cadencia ya validada. Renombrar un cron, moverle la hora o apuntarlo a otro
// handler pone esto en rojo.
// ============================================================================

import { describe, expect, it, vi } from 'vitest'

// `setup.ts` mockea `convex/_generated/api` con un `internal` recortado a mano,
// sin `_documents` ni `intake`: con ese mock, `crons.ts` muere al importarse.
// El archivo generado real no tiene efectos —es `anyApi`, el Proxy que produce
// los nombres `módulo:export`— y es justo lo que este test necesita leer.
vi.mock('../../../convex/_generated/api', async () =>
  vi.importActual('../../../convex/_generated/api')
)

import crons from '../../../convex/crons'

// Identificador, función programada y cadencia de cada tarea, en el orden en que
// `crons.ts` las registra.
const EXPECTED_JOBS = [
  {
    identifier: 'cleanup-old-data',
    handler: 'cronHandlers:cleanupOldData',
    schedule: { type: 'daily', hourUTC: 3, minuteUTC: 0 },
  },
  {
    identifier: 'check-kyc-expiration',
    handler: 'cronHandlers:checkKYCExpiration',
    schedule: { type: 'daily', hourUTC: 8, minuteUTC: 0 },
  },
  {
    identifier: 'cleanup-expired-sessions',
    handler: 'cronHandlers:cleanupExpiredSessions',
    schedule: { type: 'hourly', minuteUTC: 30 },
  },
  {
    identifier: 'purge-expired-admin-vdr-capabilities',
    handler: 'adminVdrCapabilities:_purgeExpired',
    schedule: { type: 'interval', minutes: 5 },
  },
  {
    identifier: 'mark-expired-documents',
    handler: 'documents:_markExpiredDocuments',
    schedule: { type: 'hourly', minuteUTC: 15 },
  },
  {
    identifier: 'reconcile-vdr-upload-intents',
    handler: 'documents:expireIssuedUploadIntents',
    schedule: { type: 'hourly', minuteUTC: 5 },
  },
  {
    identifier: 'reconcile-intake-artifacts',
    handler: 'intake:_reconcileArtifacts',
    schedule: { type: 'hourly', minuteUTC: 10 },
  },
  {
    identifier: 'purge-expired-document-grants',
    handler: '_documents/internals:_purgeExpiredGrants',
    schedule: { type: 'daily', hourUTC: 2, minuteUTC: 15 },
  },
  {
    identifier: 'backfill-access-log-company-id',
    handler: 'documents:_backfillAccessLogCompanyId',
    schedule: { type: 'daily', hourUTC: 2, minuteUTC: 45 },
  },
  {
    identifier: 'prune-dry-run',
    handler: 'operatorPrune:pruneDryRun',
    schedule: { type: 'weekly', dayOfWeek: 'sunday', hourUTC: 5, minuteUTC: 0 },
  },
] as const

/** La franja que ocupa una tarea dentro de su propia cadencia. */
function slotOf(schedule: Record<string, unknown>): string {
  const { type, ...rest } = schedule

  return `${String(type)} ${JSON.stringify(rest)}`
}

describe('convex/crons.ts', () => {
  it('registra las diez tareas del catálogo, y solo esas', () => {
    expect(Object.keys(crons.crons)).toEqual(EXPECTED_JOBS.map((job) => job.identifier))
  })

  it.each(EXPECTED_JOBS)('$identifier programa $handler', ({ identifier, handler, schedule }) => {
    const job = crons.crons[identifier]

    expect(job).toBeDefined()
    expect(job.name).toBe(handler)
    expect(job.schedule).toEqual(schedule)
  })

  // Convex corre los crons vencidos del mismo minuto en paralelo. Las franjas
  // escalonadas de `crons.ts` (minutos 5/10/15/30, y 01:00/02:15/02:45/03:00/
  // 08:00) son deliberadas: dos tareas pesadas en la misma franja compiten por
  // el mismo presupuesto de lecturas.
  it('escalona las tareas: ninguna comparte franja con otra de su cadencia', () => {
    const slots = Object.values(crons.crons).map((job) => slotOf(job.schedule))

    expect(new Set(slots).size).toBe(slots.length)
  })
})
