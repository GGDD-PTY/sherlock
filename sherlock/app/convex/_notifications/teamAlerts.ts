// ============================================================================
// TEAM ALERTS — el equipo se entera de que el cliente se movió
// ============================================================================
// El VDR está sellado ([F] 2026-09-01): Mycroft lo opera el fundador a mano y
// el lazo arranca cuando el equipo SE ENTERA de que un cliente soltó
// documentos. Hasta ahora no se enteraba de nada.
//
// La unidad es la TANDA, no el archivo. Los dos caminos de subida finalizan un
// archivo por llamada, así que una fila de `teamAlerts` agrupa la tanda por
// `batchKey` y la mantiene abierta mientras sigan llegando archivos dentro de
// la ventana. Esa fila ES la primitiva de idempotencia: la campanita se PARCHA
// en vez de duplicarse, y `emailDispatchedAt` hace el correo exactamente-una-
// vez por tanda aunque el job se reintente.
//
// NADA DE ESTO CORRE EN LA TRANSACCIÓN DEL CLIENTE. Los tres disparadores
// calendarizan (`scheduler.runAfter(0, ...)`) y estas funciones corren en su
// propia mutación. Es la única forma de que el aviso sea de verdad fail-open:
// n subidas concurrentes de una misma empresa escriben todas la MISMA fila de
// `teamAlerts`, y ese conflicto lo detecta Convex al hacer commit, fuera del
// handler, donde ningún try/catch alcanza — inline le costaría al cliente su
// subida. Por eso acá tampoco hay try/catch: si algo revienta, revienta sola
// esta mutación y no deja fila a medias que la tanda siguiente adopte.
//
// LO QUE ESE CONFLICTO **NO** GARANTIZA: `by_batchKey` no es un índice único, y
// una transacción no ve la fila que otra está insertando. Dos `finalize`
// concurrentes que no encuentran tanda abierta pueden dejar DOS filas del mismo
// `batchKey`; que se colapsen depende del OCC del backend, no de este módulo.
// Por eso el correo se deduplica explícitamente en `dispatchTeamAlertEmail`, y
// las campanitas duplicadas de ese caso son un riesgo conocido y aceptado.
// ============================================================================

import { Effect } from 'effect'

import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { normalizeCompanyName } from '../_helpers/companyName'
import { convexPromise, runConvex } from '../_helpers/effect'
import { sendTeamAlertEmail } from '../email'
import { roomFolderLabels, type TeamAlertKind } from '../_helpers/teamEmailTemplates'

export const TEAM_ALERT_BATCH_WINDOW_MS = 10 * 60 * 1000
// Ventana de GEMELAS, que no es la de la tanda. Dos filas gemelas son dos
// `finalize` concurrentes: nacen con el mismo `Date.now()` de dos mutaciones
// que corren a la vez, así que su `openedAt` se separa por milisegundos. Con la
// ventana de tanda (10 min), toda segunda tanda LEGÍTIMA — la que se abre
// porque la anterior ya despachó su correo, dentro del mismo cuarto de hora —
// se leía como gemela y se quedaba sin correo: el equipo se enteraba del primer
// lote y de ninguno de los siguientes.
const TEAM_ALERT_TWIN_WINDOW_MS = 5 * 1000
export const TEAM_ALERT_EMAIL_DEBOUNCE_MS = 2 * 60 * 1000
// Techo del debounce. Sin él, un goteo de subidas cada 90 s reprograma el envío
// para siempre: la tanda queda abierta y el correo no sale nunca. Media hora
// después de abrir, el aviso sale aunque sigan llegando archivos; lo que llegue
// después abre tanda nueva.
const TEAM_ALERT_EMAIL_MAX_DELAY_MS = 30 * 60 * 1000
const MAX_TEAM_ALERT_RECIPIENTS = 25
const MAX_TRACKED_FILE_NAMES = 25
const MAX_TRACKED_FOLDERS = 10

const UNIDENTIFIED_COMPANY = 'Empresa sin identificar'
const ADMIN_COMPANIES_PATH = '/admin/companies'

// El link se guarda SIN locale: la página de notificaciones navega con el
// `Link` de `@/i18n/navigation`, que antepone el locale activo. Un `/es/...`
// guardado saldría como `/es/es/...` y el ruteo deny-by-default lo hace 404.
function roomPath(companyId: Id<'companies'> | undefined): string {
  return companyId ? `${ADMIN_COMPANIES_PATH}/${companyId}/documents` : ADMIN_COMPANIES_PATH
}

function pluralizeFiles(count: number): string {
  return count === 1 ? '1 archivo' : `${count} archivos`
}

function copyFor(alert: {
  kind: TeamAlertKind
  companyName: string
  fileCount: number
  folders: string[]
}): { title: string; message: string } {
  if (alert.kind === 'COMPANY_WORKSPACE_CREATED') {
    return {
      title: `Espacio nuevo: ${alert.companyName}`,
      message: `${alert.companyName} creó su espacio en Sherlock. Abre la sala para acompañar la preparación.`,
    }
  }
  const files = pluralizeFiles(alert.fileCount)
  const folderLabels = roomFolderLabels(alert.folders)
  const where = folderLabels.length > 0 ? ` en ${folderLabels.join(', ')}` : ''
  return {
    title: `Documentos nuevos de ${alert.companyName}`,
    message: `${alert.companyName} subió ${files}${where}. Revisa la sala para arrancar la preparación.`,
  }
}

// ============================================================================
// EL NOMBRE DE LA EMPRESA SE RESUELVE AL ENVIAR, NO AL ABRIR LA TANDA
// ============================================================================
// `companies.ensureCompanyWorkspace` nombra la empresa con el nombre del
// USUARIO (o con el local-part de su correo): en el primer login no hay otro
// dato. El nombre de verdad aterriza uno o dos segundos después — el claim del
// intake aplica el que la persona escribió en /mycroft, o el cliente lo escribe
// en la sala — y los dos caminos marcan `companyChecklist.nameConfirmedAt`. Esa
// marca es lo único que distingue «así se llama la empresa» de «así se llama su
// dueño», así que la fila de `companies` solo gana cuando está confirmada.
//
// Sin ella, en la corrida del 2026-09-04 faltaron las dos mitades: el aviso del
// intake nació bien («Grupo Calesa, S.A. y Subsidiarias») y el claim lo REBAJÓ
// al nombre del perfil, y el correo salió como «Documentos nuevos: Maintainer
// Gonzalez» treinta segundos después de que la empresa ya se llamaba bien.
// ============================================================================
const confirmedCompanyName = Effect.fn('TeamAlerts.confirmedCompanyName')(function* (
  ctx: MutationCtx,
  companyId: Id<'companies'>
) {
  const checklist = yield* convexPromise(() =>
    ctx.db
      .query('companyChecklist')
      .withIndex('by_companyId', (q) => q.eq('companyId', companyId))
      .first()
  )
  if (!checklist?.nameConfirmedAt) return undefined
  const company = yield* convexPromise(() => ctx.db.get(companyId))
  return normalizeCompanyName(company?.name)
})

// Destinatario es todo ADMIN con `isActive !== false`: el campo es OPCIONAL y su
// default de producto es "activo", así que un perfil sin la bandera está vivo.
// `.eq('isActive', true)` a secas no lo alcanza — el índice guarda `undefined`
// en su propio rango — y esa fila faltante dejaba `admins` en cero, que era el
// aviso entero perdido en silencio. Se leen los DOS rangos del índice en vez de
// filtrar después del `.take()`: filtrar después vuelve a apagar el aviso en
// cuanto 25 admins desactivados ordenan antes que los vivos.
export const adminRecipientsEffect = Effect.fn('TeamAlerts.adminRecipients')(function* (
  ctx: MutationCtx
) {
  const active = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_role_isActive', (q) => q.eq('role', 'ADMIN').eq('isActive', true))
      .take(MAX_TEAM_ALERT_RECIPIENTS)
  )
  const unset = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_role_isActive', (q) => q.eq('role', 'ADMIN').eq('isActive', undefined))
      .take(MAX_TEAM_ALERT_RECIPIENTS)
  )
  return [...active, ...unset].slice(0, MAX_TEAM_ALERT_RECIPIENTS)
})

const openBatch = Effect.fn('TeamAlerts.openBatch')(function* (
  ctx: MutationCtx,
  batchKey: string,
  now: number
) {
  const latest = yield* convexPromise(() =>
    ctx.db
      .query('teamAlerts')
      .withIndex('by_batchKey', (q) => q.eq('batchKey', batchKey))
      .order('desc')
      .first()
  )
  if (!latest) return null
  if (latest.emailDispatchedAt !== undefined) return null
  return latest.lastEventAt + TEAM_ALERT_BATCH_WINDOW_MS > now ? latest : null
})

const scheduleEmail = Effect.fn('TeamAlerts.scheduleEmail')(function* (
  ctx: MutationCtx,
  alertId: Id<'teamAlerts'>,
  previousJobId: Id<'_scheduled_functions'> | undefined,
  delayMs: number
) {
  if (previousJobId) {
    yield* convexPromise(() => ctx.scheduler.cancel(previousJobId))
  }
  const emailJobId = yield* convexPromise(() =>
    ctx.scheduler.runAfter(delayMs, internal.notifications._dispatchTeamAlertEmail, { alertId })
  )
  yield* convexPromise(() => ctx.db.patch(alertId, { emailJobId }))
})

/** El debounce, recortado para que el envío nunca pase del techo de la tanda. */
function emailDelayFor(openedAt: number, now: number): number {
  const remaining = openedAt + TEAM_ALERT_EMAIL_MAX_DELAY_MS - now
  return Math.max(0, Math.min(TEAM_ALERT_EMAIL_DEBOUNCE_MS, remaining))
}

const appendToBatch = Effect.fn('TeamAlerts.appendToBatch')(function* (
  ctx: MutationCtx,
  alert: Doc<'teamAlerts'>,
  file: { fileName: string; folder?: string },
  now: number
) {
  const folders =
    file.folder && !alert.folders.includes(file.folder)
      ? [...alert.folders, file.folder].slice(0, MAX_TRACKED_FOLDERS)
      : alert.folders
  const fileNames = [...alert.fileNames, file.fileName].slice(0, MAX_TRACKED_FILE_NAMES)
  const fileCount = alert.fileCount + 1

  yield* convexPromise(() =>
    ctx.db.patch(alert._id, { fileCount, folders, fileNames, lastEventAt: now })
  )

  const copy = copyFor({
    kind: alert.kind,
    companyName: alert.companyName,
    fileCount,
    folders,
  })
  // Una campanita ya borrada (a mano, o por la purga de leídas) no se resucita
  // y sobre todo no puede abortar el resto de la tanda.
  //
  // `isRead: false` porque la tanda CRECIÓ: quien ya la había leído leyó otra
  // cosa (un archivo, no cinco), y dejarla marcada le esconde el resto.
  for (const notificationId of alert.notificationIds) {
    if (yield* convexPromise(() => ctx.db.get(notificationId))) {
      yield* convexPromise(() => ctx.db.patch(notificationId, { ...copy, isRead: false }))
    }
  }

  yield* scheduleEmail(ctx, alert._id, alert.emailJobId, emailDelayFor(alert.openedAt, now))
})

const openNewBatch = Effect.fn('TeamAlerts.openNewBatch')(function* (
  ctx: MutationCtx,
  args: {
    kind: TeamAlertKind
    batchKey: string
    companyId?: Id<'companies'>
    companyName: string
    link: string
    fileName?: string
    folder?: string
    emailDelayMs: number
  },
  now: number
) {
  const admins = yield* adminRecipientsEffect(ctx)
  // Cero destinatarios NO puede ser un `return` mudo: la fila es el único
  // registro de que el cliente se movió, y sin ella el equipo que se dé de alta
  // después no tiene nada que mirar. Se escribe igual, sin campanitas y sin
  // correo, y se deja el ruido en el log del deployment.
  if (admins.length === 0) {
    yield* Effect.logWarning(
      `[teamAlerts] tanda ${args.batchKey} sin destinatarios ADMIN: se registra la fila, ` +
        'pero no hay campanita ni correo'
    )
  }

  const folders = args.folder ? [args.folder] : []
  const fileNames = args.fileName ? [args.fileName] : []
  const fileCount = args.fileName ? 1 : 0

  const alertId = yield* convexPromise(() =>
    ctx.db.insert('teamAlerts', {
      kind: args.kind,
      batchKey: args.batchKey,
      companyId: args.companyId,
      companyName: args.companyName,
      link: args.link,
      fileCount,
      folders,
      fileNames,
      notificationIds: [],
      openedAt: now,
      lastEventAt: now,
    })
  )

  const copy = copyFor({
    kind: args.kind,
    companyName: args.companyName,
    fileCount,
    folders,
  })
  const notificationIds: Array<Id<'notifications'>> = []
  for (const admin of admins) {
    notificationIds.push(
      yield* convexPromise(() =>
        ctx.db.insert('notifications', {
          userId: admin._id,
          type: 'system',
          title: copy.title,
          message: copy.message,
          link: args.link,
          isRead: false,
          entityType: 'team_alert',
          entityId: alertId,
        })
      )
    )
  }
  yield* convexPromise(() => ctx.db.patch(alertId, { notificationIds }))

  yield* scheduleEmail(ctx, alertId, undefined, args.emailDelayMs)
})

/** Subida del cliente dentro de la sala de su empresa. */
const recordVdrUploadEffect = Effect.fn('TeamAlerts.recordVdrUpload')(function* (
  ctx: MutationCtx,
  args: { companyId: Id<'companies'>; fileName: string; folder?: string }
) {
  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) return

  const now = Date.now()
  const batchKey = `vdr:${args.companyId}`
  const existing = yield* openBatch(ctx, batchKey, now)
  if (existing) {
    yield* appendToBatch(ctx, existing, { fileName: args.fileName, folder: args.folder }, now)
    return
  }
  yield* openNewBatch(
    ctx,
    {
      kind: 'COMPANY_DOCUMENTS_UPLOADED',
      batchKey,
      companyId: args.companyId,
      companyName: normalizeCompanyName(company.name) ?? UNIDENTIFIED_COMPANY,
      link: roomPath(args.companyId),
      fileName: args.fileName,
      folder: args.folder,
      emailDelayMs: TEAM_ALERT_EMAIL_DEBOUNCE_MS,
    },
    now
  )
})

export function recordVdrUpload(
  ctx: MutationCtx,
  args: { companyId: Id<'companies'>; fileName: string; folder?: string }
): Promise<void> {
  return runConvex(recordVdrUploadEffect(ctx, args))
}

/** Subida anónima en /mycroft, antes de que exista la empresa. */
const recordIntakeUploadEffect = Effect.fn('TeamAlerts.recordIntakeUpload')(function* (
  ctx: MutationCtx,
  args: { intakeSessionId: Id<'intakeSessions'>; fileName: string }
) {
  const session = yield* convexPromise(() => ctx.db.get(args.intakeSessionId))
  if (!session) return

  const now = Date.now()
  const batchKey = `intake:${args.intakeSessionId}`
  const existing = yield* openBatch(ctx, batchKey, now)
  if (existing) {
    yield* appendToBatch(ctx, existing, { fileName: args.fileName }, now)
    return
  }

  // Una sesión ya reclamada tiene empresa: el aviso apunta a su sala. Antes del
  // claim solo existe el nombre que la persona escribió en /mycroft.
  const claimedCompanyId = session.claimedCompanyId
  const claimed = claimedCompanyId ? yield* convexPromise(() => ctx.db.get(claimedCompanyId)) : null
  const companyName =
    normalizeCompanyName(claimed?.name ?? session.identityEvidence?.name) ?? UNIDENTIFIED_COMPANY

  yield* openNewBatch(
    ctx,
    {
      kind: 'COMPANY_DOCUMENTS_UPLOADED',
      batchKey,
      companyId: claimed?._id,
      companyName,
      link: roomPath(claimed?._id),
      fileName: args.fileName,
      emailDelayMs: TEAM_ALERT_EMAIL_DEBOUNCE_MS,
    },
    now
  )
})

export function recordIntakeUpload(
  ctx: MutationCtx,
  args: { intakeSessionId: Id<'intakeSessions'>; fileName: string }
): Promise<void> {
  return runConvex(recordIntakeUploadEffect(ctx, args))
}

/**
 * El claim le pone empresa a una sesión que empezó anónima. El aviso de esa
 * tanda nació con `companyId` vacío y link a `/admin/companies`, y nunca se
 * volvía a tocar: el equipo abría el listado entero a adivinar cuál de todas
 * era. Acá se reapunta a la sala real — todas las filas de ese `batchKey`,
 * porque una ventana vencida pudo dejar más de una.
 */
const attachCompanyToIntakeAlertEffect = Effect.fn('TeamAlerts.attachCompanyToIntakeAlert')(
  function* (
    ctx: MutationCtx,
    args: { intakeSessionId: Id<'intakeSessions'>; companyId: Id<'companies'> }
  ) {
    const company = yield* convexPromise(() => ctx.db.get(args.companyId))
    if (!company) return

    const alerts = yield* convexPromise(() =>
      ctx.db
        .query('teamAlerts')
        .withIndex('by_batchKey', (q) => q.eq('batchKey', `intake:${args.intakeSessionId}`))
        .collect()
    )

    const link = roomPath(args.companyId)
    // El nombre provisional del alta no puede rebajar el que la persona declaró
    // en /mycroft: solo lo reemplaza uno confirmado. Y si el aviso todavía no
    // tiene nombre, el de la fila es mejor que nada.
    const confirmed = yield* confirmedCompanyName(ctx, args.companyId)
    for (const alert of alerts) {
      if (alert.companyId === args.companyId && alert.link === link) continue
      const companyName =
        confirmed ??
        (alert.companyName === UNIDENTIFIED_COMPANY
          ? (normalizeCompanyName(company.name) ?? alert.companyName)
          : alert.companyName)
      yield* convexPromise(() =>
        ctx.db.patch(alert._id, { companyId: args.companyId, companyName, link })
      )

      const copy = copyFor({
        kind: alert.kind,
        companyName,
        fileCount: alert.fileCount,
        folders: alert.folders,
      })
      // El aviso cambió de destino: quien ya lo había leído leyó el genérico.
      for (const notificationId of alert.notificationIds) {
        if (yield* convexPromise(() => ctx.db.get(notificationId))) {
          yield* convexPromise(() => ctx.db.patch(notificationId, { ...copy, link, isRead: false }))
        }
      }
    }
  }
)

export function attachCompanyToIntakeAlert(
  ctx: MutationCtx,
  args: { intakeSessionId: Id<'intakeSessions'>; companyId: Id<'companies'> }
): Promise<void> {
  return runConvex(attachCompanyToIntakeAlertEffect(ctx, args))
}

/** Alta del espacio de una empresa en su primer login. Una vez por empresa. */
const recordCompanyWorkspaceCreatedEffect = Effect.fn('TeamAlerts.recordCompanyWorkspaceCreated')(
  function* (ctx: MutationCtx, args: { companyId: Id<'companies'> }) {
    const company = yield* convexPromise(() => ctx.db.get(args.companyId))
    if (!company) return

    const batchKey = `workspace:${args.companyId}`
    // El alta no tiene ventana: si ya se avisó una vez, no se vuelve a avisar
    // aunque la mutación de aprovisionamiento se repita.
    const already = yield* convexPromise(() =>
      ctx.db
        .query('teamAlerts')
        .withIndex('by_batchKey', (q) => q.eq('batchKey', batchKey))
        .first()
    )
    if (already) return

    yield* openNewBatch(
      ctx,
      {
        kind: 'COMPANY_WORKSPACE_CREATED',
        batchKey,
        companyId: args.companyId,
        companyName: normalizeCompanyName(company.name) ?? UNIDENTIFIED_COMPANY,
        link: roomPath(args.companyId),
        emailDelayMs: 0,
      },
      Date.now()
    )
  }
)

export function recordCompanyWorkspaceCreated(
  ctx: MutationCtx,
  args: { companyId: Id<'companies'> }
): Promise<void> {
  return runConvex(recordCompanyWorkspaceCreatedEffect(ctx, args))
}

/**
 * Cierra la tanda y manda el correo del equipo. `emailDispatchedAt` se escribe
 * ANTES de encolar: un reintento del job encuentra la tanda cerrada y no
 * duplica el envío.
 *
 * Los destinatarios salen de las campanitas que ESTA tanda creó, no de una
 * consulta nueva: quien recibió el aviso in-app es exactamente quien recibe el
 * correo, aunque el equipo haya cambiado durante la ventana.
 */
const dispatchTeamAlertEmailEffect = Effect.fn('TeamAlerts.dispatchEmail')(function* (
  ctx: MutationCtx,
  args: { alertId: Id<'teamAlerts'> }
) {
  const alert = yield* convexPromise(() => ctx.db.get(args.alertId))
  if (!alert || alert.emailDispatchedAt !== undefined) return

  yield* convexPromise(() => ctx.db.patch(alert._id, { emailDispatchedAt: Date.now() }))

  // GEMELAS. `by_batchKey` no es un índice único, y nada dentro de UNA
  // transacción puede ver la fila que otra está insertando: si dos `finalize`
  // concurrentes no encuentran tanda abierta, el único que puede colapsarlos es
  // el OCC de Convex al hacer commit (las dos leyeron el mismo rango del índice
  // que la otra escribe), y eso es un comportamiento del backend, no una
  // garantía que este módulo pueda probar. Así que el correo se deduplica acá,
  // que es donde sí se ven las dos filas: una tanda cuya gemela ya despachó
  // dentro de la misma ventana se cierra sin enviar. Las campanitas duplicadas
  // de ese caso siguen siendo posibles; el correo, no.
  //
  // La ventana es la de GEMELAS (segundos), no la de la tanda (minutos). Una
  // tanda posterior legítima comparte `batchKey` con la anterior y se abre
  // dentro del mismo cuarto de hora: medirla contra la ventana de tanda la
  // silenciaba entera.
  const siblings = yield* convexPromise(() =>
    ctx.db
      .query('teamAlerts')
      .withIndex('by_batchKey', (q) => q.eq('batchKey', alert.batchKey))
      .collect()
  )
  const twinAlreadySent = siblings.some(
    (row) =>
      row._id !== alert._id &&
      row.emailDispatchedAt !== undefined &&
      Math.abs(row.openedAt - alert.openedAt) <= TEAM_ALERT_TWIN_WINDOW_MS
  )
  if (twinAlreadySent) return

  // El nombre pudo aterrizar DESPUÉS de abrir la tanda: se resuelve acá, se
  // corrige la fila y las campanitas que sigan vivas, y el correo sale con el
  // nombre de hoy. `isRead` no se toca: corregir un nombre no es contenido
  // nuevo para quien ya leyó el aviso.
  const companyName = alert.companyId
    ? ((yield* confirmedCompanyName(ctx, alert.companyId)) ?? alert.companyName)
    : alert.companyName
  if (companyName !== alert.companyName) {
    yield* convexPromise(() => ctx.db.patch(alert._id, { companyName }))
    const copy = copyFor({
      kind: alert.kind,
      companyName,
      fileCount: alert.fileCount,
      folders: alert.folders,
    })
    for (const notificationId of alert.notificationIds) {
      if (yield* convexPromise(() => ctx.db.get(notificationId))) {
        yield* convexPromise(() => ctx.db.patch(notificationId, copy))
      }
    }
  }

  const recipients = new Set<Id<'profiles'>>()
  for (const notificationId of alert.notificationIds) {
    const notification = yield* convexPromise(() => ctx.db.get(notificationId))
    if (notification) recipients.add(notification.userId)
  }

  for (const recipientProfileId of recipients) {
    yield* convexPromise(() =>
      sendTeamAlertEmail(ctx, {
        recipientProfileId,
        kind: alert.kind,
        companyName,
        fileCount: alert.fileCount,
        folders: alert.folders,
        fileNames: alert.fileNames,
        link: alert.link,
      })
    )
  }
})

export function dispatchTeamAlertEmail(
  ctx: MutationCtx,
  args: { alertId: Id<'teamAlerts'> }
): Promise<void> {
  return runConvex(dispatchTeamAlertEmailEffect(ctx, args))
}
