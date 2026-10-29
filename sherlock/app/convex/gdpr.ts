// ============================================================================
// Sherlock - GDPR/DATA PRIVACY FUNCTIONS
// ============================================================================
// Funciones para cumplir con GDPR y regulaciones de privacidad de datos.
// Permite a los usuarios:
// - Exportar todos sus datos personales
// - Solicitar eliminación de su cuenta y datos
// - Ver y gestionar consentimientos
// ============================================================================

import { v } from 'convex/values'
import { Effect, Schema } from 'effect'

import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import type { Doc, Id, TableNames } from './_generated/dataModel'
import { requireAuth } from './_helpers/auth'
import { evaluateCompanyManagementAuthorization } from './_helpers/companyAuthorization'
import { createSnapshot, logAdminAction } from './_helpers/auditLog'
import { convexPromise, runConvex } from './_helpers/effect'
import type { AppError } from './_helpers/errors'
import { invalidState, notFound, unauthorized } from './_helpers/errors'
import { omitUnauthorizedDeliverableRows } from './_notifications/deliverableVisibility'
import { buildDocumentPurgePlanEffect, executeDocumentPurgePlanEffect } from './_documents/purge'
import { deleteIntakeDataForClaimedProfile } from './_intake/storage'

// ============================================================================
// TYPES
// ============================================================================

// El vocabulario de consentimientos, definido una vez. El `v.union` de abajo se
// queda porque es lo que Convex valida en el borde y lo que lee el codegen; el
// tipo del módulo ya no lo repite, sale de aquí.
const ConsentTypeSchema = Schema.Literals([
  'terms_of_service',
  'privacy_policy',
  'marketing_emails',
  'analytics_tracking',
  'third_party_sharing',
])

export type ConsentType = (typeof ConsentTypeSchema)['Type']

// Un solo validador para las dos mutaciones: otorgar y revocar tienen que
// hablar del mismo vocabulario o un tipo queda sin puerta de salida.
const consentTypeValidator = v.union(
  v.literal('terms_of_service'),
  v.literal('privacy_policy'),
  v.literal('marketing_emails'),
  v.literal('analytics_tracking'),
  v.literal('third_party_sharing')
)

// ============================================================================
// LA FORMA DEL EXPORT (GDPR Art. 20)
// ============================================================================
// Lo que el titular recibe cuando pide portabilidad es contrato regulatorio, no
// un objeto literal que alguien puede recortar sin querer. Este esquema lo fija
// de una vez: el `satisfies` del handler exige exactamente estos campos, así que
// borrar uno —o dejar de incluir una tabla— deja de compilar en vez de salir
// callado en un export incompleto.
//
// `Schema.UndefinedOr` donde el dato es opcional en `schema.ts` (`fullName`,
// `legalName`, ...) es deliberado: el export dice «no hay dato», no inventa uno.
// Se exporta a propósito: es la forma del export del Artículo 20 y un test debe
// poder afirmarla. Validar el payload en runtime crearía un camino de fallo
// nuevo sobre filas viejas, que es decisión de producto y no de esta ola.
export const UserDataExportSchema = Schema.Struct({
  exportedAt: Schema.String,
  exportVersion: Schema.String,
  profile: Schema.Struct({
    id: Schema.String,
    userId: Schema.String,
    fullName: Schema.UndefinedOr(Schema.String),
    role: Schema.Literals(['COMPANY', 'ADMIN']),
    createdAt: Schema.Number,
  }),
  user: Schema.NullOr(
    Schema.Struct({
      email: Schema.String,
      name: Schema.UndefinedOr(Schema.String),
      createdAt: Schema.Number,
    })
  ),
  company: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      legalName: Schema.UndefinedOr(Schema.String),
      country: Schema.String,
      industry: Schema.UndefinedOr(Schema.String),
      description: Schema.UndefinedOr(Schema.String),
      createdAt: Schema.Number,
    })
  ),
  notifications: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      title: Schema.String,
      message: Schema.String,
      // `notifications.isRead` es opcional en `schema.ts` (default: false), y
      // el export copia el campo tal cual: una fila legacy sale sin él.
      isRead: Schema.UndefinedOr(Schema.Boolean),
      createdAt: Schema.Number,
    })
  ),
  consents: Schema.Array(
    Schema.Struct({
      type: ConsentTypeSchema,
      accepted: Schema.Boolean,
      acceptedAt: Schema.Number,
      ipAddress: Schema.UndefinedOr(Schema.String),
    })
  ),
})

export type UserDataExport = (typeof UserDataExportSchema)['Type']

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Obtener todos los consentimientos del usuario
 */
// Las cinco superficies del titular comparten la misma puerta: o eres tú, o
// eres el equipo. Un solo paso con nombre en vez de cinco copias del `if`.
const requireSelfOrAdmin = Effect.fn('Gdpr.requireSelfOrAdmin')(function* (
  ctx: QueryCtx | MutationCtx,
  profileId: Id<'profiles'>,
  denial: string
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))

  const isAdmin = auth.profile.role === 'ADMIN'
  const isOwner = auth.profile._id === profileId

  if (!isAdmin && !isOwner) {
    return yield* Effect.fail(unauthorized(denial))
  }
  return auth
})

const getUserConsentsProgram = Effect.fn('Gdpr.getUserConsents')(function* (
  ctx: QueryCtx,
  args: { profileId: Id<'profiles'> }
) {
  yield* requireSelfOrAdmin(ctx, args.profileId, 'No tienes permiso para ver estos consentimientos')

  const consents = yield* convexPromise(() =>
    ctx.db
      .query('consents')
      .withIndex('by_profileId', (q) => q.eq('profileId', args.profileId))
      .collect()
  )

  return consents
})

export const getUserConsents = query({
  args: { profileId: v.id('profiles') },
  handler: (ctx, args) => runConvex(getUserConsentsProgram(ctx, args)),
})

/**
 * Exportar todos los datos del usuario (GDPR Art. 20 - Portabilidad)
 * Retorna un objeto con todos los datos del usuario en formato JSON
 */
const exportUserDataProgram = Effect.fn('Gdpr.exportUserData')(function* (
  ctx: QueryCtx,
  args: { profileId: Id<'profiles'> }
) {
  const auth = yield* requireSelfOrAdmin(
    ctx,
    args.profileId,
    'No tienes permiso para exportar estos datos'
  )

  // ===== 1. PROFILE =====
  const profile = yield* convexPromise(() => ctx.db.get(args.profileId))
  if (!profile) {
    return yield* Effect.fail(notFound('Profile', args.profileId))
  }

  // ===== 2. USER (datos de la cuenta) =====
  const targetUser = yield* convexPromise(() =>
    profile.userId ? ctx.db.get(profile.userId) : Promise.resolve(null)
  )

  // ===== 3. COMPANY (si existe y el evaluador autoriza) =====
  // ownerId no basta: un dueño revocado con el perfil activo seguiría
  // exportando nombre, razón social y descripción. Si no autoriza, el
  // bloque sale null. El resto del titular se queda, salvo document_shared.
  const companyRow = yield* convexPromise(() =>
    ctx.db
      .query('companies')
      .withIndex('by_ownerId', (q) => q.eq('ownerId', args.profileId))
      .first()
  )
  const companyDecision = companyRow
    ? yield* convexPromise(() =>
        evaluateCompanyManagementAuthorization(ctx, auth, companyRow)
      )
    : null
  const company = companyDecision?.authorized ? companyRow : null

  // ===== 9. NOTIFICATIONS =====
  // La misma puerta que la campanita. Si la empresa existe y la decisión de
  // arriba no autoriza, document_shared no sale: avisos viejos traen la nota
  // del equipo y el nombre del documento. ADMIN queda autorizado y las conserva.
  const notificationRows = yield* convexPromise(() =>
    ctx.db
      .query('notifications')
      .withIndex('by_userId', (q) => q.eq('userId', args.profileId))
      .collect()
  )
  const notifications = yield* omitUnauthorizedDeliverableRows(notificationRows, companyDecision)

  // ===== 10. CONSENTS =====
  const consents = yield* convexPromise(() =>
    ctx.db
      .query('consents')
      .withIndex('by_profileId', (q) => q.eq('profileId', args.profileId))
      .collect()
  )

  // ===== COMPILAR EXPORT =====
  return {
    exportedAt: new Date().toISOString(),
    exportVersion: '1.0',
    profile: {
      id: profile._id,
      userId: profile.userId,
      fullName: profile.fullName,
      role: profile.role,
      createdAt: profile._creationTime,
    },
    user: targetUser
      ? {
          email: targetUser.email,
          name: targetUser.name,
          createdAt: targetUser._creationTime,
        }
      : null,
    company: company
      ? {
          name: company.name,
          legalName: company.legalName,
          country: company.country,
          industry: company.industry,
          description: company.description,
          createdAt: company._creationTime,
        }
      : null,
    notifications: notifications.map((n) => ({
      type: n.type,
      title: n.title,
      message: n.message,
      isRead: n.isRead,
      createdAt: n._creationTime,
    })),
    consents: consents.map((c) => ({
      type: c.consentType,
      accepted: c.accepted,
      acceptedAt: c.acceptedAt,
      ipAddress: c.ipAddress,
    })),
  } satisfies UserDataExport
})

/**
 * Exportar todos los datos del usuario (GDPR Art. 20 - Portabilidad)
 * Retorna un objeto con todos los datos del usuario en formato JSON
 */
export const exportUserData = query({
  args: { profileId: v.id('profiles') },
  handler: (ctx, args) => runConvex(exportUserDataProgram(ctx, args)),
})

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Registrar un consentimiento del usuario
 */
// El consentimiento vigente de un tipo, por el índice compuesto: antes se leía
// todo lo del perfil por `by_profileId` y se filtraba el tipo en memoria.
const findConsentEffect = Effect.fn('Gdpr.findConsent')(function* (
  ctx: QueryCtx | MutationCtx,
  profileId: Id<'profiles'>,
  consentType: ConsentType
) {
  return yield* convexPromise(() =>
    ctx.db
      .query('consents')
      .withIndex('by_profileId_consentType', (q) =>
        q.eq('profileId', profileId).eq('consentType', consentType)
      )
      .first()
  )
})

// `ipAddress` y `userAgent` ya no vienen del cliente: como evidencia no valen
// si los pone quien consiente (`_documents/storage.ts` documenta el mismo
// criterio para las subidas). Al re-registrar se limpian los que quedaron de
// registros viejos, porque no hay valor fiable con qué reemplazarlos.
const recordConsentProgram = Effect.fn('Gdpr.recordConsent')(function* (
  ctx: MutationCtx,
  args: { profileId: Id<'profiles'>; consentType: ConsentType; accepted: boolean }
) {
  yield* requireSelfOrAdmin(
    ctx,
    args.profileId,
    'No tienes permiso para registrar este consentimiento'
  )

  const existing = yield* findConsentEffect(ctx, args.profileId, args.consentType)
  const now = Date.now()

  if (existing) {
    yield* convexPromise(() =>
      ctx.db.patch(existing._id, {
        accepted: args.accepted,
        acceptedAt: now,
        ipAddress: undefined,
        userAgent: undefined,
      })
    )
    return existing._id
  }

  return yield* convexPromise(() =>
    ctx.db.insert('consents', {
      profileId: args.profileId,
      consentType: args.consentType,
      accepted: args.accepted,
      acceptedAt: now,
    })
  )
})

export const recordConsent = mutation({
  args: {
    profileId: v.id('profiles'),
    consentType: consentTypeValidator,
    accepted: v.boolean(),
  },
  handler: (ctx, args) => runConvex(recordConsentProgram(ctx, args)),
})

const revokeConsentProgram = Effect.fn('Gdpr.revokeConsent')(function* (
  ctx: MutationCtx,
  args: { profileId: Id<'profiles'>; consentType: ConsentType }
) {
  yield* requireSelfOrAdmin(
    ctx,
    args.profileId,
    'No tienes permiso para revocar este consentimiento'
  )

  const consent = yield* findConsentEffect(ctx, args.profileId, args.consentType)

  const now = Date.now()
  if (consent) {
    yield* convexPromise(() =>
      ctx.db.patch(consent._id, {
        accepted: false,
        acceptedAt: now,
      })
    )
  }
})

/**
 * Revocar un consentimiento específico
 */
export const revokeConsent = mutation({
  args: {
    profileId: v.id('profiles'),
    consentType: consentTypeValidator,
  },
  handler: (ctx, args) => runConvex(revokeConsentProgram(ctx, args)),
})

/**
 * Solicitar eliminación de cuenta (GDPR Art. 17 - Derecho al Olvido)
 * Crea una solicitud de eliminación que será procesada
 */
const requestAccountDeletionProgram = Effect.fn('Gdpr.requestAccountDeletion')(function* (
  ctx: MutationCtx,
  args: { profileId: Id<'profiles'>; reason?: string }
) {
  yield* requireSelfOrAdmin(
    ctx,
    args.profileId,
    'No tienes permiso para solicitar la eliminación de esta cuenta'
  )

  const profile = yield* convexPromise(() => ctx.db.get(args.profileId))
  if (!profile) {
    return yield* Effect.fail(notFound('Profile', args.profileId))
  }

  // Una PENDING previa se devuelve tal cual: la página ya lo evitaba, pero la
  // mutation es la frontera y un segundo aviso «recibida» sería mentira.
  const pendingRequests = yield* convexPromise(() =>
    ctx.db
      .query('deletionRequests')
      .withIndex('by_profileId', (q) => q.eq('profileId', args.profileId))
      .collect()
  )
  const pending = pendingRequests.find((request) => request.status === 'PENDING')
  if (pending) return pending._id

  // Obtener el email del usuario para respaldo
  const targetUser = yield* convexPromise(() => ctx.db.get(profile.userId))
  const email = targetUser?.email ?? ''

  // Crear solicitud de eliminación
  const requestId = yield* convexPromise(() =>
    ctx.db.insert('deletionRequests', {
      profileId: args.profileId,
      email,
      reason: args.reason,
      status: 'PENDING',
      requestedAt: Date.now(),
    })
  )

  // Crear notificación al usuario
  yield* convexPromise(() =>
    ctx.db.insert('notifications', {
      userId: args.profileId,
      type: 'system',
      title: 'Solicitud de eliminación recibida',
      message:
        'Tu solicitud de eliminación de cuenta ha sido recibida. Procesaremos tu solicitud en un máximo de 30 días según la normativa GDPR.',
      isRead: false,
    })
  )

  return requestId
})

export const requestAccountDeletion = mutation({
  args: {
    profileId: v.id('profiles'),
    reason: v.optional(v.string()),
  },
  handler: (ctx, args) => runConvex(requestAccountDeletionProgram(ctx, args)),
})

const cancelDeletionRequestProgram = Effect.fn('Gdpr.cancelDeletionRequest')(function* (
  ctx: MutationCtx,
  args: { requestId: Id<'deletionRequests'>; profileId: Id<'profiles'> }
) {
  const { profile: viewerProfile } = yield* convexPromise(() => requireAuth(ctx))
  const request = yield* convexPromise(() => ctx.db.get(args.requestId))

  if (!request) {
    return yield* Effect.fail(notFound('Deletion request', args.requestId))
  }

  if (request.profileId !== args.profileId) {
    return yield* Effect.fail(unauthorized())
  }

  if (viewerProfile.role !== 'ADMIN' && viewerProfile._id !== request.profileId) {
    return yield* Effect.fail(unauthorized())
  }

  if (request.status !== 'PENDING') {
    return yield* Effect.fail(invalidState('Cannot cancel a processed request', request.status))
  }

  yield* convexPromise(() =>
    ctx.db.patch(args.requestId, {
      status: 'CANCELLED',
    })
  )

  // Notificar al usuario
  yield* convexPromise(() =>
    ctx.db.insert('notifications', {
      userId: request.profileId,
      type: 'system',
      title: 'Solicitud de eliminación cancelada',
      message: 'Tu solicitud de eliminación de cuenta ha sido cancelada. Tu cuenta sigue activa.',
      isRead: false,
    })
  )
})

/**
 * Cancelar solicitud de eliminación
 */
export const cancelDeletionRequest = mutation({
  args: {
    requestId: v.id('deletionRequests'),
    profileId: v.id('profiles'),
  },
  handler: (ctx, args) => runConvex(cancelDeletionRequestProgram(ctx, args)),
})

/**
 * Solicitud de eliminación PENDING del propio perfil.
 *
 * Sin esta lectura la página de privacidad no sabía que ya había pedido el
 * borrado: cada clic insertaba otra fila y la tarjeta seguía luciendo virgen.
 */
const getPendingDeletionRequestProgram = Effect.fn('Gdpr.getPendingDeletionRequest')(function* (
  ctx: QueryCtx,
  args: { profileId: Id<'profiles'> }
) {
  yield* requireSelfOrAdmin(
    ctx,
    args.profileId,
    'No tienes permiso para ver estas solicitudes de eliminación'
  )

  return yield* convexPromise(() =>
    ctx.db
      .query('deletionRequests')
      .withIndex('by_profileId', (q) => q.eq('profileId', args.profileId))
      .filter((q) => q.eq(q.field('status'), 'PENDING'))
      .order('desc')
      .first()
  )
})

export const getPendingDeletionRequest = query({
  args: { profileId: v.id('profiles') },
  handler: (ctx, args) => runConvex(getPendingDeletionRequestProgram(ctx, args)),
})

/**
 * Cola de solicitudes de eliminación para el panel de admin.
 *
 * `processAccountDeletion` existió meses sin un solo caller: toda solicitud
 * quedaba PENDING para siempre (riesgo Art. 17, no deuda técnica). Esta query
 * es la mitad de lectura de esa superficie. Tope fijo de 200: la cola operable
 * cabe ahí y una consulta sin límite es la clase de scan que ya nos mordió.
 */
const listDeletionRequestsProgram = Effect.fn('Gdpr.listDeletionRequests')(function* (
  ctx: QueryCtx,
  args: { status?: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED' }
) {
  const { profile } = yield* convexPromise(() => requireAuth(ctx))

  if (profile.role !== 'ADMIN') {
    return yield* Effect.fail(
      unauthorized('Solo administradores pueden ver las solicitudes de eliminación')
    )
  }

  const status = args.status
  return yield* convexPromise(() =>
    status
      ? ctx.db
          .query('deletionRequests')
          .withIndex('by_status', (q) => q.eq('status', status))
          .order('desc')
          .take(200)
      : ctx.db.query('deletionRequests').order('desc').take(200)
  )
})

export const listDeletionRequests = query({
  args: {
    status: v.optional(
      v.union(
        v.literal('PENDING'),
        v.literal('PROCESSING'),
        v.literal('COMPLETED'),
        v.literal('CANCELLED')
      )
    ),
  },
  handler: (ctx, args) => runConvex(listDeletionRequestsProgram(ctx, args)),
})

// ============================================================================
// ERASURE CASCADE HELPERS (GDPR Art. 17)
// ============================================================================
// Convex no aplica integridad referencial: cualquier tabla con un FK hacia una
// fila borrada sobrevive apuntando al vacío. La cascada de abajo recorre TODAS
// las tablas que referencian profile/company/document.
//
// Residuales aceptados y documentados (no se tocan a propósito):
// - `adminAuditLogs.adminProfileId` es un FK NO opcional sobre registros de
//   auditoría que pertenecen a terceros; se conserva por obligación legal
//   (GDPR Art. 17.3.b/e) y sólo se le redacta la PII textual (email/IP/user-agent)
//   cuando aplica.
// - `documentAccessLogs.accessedById` es un FK NO opcional dentro del rastro de
//   cumplimiento de OTRA empresa; borrarlo destruiría el audit trail ajeno, así
//   que el id queda colgando sin PII textual.
// - `notifications.actorId` no tiene índice: barrerlo exigiría un full scan.
//
// RETENCIÓN — cinco tablas quedan DELIBERADAMENTE fuera de esta cascada
// (decisión de Maintainer 2026-07-25: anonimizar, no borrar):
//   `ndas`, `ndaSignatures`, `generatedNdas`, `subscriptions`,
//   `documentAccessLogs`.
// `ndaSignatures` es el registro append-only de eventos de firma: `ndas` guarda
// el estado vigente y se sobrescribe al re-firmar, así que sin esa tabla una
// re-firma borraría la prueba de la firma anterior. Lleva `signatoryName` y
// `signedByProfileId`, o sea PII, y entra en la misma anonimización de la Fase 4.
// Son evidencia contractual, fiscal y de cumplimiento, y borrarlas destruye la
// prueba de quién firmó qué y quién accedió a qué (GDPR Art. 17.3.b/e). El
// tratamiento correcto es conservar la fila con la PII nulificada, igual que ya
// se hace más abajo con `activityLogs` / `adminAuditLogs` / `securityEvents`.
// Eso exige ampliar sus FKs a `v.optional(...)` en el schema, así que va en su
// propio PR. Hasta entonces estas filas sobreviven intactas — el mismo
// comportamiento que `main` tenía antes de esta cascada, no una regresión.

const ANONYMIZED = 'ANONYMIZED'
const REDACTED_EMAIL = 'fixture-c5f01650@example.com'

/**
 * Borra un conjunto de filas y devuelve cuántas fueron eliminadas.
 *
 * El nombre del span lleva la tabla: un borrado a medias deja hasta ahora
 * huérfanos silenciosos, y esto es lo que hace que la traza diga en qué tabla
 * se cortó la cascada en vez de solo «falló el borrado».
 */
const deleteRowsEffect = Effect.fn('Gdpr.deleteRows')(function* (
  ctx: MutationCtx,
  rows: Array<{ _id: Id<TableNames> }>
) {
  for (const row of rows) {
    yield* convexPromise(() => ctx.db.delete(row._id))
  }
  return rows.length
})

/**
 * Purga un lote de documentos del VDR con el mismo plan que usa la purga del
 * operador (`_documents/purge.ts`): grants, versiones, texto extraído
 * (`documentTextIndex`) y los blobs que ninguna otra fila viva sigue
 * referenciando. Antes la cascada GDPR tenía su propia copia que olvidaba el
 * texto extraído, así que la supresión Art. 17 dejaba hasta 400k caracteres del
 * contenido por versión. Un solo lugar decide qué muere con un documento.
 *
 * Solo corre dentro de la eliminación GDPR, después de la preflight global de
 * legal holds. NO toca `documentAccessLogs`: ver la nota de RETENCIÓN de
 * arriba. El log queda con un `documentId` colgando hasta que el PR de
 * anonimización lo resuelva.
 */
const purgeDocumentsEffect = Effect.fn('Gdpr.purgeDocuments')(function* (
  ctx: MutationCtx,
  documents: Doc<'documents'>[]
) {
  const plan = yield* buildDocumentPurgePlanEffect(ctx, documents)
  yield* executeDocumentPurgePlanEffect(ctx, plan)
})

/**
 * Procesar eliminación de cuenta (para admins o cron job).
 * SOLO debe llamarse después de verificar la identidad del usuario.
 * La cascada no agenda contadores: `systemStats` no tiene escritores.
 */
/**
 * Las dos salidas que cierran la solicitud: el perfil ya no estaba, o el
 * usuario se eliminó. El nombre explícito evita que el handler colapse a `any`.
 */
type AccountDeletionOutcome =
  { deleted: true; profileAlreadyGone: true } | { deleted: true; userDeleted: boolean }

const processAccountDeletionProgram = Effect.fn('Gdpr.processAccountDeletion')(function* (
  ctx: MutationCtx,
  args: { requestId: Id<'deletionRequests'> }
): Effect.fn.Return<AccountDeletionOutcome, AppError> {
  const { profile: viewerProfile, user: viewerUser } = yield* convexPromise(() => requireAuth(ctx))

  if (viewerProfile.role !== 'ADMIN') {
    return yield* Effect.fail(
      unauthorized('Solo administradores pueden procesar eliminaciones de cuenta')
    )
  }

  const request = yield* convexPromise(() => ctx.db.get(args.requestId))

  if (!request) {
    return yield* Effect.fail(notFound('Deletion request', args.requestId))
  }

  if (request.status !== 'PENDING') {
    return yield* Effect.fail(invalidState('Invalid or already processed request', request.status))
  }

  const profileId = request.profileId
  const profile = yield* convexPromise(() => ctx.db.get(profileId))
  if (!profile) {
    yield* convexPromise(() => ctx.db.patch(args.requestId, { status: 'COMPLETED' }))

    // AUDITORÍA: la solicitud se cierra sin borrado real; queda trazado igual.
    yield* convexPromise(() =>
      logAdminAction({
        ctx,
        adminProfileId: viewerProfile._id,
        adminEmail: viewerUser.email,
        action: 'USER_DELETE',
        targetType: 'PROFILE',
        targetId: profileId,
        newValue: { requestStatus: 'COMPLETED', profileAlreadyGone: true },
        notes: `Solicitud de eliminación ${args.requestId} cerrada: el profile ya no existía`,
      })
    )

    return { deleted: true, profileAlreadyGone: true }
  }

  // Legal hold gana sobre erasure. Se comprueba ANTES de escribir un audit
  // que diga "deleted" y antes de iniciar cualquier cascada, de modo que la
  // transacción completa queda intacta si existe evidencia bajo conservación.
  const company = yield* convexPromise(() =>
    ctx.db
      .query('companies')
      .withIndex('by_ownerId', (q) => q.eq('ownerId', profileId))
      .first()
  )
  if (company) {
    const activeHold = yield* convexPromise(() =>
      ctx.db
        .query('documentLegalHolds')
        .withIndex('by_company_status', (q) =>
          q.eq('companyId', company._id).eq('status', 'ACTIVE')
        )
        .first()
    )
    if (activeHold) {
      return yield* Effect.fail(
        invalidState(
          'La cuenta tiene documentos sujetos a legal hold. Libera el hold antes de procesar la eliminación.',
          'LEGAL_HOLD_BLOCKS_ERASURE'
        )
      )
    }
  }

  // Se registra ANTES de la cascada, y una sola vez, por dos razones que se
  // sostienen juntas:
  //  - si el admin borra su propia cuenta, la redacción de PII de más abajo
  //    alcanza también a este registro (motivo de #149);
  //  - `previousValue` es la única evidencia de QUÉ se borró, porque después de
  //    la cascada el profile ya no existe para muestrearlo (motivo de #148).
  // Una segunda entrada post-cascada tendría el snapshot pero escaparía a la
  // redacción, conservando el email del propio titular que ejerció la supresión.
  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: viewerProfile._id,
      adminEmail: viewerUser.email,
      action: 'USER_DELETE',
      targetType: 'PROFILE',
      targetId: profileId,
      previousValue: createSnapshot(profile, ['role', 'kycStatus', 'isActive']),
      newValue: { deleted: true, requestStatus: 'COMPLETED' },
      notes: `GDPR Art. 17 - eliminación procesada desde la solicitud ${args.requestId}`,
    })
  )

  // ===== ELIMINAR DATOS EN ORDEN =====

  // 1. Company y todo lo que cuelga de ella (documentos del VDR)
  if (company) {
    const documents = yield* convexPromise(() =>
      ctx.db
        .query('documents')
        .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
        .collect()
    )
    yield* purgeDocumentsEffect(ctx, documents)

    const authorizationInventoryRows = yield* convexPromise(() =>
      ctx.db
        .query('companyAuthorizationInventoryRows')
        .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
        .collect()
    )
    yield* deleteRowsEffect(ctx, authorizationInventoryRows)
    const organizationBindings = yield* convexPromise(() =>
      ctx.db
        .query('companyOrganizationBindings')
        .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
        .collect()
    )
    yield* deleteRowsEffect(ctx, organizationBindings)
    yield* convexPromise(() => ctx.db.delete(company._id))
  }

  // 2. Datos colgados directamente del profile
  const notifications = yield* convexPromise(() =>
    ctx.db
      .query('notifications')
      .withIndex('by_userId', (q) => q.eq('userId', profileId))
      .collect()
  )
  yield* deleteRowsEffect(ctx, notifications)

  const consents = yield* convexPromise(() =>
    ctx.db
      .query('consents')
      .withIndex('by_profileId', (q) => q.eq('profileId', profileId))
      .collect()
  )
  yield* deleteRowsEffect(ctx, consents)

  const preferences = yield* convexPromise(() =>
    ctx.db
      .query('notificationPreferences')
      .withIndex('by_userId', (q) => q.eq('userId', profileId))
      .collect()
  )
  yield* deleteRowsEffect(ctx, preferences)

  // `subscriptions`: retenido a propósito — registro fiscal (ver nota de RETENCIÓN).

  const grants = yield* convexPromise(() =>
    ctx.db
      .query('documentAccessGrants')
      .withIndex('by_profileId', (q) => q.eq('profileId', profileId))
      .collect()
  )
  yield* deleteRowsEffect(ctx, grants)

  const membershipsByProfile = yield* convexPromise(() =>
    ctx.db
      .query('organizationMemberships')
      .withIndex('by_profileId', (q) => q.eq('profileId', profileId))
      .collect()
  )
  yield* deleteRowsEffect(ctx, membershipsByProfile)

  // Claimed intake provenance participates in the same explicit erasure. The
  // helper deletes a blob only while intake remains its sole authoritative
  // owner; canonical company references always win.
  yield* convexPromise(() => deleteIntakeDataForClaimedProfile(ctx, profileId))

  // 4. Anonimizar (no borrar) los rastros que deben sobrevivir por auditoría
  const activity = yield* convexPromise(() =>
    ctx.db
      .query('activityLogs')
      .withIndex('by_userId', (q) => q.eq('userId', profileId))
      .collect()
  )
  for (const log of activity) {
    yield* convexPromise(() =>
      ctx.db.patch(log._id, {
        userId: undefined,
        ipAddress: ANONYMIZED,
        userAgent: ANONYMIZED,
      })
    )
  }

  // `adminProfileId` no es opcional: se conserva el registro del acto administrativo
  // y se redacta sólo la PII textual.
  const adminLogs = yield* convexPromise(() =>
    ctx.db
      .query('adminAuditLogs')
      .withIndex('by_adminProfileId', (q) => q.eq('adminProfileId', profileId))
      .collect()
  )
  for (const log of adminLogs) {
    yield* convexPromise(() =>
      ctx.db.patch(log._id, {
        adminEmail: REDACTED_EMAIL,
        ipAddress: ANONYMIZED,
        userAgent: ANONYMIZED,
      })
    )
  }

  const securityEvents = yield* convexPromise(() =>
    ctx.db
      .query('securityEvents')
      .withIndex('by_userId', (q) => q.eq('userId', profile.userId))
      .collect()
  )
  for (const event of securityEvents) {
    yield* convexPromise(() =>
      ctx.db.patch(event._id, {
        userId: undefined,
        userEmail: REDACTED_EMAIL,
        ipAddress: ANONYMIZED,
        userAgent: ANONYMIZED,
      })
    )
  }

  // Las solicitudes de borrado se conservan como prueba del ejercicio del derecho,
  // pero el email de respaldo es PII y se redacta.
  const deletionRequests = yield* convexPromise(() =>
    ctx.db
      .query('deletionRequests')
      .withIndex('by_profileId', (q) => q.eq('profileId', profileId))
      .collect()
  )
  for (const deletionRequest of deletionRequests) {
    yield* convexPromise(() => ctx.db.patch(deletionRequest._id, { email: REDACTED_EMAIL }))
  }

  // 5. Eliminar el profile
  yield* convexPromise(() => ctx.db.delete(profileId))

  // 6. Eliminar la identidad de auth (email/nombre/avatar) si ya no queda ningún
  // otro profile apuntando a ese user. Decisión explícita: se BORRA, no se anonimiza,
  // porque la fila `users` es el registro de identidad del titular.
  const membershipsByUser = yield* convexPromise(() =>
    ctx.db
      .query('organizationMemberships')
      .withIndex('by_userId', (q) => q.eq('userId', profile.userId))
      .collect()
  )
  yield* deleteRowsEffect(ctx, membershipsByUser)

  const remainingProfiles = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', profile.userId))
      .collect()
  )

  const userDeleted = remainingProfiles.length === 0
  if (userDeleted) {
    yield* convexPromise(() => ctx.db.delete(profile.userId))
  } else {
    yield* Effect.logWarning(
      `[gdpr] user ${profile.userId} conserva ${remainingProfiles.length} profile(s); no se elimina la identidad de auth`
    )
  }

  // 7. Marcar solicitud como completada
  yield* convexPromise(() =>
    ctx.db.patch(args.requestId, {
      status: 'COMPLETED',
      processedAt: Date.now(),
      processedBy: viewerProfile._id,
      email: REDACTED_EMAIL,
    })
  )

  // La auditoría de esta cascada se emitió arriba, antes de borrar, para que
  // quedara dentro del alcance de la redacción de PII. No se repite aquí.
  return { deleted: true, userDeleted }
})

/**
 * Procesar eliminación de cuenta (para admins o cron job)
 * SOLO debe llamarse después de verificar la identidad del usuario
 */
export const processAccountDeletion = mutation({
  args: { requestId: v.id('deletionRequests') },
  handler: (ctx, args): Promise<AccountDeletionOutcome> =>
    runConvex(processAccountDeletionProgram(ctx, args)),
})
