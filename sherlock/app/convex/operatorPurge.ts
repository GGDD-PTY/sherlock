// ============================================================================
// PURGA FÍSICA DE OPERADOR
// ============================================================================
// `documents:remove` (`_documents/mutations.ts:472`) ARCHIVA: conserva bytes,
// hashes y versiones a propósito, y su propio comentario anuncia que "la purga
// física será un flujo separado". Esto es ese flujo. Valida el lote entero,
// borra sus filas de custodia y elimina una sola vez cada blob sin dueño vivo.
//
// CONTROL DE ACCESO: `internalMutation`, alcanzable solo con la deploy key del
// deployment. La lista de ids es explícita y cada id se verifica contra la
// empresa nombrada. El nombre de la empresa viaja como oráculo humano, no como
// bandera.
//
// NO toca la burbuja de model-runs, `documentAccessLogs`, `vdrReadAudits` ni
// legal holds liberados. Agrega un `adminAuditLogs` honesto por ejecución.
//
// La SEGUNDA mitad de este archivo (abajo, «PURGA DE UNA EMPRESA COMPLETA»)
// sí borra por empresa: otro eje, otras confirmaciones, mismo módulo.
// ============================================================================

import { v } from 'convex/values'
import { Effect } from 'effect'

import { internal } from './_generated/api'
import type { Doc, Id, TableNames } from './_generated/dataModel'
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server'
import {
  buildDocumentPurgePlan,
  executeDocumentPurgePlan,
  loadValidatedPurgeDocuments,
  storageHasLiveOwner,
} from './_documents/purge'
import { logAdminAction } from './_helpers/auditLog'
import { convexPromise, runConvex } from './_helpers/effect'
import type { AppError } from './_helpers/errors'
import { notFound, validationFailed } from './_helpers/errors'

const deleteDocumentsHardProgram = Effect.fn('Purge.deleteDocumentsHard')(function* (
  ctx: MutationCtx,
  args: {
    companyId: Id<'companies'>
    documentIds: Array<Id<'documents'>>
    operatorProfileId: Id<'profiles'>
    confirmCompanyName: string
    reason: string
    execute?: boolean
  }
) {
  const execute = args.execute === true
  const reason = args.reason.trim()
  if (!reason) {
    return yield* Effect.fail(validationFailed('La razón de la purga es obligatoria.', 'reason'))
  }

  const operator = yield* convexPromise(() => ctx.db.get(args.operatorProfileId))
  if (!operator || operator.role !== 'ADMIN') {
    return yield* Effect.fail(
      validationFailed('operatorProfileId debe identificar un perfil ADMIN real.')
    )
  }
  if (operator.isActive === false) {
    return yield* Effect.fail(validationFailed('El perfil ADMIN operador debe estar activo.'))
  }
  const operatorUser = yield* convexPromise(() => ctx.db.get(operator.userId))
  if (!operatorUser) {
    return yield* Effect.fail(notFound('Usuario del operador ADMIN', `${operator.userId}`))
  }

  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) return yield* Effect.fail(notFound('Company', args.companyId))
  if (args.confirmCompanyName !== company.name) {
    return yield* Effect.fail(
      validationFailed(
        `confirmCompanyName no coincide con el nombre de la empresa. Escribe exactamente: ${company.name}`
      )
    )
  }

  const documents = yield* convexPromise(() =>
    loadValidatedPurgeDocuments(ctx, args.companyId, args.documentIds)
  )
  const plan = yield* convexPromise(() => buildDocumentPurgePlan(ctx, documents))

  const summary = {
    execute,
    company: company.name,
    documents: plan.rows.map((rowPlan) => ({
      id: rowPlan.document._id,
      name: rowPlan.document.name,
      versions: rowPlan.versions.length,
      grants: rowPlan.grants.length,
      textRows: rowPlan.textRows.length,
      blobs: plan.blobs.filter((blob) => blob.documentIds.includes(rowPlan.document._id)).length,
    })),
    totals: {
      documents: plan.rows.length,
      versions: plan.rows.reduce((n, rowPlan) => n + rowPlan.versions.length, 0),
      grants: plan.rows.reduce((n, rowPlan) => n + rowPlan.grants.length, 0),
      textRows: plan.rows.reduce((n, rowPlan) => n + rowPlan.textRows.length, 0),
      blobs: plan.blobs.length,
    },
  }

  if (!execute) return summary

  yield* convexPromise(() => executeDocumentPurgePlan(ctx, plan))
  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: operator._id,
      adminEmail: operatorUser.email,
      action: 'DOCUMENT_PURGE',
      targetType: 'DOCUMENT',
      targetId: args.documentIds.map((id) => `${id}`).join(','),
      previousValue: {
        documents: plan.rows.map(({ document }) => ({
          id: `${document._id}`,
          name: document.name,
          lifecycleStatus: document.lifecycleStatus ?? null,
        })),
      },
      newValue: { reason, totals: summary.totals },
      notes: reason,
    })
  )

  return summary
})

export const deleteDocumentsHard = internalMutation({
  args: {
    companyId: v.id('companies'),
    documentIds: v.array(v.id('documents')),
    operatorProfileId: v.id('profiles'),
    confirmCompanyName: v.string(),
    reason: v.string(),
    execute: v.optional(v.boolean()),
  },
  handler: (ctx, args) => runConvex(deleteDocumentsHardProgram(ctx, args)),
})

// ============================================================================
// PURGA DE UNA EMPRESA COMPLETA (Convex) + BARRIDO DE SEMILLAS
// ============================================================================
// `deleteDocumentsHard` (arriba) borra un LOTE DE DOCUMENTOS con ids explícitos.
// Esto es el otro eje: la empresa entera — sala, grants, corridas, bitácoras de
// lectura — para las empresas de PRUEBA que quedaron en prod (45 de 48 el
// 2026-09-02). No hay cascada en Convex ni FK: cada tabla
// con `companyId` se decide a mano en `COMPANY_PURGE_TABLE_PLAN` y este archivo
// es el inventario ejecutable de esa decisión.
//
// TRES REGLAS QUE NO SE NEGOCIAN
//   1. `confirmName` tiene que ser IDÉNTICO al nombre de la empresa. Es un
//      oráculo humano, no una bandera: quien no sabe escribir el nombre no
//      estaba mirando la sala que va a borrar.
//   2. Sólo el dominio del correo del DUEÑO decide si una empresa es semilla, y
//      un solo miembro con correo real (gmail, sherlock.capital, lo que sea)
//      la saca del barrido para siempre. Las salas reales no son datos de prueba.
//   3. La bitácora (`adminAuditLogs`) y `webhookEvents` NO se tocan, y la
//      burbuja de corridas de Reviewer se MARCA, nunca se borra.
//
// LÍMITES DE CONVEX: 32.000 documentos escaneados y 16.000 escritos por
// transacción. `documentAccessLogs` y `vdrReadAudits` los rompen solas, así que
// la purga va por lotes: `take(N)` por tabla, una fila `companyPurgeRuns` como
// estado, y `ctx.scheduler.runAfter(0, …)` para el siguiente lote. Reanudable e
// idempotente: correrla sobre una empresa ya purgada responde `{ deleted: 0 }`.
//
// CONTROL DE ACCESO: `internalMutation` / `internalQuery`, alcanzables sólo con
// la deploy key del deployment. El único camino operativo es
// `scripts/operator/purge-company.mjs` (playbook en
// `llm-wiki/bundle/engineering/playbooks.md`).
// ============================================================================

/** Los tres dominios que marcan data sembrada. `seed.local` lo escriben los
 *  seeds (`_demoSeed.ts`, `scripts/demo/*`), `dev.local` el bypass de dev
 *  (`convex/devAuth.ts`) y `retired.local` el reparador de correos
 *  (`admin.ts:repairUserEmail`). Cualquier otro dominio — incluido
 *  `example.com` — cuenta como REAL y protege la empresa. */
export const SEED_OWNER_EMAIL_DOMAINS = ['seed.local', 'dev.local', 'retired.local'] as const

/** Filas leídas por tabla y por lote. Techo del inventario en dry-run y
 *  tamaño de lote por defecto en `execute`. */
export const COMPANY_PURGE_SCAN_LIMIT = 200

/** Empresas inspeccionadas por corrida del barrido. Prod tenía 48. */
export const SEED_SWEEP_SCAN_LIMIT = 500

/** Comparación por dominio EXACTO, nunca por sufijo: `owner@seed.local`
 *  termina en `seed.local` y no es una semilla. */
export function isSeedOwnerEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const at = email.lastIndexOf('@')
  if (at < 0) return false
  const domain = email.slice(at + 1).toLowerCase()
  return (SEED_OWNER_EMAIL_DOMAINS as readonly string[]).includes(domain)
}

// ---------------------------------------------------------------------------
// PLAN DE TABLAS
// ---------------------------------------------------------------------------
// Una entrada por cada tabla de `schema.ts` que lleva `companyId`. El orden es
// hijos → padre: `companies` va última y su borrado es lo que hace idempotente
// una segunda corrida.
//
// `select: 'filter'` es para las tablas sin índice por `companyId`; con índice
// se usa el prefijo (`by_company_status` con sólo `eq('companyId', …)` es un
// rango válido en Convex y en el harness de tests).

export type CompanyPurgeDecision = 'DELETE'

export type CompanyPurgeTablePlan = {
  table: TableNames
  decision: CompanyPurgeDecision
  index?: string
  /** Campo por el que se selecciona; siempre `companyId`. */
  scope?: 'company' | 'ownerProfile'
  note?: string
}

export const COMPANY_PURGE_TABLE_PLAN: CompanyPurgeTablePlan[] = [
  // --- Sala: snapshots (lo más hijo) ---
  { table: 'financialSnapshots', decision: 'DELETE', index: 'by_companyId' },
  // --- Bitácoras de lectura de la sala. Son las dos tablas que rompen el
  //     límite de transacción y la razón de que esto vaya por lotes. Su
  //     `companyId` es opcional: las filas legacy sin él no se alcanzan por
  //     este eje y quedan como ruido sin dueño (se reporta en `notes`). ---
  { table: 'documentAccessLogs', decision: 'DELETE', index: 'by_companyId_accessedAt' },
  { table: 'vdrReadAudits', decision: 'DELETE', index: 'by_company_occurredAt' },
  // --- Documentos: el cascade con blobs corre antes (ver `purgeDocumentBatch`);
  //     estas entradas recogen las filas que quedaran sin documento padre. ---
  { table: 'documentTextIndex', decision: 'DELETE' },
  { table: 'documentAccessGrants', decision: 'DELETE' },
  { table: 'documentLegalHolds', decision: 'DELETE', index: 'by_company_status' },
  { table: 'deliverables', decision: 'DELETE', index: 'by_companyId' },
  { table: 'documentVersions', decision: 'DELETE', index: 'by_company_createdAt' },
  { table: 'documents', decision: 'DELETE', index: 'by_companyId' },
  { table: 'vdrUploadIntents', decision: 'DELETE', index: 'by_company_createdAt' },
  // --- Acceso de invitados a la sala de la empresa ---
  { table: 'guestInvitations', decision: 'DELETE' },
  // --- Identidad y configuración de la empresa ---
  { table: 'companyChecklist', decision: 'DELETE', index: 'by_companyId' },
  { table: 'companyInferenceCredentials', decision: 'DELETE', index: 'by_companyId' },
  { table: 'adminVdrCapabilities', decision: 'DELETE' },
  { table: 'companyAuthorizationInventoryRows', decision: 'DELETE', index: 'by_companyId' },
  { table: 'companyOrganizationBindings', decision: 'DELETE', index: 'by_companyId' },
  { table: 'teamAlerts', decision: 'DELETE' },
]

/** Tablas que la purga NO toca a propósito, con su razón. Vive junto al plan
 *  para que el inventario del reporte sea completo. */
export const COMPANY_PURGE_PRESERVED_TABLES: Array<{ table: string; why: string }> = [
  { table: 'adminAuditLogs', why: 'la bitácora del equipo sobrevive a lo que audita' },
  { table: 'webhookEvents', why: 'idempotencia de webhooks: borrarla reabre reprocesos' },
  {
    table: 'intakeSubmissions',
    why: '`claimedCompanyId` queda colgando; la sesión de intake caduca sola por `absoluteExpiresAt`',
  },
]

// ---------------------------------------------------------------------------
// SELECCIÓN DE FILAS POR EMPRESA
// ---------------------------------------------------------------------------

type CompanyScopeId = Id<'companies'> | Id<'profiles'>

/** Un lote de filas de `entry.table` que pertenecen a `scopeId`. Con índice usa
 *  el prefijo `eq('companyId', …)`; sin índice, `filter` sobre el mismo campo.
 *  Nunca devuelve más de `limit`, que es lo que mantiene cada lote dentro de
 *  los límites de transacción de Convex. */
const takeCompanyRows = Effect.fn('Purge.takeCompanyRows')(function* (
  ctx: MutationCtx,
  entry: CompanyPurgeTablePlan,
  scopeId: CompanyScopeId,
  limit: number
): Effect.fn.Return<Array<{ _id: Id<TableNames> }>, AppError> {
  const table = entry.table as 'documents'
  const base = ctx.db.query(table)
  const scoped = entry.index
    ? base.withIndex(
        entry.index as 'by_companyId',
        (q) =>
          (q as unknown as { eq: (field: string, value: unknown) => unknown }).eq(
            'companyId',
            scopeId
          ) as never
      )
    : base.filter((q) => q.eq(q.field('companyId'), scopeId))
  return (yield* convexPromise(() => scoped.take(limit))) as unknown as Array<{
    _id: Id<TableNames>
  }>
})

/** Los blobs que cuelgan de filas que no son documentos (hoy sólo los intents
 *  de subida). Se borran uno por uno y sólo si nadie vivo los referencia:
 *  Convex revienta la mutation entera ante un doble delete del mismo blob. */
const deleteOrphanedIntentBlob = Effect.fn('Purge.deleteOrphanedIntentBlob')(function* (
  ctx: MutationCtx,
  row: { storageId?: Id<'_storage'> }
) {
  const storageId = row.storageId
  if (!storageId) return false
  if (yield* convexPromise(() => storageHasLiveOwner(ctx, storageId))) return false
  yield* convexPromise(() => ctx.storage.delete(storageId))
  return true
})

// ---------------------------------------------------------------------------
// MIEMBROS DE UNA EMPRESA (la regla que protege SAMPLE_LOGISTICS y SAMPLE_ENERGY)
// ---------------------------------------------------------------------------
// "Miembro" no existe como tabla: se deriva de quién ACTUÓ sobre la sala. Se
// leen las seis fuentes que tienen índice por empresa; los perfiles ADMIN son
// el equipo operando y se reportan aparte, porque si bloquearan, una sola
// visita de Reviewer a una sala sembrada congelaría el barrido para siempre.

type CompanyMemberScan = {
  ownerEmail: string | null
  memberEmails: string[]
  operatorEmails: string[]
}

const scanCompanyPeople = Effect.fn('Purge.scanCompanyPeople')(function* (
  ctx: MutationCtx,
  company: Doc<'companies'>
): Effect.fn.Return<CompanyMemberScan, AppError> {
  const profileIds = new Set<string>([`${company.ownerId}`])
  const add = (id: Id<'profiles'> | undefined | null) => {
    if (id) profileIds.add(`${id}`)
  }

  const bindings = yield* convexPromise(() =>
    ctx.db
      .query('companyOrganizationBindings')
      .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
      .take(COMPANY_PURGE_SCAN_LIMIT)
  )
  for (const row of bindings) {
    add(row.ownerProfileId)
    add(row.createdByProfileId)
    add(row.updatedByProfileId)
  }

  const versions = yield* convexPromise(() =>
    ctx.db
      .query('documentVersions')
      .withIndex('by_company_createdAt', (q) => q.eq('companyId', company._id))
      .take(COMPANY_PURGE_SCAN_LIMIT)
  )
  for (const row of versions) add(row.createdByProfileId)


  let ownerEmail: string | null = null
  const memberEmails: string[] = []
  const operatorEmails: string[] = []
  for (const rawId of profileIds) {
    const profile = yield* convexPromise(() => ctx.db.get(rawId as Id<'profiles'>))
    if (!profile) continue
    const user = yield* convexPromise(() => ctx.db.get(profile.userId))
    const email = user?.email ?? null
    if (`${profile._id}` === `${company.ownerId}`) ownerEmail = email
    if (!email) continue
    if (profile.role === 'ADMIN') {
      if (!operatorEmails.includes(email)) operatorEmails.push(email)
      continue
    }
    if (!memberEmails.includes(email)) memberEmails.push(email)
  }

  return { ownerEmail, memberEmails, operatorEmails }
})

/** Los perfiles ADMIN activos, para que el script de operador resuelva
 *  `--operator-email` sin ir al dashboard. Es la MISMA información que la
 *  página de usuarios del admin ya muestra, y sólo la alcanza el deploy key. */
const listAdminOperatorsProgram = Effect.fn('Purge.listAdminOperators')(function* (
  ctx: MutationCtx
) {
  const profiles = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_role', (q) => q.eq('role', 'ADMIN'))
      .take(COMPANY_PURGE_SCAN_LIMIT)
  )
  const operators = []
  for (const profile of profiles) {
    if (profile.isActive === false) continue
    const user = yield* convexPromise(() => ctx.db.get(profile.userId))
    if (!user) continue
    operators.push({ profileId: profile._id, email: user.email })
  }
  return { operators }
})

export const listAdminOperators = internalQuery({
  args: {},
  handler: (ctx) => runConvex(listAdminOperatorsProgram(ctx as unknown as MutationCtx)),
})

const listSeedSweepCandidatesProgram = Effect.fn('Purge.listSeedSweepCandidates')(function* (
  ctx: MutationCtx,
  args: { limit?: number }
) {
  const limit = Math.max(1, Math.min(args.limit ?? SEED_SWEEP_SCAN_LIMIT, SEED_SWEEP_SCAN_LIMIT))
  const companies = yield* convexPromise(() => ctx.db.query('companies').take(limit))

  const rows = []
  for (const company of companies) {
    const people = yield* scanCompanyPeople(ctx, company)
    // El dueño manda: sin correo, o con uno real, la empresa no se toca.
    const blockedBy = people.memberEmails.filter((email) => !isSeedOwnerEmail(email))
    if (!people.ownerEmail) blockedBy.unshift('(dueño sin correo)')
    else if (!isSeedOwnerEmail(people.ownerEmail) && !blockedBy.includes(people.ownerEmail)) {
      blockedBy.unshift(people.ownerEmail)
    }
    rows.push({
      companyId: company._id,
      name: company.name,
      demo: company.demo === true,
      ownerEmail: people.ownerEmail,
      memberEmails: people.memberEmails,
      operatorEmails: people.operatorEmails,
      blockedBy,
      selectable: blockedBy.length === 0,
    })
  }

  return {
    generatedAt: Date.now(),
    scanLimit: limit,
    capped: companies.length >= limit,
    seedDomains: [...SEED_OWNER_EMAIL_DOMAINS],
    companies: rows,
  }
})

export const listSeedSweepCandidates = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: (ctx, args) =>
    runConvex(listSeedSweepCandidatesProgram(ctx as unknown as MutationCtx, args)),
})

// ---------------------------------------------------------------------------
// PURGA
// ---------------------------------------------------------------------------

type PurgeTally = { deleted: number; marked: number; blobs: number }

/** Documentos: el único tramo con blobs propios. Reusa el plan de
 *  `deleteDocumentsHard` (versiones, grants, redacciones, índice de texto y
 *  blobs sin dueño vivo) en vez de reescribir el conteo de referencias. */
const purgeDocumentBatch = Effect.fn('Purge.documentBatch')(function* (
  ctx: MutationCtx,
  companyId: Id<'companies'>,
  budget: number
): Effect.fn.Return<PurgeTally, AppError> {
  const documents = yield* convexPromise(() =>
    ctx.db
      .query('documents')
      .withIndex('by_companyId', (q) => q.eq('companyId', companyId))
      .take(Math.max(1, Math.min(budget, COMPANY_PURGE_SCAN_LIMIT)))
  )
  if (documents.length === 0) return { deleted: 0, marked: 0, blobs: 0 }

  const plan = yield* convexPromise(() => buildDocumentPurgePlan(ctx, documents))
  yield* convexPromise(() => executeDocumentPurgePlan(ctx, plan))
  const deleted =
    plan.rows.length +
    plan.rows.reduce(
      (total, row) =>
        total +
        row.versions.length + row.grants.length + row.textRows.length,
      0
    )
  return { deleted, marked: 0, blobs: plan.blobs.length }
})

/** Un lote: recorre el plan en orden y gasta hasta `budget` escrituras.
 *  Devuelve `remaining: true` si alguna tabla quedó con filas. */
const runPurgePass = Effect.fn('Purge.pass')(function* (
  ctx: MutationCtx,
  company: Doc<'companies'>,
  budget: number,
  byTable: Map<string, number>
): Effect.fn.Return<PurgeTally & { remaining: boolean }, AppError> {
  let left = budget
  let deleted = 0
  let blobs = 0
  let remaining = false

  const bump = (table: string, count: number) => {
    byTable.set(table, (byTable.get(table) ?? 0) + count)
  }

  // Los documentos primero: su cascade también borra filas de tablas que el
  // plan visita después, y hacerlo al revés dejaría blobs sin dueño.
  const documentTally = yield* purgeDocumentBatch(ctx, company._id, left)
  if (documentTally.deleted > 0) {
    deleted += documentTally.deleted
    blobs += documentTally.blobs
    left -= documentTally.deleted
    bump('documents', documentTally.deleted)
  }

  for (const entry of COMPANY_PURGE_TABLE_PLAN) {
    if (left <= 0) {
      remaining = true
      break
    }
    const scopeId: CompanyScopeId = entry.scope === 'ownerProfile' ? company.ownerId : company._id
    const rows = yield* takeCompanyRows(
      ctx,
      entry,
      scopeId,
      Math.min(left, COMPANY_PURGE_SCAN_LIMIT)
    )
    if (rows.length === 0) continue

    for (const row of rows) {
      if (left <= 0) {
        remaining = true
        break
      }
      // Cada tabla aporta lo suyo antes del borrado; el borrado de la fila es
      // el mismo para todas y va una sola vez.
      if (entry.table === 'teamAlerts') {
        for (const notificationId of (row as unknown as Doc<'teamAlerts'>).notificationIds ?? []) {
          yield* convexPromise(() => ctx.db.delete(notificationId))
        }
      } else if (entry.table === 'vdrUploadIntents') {
        const removed = yield* deleteOrphanedIntentBlob(
          ctx,
          row as unknown as { storageId?: Id<'_storage'> }
        )
        if (removed) blobs += 1
      }
      yield* convexPromise(() => ctx.db.delete(row._id))
      deleted += 1
      left -= 1
      bump(entry.table, 1)
    }
    if (rows.length >= COMPANY_PURGE_SCAN_LIMIT) remaining = true
  }

  // `marked` sobrevive en el ledger de purgas: las tablas del puente con Mycroft
  // se marcaban en vez de borrarse y ya no existen ([F] 2026-09-06, DECISIONS).
  return { deleted, marked: 0, blobs, remaining }
})

/** El dueño sólo se borra si esta empresa era la última que tenía y su
 *  bitácora no lo nombra: `adminAuditLogs` sobrevive a lo que audita, y un
 *  `adminProfileId` colgando la vuelve ilegible. */
const purgeOwnerIdentity = Effect.fn('Purge.ownerIdentity')(function* (
  ctx: MutationCtx,
  company: Doc<'companies'>,
  operatorProfileId: Id<'profiles'>
): Effect.fn.Return<{ workosUserIds: string[]; deleted: number; keptReason?: string }, AppError> {
  const owner = yield* convexPromise(() => ctx.db.get(company.ownerId))
  if (!owner) return { workosUserIds: [], deleted: 0, keptReason: 'el perfil dueño ya no existe' }

  // Dev encontró el caso real: `admin@dev.local` es ADMIN y dueño de una sala
  // sembrada. Una purga que desactiva o borra a quien la está corriendo deja al
  // operador fuera a mitad del barrido.
  if (`${owner._id}` === `${operatorProfileId}`) {
    return { workosUserIds: [], deleted: 0, keptReason: 'el perfil dueño ES el operador' }
  }
  if (owner.role === 'ADMIN') {
    return { workosUserIds: [], deleted: 0, keptReason: 'el perfil dueño es del equipo (ADMIN)' }
  }

  const otherCompany = yield* convexPromise(() =>
    ctx.db
      .query('companies')
      .withIndex('by_ownerId', (q) => q.eq('ownerId', owner._id))
      .filter((q) => q.neq(q.field('_id'), company._id))
      .first()
  )
  if (otherCompany) {
    return { workosUserIds: [], deleted: 0, keptReason: 'el perfil dueño tiene otra empresa viva' }
  }

  const auditRow = yield* convexPromise(() =>
    ctx.db
      .query('adminAuditLogs')
      .withIndex('by_adminProfileId', (q) => q.eq('adminProfileId', owner._id))
      .first()
  )
  if (auditRow) {
    yield* convexPromise(() =>
      ctx.db.patch(owner._id, {
        isActive: false,
        deactivatedBy: 'ADMIN',
        deactivationReason: 'Empresa purgada; el perfil firma filas de la bitácora y se conserva.',
      })
    )
    return { workosUserIds: [], deleted: 0, keptReason: 'el perfil dueño firma filas de bitácora' }
  }

  const user = yield* convexPromise(() => ctx.db.get(owner.userId))
  const workosUserIds = user?.workosUserId ? [user.workosUserId] : []
  yield* convexPromise(() => ctx.db.delete(owner._id))
  if (user) yield* convexPromise(() => ctx.db.delete(user._id))
  return { workosUserIds, deleted: user ? 2 : 1 }
})

const requireOperator = Effect.fn('Purge.requireOperator')(function* (
  ctx: MutationCtx,
  operatorProfileId: Id<'profiles'>,
  reason: string
) {
  const trimmed = reason.trim()
  if (!trimmed) {
    return yield* Effect.fail(validationFailed('La razón de la purga es obligatoria.', 'reason'))
  }

  const operator = yield* convexPromise(() => ctx.db.get(operatorProfileId))
  if (!operator || operator.role !== 'ADMIN') {
    return yield* Effect.fail(
      validationFailed('operatorProfileId debe identificar un perfil ADMIN real.')
    )
  }
  if (operator.isActive === false) {
    return yield* Effect.fail(validationFailed('El perfil ADMIN operador debe estar activo.'))
  }
  const operatorUser = yield* convexPromise(() => ctx.db.get(operator.userId))
  if (!operatorUser) {
    return yield* Effect.fail(notFound('Usuario del operador ADMIN', `${operator.userId}`))
  }
  return { operator, operatorUser, reason: trimmed }
})

const purgeCompanyProgram = Effect.fn('Purge.company')(function* (
  ctx: MutationCtx,
  args: {
    companyId: Id<'companies'>
    confirmName: string
    operatorProfileId: Id<'profiles'>
    reason: string
    execute?: boolean
    batchSize?: number
  }
) {
  const execute = args.execute === true
  const batchSize = Math.max(1, Math.min(args.batchSize ?? COMPANY_PURGE_SCAN_LIMIT, 1_000))
  const { operator, operatorUser, reason } = yield* requireOperator(
    ctx,
    args.operatorProfileId,
    args.reason
  )

  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  // IDEMPOTENCIA. `companies` se borra al final, así que su ausencia prueba
  // que la purga terminó. Contesta el mismo objeto, con `deleted: 0`, en vez
  // de un 404: volver a correrla no es un error del operador.
  if (!company) {
    return {
      execute,
      companyId: args.companyId,
      company: null,
      alreadyPurged: true,
      status: 'COMPLETED' as const,
      deleted: 0,
      marked: 0,
      blobsDeleted: 0,
      tables: [] as Array<{ table: string; decision: CompanyPurgeDecision; rows: number }>,
      workos: { userIds: [] as string[], organizationId: undefined as string | undefined },
      passes: 0,
      notes: [] as string[],
    }
  }

  if (args.confirmName !== company.name) {
    return yield* Effect.fail(
      validationFailed(
        `confirmName no coincide con el nombre de la empresa. Escribe exactamente: ${company.name}`
      )
    )
  }

  const binding = yield* convexPromise(() =>
    ctx.db
      .query('companyOrganizationBindings')
      .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
      .first()
  )
  const workosOrganizationId = binding?.providerOrgId

  // ---- DRY RUN: inventario por tabla, cero escrituras ----
  if (!execute) {
    const tables: Array<{
      table: string
      decision: CompanyPurgeDecision
      rows: number
      capped: boolean
      note?: string
    }> = []
    for (const entry of COMPANY_PURGE_TABLE_PLAN) {
      const scopeId: CompanyScopeId = entry.scope === 'ownerProfile' ? company.ownerId : company._id
      const rows = yield* takeCompanyRows(ctx, entry, scopeId, COMPANY_PURGE_SCAN_LIMIT)
      if (rows.length === 0) continue
      tables.push({
        table: entry.table,
        decision: entry.decision,
        rows: rows.length,
        capped: rows.length >= COMPANY_PURGE_SCAN_LIMIT,
        note: entry.note,
      })
    }
    const owner = yield* convexPromise(() => ctx.db.get(company.ownerId))
    const ownerUser = yield* convexPromise(() =>
      owner ? ctx.db.get(owner.userId) : Promise.resolve(null)
    )
    return {
      execute,
      companyId: args.companyId,
      company: company.name,
      alreadyPurged: false,
      status: 'PLANNED' as const,
      deleted: 0,
      marked: 0,
      blobsDeleted: 0,
      tables,
      workos: {
        userIds: ownerUser?.workosUserId ? [ownerUser.workosUserId] : [],
        organizationId: workosOrganizationId,
      },
      passes: 0,
      notes: [
        '`documentAccessLogs` y `vdrReadAudits` legacy sin companyId no entran por este eje.',
        `conteos con techo de ${COMPANY_PURGE_SCAN_LIMIT} filas por tabla; en las MARK, filas que faltan por marcar`,
        ...COMPANY_PURGE_PRESERVED_TABLES.map((row) => `se conserva \`${row.table}\`: ${row.why}`),
      ],
    }
  }

  // ---- EJECUCIÓN POR LOTES ----
  const now = Date.now()
  const existing = yield* convexPromise(() =>
    ctx.db
      .query('companyPurgeRuns')
      .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
      .filter((q) => q.eq(q.field('status'), 'RUNNING'))
      .first()
  )

  const byTable = new Map<string, number>()
  for (const row of existing?.byTable ?? []) byTable.set(row.table, row.deleted)

  const pass = yield* runPurgePass(ctx, company, batchSize, byTable)
  const deletedRows = (existing?.deletedRows ?? 0) + pass.deleted
  const markedRows = (existing?.markedRows ?? 0) + pass.marked
  const deletedBlobs = (existing?.deletedBlobs ?? 0) + pass.blobs
  const passes = (existing?.passes ?? 0) + 1
  const serializedByTable = [...byTable.entries()].map(([table, deleted]) => ({ table, deleted }))

  if (pass.remaining) {
    const progress = {
      companyId: company._id,
      companyName: company.name,
      status: 'RUNNING' as const,
      operatorProfileId: operator._id,
      reason,
      batchSize,
      passes,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      deletedRows,
      markedRows,
      deletedBlobs,
      byTable: serializedByTable,
      workosUserIds: existing?.workosUserIds ?? [],
      workosOrganizationId,
    }
    if (existing) yield* convexPromise(() => ctx.db.patch(existing._id, progress))
    else yield* convexPromise(() => ctx.db.insert('companyPurgeRuns', progress))

    // El thunk es `async` y no retorna el `runAfter`: si el tipo de esa
    // promesa se infiere desde `purgeCompany`, TypeScript cierra el ciclo
    // `programa → mutation → programa` y el archivo entero se vuelve `any`.
    yield* convexPromise(async () => {
      await ctx.scheduler.runAfter(0, internal.operatorPurge.purgeCompany, {
        companyId: args.companyId,
        confirmName: args.confirmName,
        operatorProfileId: args.operatorProfileId,
        reason: args.reason,
        execute: true,
        batchSize,
      })
    })

    return {
      execute,
      companyId: args.companyId,
      company: company.name,
      alreadyPurged: false,
      status: 'SCHEDULED' as const,
      deleted: deletedRows,
      marked: markedRows,
      blobsDeleted: deletedBlobs,
      tables: serializedByTable.map((row) => ({
        table: row.table,
        decision: 'DELETE' as CompanyPurgeDecision,
        rows: row.deleted,
      })),
      workos: { userIds: [] as string[], organizationId: workosOrganizationId },
      passes,
      notes: [] as string[],
    }
  }

  // Último lote: identidad del dueño, empresa, bitácora y cierre del recibo.
  const ownerOutcome = yield* purgeOwnerIdentity(ctx, company, operator._id)
  yield* convexPromise(() => ctx.db.delete(company._id))
  const totalDeleted = deletedRows + ownerOutcome.deleted + 1

  const completion = {
    companyId: company._id,
    companyName: company.name,
    status: 'COMPLETED' as const,
    operatorProfileId: operator._id,
    reason,
    batchSize,
    passes,
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
    completedAt: now,
    deletedRows: totalDeleted,
    markedRows,
    deletedBlobs,
    byTable: serializedByTable,
    workosUserIds: ownerOutcome.workosUserIds,
    workosOrganizationId,
  }
  if (existing) yield* convexPromise(() => ctx.db.patch(existing._id, completion))
  else yield* convexPromise(() => ctx.db.insert('companyPurgeRuns', completion))

  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: operator._id,
      adminEmail: operatorUser.email,
      action: 'COMPANY_PURGE',
      targetType: 'COMPANY',
      targetId: `${company._id}`,
      previousValue: {
        name: company.name,
        ownerId: `${company.ownerId}`,
        demo: company.demo ?? null,
      },
      newValue: {
        deleted: totalDeleted,
        marked: markedRows,
        blobs: deletedBlobs,
        passes,
        byTable: serializedByTable,
        ownerKeptReason: ownerOutcome.keptReason ?? null,
        workosUserIds: ownerOutcome.workosUserIds,
        workosOrganizationId: workosOrganizationId ?? null,
      },
      notes: reason,
    })
  )

  return {
    execute,
    companyId: args.companyId,
    company: company.name,
    alreadyPurged: false,
    status: 'COMPLETED' as const,
    deleted: totalDeleted,
    marked: markedRows,
    blobsDeleted: deletedBlobs,
    tables: serializedByTable.map((row) => ({
      table: row.table,
      decision: 'DELETE' as CompanyPurgeDecision,
      rows: row.deleted,
    })),
    workos: { userIds: ownerOutcome.workosUserIds, organizationId: workosOrganizationId },
    passes,
    notes: ownerOutcome.keptReason ? [`perfil dueño conservado: ${ownerOutcome.keptReason}`] : [],
  }
})

export const purgeCompany = internalMutation({
  args: {
    companyId: v.id('companies'),
    confirmName: v.string(),
    operatorProfileId: v.id('profiles'),
    reason: v.string(),
    execute: v.optional(v.boolean()),
    batchSize: v.optional(v.number()),
  },
  handler: (ctx, args) => runConvex(purgeCompanyProgram(ctx, args)),
})

// ---------------------------------------------------------------------------
// USUARIOS SEMILLA
// ---------------------------------------------------------------------------
// `fixture-ae0b4b41@example.com` y `admin@dev.local` (PENDING 2026-09-02) se
// DESACTIVAN, no se borran. Dos razones: `admin@dev.local` es el usuario del
// bypass de dev y `_helpers/auth.dev.ts` lo espera; y ambos pueden firmar filas
// de `adminAuditLogs`, que sobrevive a lo que audita. `isActive: false` con
// `deactivatedBy: 'ADMIN'` es pegajoso: sólo un admin lo revierte.

const deactivateSeedUsersProgram = Effect.fn('Purge.deactivateSeedUsers')(function* (
  ctx: MutationCtx,
  args: {
    emails: string[]
    operatorProfileId: Id<'profiles'>
    reason: string
    execute?: boolean
  }
) {
  const execute = args.execute === true
  const { operator, operatorUser, reason } = yield* requireOperator(
    ctx,
    args.operatorProfileId,
    args.reason
  )

  const users: Array<{
    email: string
    action:
      'DEACTIVATED' | 'ALREADY_INACTIVE' | 'SKIPPED_NOT_SEED' | 'SKIPPED_OPERATOR' | 'NOT_FOUND'
    workosUserId?: string
  }> = []

  for (const rawEmail of args.emails) {
    const email = rawEmail.trim()
    if (!isSeedOwnerEmail(email)) {
      users.push({ email, action: 'SKIPPED_NOT_SEED' })
      continue
    }
    const user = yield* convexPromise(() =>
      ctx.db
        .query('users')
        .withIndex('by_email', (q) => q.eq('email', email))
        .first()
    )
    if (!user) {
      users.push({ email, action: 'NOT_FOUND' })
      continue
    }
    const profile = yield* convexPromise(() =>
      ctx.db
        .query('profiles')
        .withIndex('by_userId', (q) => q.eq('userId', user._id))
        .first()
    )
    if (!profile) {
      users.push({ email, action: 'NOT_FOUND' })
      continue
    }
    // Nunca al operador: en dev el único ADMIN activo ES `admin@dev.local`,
    // y desactivarlo mata la corrida que lo está usando.
    if (`${profile._id}` === `${operator._id}`) {
      users.push({ email, action: 'SKIPPED_OPERATOR', workosUserId: user.workosUserId })
      continue
    }
    if (profile.isActive === false) {
      users.push({ email, action: 'ALREADY_INACTIVE', workosUserId: user.workosUserId })
      continue
    }
    users.push({ email, action: 'DEACTIVATED', workosUserId: user.workosUserId })
    if (!execute) continue

    yield* convexPromise(() =>
      ctx.db.patch(profile._id, {
        isActive: false,
        deactivatedBy: 'ADMIN',
        deactivationReason: reason,
      })
    )
    yield* convexPromise(() =>
      logAdminAction({
        ctx,
        adminProfileId: operator._id,
        adminEmail: operatorUser.email,
        action: 'USER_STATUS_CHANGE',
        targetType: 'PROFILE',
        targetId: `${profile._id}`,
        previousValue: { isActive: true },
        newValue: { isActive: false, deactivatedBy: 'ADMIN', email },
        notes: reason,
      })
    )
  }

  return { execute, users }
})

export const deactivateSeedUsers = internalMutation({
  args: {
    emails: v.array(v.string()),
    operatorProfileId: v.id('profiles'),
    reason: v.string(),
    execute: v.optional(v.boolean()),
  },
  handler: (ctx, args) => runConvex(deactivateSeedUsersProgram(ctx, args)),
})

/**
 * Borra por completo un perfil huérfano: un usuario que no es ADMIN, no es el
 * operador, no es dueño de ninguna empresa ni inversor. Es el cierre que
 * `deactivateSeedUsers` no da para correos con dominio real que nunca debieron
 * quedar en prod (cuentas de prueba, perfiles sin usuario en WorkOS). Las tablas
 * por usuario son las mismas que borra `gdpr.processAccountDeletion`; los
 * rastros de auditoría (`activityLogs`, `securityEvents`, `adminAuditLogs`) se
 * cuentan y se conservan. Sin `execute` solo inventaría.
 */
const purgeOrphanUserProgram = Effect.fn('Purge.orphanUser')(function* (
  ctx: MutationCtx,
  args: {
    email: string
    operatorProfileId: Id<'profiles'>
    reason: string
    execute?: boolean
  }
) {
  const execute = args.execute === true
  const { operator, operatorUser, reason } = yield* requireOperator(
    ctx,
    args.operatorProfileId,
    args.reason
  )
  const email = args.email.trim()
  const tables: Array<{ table: string; rows: number; decision: 'DELETE' | 'KEEP' }> = []

  const user = yield* convexPromise(() =>
    ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', email))
      .first()
  )
  if (!user) {
    return { execute, email, action: 'NOT_FOUND' as const, blockers: [], tables }
  }
  const profile = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .first()
  )

  const blockers: string[] = []
  if (profile) {
    if (`${profile._id}` === `${operator._id}`) blockers.push('es el operador')
    if (profile.role === 'ADMIN') blockers.push('es ADMIN')
    const companies = yield* convexPromise(() =>
      ctx.db
        .query('companies')
        .withIndex('by_ownerId', (q) => q.eq('ownerId', profile._id))
        .collect()
    )
    if (companies.length > 0) {
      blockers.push(`dueño de ${companies.length} empresa(s): purga la empresa con --company-id`)
    }
  }
  if (blockers.length > 0) {
    return { execute, email, action: 'REFUSED' as const, blockers, tables }
  }

  type Row = { _id: Parameters<MutationCtx['db']['delete']>[0] }
  // Cada tabla barrida lleva su nombre en el span: si el borrado se corta a la
  // mitad, la traza dice cuál se alcanzó a vaciar y cuál no.
  const sweep = Effect.fn('Purge.orphanUserSweep')(function* (table: string, rows: Row[]) {
    tables.push({ table, rows: rows.length, decision: 'DELETE' })
    if (!execute) return
    for (const row of rows) yield* convexPromise(() => ctx.db.delete(row._id))
  })
  const keep = (table: string, rows: Row[]) => {
    tables.push({ table, rows: rows.length, decision: 'KEEP' })
  }

  if (profile) {
    const pid = profile._id
    yield* sweep(
      'notifications',
      yield* convexPromise(() =>
        ctx.db
          .query('notifications')
          .withIndex('by_userId', (q) => q.eq('userId', pid))
          .collect()
      )
    )
    yield* sweep(
      'notificationPreferences',
      yield* convexPromise(() =>
        ctx.db
          .query('notificationPreferences')
          .withIndex('by_userId', (q) => q.eq('userId', pid))
          .collect()
      )
    )
    yield* sweep(
      'consents',
      yield* convexPromise(() =>
        ctx.db
          .query('consents')
          .withIndex('by_profileId', (q) => q.eq('profileId', pid))
          .collect()
      )
    )
    yield* sweep(
      'deletionRequests',
      yield* convexPromise(() =>
        ctx.db
          .query('deletionRequests')
          .withIndex('by_profileId', (q) => q.eq('profileId', pid))
          .collect()
      )
    )
    yield* sweep(
      'documentAccessGrants',
      yield* convexPromise(() =>
        ctx.db
          .query('documentAccessGrants')
          .withIndex('by_profileId', (q) => q.eq('profileId', pid))
          .collect()
      )
    )
    yield* sweep(
      'adminVdrCapabilities',
      yield* convexPromise(() =>
        ctx.db
          .query('adminVdrCapabilities')
          .withIndex('by_profile_expiresAt', (q) => q.eq('profileId', pid))
          .collect()
      )
    )
    yield* sweep(
      'organizationMemberships',
      yield* convexPromise(() =>
        ctx.db
          .query('organizationMemberships')
          .withIndex('by_profileId', (q) => q.eq('profileId', pid))
          .collect()
      )
    )
    keep(
      'activityLogs',
      yield* convexPromise(() =>
        ctx.db
          .query('activityLogs')
          .withIndex('by_userId', (q) => q.eq('userId', pid))
          .collect()
      )
    )
  }
  yield* sweep(
    'organizationMemberships(userId)',
    yield* convexPromise(() =>
      ctx.db
        .query('organizationMemberships')
        .withIndex('by_userId', (q) => q.eq('userId', user._id))
        .collect()
    )
  )
  keep(
    'securityEvents',
    yield* convexPromise(() =>
      ctx.db
        .query('securityEvents')
        .withIndex('by_userId', (q) => q.eq('userId', user._id))
        .collect()
    )
  )
  tables.push({ table: 'profiles', rows: profile ? 1 : 0, decision: 'DELETE' })
  tables.push({ table: 'users', rows: 1, decision: 'DELETE' })

  if (execute) {
    if (profile) yield* convexPromise(() => ctx.db.delete(profile._id))
    yield* convexPromise(() => ctx.db.delete(user._id))
    yield* convexPromise(() =>
      logAdminAction({
        ctx,
        adminProfileId: operator._id,
        adminEmail: operatorUser.email,
        action: 'USER_DELETE',
        targetType: 'PROFILE',
        targetId: profile ? `${profile._id}` : `${user._id}`,
        previousValue: {
          email,
          role: profile?.role ?? null,
          workosUserId: user.workosUserId ?? null,
        },
        newValue: { deleted: true, tables },
        notes: reason,
      })
    )
  }

  return {
    execute,
    email,
    action: execute ? ('DELETED' as const) : ('WOULD_DELETE' as const),
    blockers,
    workosUserId: user.workosUserId ?? null,
    tables,
  }
})

export const purgeOrphanUser = internalMutation({
  args: {
    email: v.string(),
    operatorProfileId: v.id('profiles'),
    reason: v.string(),
    execute: v.optional(v.boolean()),
  },
  handler: (ctx, args) => runConvex(purgeOrphanUserProgram(ctx, args)),
})
