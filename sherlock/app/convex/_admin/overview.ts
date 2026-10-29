// ============================================================================
// VISTA GENERAL DEL EQUIPO — una sola pantalla, densa, sin cards decorativas
// ============================================================================
// El equipo son dos personas. Lo que necesitan al abrir `/admin` es una tabla
// de empresas con su sala, los avisos que llegaron, la bandeja de soporte y el
// consumo del plan Starter de Convex. Todo lo demás son enlaces.
//
// TODA lectura es ACOTADA. Convex cobra por documento leído y una consulta que
// escanea sin tope se degrada en silencio hasta que la tabla crece: cada `take`
// pide un elemento de más para poder DECIR que truncó en vez de mentir con un
// total incompleto. Los conteos que salen de acá son mínimos verificables, no
// agregados de base de datos.
//
// Las funciones son puras sobre `QueryCtx`: la autorización vive en los
// `query()` de `convex/adminOverview.ts`, y los tests las ejercitan directo.
// ============================================================================

import { Effect } from 'effect'

import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { normalizeCompanyName } from '../_helpers/companyName'
import { convexPromise, runConvex } from '../_helpers/effect'
import type { AppError } from '../_helpers/errors'
import { supportScopeKey } from '../_support/model'
import {
  VDR_SHELL_FOLDER_VALUES,
  getVdrShellFolderValue,
} from '../../src/lib/vdr/document-taxonomy'

const ADMIN_OVERVIEW_COMPANY_CAP = 50
const ADMIN_OVERVIEW_DOCUMENT_CAP = 500
const ADMIN_OVERVIEW_VERSION_CAP = 500
const ADMIN_OVERVIEW_ALERT_CAP = 12
const ADMIN_OVERVIEW_SUPPORT_CAP = 10
const ADMIN_OVERVIEW_ROLE_CAP = 500

/** Plan Starter de Convex: 1 GiB de archivos. El egreso no es legible desde la base. */
export const CONVEX_STARTER_STORAGE_BYTES = 1024 * 1024 * 1024

type AdminOverviewFolderCounts = {
  room_legal: number
  room_corporate: number
  room_financial: number
  room_operations: number
  room_marketing: number
}

export type AdminOverviewCompanyRow = {
  companyId: Id<'companies'>
  name: string
  ownerEmail: string | null
  documentsTotal: number
  documentsByFolder: AdminOverviewFolderCounts
  storageBytes: number
  lastUploadAt: number | null
  deliverableVersions: number
  supportUnread: number
  truncated: boolean
}

export type AdminOverviewAlert = {
  alertId: Id<'teamAlerts'>
  kind: Doc<'teamAlerts'>['kind']
  companyId: Id<'companies'> | null
  companyName: string
  link: string
  fileCount: number
  folders: string[]
  openedAt: number
  lastEventAt: number
  isRead: boolean
}

export type AdminOverviewSupportThread = {
  threadId: Id<'supportThreads'>
  companyId: Id<'companies'> | null
  roomLabel: string | null
  scopeKind: 'COMPANY' | 'INTAKE'
  unreadCount: number
  lastMessageAt: number
}

export type AdminOverviewUsage = {
  companies: number
  documents: number
  storageBytes: number
  storageCapBytes: number
  usersByRole: { ADMIN: number; COMPANY: number }
  truncated: boolean
}

function emptyFolderCounts(): AdminOverviewFolderCounts {
  return {
    room_legal: 0,
    room_corporate: 0,
    room_financial: 0,
    room_operations: 0,
    room_marketing: 0,
  }
}

function countFolder(counts: AdminOverviewFolderCounts, folder: string | undefined): void {
  const shellFolder = getVdrShellFolderValue(folder)
  if (VDR_SHELL_FOLDER_VALUES.includes(shellFolder)) {
    counts[shellFolder as keyof AdminOverviewFolderCounts] += 1
  }
}

const ownerEmailFor = Effect.fn('AdminOverview.ownerEmail')(function* (
  ctx: QueryCtx,
  company: Doc<'companies'>
) {
  const owner = yield* convexPromise(() => ctx.db.get(company.ownerId))
  if (!owner) return null
  const user = yield* convexPromise(() => ctx.db.get(owner.userId))
  return user?.email ?? null
})

/**
 * Una fila por empresa. Los bytes salen de las VERSIONES, que es lo que ocupa
 * el storage: un documento con tres versiones pesa tres veces. Los documentos
 * anteriores a la migración de versiones (`currentVersionId` ausente) aportan
 * su `fileSize` para que la fila no subestime la custodia legacy.
 */
const buildCompanyRow = Effect.fn('AdminOverview.companyRow')(function* (
  ctx: QueryCtx,
  company: Doc<'companies'>
): Effect.fn.Return<AdminOverviewCompanyRow, AppError> {
  const documentRows = yield* convexPromise(() =>
    ctx.db
      .query('documents')
      .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
      .take(ADMIN_OVERVIEW_DOCUMENT_CAP + 1)
  )
  const versionRows = yield* convexPromise(() =>
    ctx.db
      .query('documentVersions')
      .withIndex('by_company_createdAt', (q) => q.eq('companyId', company._id))
      .take(ADMIN_OVERVIEW_VERSION_CAP + 1)
  )

  const documents = documentRows.slice(0, ADMIN_OVERVIEW_DOCUMENT_CAP)
  const versions = versionRows.slice(0, ADMIN_OVERVIEW_VERSION_CAP)

  const documentsByFolder = emptyFolderCounts()
  let storageBytes = 0
  let lastUploadAt: number | null = null

  for (const document of documents) {
    if (document.lifecycleStatus === 'ARCHIVED') continue
    countFolder(documentsByFolder, document.folder)
    if (document.currentVersionId === undefined) {
      storageBytes += document.fileSize ?? 0
    }
    const uploadedAt = document.updatedAt ?? document._creationTime
    if (lastUploadAt === null || uploadedAt > lastUploadAt) lastUploadAt = uploadedAt
  }

  let deliverableVersions = 0
  for (const version of versions) {
    storageBytes += version.byteSize
    if (version.deliveryLabel !== undefined) deliverableVersions += 1
    if (lastUploadAt === null || version.createdAt > lastUploadAt) lastUploadAt = version.createdAt
  }

  const thread = yield* convexPromise(() =>
    ctx.db
      .query('supportThreads')
      .withIndex('by_scopeKey', (q) =>
        q.eq('scopeKey', supportScopeKey({ kind: 'COMPANY', companyId: company._id }))
      )
      .first()
  )

  return {
    companyId: company._id,
    name: company.name,
    ownerEmail: yield* ownerEmailFor(ctx, company),
    documentsTotal: documents.filter((document) => document.lifecycleStatus !== 'ARCHIVED').length,
    documentsByFolder,
    storageBytes,
    lastUploadAt,
    deliverableVersions,
    supportUnread: thread?.adminUnreadCount ?? 0,
    truncated:
      documentRows.length > ADMIN_OVERVIEW_DOCUMENT_CAP ||
      versionRows.length > ADMIN_OVERVIEW_VERSION_CAP,
  }
})

const buildCompanyRowsEffect = Effect.fn('AdminOverview.companyRows')(function* (ctx: QueryCtx) {
  const companyRows = yield* convexPromise(() =>
    ctx.db
      .query('companies')
      .order('desc')
      .take(ADMIN_OVERVIEW_COMPANY_CAP + 1)
  )
  const companies = companyRows.slice(0, ADMIN_OVERVIEW_COMPANY_CAP)

  const rows: AdminOverviewCompanyRow[] = []
  for (const company of companies) {
    rows.push(yield* buildCompanyRow(ctx, company))
  }

  // La sala que se movió de último va primero: es la que el equipo abre.
  rows.sort((left, right) => (right.lastUploadAt ?? 0) - (left.lastUploadAt ?? 0))

  return {
    rows,
    truncated: companyRows.length > ADMIN_OVERVIEW_COMPANY_CAP || rows.some((row) => row.truncated),
  }
})

export function buildCompanyRows(
  ctx: QueryCtx
): Promise<{ rows: AdminOverviewCompanyRow[]; truncated: boolean }> {
  return runConvex(buildCompanyRowsEffect(ctx))
}

/**
 * Los avisos más nuevos. `isRead` es del ADMIN QUE MIRA: la campanita que la
 * tanda le creó a él. Si su fila ya no existe (purga de leídas, borrado a
 * mano), el aviso cuenta como leído — no se resucita para volver a gritar.
 *
 * La excepción es una tanda que NUNCA repartió campanitas
 * (`notificationIds: []`, lo que deja `openNewBatch` cuando el deployment no
 * tenía ni un ADMIN): ahí nadie leyó nada. Esa fila existe precisamente para
 * que el equipo que se dé de alta después la vea, y darla por leída la
 * enterraba en el mismo silencio que la fila venía a romper.
 */
const buildTeamAlertsEffect = Effect.fn('AdminOverview.teamAlerts')(function* (
  ctx: QueryCtx,
  viewerProfileId: Id<'profiles'>
) {
  const alerts = yield* convexPromise(() =>
    ctx.db.query('teamAlerts').withIndex('by_openedAt').order('desc').take(ADMIN_OVERVIEW_ALERT_CAP)
  )

  const projected: AdminOverviewAlert[] = []
  const companyNames = new Map<Id<'companies'>, string>()
  for (const alert of alerts) {
    let companyName = normalizeCompanyName(alert.companyName) ?? 'Empresa sin identificar'
    if (alert.companyId) {
      const companyId = alert.companyId
      let currentName = companyNames.get(companyId)
      if (currentName === undefined) {
        const checklist = yield* convexPromise(() =>
          ctx.db
            .query('companyChecklist')
            .withIndex('by_companyId', (q) => q.eq('companyId', companyId))
            .first()
        )
        const company = checklist?.nameConfirmedAt
          ? yield* convexPromise(() => ctx.db.get(companyId))
          : null
        currentName = normalizeCompanyName(company?.name) ?? 'Empresa sin identificar'
        companyNames.set(companyId, currentName)
      }
      companyName = currentName
    }
    let isRead = alert.notificationIds.length > 0
    for (const notificationId of alert.notificationIds) {
      const notification = yield* convexPromise(() => ctx.db.get(notificationId))
      if (notification?.userId !== viewerProfileId) continue
      isRead = notification.isRead === true
      break
    }
    projected.push({
      alertId: alert._id,
      kind: alert.kind,
      companyId: alert.companyId ?? null,
      companyName,
      link: alert.link,
      fileCount: alert.fileCount,
      folders: alert.folders,
      openedAt: alert.openedAt,
      lastEventAt: alert.lastEventAt,
      isRead,
    })
  }
  return projected
})

export function buildTeamAlerts(
  ctx: QueryCtx,
  viewerProfileId: Id<'profiles'>
): Promise<AdminOverviewAlert[]> {
  return runConvex(buildTeamAlertsEffect(ctx, viewerProfileId))
}

/** Solo los hilos que esperan respuesta del equipo. Un cero es una bandeja vacía. */
const buildSupportInboxEffect = Effect.fn('AdminOverview.supportInbox')(function* (ctx: QueryCtx) {
  const threads = yield* convexPromise(() =>
    ctx.db
      .query('supportThreads')
      .withIndex('by_adminUnread_lastMessageAt', (q) => q.eq('adminUnread', true))
      .order('desc')
      .take(ADMIN_OVERVIEW_SUPPORT_CAP)
  )

  const projected: AdminOverviewSupportThread[] = []
  let unreadMessages = 0
  for (const thread of threads) {
    unreadMessages += thread.adminUnreadCount
    if (thread.scope.kind === 'COMPANY') {
      // El id se saca ANTES del cierre: la estrechez del discriminante no viaja
      // adentro de la lambda.
      const companyId = thread.scope.companyId
      const company = yield* convexPromise(() => ctx.db.get(companyId))
      projected.push({
        threadId: thread._id,
        companyId: company?._id ?? null,
        roomLabel: company?.name ?? null,
        scopeKind: 'COMPANY',
        unreadCount: thread.adminUnreadCount,
        lastMessageAt: thread.lastMessageAt,
      })
      continue
    }
    projected.push({
      threadId: thread._id,
      companyId: null,
      roomLabel: null,
      scopeKind: 'INTAKE',
      unreadCount: thread.adminUnreadCount,
      lastMessageAt: thread.lastMessageAt,
    })
  }

  return { threads: projected, unreadThreads: projected.length, unreadMessages }
})

export function buildSupportInbox(ctx: QueryCtx): Promise<{
  threads: AdminOverviewSupportThread[]
  unreadThreads: number
  unreadMessages: number
}> {
  return runConvex(buildSupportInboxEffect(ctx))
}

const countRole = Effect.fn('AdminOverview.countRole')(function* (
  ctx: QueryCtx,
  role: Doc<'profiles'>['role']
) {
  const rows = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_role', (q) => q.eq('role', role))
      .take(ADMIN_OVERVIEW_ROLE_CAP)
  )
  return rows.length
})

/**
 * Consumo del plan. El storage se suma de las mismas filas de empresa que ya se
 * leyeron: nada de un segundo escaneo de `documentVersions` para el mismo dato.
 */
const buildConvexUsageEffect = Effect.fn('AdminOverview.convexUsage')(function* (
  ctx: QueryCtx,
  companyRows: AdminOverviewCompanyRow[],
  truncated: boolean
): Effect.fn.Return<AdminOverviewUsage, AppError> {
  const admins = yield* countRole(ctx, 'ADMIN')
  const companyProfiles = yield* countRole(ctx, 'COMPANY')

  return {
    companies: companyRows.length,
    documents: companyRows.reduce((total, row) => total + row.documentsTotal, 0),
    storageBytes: companyRows.reduce((total, row) => total + row.storageBytes, 0),
    storageCapBytes: CONVEX_STARTER_STORAGE_BYTES,
    usersByRole: { ADMIN: admins, COMPANY: companyProfiles },
    truncated,
  }
})

export function buildConvexUsage(
  ctx: QueryCtx,
  companyRows: AdminOverviewCompanyRow[],
  truncated: boolean
): Promise<AdminOverviewUsage> {
  return runConvex(buildConvexUsageEffect(ctx, companyRows, truncated))
}

const buildAdminOverviewEffect = Effect.fn('AdminOverview.build')(function* (
  ctx: QueryCtx,
  viewerProfileId: Id<'profiles'>
) {
  const { rows, truncated } = yield* buildCompanyRowsEffect(ctx)
  const alerts = yield* buildTeamAlertsEffect(ctx, viewerProfileId)
  const support = yield* buildSupportInboxEffect(ctx)
  const usage = yield* buildConvexUsageEffect(ctx, rows, truncated)

  return {
    companies: rows,
    alerts,
    support,
    usage,
    coverage: { truncated, companyCap: ADMIN_OVERVIEW_COMPANY_CAP },
    generatedAt: Date.now(),
  }
})

export function buildAdminOverview(ctx: QueryCtx, viewerProfileId: Id<'profiles'>) {
  return runConvex(buildAdminOverviewEffect(ctx, viewerProfileId))
}
