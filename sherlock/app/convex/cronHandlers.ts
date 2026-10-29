// ============================================================================
// CRON HANDLERS - Funciones ejecutadas por los scheduled jobs
// ============================================================================
// Estas funciones son llamadas automáticamente por los crons definidos
// en convex/crons.ts. Son funciones "internas" que no se exponen al cliente.
//
// Todas las funciones aquí deben ser internalMutation
// para que puedan ser llamadas por el scheduler.
//
// NADIE MIRA UN CRON. Corren solos, de madrugada, sin un cliente esperando la
// respuesta, así que un fallo silencioso acá vive meses. Por eso cada corrida es
// un programa `Effect.fn` con nombre de span: el reparto de canales de
// `runConvex` deja el defecto con su `Cause` en los logs de Convex en vez de
// dejarlo morir como una promesa rechazada sin dueño.
// ============================================================================

import { Effect } from 'effect'

import { internalMutation, type MutationCtx } from './_generated/server'
import { convexPromise, runConvex } from './_helpers/effect'

// ============================================================================
// LIMPIEZA DE DATOS ANTIGUOS
// ============================================================================

// ============================================================================
// VENTANAS DE RETENCIÓN
// ============================================================================
// Estas ventanas son la implementación de lo que promete la política de
// privacidad publicada (src/app/[locale]/privacy/page.tsx). Si cambias una,
// cambia también la política — el compromiso publicado manda sobre el cron.
//
// Política: "Bitácoras de acceso a documentos (VDR) y registros de seguridad:
// 5 años, por su función probatoria."
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000

export const RETENTION_MS = {
  /** Notificaciones ya leídas: no son prueba de nada, se purgan pronto. */
  readNotifications: 30 * DAY_MS,
  /** Bitácoras de acceso al VDR: 5 años (función probatoria). */
  documentAccessLogs: 5 * 365 * DAY_MS,
  /** Registros de actividad/seguridad: 5 años (función probatoria). */
  activityLogs: 5 * 365 * DAY_MS,
  /**
   * Avisos al equipo: la tanda se cierra en minutos y su valor probatorio vive
   * en `activityLogs`. A los 90 días la fila solo guarda punteros a campanitas
   * que la purga de 30 días ya borró.
   */
  teamAlerts: 90 * DAY_MS,
  /**
   * Alertas de 5xx: misma ventana y mismo razonamiento que `teamAlerts`, con
   * un motivo extra de costo. El incidente dura 15 minutos y la fila es su
   * único registro mientras alguien lo mira; pasada la ventana, lo que queda
   * son punteros a campanitas que la purga de 30 días ya borró. Sin esta poda
   * una tormenta de 5xx deja filas para siempre — la tabla que la ventana
   * acota por ESCRITURA quedaba sin acotar por RETENCIÓN.
   */
  serverErrorAlerts: 90 * DAY_MS,
} as const

const cleanupOldDataProgram = Effect.fn('Cron.cleanupOldData')(function* (ctx: MutationCtx) {
  const now = Date.now()
  const thirtyDaysAgo = now - RETENTION_MS.readNotifications
  const accessLogCutoff = now - RETENTION_MS.documentAccessLogs
  const activityLogCutoff = now - RETENTION_MS.activityLogs

  let deletedCount = 0

  // ===== 1. LIMPIAR NOTIFICACIONES LEÍDAS ANTIGUAS =====
  // El `.filter(isRead && _creationTime<cutoff).take(100)` original no
  // pasaba por ningún índice: Convex evalúa el predicado fila por fila
  // sobre TODA la tabla y recién después recorta a 100 — el costo escala
  // con el tamaño de la tabla, no con el trabajo real (filas vencidas). El
  // corte SÍ es por `_creationTime`, así que el índice implícito
  // `by_creation_time` acota el escaneo al rango < cutoff antes de aplicar
  // el filtro adicional de `isRead`.
  const oldNotifications = yield* convexPromise(() =>
    ctx.db
      .query('notifications')
      .withIndex('by_creation_time', (q) => q.lt('_creationTime', thirtyDaysAgo))
      .filter((q) => q.eq(q.field('isRead'), true))
      .take(100)
  ) // Lote por corrida; la próxima corrida procesa el resto

  for (const notification of oldNotifications) {
    yield* convexPromise(() => ctx.db.delete(notification._id))
    deletedCount++
  }

  // ===== 2. LIMPIAR LOGS DE ACCESO ANTIGUOS =====
  const oldAccessLogs = yield* convexPromise(() =>
    ctx.db
      .query('documentAccessLogs')
      .withIndex('by_creation_time', (q) => q.lt('_creationTime', accessLogCutoff))
      .take(100)
  )

  for (const log of oldAccessLogs) {
    yield* convexPromise(() => ctx.db.delete(log._id))
    deletedCount++
  }

  // ===== 3. LIMPIAR ACTIVITY LOGS ANTIGUOS =====
  const oldActivityLogs = yield* convexPromise(() =>
    ctx.db
      .query('activityLogs')
      .withIndex('by_creation_time', (q) => q.lt('_creationTime', activityLogCutoff))
      .take(100)
  )

  for (const log of oldActivityLogs) {
    yield* convexPromise(() => ctx.db.delete(log._id))
    deletedCount++
  }

  // ===== 4. LIMPIAR AVISOS AL EQUIPO YA CERRADOS =====
  const oldTeamAlerts = yield* convexPromise(() =>
    ctx.db
      .query('teamAlerts')
      .withIndex('by_openedAt', (q) => q.lt('openedAt', now - RETENTION_MS.teamAlerts))
      .take(100)
  )

  for (const alert of oldTeamAlerts) {
    yield* convexPromise(() => ctx.db.delete(alert._id))
    deletedCount++
  }

  // ===== 5. LIMPIAR ALERTAS DE 5xx VENCIDAS =====
  // `by_openedAt` es el corte real: `openedAt` es cuándo se abrió el
  // incidente, no cuándo Convex escribió la fila.
  const oldServerErrorAlerts = yield* convexPromise(() =>
    ctx.db
      .query('serverErrorAlerts')
      .withIndex('by_openedAt', (q) => q.lt('openedAt', now - RETENTION_MS.serverErrorAlerts))
      .take(100)
  )

  for (const alert of oldServerErrorAlerts) {
    yield* convexPromise(() => ctx.db.delete(alert._id))
    deletedCount++
  }

  yield* Effect.log(`[CRON] cleanupOldData: Deleted ${deletedCount} old records`)

  return { deletedCount }
})

/**
 * Limpia datos antiguos de la base de datos según RETENTION_MS.
 * - Notificaciones leídas > 30 días
 * - Logs de acceso a documentos (VDR) > 5 años
 * - Activity logs > 5 años
 */
export const cleanupOldData = internalMutation({
  args: {},
  handler: (ctx) => runConvex(cleanupOldDataProgram(ctx)),
})

// ============================================================================
// VERIFICACIÓN DE EXPIRACIÓN KYC
// ============================================================================

/**
 * Techo del escaneo de candidatos VERIFIED-en-ventana para expiringKYC.
 *
 * Follow-up W6a-bis (verificador adversarial de #216): `profiles` solo tiene
 * `by_kycStatus` — no existe (ni se puede agregar aquí; requeriría tocar
 * schema.ts) un índice compuesto por fecha de expiración. Sin él, el orden
 * natural del índice es por `_creationTime` (desempate implícito), así que
 * un `.take(100)` directo sobre ese orden SIEMPRE se queda con los 100
 * perfiles VERIFIED-en-ventana con la cuenta MÁS VIEJA — sin importar qué
 * tan cerca estén de vencer los perfiles 101+. Con más de 100 candidatos en
 * la ventana, una cuenta creada después pero a un día de que le expire el
 * KYC podía no recibir aviso nunca.
 *
 * Fix sin schema: se escanea hasta este techo (bounded, con el mismo
 * centinela `cap+1` que `STATS_FALLBACK_SCAN_CAP` usa más abajo para
 * declarar honestamente si el universo excede lo visto) y, DENTRO de ese
 * lote, se reordena por urgencia real (`kycExpiresAt` ascendente) antes de
 * recortar al cupo de notificaciones de la corrida — ver
 * `KYC_EXPIRING_SOON_NOTIFY_CAP`. Esto no agrega índice ni campo nuevo: usa
 * `by_kycStatus`, que ya existe, y solo cambia cuánto se lee y en qué orden
 * se prioriza para notificar.
 */
const KYC_EXPIRING_SOON_SCAN_CAP = 1000

/** Cupo de notificaciones por corrida — paridad con el `.take(100)` que reemplaza. */
const KYC_EXPIRING_SOON_NOTIFY_CAP = 100

const checkKYCExpirationProgram = Effect.fn('Cron.checkKYCExpiration')(function* (
  ctx: MutationCtx
) {
  const now = Date.now()
  const thirtyDaysFromNow = now + 30 * 24 * 60 * 60 * 1000

  // ===== BUSCAR KYC EXPIRADO =====
  // `.filter(kycStatus==='VERIFIED' && kycExpiresAt<now).collect()` SIN
  // índice y SIN cota escaneaba TODA la tabla `profiles` — todos los roles
  // y estados de KYC — y traía el resultado completo a memoria. `profiles`
  // ya tiene `by_kycStatus`: se usa para saltar directo a los perfiles
  // VERIFIED antes de filtrar por fecha, y se acota con `.take(100)` (lote
  // por corrida; la próxima corrida procesa el resto).
  const expiredKYC = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_kycStatus', (q) => q.eq('kycStatus', 'VERIFIED'))
      .filter((q) => q.lt(q.field('kycExpiresAt'), now))
      .take(100)
  )

  // Marcar como expirado
  for (const profile of expiredKYC) {
    yield* convexPromise(() =>
      ctx.db.patch(profile._id, {
        kycStatus: 'EXPIRED',
      })
    )

    // Crear notificación
    yield* convexPromise(() =>
      ctx.db.insert('notifications', {
        userId: profile._id,
        type: 'system',
        title: 'KYC Expirado',
        message: 'Tu verificación KYC ha expirado. Por favor renuévala para continuar operando.',
        isRead: false,
      })
    )
  }

  // ===== BUSCAR KYC PRÓXIMO A EXPIRAR =====
  // Mismo índice `by_kycStatus` que expiredKYC arriba, pero con techo mayor
  // y reordenado por urgencia real — ver KYC_EXPIRING_SOON_SCAN_CAP arriba.
  const expiringKYCCandidates = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_kycStatus', (q) => q.eq('kycStatus', 'VERIFIED'))
      .filter((q) =>
        q.and(q.gt(q.field('kycExpiresAt'), now), q.lt(q.field('kycExpiresAt'), thirtyDaysFromNow))
      )
      .take(KYC_EXPIRING_SOON_SCAN_CAP + 1)
  )

  // Honestidad del techo: si es true, hay más perfiles VERIFIED venciendo
  // en los próximos 30 días que los que esta corrida pudo ver. No se
  // pierden — la próxima corrida los vuelve a evaluar por urgencia igual
  // que hoy — pero esta corrida no cubrió el 100% del universo.
  const expiringKYCScanTruncated = expiringKYCCandidates.length > KYC_EXPIRING_SOON_SCAN_CAP
  const expiringKYC = expiringKYCCandidates
    .slice(0, KYC_EXPIRING_SOON_SCAN_CAP)
    // Urgencia real, no antigüedad de cuenta: sin este sort, `_creationTime`
    // (el orden natural de `by_kycStatus`) siempre gana el cupo de abajo,
    // aunque venza después que perfiles con cuenta más nueva.
    // `?? Infinity`: sin fecha de expiración van al final — no consumen el
    // cupo de notificación (el loop de abajo los saltaría de todas formas).
    .sort((a, b) => (a.kycExpiresAt ?? Infinity) - (b.kycExpiresAt ?? Infinity))
    .slice(0, KYC_EXPIRING_SOON_NOTIFY_CAP)

  // Crear notificaciones de advertencia
  for (const profile of expiringKYC) {
    // Verificar si ya enviamos notificación reciente.
    //
    // El lookup anterior era `.filter(userId && type === 'system').first()`
    // SIN índice: Convex evalúa el predicado fila por fila sobre TODA la
    // tabla `notifications` y, en el peor caso (perfil sin aviso reciente),
    // la recorre completa — hasta 100 veces por corrida, una por perfil.
    // `notifications` ya tiene `by_userId_type`, que calza exacto con los
    // dos campos del predicado: se salta directo a las notificaciones
    // system de ESTE perfil y el filtro por `_creationTime` corre solo
    // sobre ese subconjunto.
    const existingNotification = yield* convexPromise(() =>
      ctx.db
        .query('notifications')
        .withIndex('by_userId_type', (q) => q.eq('userId', profile._id).eq('type', 'system'))
        .filter((q) => q.gt(q.field('_creationTime'), now - 7 * 24 * 60 * 60 * 1000))
        .first()
    )

    if (!existingNotification) {
      // Seguridad: Verificar que la fecha de expiración existe antes de calcular
      // Evita errores si kycExpiresAt es undefined a pesar de los filtros anteriores
      if (profile.kycExpiresAt === undefined) {
        yield* Effect.logWarning(`[CRON] Profile ${profile._id} marked as VERIFIED but has no kycExpiresAt`)
        continue
      }

      const daysRemaining = Math.ceil((profile.kycExpiresAt - now) / (24 * 60 * 60 * 1000))

      yield* convexPromise(() =>
        ctx.db.insert('notifications', {
          userId: profile._id,
          type: 'system',
          title: 'KYC Próximo a Expirar',
          message: `Tu verificación KYC expira en ${daysRemaining} días. Renuévala para evitar interrupciones.`,
          isRead: false,
        })
      )
    }
  }

  yield* Effect.log(
    `[CRON] checkKYCExpiration: ${expiredKYC.length} expired, ${expiringKYC.length} expiring soon` +
      (expiringKYCScanTruncated
        ? ` (techo de escaneo alcanzado — hay más candidatos VERIFIED-en-ventana que los vistos)`
        : '')
  )

  return {
    expired: expiredKYC.length,
    expiringSoon: expiringKYC.length,
    // true si el universo VERIFIED-en-ventana excede KYC_EXPIRING_SOON_SCAN_CAP
    // — ver comentario en la constante. false/no-partial en el caso normal.
    expiringSoonScanTruncated: expiringKYCScanTruncated,
  }
})

/**
 * Verifica perfiles con KYC próximo a expirar o expirado
 * Crea notificaciones para que renueven
 */
export const checkKYCExpiration = internalMutation({
  args: {},
  handler: (ctx) => runConvex(checkKYCExpirationProgram(ctx)),
})

// ============================================================================
// LIMPIEZA DE SESIONES EXPIRADAS
// ============================================================================

/** Contadores de rate limit sin actividad reciente; la ventana más larga en uso es de 1 hora. */
const STALE_RATE_LIMIT_MS = 7 * DAY_MS

/**
 * Margen para el pre-filtro por `_creationTime`: `enforceRateLimit` evalúa
 * `lastHitAt: Date.now()` ANTES de que Convex asigne `_creationTime` al
 * commit, así que `lastHitAt` puede quedar unos ms por debajo de
 * `_creationTime`. Sin margen, una fila justo en el borde del cutoff podría
 * quedar fuera del pre-filtro aunque `lastHitAt < staleCutoff` sea true.
 * 60s cubre ese sesgo de sobra y mantiene la propiedad de superset.
 */
const CREATION_TIME_MARGIN_MS = 60 * 1000

const cleanupExpiredSessionsProgram = Effect.fn('Cron.cleanupExpiredSessions')(function* (
  ctx: MutationCtx
) {
  const staleCutoff = Date.now() - STALE_RATE_LIMIT_MS

  // El corte real es por `lastHitAt`, campo sin índice propio (`rateLimits`
  // solo tiene `by_key`) — no se agrega uno nuevo por regla del repo. Pero
  // `lastHitAt` casi nunca es anterior a `_creationTime`: enforceRateLimit
  // (_helpers/rateLimit.ts) fija `lastHitAt: now` tanto al insertar como en
  // cada patch posterior (con un sesgo de unos ms al insertar, porque
  // `Date.now()` corre antes de que Convex asigne `_creationTime` al
  // commit — de ahí CREATION_TIME_MARGIN_MS). Eso hace seguro usar el
  // índice implícito `by_creation_time` como PRE-FILTRO (superset — nunca
  // excluye un positivo real): las filas creadas después del cutoff (más
  // margen) ni se tocan, y el filtro exacto de `lastHitAt` corre solo
  // sobre lo que sí puede calificar.
  const staleRateLimits = yield* convexPromise(() =>
    ctx.db
      .query('rateLimits')
      .withIndex('by_creation_time', (q) =>
        q.lt('_creationTime', staleCutoff + CREATION_TIME_MARGIN_MS)
      )
      .filter((q) => q.lt(q.field('lastHitAt'), staleCutoff))
      .take(100)
  )

  for (const rateLimit of staleRateLimits) {
    yield* convexPromise(() => ctx.db.delete(rateLimit._id))
  }

  yield* Effect.log(
    `[CRON] cleanupExpiredSessions: Cleaned ${staleRateLimits.length} stale rate-limit counters`
  )

  return { cleaned: staleRateLimits.length }
})

/**
 * Limpia datos temporales: contadores de rate limit ya vencidos.
 *
 * NO toca `deletionRequests`. Las solicitudes de borrado completadas se
 * conservan como prueba de que el titular ejerció su derecho — `gdpr.ts`
 * redacta el email (PII) y deja la fila en pie a propósito. Borrarlas aquí
 * destruía justo la evidencia que esa redacción preserva.
 */
export const cleanupExpiredSessions = internalMutation({
  args: {},
  handler: (ctx) => runConvex(cleanupExpiredSessionsProgram(ctx)),
})
