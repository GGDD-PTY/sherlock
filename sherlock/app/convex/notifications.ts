// ============================================================================
// Sherlock - NOTIFICATION FUNCTIONS
// ============================================================================
// Funciones para manejar notificaciones en tiempo real.
// Convex proporciona suscripciones reactivas automáticamente.
//
// SEGURIDAD:
// - Las mutations de usuario (markAsRead, etc.) verifican ownership.
//
// LAS SEIS BANDERAS SE ESCRIBEN UNA VEZ. `updatePreferences` y
// `cleanupDuplicatePreferences` traían el mismo bloque de seis `if` copiado
// entero para consolidar filas duplicadas: doce condiciones que decían lo mismo
// y que había que acordarse de tocar en los dos lados. `PREFERENCE_FLAGS` es esa
// lista como dato y `mergePreferenceFlags` la recorre una sola vez.
// ============================================================================

import { v } from 'convex/values'
import { Effect, Schema } from 'effect'

import type { Doc, Id } from './_generated/dataModel'
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import {
  requireAuth,
  requireAuthAdmin,
  requireOwnership,
  type AuthResult,
} from './_helpers/auth'
import { evaluateCompanyManagementAuthorization } from './_helpers/companyAuthorization'
import { isDevAuthBypassedViaEnv } from './_helpers/auth.dev'
import { logAdminAction } from './_helpers/auditLog'
import { convexPromise, convexSync, runConvex } from './_helpers/effect'
import { clampLimit } from './_helpers/limits'
import { unauthorized, validationFailed } from './_helpers/errors'
import { omitUnauthorizedDeliverableRows } from './_notifications/deliverableVisibility'
import {
  attachCompanyToIntakeAlert,
  dispatchTeamAlertEmail,
  recordCompanyWorkspaceCreated,
  recordIntakeUpload,
  recordVdrUpload,
} from './_notifications/teamAlerts'
import { dispatchSupportMessageEmail } from './_support/teamEmail'
import { recordEmailFailure } from './_notifications/emailEvents'
import { recordServerError } from './_notifications/serverErrorAlerts'
import { vOnEmailEventArgs } from '@convex-dev/resend'

// ============================================================================
// AVISOS AL EQUIPO (internos, no direccionables desde el cliente)
// ============================================================================
// Los tres disparadores de producto (subida en la sala, subida de intake, alta
// del espacio) calendarizan estas mutaciones en vez de llamar al módulo en
// línea. Ese salto ES el fail-open: el aviso escribe una fila `teamAlerts`
// compartida por toda la empresa, y ese conflicto de escritura lo resuelve
// Convex al hacer commit — fuera del alcance de cualquier try/catch. Inline, un
// pico de subidas concurrentes le costaría al cliente su documento.

const recordVdrUploadProgram = Effect.fn('Notifications.recordVdrUpload')(function* (
  ctx: MutationCtx,
  args: Parameters<typeof recordVdrUpload>[1]
) {
  yield* convexPromise(() => recordVdrUpload(ctx, args))
})

export const _recordVdrUpload = internalMutation({
  args: {
    companyId: v.id('companies'),
    fileName: v.string(),
    folder: v.optional(v.string()),
  },
  handler: (ctx, args) => runConvex(recordVdrUploadProgram(ctx, args)),
})

const recordIntakeUploadProgram = Effect.fn('Notifications.recordIntakeUpload')(function* (
  ctx: MutationCtx,
  args: Parameters<typeof recordIntakeUpload>[1]
) {
  yield* convexPromise(() => recordIntakeUpload(ctx, args))
})

export const _recordIntakeUpload = internalMutation({
  args: {
    intakeSessionId: v.id('intakeSessions'),
    fileName: v.string(),
  },
  handler: (ctx, args) => runConvex(recordIntakeUploadProgram(ctx, args)),
})

const attachCompanyToIntakeAlertProgram = Effect.fn('Notifications.attachCompanyToIntakeAlert')(
  function* (ctx: MutationCtx, args: Parameters<typeof attachCompanyToIntakeAlert>[1]) {
    yield* convexPromise(() => attachCompanyToIntakeAlert(ctx, args))
  }
)

/**
 * El claim le puso empresa a una sesión que empezó anónima: el aviso de esa
 * tanda deja de apuntar al listado de empresas y apunta a la sala real.
 */
export const _attachCompanyToIntakeAlert = internalMutation({
  args: {
    intakeSessionId: v.id('intakeSessions'),
    companyId: v.id('companies'),
  },
  handler: (ctx, args) => runConvex(attachCompanyToIntakeAlertProgram(ctx, args)),
})

const recordCompanyWorkspaceCreatedProgram = Effect.fn(
  'Notifications.recordCompanyWorkspaceCreated'
)(function* (ctx: MutationCtx, args: Parameters<typeof recordCompanyWorkspaceCreated>[1]) {
  yield* convexPromise(() => recordCompanyWorkspaceCreated(ctx, args))
})

export const _recordCompanyWorkspaceCreated = internalMutation({
  args: { companyId: v.id('companies') },
  handler: (ctx, args) => runConvex(recordCompanyWorkspaceCreatedProgram(ctx, args)),
})

const dispatchTeamAlertEmailProgram = Effect.fn('Notifications.dispatchTeamAlertEmail')(function* (
  ctx: MutationCtx,
  args: Parameters<typeof dispatchTeamAlertEmail>[1]
) {
  yield* convexPromise(() => dispatchTeamAlertEmail(ctx, args))
})

/**
 * Envío diferido del aviso. Lo calendariza `_notifications/teamAlerts` con
 * debounce, para que una tanda de subidas mande un solo correo.
 */
export const _dispatchTeamAlertEmail = internalMutation({
  args: { alertId: v.id('teamAlerts') },
  handler: (ctx, args) => runConvex(dispatchTeamAlertEmailProgram(ctx, args)),
})

const dispatchSupportMessageEmailProgram = Effect.fn('Notifications.dispatchSupportMessageEmail')(
  function* (ctx: MutationCtx, args: Parameters<typeof dispatchSupportMessageEmail>[1]) {
    yield* convexPromise(() => dispatchSupportMessageEmail(ctx, args))
  }
)

/**
 * El aviso del hilo de soporte, diferido. Lo calendariza `convex/support.ts`
 * con debounce, para que una ráfaga de mensajes del cliente mande un solo
 * correo, y corre acá —fuera de la transacción del cliente— igual que el aviso
 * de las subidas.
 */
export const _dispatchSupportMessageEmail = internalMutation({
  args: { threadId: v.id('supportThreads') },
  handler: (ctx, args) => runConvex(dispatchSupportMessageEmailProgram(ctx, args)),
})

const recordServerErrorProgram = Effect.fn('Notifications.recordServerError')(function* (
  ctx: MutationCtx,
  args: Parameters<typeof recordServerError>[1]
) {
  yield* convexPromise(() => recordServerError(ctx, args))
})

/**
 * Un 5xx del servidor Next. Lo llama `src/lib/observability/server-error-alert`
 * con el cliente admin (mismo carril que el webhook de WorkOS) y con el payload
 * YA redactado: plantilla de ruta, método, status, nombre del error y 200
 * caracteres de mensaje. Nunca headers, cookies, cuerpo, stack ni PII.
 */
export const _recordServerError = internalMutation({
  args: {
    route: v.string(),
    errorName: v.string(),
    status: v.number(),
    message: v.string(),
    requestId: v.string(),
    method: v.optional(v.string()),
    synthetic: v.optional(v.boolean()),
    repeats: v.optional(v.number()),
    digest: v.optional(v.string()),
  },
  handler: (ctx, args) => runConvex(recordServerErrorProgram(ctx, args)),
})

const recordEmailFailureProgram = Effect.fn('Notifications.recordEmailFailure')(function* (
  ctx: MutationCtx,
  args: Parameters<typeof recordEmailFailure>[1]
) {
  yield* convexPromise(() => recordEmailFailure(ctx, args))
})

/**
 * Callback del componente de Resend por cada evento firmado que entra por
 * `convex/http.ts`. Sólo rebotes, quejas y fallos se vuelven campanita.
 */
export const _recordEmailFailure = internalMutation({
  args: vOnEmailEventArgs,
  handler: (ctx, args) => runConvex(recordEmailFailureProgram(ctx, args)),
})

// ============================================================================
// QUERIES
// ============================================================================

const NOTIFICATIONS_PAGE = { fallback: 20, max: 100 } as const

// La fila document_shared puede traer, en avisos ya guardados, la nota del
// equipo y el nombre del documento. Si la empresa del perfil no autoriza,
// esas filas no salen. Sin filas de ese tipo no se lee la empresa.
const withoutRevokedDeliverableRows = Effect.fn('Notifications.withoutRevokedDeliverables')(
  function* (ctx: QueryCtx, auth: AuthResult, rows: Doc<'notifications'>[]) {
    if (!rows.some((row) => row.type === 'document_shared')) return rows

    const company = yield* convexPromise(() =>
      ctx.db
        .query('companies')
        .withIndex('by_ownerId', (q) => q.eq('ownerId', auth.profile._id))
        .unique()
    )
    if (!company) return rows

    const decision = yield* convexPromise(() =>
      evaluateCompanyManagementAuthorization(ctx, auth, company)
    )
    return yield* omitUnauthorizedDeliverableRows(rows, decision)
  }
)

const getNotificationsProgram = Effect.fn('Notifications.getNotifications')(function* (
  ctx: QueryCtx,
  args: { userId: Id<'profiles'>; limit?: number; unreadOnly?: boolean }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  yield* convexSync(() =>
    requireOwnership(auth.profile, args.userId, 'No tienes permiso para ver estas notificaciones')
  )

  const limit = clampLimit(args.limit, NOTIFICATIONS_PAGE)

  const rows = args.unreadOnly
    ? yield* convexPromise(() =>
        ctx.db
          .query('notifications')
          .withIndex('by_userId_unread', (q) => q.eq('userId', args.userId).eq('isRead', false))
          .order('desc')
          .take(limit)
      )
    : yield* convexPromise(() =>
        ctx.db
          .query('notifications')
          .withIndex('by_userId', (q) => q.eq('userId', args.userId))
          .order('desc')
          .take(limit)
      )

  return yield* withoutRevokedDeliverableRows(ctx, auth, rows)
})

/**
 * Obtener notificaciones del usuario (suscripción en tiempo real)
 */
export const getNotifications = query({
  args: {
    userId: v.id('profiles'),
    limit: v.optional(v.number()),
    unreadOnly: v.optional(v.boolean()),
  },
  handler: (ctx, args) => runConvex(getNotificationsProgram(ctx, args)),
})

const getUnreadCountProgram = Effect.fn('Notifications.getUnreadCount')(function* (
  ctx: QueryCtx,
  args: { userId: Id<'profiles'> }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  yield* convexSync(() =>
    requireOwnership(auth.profile, args.userId, 'No tienes permiso para ver estas notificaciones')
  )

  // Exacto a propósito: `useNotifications` dispara el toast de aviso nuevo
  // cuando este número sube, y la página lo muestra como total. Un tope lo
  // congelaría en cuanto lo alcanza. El rango va por índice y solo lee las no
  // leídas de este perfil. Las de entrega que el evaluador niega no cuentan.
  const unread = yield* convexPromise(() =>
    ctx.db
      .query('notifications')
      .withIndex('by_userId_unread', (q) => q.eq('userId', args.userId).eq('isRead', false))
      .collect()
  )
  const visible = yield* withoutRevokedDeliverableRows(ctx, auth, unread)

  return visible.length
})

/**
 * Contar notificaciones no leídas
 */
export const getUnreadCount = query({
  args: { userId: v.id('profiles') },
  handler: (ctx, args) => runConvex(getUnreadCountProgram(ctx, args)),
})

// ============================================================================
// MUTATIONS (PUBLIC - Con autenticación)
// ============================================================================

const markAsReadProgram = Effect.fn('Notifications.markAsRead')(function* (
  ctx: MutationCtx,
  args: { notificationId: Id<'notifications'> }
) {
  // ===== AUTH: Verificar autenticación =====
  const { profile } = yield* convexPromise(() => requireAuth(ctx))

  // Verificar que la notificación existe
  // Colapsa el oráculo de existencia: mismo 403 exista o no la notificación.
  const notification = yield* convexPromise(() => ctx.db.get(args.notificationId))
  if (!notification) {
    return yield* Effect.fail(
      unauthorized('No autorizado: Solo puedes marcar tus propias notificaciones como leídas')
    )
  }

  // ===== AUTORIZACIÓN: Solo el dueño o admin pueden marcar como leída =====
  yield* convexSync(() =>
    requireOwnership(
      profile,
      notification.userId,
      'No autorizado: Solo puedes marcar tus propias notificaciones como leídas'
    )
  )

  yield* convexPromise(() => ctx.db.patch(args.notificationId, { isRead: true }))
  return true
})

/**
 * Marcar una notificación como leída
 * SEGURIDAD: Solo el dueño de la notificación puede marcarla como leída
 */
export const markAsRead = mutation({
  args: { notificationId: v.id('notifications') },
  handler: (ctx, args) => runConvex(markAsReadProgram(ctx, args)),
})

const markAllAsReadProgram = Effect.fn('Notifications.markAllAsRead')(function* (ctx: MutationCtx) {
  // ===== AUTH: Verificar autenticación =====
  const { profile } = yield* convexPromise(() => requireAuth(ctx))

  // Usar el profile ID del usuario autenticado (no confiar en parámetros)
  const unread = yield* convexPromise(() =>
    ctx.db
      .query('notifications')
      .withIndex('by_userId_unread', (q) => q.eq('userId', profile._id).eq('isRead', false))
      .collect()
  )

  for (const notification of unread) {
    yield* convexPromise(() => ctx.db.patch(notification._id, { isRead: true }))
  }

  return unread.length
})

/**
 * Marcar todas las notificaciones del usuario como leídas
 * SEGURIDAD: Solo marca las notificaciones del usuario autenticado
 */
export const markAllAsRead = mutation({
  args: {},
  handler: (ctx) => runConvex(markAllAsReadProgram(ctx)),
})

const deleteNotificationProgram = Effect.fn('Notifications.deleteNotification')(function* (
  ctx: MutationCtx,
  args: { notificationId: Id<'notifications'> }
) {
  const { profile } = yield* convexPromise(() => requireAuth(ctx))

  // Colapsa el oráculo de existencia: mismo 403 exista o no la notificación.
  const notification = yield* convexPromise(() => ctx.db.get(args.notificationId))
  if (!notification) {
    return yield* Effect.fail(unauthorized('No tienes permiso para eliminar esta notificación'))
  }

  yield* convexSync(() =>
    requireOwnership(
      profile,
      notification.userId,
      'No tienes permiso para eliminar esta notificación'
    )
  )

  yield* convexPromise(() => ctx.db.delete(args.notificationId))
  return true
})

/**
 * Eliminar una notificación
 */
export const deleteNotification = mutation({
  args: { notificationId: v.id('notifications') },
  handler: (ctx, args) => runConvex(deleteNotificationProgram(ctx, args)),
})

const deleteReadNotificationsProgram = Effect.fn('Notifications.deleteReadNotifications')(
  function* (ctx: MutationCtx) {
    // ===== AUTH: Verificar autenticación =====
    const { profile } = yield* convexPromise(() => requireAuth(ctx))

    // Usar el profile ID del usuario autenticado (no confiar en parámetros)
    const read = yield* convexPromise(() =>
      ctx.db
        .query('notifications')
        .withIndex('by_userId_unread', (q) => q.eq('userId', profile._id).eq('isRead', true))
        .collect()
    )

    for (const notification of read) {
      yield* convexPromise(() => ctx.db.delete(notification._id))
    }

    return read.length
  }
)

/**
 * Eliminar todas las notificaciones leídas del usuario (cleanup)
 * SEGURIDAD: Solo elimina las notificaciones del usuario autenticado
 */
export const deleteReadNotifications = mutation({
  args: {},
  handler: (ctx) => runConvex(deleteReadNotificationsProgram(ctx)),
})

// ============================================================================
// PREFERENCIAS DE NOTIFICACIONES
// ============================================================================

/** Las seis banderas, como dato. Es la lista que recorre la consolidación. */
const PREFERENCE_FLAGS = [
  'emailNewConnection',
  'emailNewMessage',
  'emailRoomUpdates',
  'emailWeeklyDigest',
  'emailAnalysisComplete',
  'pushEnabled',
] as const

export const PreferenceFlagSchema = Schema.Literals(PREFERENCE_FLAGS)
type PreferenceFlag = typeof PreferenceFlagSchema.Type

/** Lo que ve un usuario que nunca tocó sus preferencias. */
const PREFERENCE_DEFAULTS: Readonly<Record<PreferenceFlag, boolean>> = {
  emailNewConnection: true,
  emailNewMessage: true,
  emailRoomUpdates: true,
  emailWeeklyDigest: false,
  emailAnalysisComplete: true,
  pushEnabled: true,
}

/**
 * El valor más reciente de cada bandera entre filas duplicadas. `sorted` viene
 * de más reciente a más viejo, así que la primera fila que define una bandera
 * gana y las demás ya no la pisan.
 */
function mergePreferenceFlags(
  sorted: readonly Doc<'notificationPreferences'>[]
): Record<string, boolean> {
  const merged: Record<string, boolean> = {}
  for (const pref of sorted) {
    for (const flag of PREFERENCE_FLAGS) {
      const value = pref[flag]
      if (value !== undefined && merged[flag] === undefined) {
        merged[flag] = value
      }
    }
  }
  return merged
}

/** Más reciente primero: el orden que asume `mergePreferenceFlags`. */
function newestFirst(
  preferences: Doc<'notificationPreferences'>[]
): Doc<'notificationPreferences'>[] {
  return preferences.sort((a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0))
}

const getPreferencesProgram = Effect.fn('Notifications.getPreferences')(function* (
  ctx: QueryCtx,
  args: { userId: Id<'profiles'> }
) {
  const { profile } = yield* convexPromise(() => requireAuth(ctx))
  yield* convexSync(() =>
    requireOwnership(profile, args.userId, 'No tienes permiso para consultar estas preferencias')
  )

  const prefs = yield* convexPromise(() =>
    ctx.db
      .query('notificationPreferences')
      .withIndex('by_userId', (q) => q.eq('userId', args.userId))
      .first()
  )

  // Retornar preferencias o defaults
  return {
    emailNewConnection: prefs?.emailNewConnection ?? PREFERENCE_DEFAULTS.emailNewConnection,
    emailNewMessage: prefs?.emailNewMessage ?? PREFERENCE_DEFAULTS.emailNewMessage,
    emailRoomUpdates: prefs?.emailRoomUpdates ?? PREFERENCE_DEFAULTS.emailRoomUpdates,
    emailWeeklyDigest: prefs?.emailWeeklyDigest ?? PREFERENCE_DEFAULTS.emailWeeklyDigest,
    emailAnalysisComplete:
      prefs?.emailAnalysisComplete ?? PREFERENCE_DEFAULTS.emailAnalysisComplete,
    pushEnabled: prefs?.pushEnabled ?? PREFERENCE_DEFAULTS.pushEnabled,
  }
})

/**
 * Obtener preferencias de notificación del usuario
 * Retorna defaults si no existen aún
 */
export const getPreferences = query({
  args: { userId: v.id('profiles') },
  handler: (ctx, args) => runConvex(getPreferencesProgram(ctx, args)),
})

const updatePreferencesProgram = Effect.fn('Notifications.updatePreferences')(function* (
  ctx: MutationCtx,
  args: {
    userId: Id<'profiles'>
    emailNewConnection?: boolean
    emailNewMessage?: boolean
    emailRoomUpdates?: boolean
    emailWeeklyDigest?: boolean
    emailAnalysisComplete?: boolean
    pushEnabled?: boolean
  }
) {
  const { profile, user } = yield* convexPromise(() => requireAuth(ctx))
  yield* convexSync(() =>
    requireOwnership(profile, args.userId, 'No tienes permiso para actualizar estas preferencias')
  )

  const { userId, ...updates } = args
  const preferenceId = yield* savePreferencesEffect(ctx, userId, updates)

  // Un admin que toca las preferencias de otro perfil deja rastro.
  if (profile.role === 'ADMIN' && profile._id !== userId) {
    yield* convexPromise(() =>
      logAdminAction({
        ctx,
        adminProfileId: profile._id,
        adminEmail: user.email,
        action: 'NOTIFICATION_PREFERENCES_UPDATE',
        targetType: 'PROFILE',
        targetId: userId,
        newValue: updates,
      })
    )
  }

  return preferenceId
})

/**
 * Upsert con manejo de duplicados: Convex no tiene unicidad en el schema y dos
 * requests concurrentes pueden dejar dos filas para el mismo perfil.
 */
const savePreferencesEffect = Effect.fn('Notifications.savePreferences')(function* (
  ctx: MutationCtx,
  userId: Id<'profiles'>,
  updates: Partial<typeof PREFERENCE_DEFAULTS>
) {
  // Buscar TODAS las preferencias existentes para este usuario
  // (puede haber duplicados bajo requests concurrentes)
  const allPreferences = yield* convexPromise(() =>
    ctx.db
      .query('notificationPreferences')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .collect()
  )

  if (allPreferences.length === 0) {
    // No hay preferencias existentes, crear nuevo registro
    return yield* convexPromise(() =>
      ctx.db.insert('notificationPreferences', {
        userId,
        emailNewConnection: updates.emailNewConnection ?? PREFERENCE_DEFAULTS.emailNewConnection,
        emailNewMessage: updates.emailNewMessage ?? PREFERENCE_DEFAULTS.emailNewMessage,
        emailRoomUpdates: updates.emailRoomUpdates ?? PREFERENCE_DEFAULTS.emailRoomUpdates,
        emailWeeklyDigest: updates.emailWeeklyDigest ?? PREFERENCE_DEFAULTS.emailWeeklyDigest,
        emailAnalysisComplete:
          updates.emailAnalysisComplete ?? PREFERENCE_DEFAULTS.emailAnalysisComplete,
        pushEnabled: updates.pushEnabled ?? PREFERENCE_DEFAULTS.pushEnabled,
      })
    )
  }

  if (allPreferences.length === 1) {
    // Caso normal: una sola preferencia, actualizar
    const existing = allPreferences[0]
    yield* convexPromise(() => ctx.db.patch(existing._id, updates))
    return existing._id
  }

  // Caso de duplicados: consolidar y limpiar
  // Ordenar por _creationTime (más reciente primero)
  const sorted = newestFirst(allPreferences)

  // Usar el registro más reciente como base
  const primary = sorted[0]

  // Mergear valores: preferir los valores más recientes de cada registro
  // Si un campo está undefined en el más reciente, buscar en los otros
  // Aplicar los updates nuevos (tienen prioridad sobre los valores existentes)
  const finalUpdates = { ...mergePreferenceFlags(sorted), ...updates }

  // Actualizar el registro primario
  yield* convexPromise(() => ctx.db.patch(primary._id, finalUpdates))

  // Eliminar los duplicados
  for (let i = 1; i < sorted.length; i++) {
    yield* convexPromise(() => ctx.db.delete(sorted[i]._id))
  }

  return primary._id
})

/**
 * Actualizar preferencias de notificación
 * Crea el registro si no existe (upsert)
 *
 * NOTA: Convex no soporta constraints de unicidad en el schema.
 * Este handler incluye lógica defensiva para manejar duplicados
 * que pueden ocurrir bajo requests concurrentes.
 */
export const updatePreferences = mutation({
  args: {
    userId: v.id('profiles'),
    emailNewConnection: v.optional(v.boolean()),
    emailNewMessage: v.optional(v.boolean()),
    emailRoomUpdates: v.optional(v.boolean()),
    emailWeeklyDigest: v.optional(v.boolean()),
    emailAnalysisComplete: v.optional(v.boolean()),
    pushEnabled: v.optional(v.boolean()),
  },
  handler: (ctx, args) => runConvex(updatePreferencesProgram(ctx, args)),
})

const cleanupDuplicatePreferencesProgram = Effect.fn('Notifications.cleanupDuplicatePreferences')(
  function* (ctx: MutationCtx) {
    // ===== AUTENTICACIÓN Y AUTORIZACIÓN =====
    const { profile, user } = yield* convexPromise(() => requireAuthAdmin(ctx))

    // ===== LIMPIEZA DE DUPLICADOS =====
    // Obtener todas las preferencias
    const allPreferences = yield* convexPromise(() =>
      ctx.db.query('notificationPreferences').collect()
    )

    // Agrupar por userId
    const preferencesByUser = new Map<string, typeof allPreferences>()
    for (const pref of allPreferences) {
      // Convertir Id a string para usar como clave del Map
      const userIdStr = pref.userId as string
      if (!preferencesByUser.has(userIdStr)) {
        preferencesByUser.set(userIdStr, [])
      }
      preferencesByUser.get(userIdStr)!.push(pref)
    }

    let cleanedCount = 0
    let deletedCount = 0

    // Para cada usuario con múltiples preferencias, consolidar
    for (const [, prefs] of preferencesByUser.entries()) {
      if (prefs.length > 1) {
        // Ordenar por _creationTime (más reciente primero)
        const sorted = newestFirst(prefs)

        const primary = sorted[0]

        // Mergear valores: tomar el más reciente de cada campo
        yield* convexPromise(() => ctx.db.patch(primary._id, mergePreferenceFlags(sorted)))
        cleanedCount++

        // Eliminar duplicados
        for (let i = 1; i < sorted.length; i++) {
          yield* convexPromise(() => ctx.db.delete(sorted[i]._id))
          deletedCount++
        }
      }
    }

    yield* convexPromise(() =>
      logAdminAction({
        ctx,
        adminProfileId: profile._id,
        adminEmail: user.email,
        action: 'NOTIFICATION_PREFERENCES_CLEANUP',
        targetType: 'SYSTEM',
        newValue: { cleanedUsers: cleanedCount, deletedDuplicates: deletedCount },
      })
    )

    return {
      cleanedUsers: cleanedCount,
      deletedDuplicates: deletedCount,
      message: `Limpieza completada: ${cleanedCount} usuarios consolidados, ${deletedCount} duplicados eliminados`,
    }
  }
)

/**
 * Mutación de mantenimiento: limpiar preferencias duplicadas
 * Encuentra todos los usuarios con múltiples registros de preferencias,
 * consolida los valores (manteniendo el más reciente o mergeando flags)
 * y elimina los duplicados.
 *
 * Solo puede ser ejecutada por usuarios ADMIN.
 */
export const cleanupDuplicatePreferences = mutation({
  args: {},
  handler: (ctx) => runConvex(cleanupDuplicatePreferencesProgram(ctx)),
})

// ============================================================================
// SEED LOCAL DE VOLUMEN (solo desarrollo)
// ============================================================================
// La pantalla se mide con la lista llena (20 filas a 1440x900) y el backend
// local nace sin un solo aviso: las filas de `notifications` las escriben los
// handlers de producto desde eventos que el seed no dispara. Esta mutation las
// pone directo, con la misma guarda anti-producción de `_localSeed` — no la
// sesión del que llama, sino el entorno del deployment.

/** Procedencia de la fila. La marca va en el campo y no en el título para que la
 *  pantalla se vea como se ve en producción, sin marcas de andamio. */
const DEV_SEED_ENTITY_TYPE = 'devSeed'

type DevSeedShape = {
  readonly type: Doc<'notifications'>['type']
  readonly title: string
  readonly message: string
  readonly link?: string
}

const DEV_SEED_SHAPES: readonly DevSeedShape[] = [
  {
    type: 'document_shared',
    title: 'Documento nuevo en la sala',
    message: 'Subiste «Estados financieros 2025» a la carpeta Financiero.',
    link: '/my-company/documents',
  },
  {
    type: 'new_message',
    title: 'Nota del equipo',
    message: 'El equipo te dejó una nota sobre la preparación de tu Data Room.',
    link: '/my-company/preparation',
  },
  {
    type: 'nda_signed',
    title: 'NDA firmado',
    message: 'Un invitado firmó el NDA y ya puede leer la sala.',
  },
  {
    type: 'analysis_complete',
    title: 'Modelo listo',
    message: 'El modelo v1 de tu empresa está en la sala, con su nota y su disclaimer.',
    link: '/my-company/documents',
  },
  {
    type: 'system',
    title: 'Revisión de la sala',
    message: 'Tu sala tiene una revisión pendiente con el equipo esta semana.',
  },
]

/** Uno de cada cuatro avisos sembrados lleva este mensaje de 240 caracteres: la
 *  fila tiene que aguantar el texto largo (dos líneas y elipsis) sin estirar la
 *  pantalla, y sin un aviso largo en la lista eso no se puede medir. */
const DEV_SEED_LONG_MESSAGE =
  'El equipo revisó los estados financieros de 2023, 2024 y 2025 y dejó catorce preguntas en ' +
  'el hilo de preparación: conciliación de inventario, arrendamientos, partes relacionadas y ' +
  'el detalle de la deuda bancaria con garantías y vencimientos.'

const seedForDevProgram = Effect.fn('Notifications.seedForDev')(function* (
  ctx: MutationCtx,
  args: { email: string; count: number }
) {
  if (!isDevAuthBypassedViaEnv()) {
    return yield* Effect.fail(
      unauthorized(
        'notifications.seedForDev solo puede ejecutarse en un deployment de desarrollo ' +
          '(requiere BYPASS_AUTH=true + CONVEX_ENV=dev). Bloqueado en producción.'
      )
    )
  }

  if (!Number.isInteger(args.count) || args.count < 0) {
    return yield* Effect.fail(
      validationFailed('count debe ser un entero mayor o igual a 0', 'count')
    )
  }

  const user = yield* convexPromise(() =>
    ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', args.email))
      .unique()
  )

  if (!user) {
    return yield* Effect.fail(
      validationFailed(`No hay usuario con el correo ${args.email}`, 'email')
    )
  }

  const profile = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .unique()
  )

  if (!profile) {
    return yield* Effect.fail(validationFailed(`El usuario ${args.email} no tiene perfil`, 'email'))
  }

  const existing = yield* convexPromise(() =>
    ctx.db
      .query('notifications')
      .withIndex('by_userId', (q) => q.eq('userId', profile._id))
      .collect()
  )

  // La corrida deja EXACTAMENTE `count` avisos para ese usuario: borra lo que
  // haya y repone. Es un backend de desarrollo y la alternativa —acumular— hace
  // que la segunda corrida ya no mida lo que dice medir.
  for (const notification of existing) {
    yield* convexPromise(() => ctx.db.delete(notification._id))
  }

  for (let index = 0; index < args.count; index++) {
    const shape = DEV_SEED_SHAPES[index % DEV_SEED_SHAPES.length]
    yield* convexPromise(() =>
      ctx.db.insert('notifications', {
        userId: profile._id,
        type: shape.type,
        title: shape.title,
        message: index % 4 === 0 ? DEV_SEED_LONG_MESSAGE : shape.message,
        link: shape.link,
        entityType: DEV_SEED_ENTITY_TYPE,
        // Una de cada tres nace leída: el filtro y el contador de la lista solo
        // se distinguen cuando la lista mezcla los dos estados.
        isRead: index % 3 === 0,
      })
    )
  }

  return { created: args.count, removed: existing.length }
})

/**
 * Siembra avisos sintéticos para un usuario de desarrollo. Cada corrida borra
 * los avisos que ese usuario tenga y deja exactamente `count`.
 */
export const seedForDev = internalMutation({
  args: { email: v.string(), count: v.number() },
  handler: (ctx, args) => runConvex(seedForDevProgram(ctx, args)),
})
