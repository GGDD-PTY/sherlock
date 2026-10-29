// ============================================================================
// CONVEX SCHEDULED FUNCTIONS (CRONS) - FREE!
// ============================================================================
// Funciones programadas que corren automáticamente.
//
// GRATIS en el free tier:
// - Ejecutar tareas periódicas
// - Limpiar datos antiguos
// - Mantener la base de datos limpia
//
// Configuración: Los crons se definen en convex/crons.ts y se despliegan
// automáticamente cuando haces `npx convex dev` o `npx convex deploy`
// ============================================================================

import { cronJobs } from 'convex/server'
import { Schema } from 'effect'

import { internal } from './_generated/api'

const purgeExpiredGrants = internal._documents.internals._purgeExpiredGrants
// Referencia tipada de _generated: si el archivo o el export se renombran,
// el typecheck (y con él CI/deploy) falla antes de desplegar, evitando que
// una referencia inválida llegue a producción y rompa el cron en runtime.
const purgeExpiredAdminVdrCapabilities = internal.adminVdrCapabilities._purgeExpired
// Antes esta era la excepción: `makeFunctionReference('intake:_reconcileArtifacts')`
// con un `as unknown as FunctionReference<…>` encima, o sea la única de las
// cuatro referencias que NO tenía la garantía que el comentario de arriba
// promete. Un renombre en `intake.ts` habría pasado el typecheck y roto el cron
// a las 10 de cada hora, en runtime.
const reconcileIntakeArtifacts = internal.intake._reconcileArtifacts

// ============================================================================
// DEFINICIÓN DE CRONS
// ============================================================================

const crons = cronJobs()

// ===== LIMPIEZA DIARIA =====
// Corre todos los días a las 3:00 AM UTC
crons.daily('cleanup-old-data', { hourUTC: 3, minuteUTC: 0 }, internal.cronHandlers.cleanupOldData)

// ===== VERIFICACIÓN DE EXPIRACIÓN KYC =====
// Corre todos los días a las 8:00 AM UTC
crons.daily(
  'check-kyc-expiration',
  { hourUTC: 8, minuteUTC: 0 },
  internal.cronHandlers.checkKYCExpiration
)

// ===== LIMPIEZA DE SESIONES EXPIRADAS =====
// Corre cada hora
crons.hourly(
  'cleanup-expired-sessions',
  { minuteUTC: 30 },
  internal.cronHandlers.cleanupExpiredSessions
)

// Bearers expire after 60 seconds. The worker is bounded and self-chains only
// while a backlog remains, so raw operational rows do not accumulate.
crons.interval(
  'purge-expired-admin-vdr-capabilities',
  { minutes: 5 },
  purgeExpiredAdminVdrCapabilities
)

// ===== EXPIRACIÓN DE DOCUMENTOS (Trust Feature) =====
// Corre cada hora para marcar documentos expirados
// Los documentos expirados no pueden ser descargados
crons.hourly('mark-expired-documents', { minuteUTC: 15 }, internal.documents._markExpiredDocuments)

// Closes unused upload authority, converts interrupted scanner leases into
// durable uncertainty, and quarantines stale uncertainty without enabling a
// second upload of the same bytes.
crons.hourly(
  'reconcile-vdr-upload-intents',
  { minuteUTC: 5 },
  internal.documents.expireIssuedUploadIntents,
  {}
)

// Removes only expired proof nonces and closes expired authority/intent leases.
// Retained intake rows and valid staged blobs are never calendar-purged.
crons.hourly('reconcile-intake-artifacts', { minuteUTC: 10 }, reconcileIntakeArtifacts, {})

crons.daily('purge-expired-document-grants', { hourUTC: 2, minuteUTC: 15 }, purgeExpiredGrants)

// ===== BACKFILL companyId EN documentAccessLogs =====
// Runner del backfill que antes dependía de un run manual desde el dashboard.
// La primera lectura es el guard (índice by_companyId_accessedAt con
// companyId=undefined): con el backlog en cero cuesta una lectura vacía al día.
// Idempotente y auto-encadenado por lotes — el primer disparo agota el backlog.
crons.daily(
  'backfill-access-log-company-id',
  { hourUTC: 2, minuteUTC: 45 },
  internal.documents._backfillAccessLogCompanyId
)

// ===== REPORTE DE PODA (DRY-RUN) =====
// Semanal, domingo 05:00 UTC, lejos del backup mensual del día 1. NO borra:
// escribe una fila `pruneReports` con candidatos y bytes por categoría, para
// llegar al primer cliente sabiendo cuánto storage habría que podar. El borrado
// real sigue siendo manual
// (`operatorPurge.deleteDocumentsHard`).
crons.weekly(
  'prune-dry-run',
  { dayOfWeek: 'sunday', hourUTC: 5, minuteUTC: 0 },
  internal.operatorPrune.pruneDryRun
)

// ============================================================================
// CATÁLOGO REAL DE TAREAS PROGRAMADAS
// ============================================================================
// Los diez identificadores de arriba, como `Schema.Literals` en vez de solo
// vivir sueltos dentro de cada llamada a `crons.*`. `Crons.crons`
// (`convex/server`) es el registro público que esas llamadas arman; `.literals`
// lo recorre después de que todas corrieron, así que un identificador que se
// renombra en una llamada sin renombrarse acá (o viceversa) queda anotado en
// cada cold start del isolate, no solo cuando alguien nota el diff. Convex ya
// lanza si dos llamadas registran el mismo identificador (`Crons.schedule`,
// `convex/server`), así que esto no reemplaza esa guarda: la complementa
// contra el catálogo declarado.
const CronJobNameSchema = Schema.Literals([
  'cleanup-old-data',
  'check-kyc-expiration',
  'cleanup-expired-sessions',
  'purge-expired-admin-vdr-capabilities',
  'mark-expired-documents',
  'reconcile-vdr-upload-intents',
  'reconcile-intake-artifacts',
  'purge-expired-document-grants',
  'backfill-access-log-company-id',
  'prune-dry-run',
])

const registeredCronNames = new Set(Object.keys(crons.crons))

for (const name of CronJobNameSchema.literals) {
  if (!registeredCronNames.has(name)) {
    console.error(`[convex/crons] "${name}" está en el catálogo pero no se registró`)
  }
}

if (registeredCronNames.size !== CronJobNameSchema.literals.length) {
  console.error('[convex/crons] hay una tarea registrada que no está en el catálogo')
}

export default crons
