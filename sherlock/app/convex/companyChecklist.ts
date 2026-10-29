// ============================================================================
// COMPANY CHECKLIST — activación artesanal de la sala ([F] 2026-09-01)
// ============================================================================
// Siete ítems (cinco derivados, dos manuales) y un sello de activación que
// declara el equipo a mano. El rail de ocho etapas se lee de `deliverables`;
// no hay gate: el cliente sube y habla desde el minuto cero, activada o no.
// Una empresa sin fila es una empresa con checklist en cero — el alta nunca
// inserta aquí.
// ============================================================================

import { v } from 'convex/values'
import { Effect } from 'effect'

import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import {
  DELIVERABLE_KINDS,
  type DeliverableKind,
  type DeliverableStatus,
} from './_deliverables/model'
import { logAdminAction } from './_helpers/auditLog'
import { requireAuth, requireAuthAdmin } from './_helpers/auth'
import { requireCompanyReadAuthorization } from './_helpers/companyAuthorization'
import { convexPromise, convexSync, runConvex } from './_helpers/effect'
import { notFound, unauthorized, validationFailed } from './_helpers/errors'
import { getVdrShellFolderValue } from '../src/lib/vdr/document-taxonomy'

const DOCUMENT_SCAN_CAP = 500
const NOTE_MAX_LENGTH = 500

export type NameConfirmedSource = 'INTAKE_CLAIM' | 'ROOM_RENAME'
export type ChecklistManualItem = 'financialsDepth' | 'kickoffCall'
export type ChecklistStageStatus = DeliverableStatus | 'PENDING'
export type ChecklistStageKey =
  'MODEL_V1' | 'MODEL_V2' | 'TEASER' | 'CIM' | 'MGMT_PRESENTATION' | 'DECKS' | 'QA' | 'IRL'

type DbCtx = Pick<QueryCtx | MutationCtx, 'db'>

const STAGE_ORDER: readonly ChecklistStageKey[] = [
  'MODEL_V1',
  'MODEL_V2',
  'TEASER',
  'CIM',
  'MGMT_PRESENTATION',
  'DECKS',
  'QA',
  'IRL',
]

export type ChecklistStageItem = {
  kind: DeliverableKind
  status: ChecklistStageStatus
}

type ChecklistItemView = {
  done: boolean
  at: number | null
  // Marcas internas del equipo: SOLO viajan a un lector admin.
  by?: Id<'profiles'> | null
  note?: string | null
  count?: number
  source?: NameConfirmedSource | null
}

export type CompanyChecklistView = {
  companyId: Id<'companies'>
  items: {
    nameConfirmed: ChecklistItemView
    phone: ChecklistItemView
    financials: ChecklistItemView
    legal: ChecklistItemView
    corporate: ChecklistItemView
    financialsDepth: ChecklistItemView
    kickoffCall: ChecklistItemView
  }
  completedCount: number
  activation: {
    active: boolean
    at: number | null
    by?: Id<'profiles'> | null
    note?: string | null
  }
  stages: Array<{
    key: ChecklistStageKey
    status: ChecklistStageStatus
    updatedAt: number | null
    // Solo la etapa Decks: deuda y equity son dos entregables distintos y el
    // cliente tiene que ver cuál de los dos lo está esperando.
    items?: ChecklistStageItem[]
  }>
}

function emptyItem(overrides: Partial<ChecklistItemView> = {}): ChecklistItemView {
  return {
    done: false,
    at: null,
    by: null,
    note: null,
    ...overrides,
  }
}

function trimNote(note: string | undefined): string | undefined {
  if (typeof note !== 'string') return undefined
  const trimmed = note.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > NOTE_MAX_LENGTH) {
    throw validationFailed(`La nota no puede pasar de ${NOTE_MAX_LENGTH} caracteres.`, 'note')
  }
  return trimmed
}

async function loadChecklistRow(ctx: DbCtx, companyId: Id<'companies'>) {
  return await ctx.db
    .query('companyChecklist')
    .withIndex('by_companyId', (q) => q.eq('companyId', companyId))
    .first()
}

const getOrCreateChecklistRow = Effect.fn('Checklist.getOrCreateRow')(function* (
  ctx: MutationCtx,
  companyId: Id<'companies'>
) {
  const existing = yield* convexPromise(() => loadChecklistRow(ctx, companyId))
  if (existing) return existing
  const now = Date.now()
  const fields = { companyId, createdAt: now, updatedAt: now }
  const id = yield* convexPromise(() => ctx.db.insert('companyChecklist', fields))
  return { _id: id, _creationTime: now, ...fields } satisfies Doc<'companyChecklist'>
})

/**
 * Marca que el nombre lo puso una persona. Idempotente: la primera fuente
 * gana; un rename posterior no pisa el claim, y al revés tampoco.
 */
const confirmCompanyNameEffect = Effect.fn('Checklist.confirmCompanyName')(function* (
  ctx: MutationCtx,
  companyId: Id<'companies'>,
  source: NameConfirmedSource
) {
  const row = yield* getOrCreateChecklistRow(ctx, companyId)
  if (row.nameConfirmedAt) return
  const now = Date.now()
  yield* convexPromise(() =>
    ctx.db.patch(row._id, {
      nameConfirmedAt: now,
      nameConfirmedSource: source,
      updatedAt: now,
    })
  )
})

// El borde Promise que conservan `companies.ts` y `_intake/claim.ts`.
export function confirmCompanyName(
  ctx: MutationCtx,
  companyId: Id<'companies'>,
  source: NameConfirmedSource
): Promise<void> {
  return runConvex(confirmCompanyNameEffect(ctx, companyId, source))
}

function phoneDone(profile: Doc<'profiles'> | null): boolean {
  return typeof profile?.phone === 'string' && profile.phone.trim().length > 0
}

function folderCounts(documents: Doc<'documents'>[]) {
  let financials = 0
  let legal = 0
  let corporate = 0
  for (const document of documents) {
    if (document.lifecycleStatus !== 'ACTIVE') continue
    const folder = getVdrShellFolderValue(document.folder)
    if (folder === 'room_financial') financials += 1
    else if (folder === 'room_legal') legal += 1
    else if (folder === 'room_corporate') corporate += 1
  }
  return { financials, legal, corporate }
}

function versionFromLabel(label: string | undefined): number {
  if (!label) return 0
  const match = label
    .trim()
    .toLowerCase()
    .match(/^v?(\d+)/)
  if (!match) return 0
  return Number(match[1])
}

const modelVersionCeiling = Effect.fn('Checklist.modelVersionCeiling')(function* (
  ctx: DbCtx,
  model: Doc<'deliverables'> | undefined
) {
  if (!model) return 0
  let maxVersion = 0
  for (const rendition of model.renditions ?? []) {
    const document = yield* convexPromise(() => ctx.db.get(rendition.documentId))
    if (!document || document.companyId !== model.companyId) continue
    if (typeof document.currentVersionNumber === 'number') {
      maxVersion = Math.max(maxVersion, document.currentVersionNumber)
    }
    if (document.currentVersionId) {
      const version = yield* convexPromise(() => ctx.db.get(document.currentVersionId!))
      maxVersion = Math.max(maxVersion, versionFromLabel(version?.deliveryLabel))
    }
  }
  return maxVersion
})

function stageOf(row: Doc<'deliverables'> | undefined): {
  status: ChecklistStageStatus
  updatedAt: number | null
} {
  if (!row) return { status: 'PENDING', updatedAt: null }
  return { status: row.status, updatedAt: row.updatedAt }
}

// Deuda y equity no se colapsan: la etapa vale lo que vale su deck MENOS
// avanzado, y NEEDS_INPUT gana sobre todo porque es el único estado que le
// pide algo al cliente. PENDING pierde siempre — un solo deck abierto le da
// su estado a la etapa — salvo que ninguno de los dos exista.
const DECK_STAGE_PRIORITY: readonly ChecklistStageStatus[] = [
  'NEEDS_INPUT',
  'REQUESTED',
  'IN_PROGRESS',
  'DRAFT_READY',
  'IN_REVIEW',
  'APPROVED',
  'DELIVERED',
  'PENDING',
]

const DECK_KINDS: readonly DeliverableKind[] = ['DEBT_DECK', 'EQUITY_DECK']

function combineDeckStages(
  parts: Array<{ kind: DeliverableKind; status: ChecklistStageStatus; updatedAt: number | null }>
): {
  status: ChecklistStageStatus
  updatedAt: number | null
  items: ChecklistStageItem[]
} {
  const timestamps = parts
    .map((part) => part.updatedAt)
    .filter((value): value is number => value !== null)
  const status = parts.reduce<ChecklistStageStatus>(
    (winner, part) =>
      DECK_STAGE_PRIORITY.indexOf(part.status) < DECK_STAGE_PRIORITY.indexOf(winner)
        ? part.status
        : winner,
    'PENDING'
  )

  return {
    status,
    updatedAt: timestamps.length > 0 ? Math.max(...timestamps) : null,
    items: parts.map((part) => ({ kind: part.kind, status: part.status })),
  }
}

const buildStages = Effect.fn('Checklist.buildStages')(function* (
  ctx: DbCtx,
  companyId: Id<'companies'>
) {
  const rows = yield* convexPromise(() =>
    ctx.db
      .query('deliverables')
      .withIndex('by_companyId', (q) => q.eq('companyId', companyId))
      .take(DELIVERABLE_KINDS.length)
  )
  const byKind = new Map<DeliverableKind, Doc<'deliverables'>>()
  for (const row of rows) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, row)
  }

  const model = byKind.get('MODEL')
  const modelV1 = stageOf(model)
  const versionCeiling = yield* modelVersionCeiling(ctx, model)
  const modelV2 =
    versionCeiling >= 2 ? stageOf(model) : { status: 'PENDING' as const, updatedAt: null }

  const byKey: Record<
    ChecklistStageKey,
    { status: ChecklistStageStatus; updatedAt: number | null; items?: ChecklistStageItem[] }
  > = {
    MODEL_V1: modelV1,
    MODEL_V2: modelV2,
    TEASER: stageOf(byKind.get('TEASER')),
    CIM: stageOf(byKind.get('CIM')),
    MGMT_PRESENTATION: stageOf(byKind.get('MGMT_PRESENTATION')),
    DECKS: combineDeckStages(DECK_KINDS.map((kind) => ({ kind, ...stageOf(byKind.get(kind)) }))),
    QA: stageOf(byKind.get('QA')),
    IRL: stageOf(byKind.get('IRL')),
  }

  return STAGE_ORDER.map((key) => ({ key, ...byKey[key] })) satisfies CompanyChecklistView['stages']
})

export async function buildCompanyChecklistItems(
  ctx: DbCtx,
  company: Doc<'companies'>,
  suppliedDocuments?: Doc<'documents'>[]
) {
  const [row, owner, documents] = await Promise.all([
    loadChecklistRow(ctx, company._id),
    ctx.db.get(company.ownerId),
    suppliedDocuments ??
      ctx.db
        .query('documents')
        .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
        .take(DOCUMENT_SCAN_CAP),
  ])
  const counts = folderCounts(documents)
  const nameConfirmed = emptyItem({
    done: typeof row?.nameConfirmedAt === 'number',
    at: row?.nameConfirmedAt ?? null,
    source: row?.nameConfirmedSource ?? null,
  })
  const phone = emptyItem({ done: phoneDone(owner) })
  const financials = emptyItem({ done: counts.financials > 0, count: counts.financials })
  const legal = emptyItem({ done: counts.legal > 0, count: counts.legal })
  const corporate = emptyItem({ done: counts.corporate > 0, count: counts.corporate })
  const financialsDepth = emptyItem({
    done: typeof row?.financialsDepthConfirmedAt === 'number',
    at: row?.financialsDepthConfirmedAt ?? null,
    by: row?.financialsDepthConfirmedBy ?? null,
    note: row?.financialsDepthNote ?? null,
  })
  const kickoffCall = emptyItem({
    done: typeof row?.kickoffCallAt === 'number',
    at: row?.kickoffCallAt ?? null,
    by: row?.kickoffCallBy ?? null,
    note: row?.kickoffCallNote ?? null,
  })
  const items = {
    nameConfirmed,
    phone,
    financials,
    legal,
    corporate,
    financialsDepth,
    kickoffCall,
  }
  const completedCount = Object.values(items).filter((item) => item.done).length

  return {
    companyId: company._id,
    items,
    completedCount,
    activation: {
      active: typeof row?.activatedAt === 'number',
      at: row?.activatedAt ?? null,
      by: row?.activatedBy ?? null,
      note: row?.activationNote ?? null,
    },
  }
}

const buildCompanyChecklist = Effect.fn('Checklist.build')(function* (
  ctx: DbCtx,
  company: Doc<'companies'>
) {
  const items = yield* convexPromise(() => buildCompanyChecklistItems(ctx, company))
  const stages = yield* buildStages(ctx, company._id)
  return { ...items, stages } satisfies CompanyChecklistView
})

function withoutInternalMarks<T extends { by?: unknown; note?: unknown }>(
  value: T
): Omit<T, 'by' | 'note'> {
  const copy = { ...value }
  delete copy.by
  delete copy.note
  return copy
}

/**
 * Vista para un lector NO admin. El cliente ve su progreso — estado y fechas —
 * pero nunca la nota interna con la que el equipo se habla ni el id de perfil
 * del admin que marcó el ítem: eso es operación del equipo, no del cliente.
 */
function redactForCompany(view: CompanyChecklistView): CompanyChecklistView {
  const items = {} as CompanyChecklistView['items']
  for (const key of Object.keys(view.items) as Array<keyof CompanyChecklistView['items']>) {
    items[key] = withoutInternalMarks(view.items[key])
  }
  return { ...view, items, activation: withoutInternalMarks(view.activation) }
}

const loadCompanyOrThrow = Effect.fn('Checklist.loadCompany')(function* (
  ctx: DbCtx,
  companyId: Id<'companies'>
) {
  const company = yield* convexPromise(() => ctx.db.get(companyId))
  if (!company) return yield* Effect.fail(notFound('Empresa', companyId))
  return company
})

const getCompanyChecklistProgram = Effect.fn('Checklist.getCompanyChecklist')(function* (
  ctx: QueryCtx,
  args: { companyId: Id<'companies'> }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const denialMessage = 'No tienes permiso para abrir esta sala'
  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) return yield* Effect.fail(unauthorized(denialMessage))
  yield* convexPromise(() => requireCompanyReadAuthorization(ctx, auth, company, denialMessage))
  const view = yield* buildCompanyChecklist(ctx, company)
  return auth.profile.role === 'ADMIN' ? view : redactForCompany(view)
})

export const getCompanyChecklist = query({
  args: { companyId: v.id('companies') },
  handler: (ctx, args): Promise<CompanyChecklistView> =>
    runConvex(getCompanyChecklistProgram(ctx, args)),
})

const manualItemValidator = v.union(v.literal('financialsDepth'), v.literal('kickoffCall'))

const setChecklistItemProgram = Effect.fn('Checklist.setItem')(function* (
  ctx: MutationCtx,
  args: {
    companyId: Id<'companies'>
    item: ChecklistManualItem
    done: boolean
    note?: string
  }
) {
  const { profile, user } = yield* convexPromise(() => requireAuthAdmin(ctx))
  const company = yield* loadCompanyOrThrow(ctx, args.companyId)
  const note = yield* convexSync(() => trimNote(args.note))
  const row = yield* getOrCreateChecklistRow(ctx, company._id)
  const now = Date.now()

  const previous =
    args.item === 'financialsDepth'
      ? {
          at: row.financialsDepthConfirmedAt ?? null,
          by: row.financialsDepthConfirmedBy ?? null,
          note: row.financialsDepthNote ?? null,
        }
      : {
          at: row.kickoffCallAt ?? null,
          by: row.kickoffCallBy ?? null,
          note: row.kickoffCallNote ?? null,
        }

  const patch =
    args.item === 'financialsDepth'
      ? args.done
        ? {
            financialsDepthConfirmedAt: row.financialsDepthConfirmedAt ?? now,
            financialsDepthConfirmedBy: profile._id,
            financialsDepthNote: note,
            updatedAt: now,
          }
        : {
            financialsDepthConfirmedAt: undefined,
            financialsDepthConfirmedBy: undefined,
            financialsDepthNote: undefined,
            updatedAt: now,
          }
      : args.done
        ? {
            kickoffCallAt: row.kickoffCallAt ?? now,
            kickoffCallBy: profile._id,
            kickoffCallNote: note,
            updatedAt: now,
          }
        : {
            kickoffCallAt: undefined,
            kickoffCallBy: undefined,
            kickoffCallNote: undefined,
            updatedAt: now,
          }

  yield* convexPromise(() => ctx.db.patch(row._id, patch))
  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: user.email,
      action: 'CHECKLIST_ITEM_SET',
      targetType: 'COMPANY',
      targetId: `${company._id}`,
      previousValue: { item: args.item, ...previous },
      newValue: { item: args.item, done: args.done, note: note ?? null },
      notes: note,
    })
  )
  return yield* buildCompanyChecklist(ctx, company)
})

export const setChecklistItem = mutation({
  args: {
    companyId: v.id('companies'),
    item: manualItemValidator,
    done: v.boolean(),
    note: v.optional(v.string()),
  },
  handler: (ctx, args): Promise<CompanyChecklistView> =>
    runConvex(setChecklistItemProgram(ctx, args)),
})

const setActivationProgram = Effect.fn('Checklist.setActivation')(function* (
  ctx: MutationCtx,
  args: { companyId: Id<'companies'>; active: boolean; note?: string }
) {
  const { profile, user } = yield* convexPromise(() => requireAuthAdmin(ctx))
  const company = yield* loadCompanyOrThrow(ctx, args.companyId)
  const note = yield* convexSync(() => trimNote(args.note))

  // Idempotente: pedir el estado que ya rige no escribe, no audita y no
  // mueve el sello. Dos clics en "Activar" dejan un solo activador y una
  // sola fila de auditoría; desactivar una sala que nunca se activó ni
  // siquiera crea la fila del checklist.
  const existing = yield* convexPromise(() => loadChecklistRow(ctx, company._id))
  const currentlyActive = typeof existing?.activatedAt === 'number'
  if (currentlyActive === args.active) {
    return { ...(yield* buildCompanyChecklist(ctx, company)), changed: false as const }
  }

  const row = existing ?? (yield* getOrCreateChecklistRow(ctx, company._id))
  const now = Date.now()
  const previous = {
    active: typeof row.activatedAt === 'number',
    at: row.activatedAt ?? null,
    by: row.activatedBy ?? null,
    note: row.activationNote ?? null,
  }

  yield* convexPromise(() =>
    ctx.db.patch(
      row._id,
      args.active
        ? {
            activatedAt: row.activatedAt ?? now,
            activatedBy: profile._id,
            activationNote: note ?? row.activationNote,
            updatedAt: now,
          }
        : {
            activatedAt: undefined,
            activatedBy: undefined,
            activationNote: undefined,
            updatedAt: now,
          }
    )
  )
  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: user.email,
      action: 'COMPANY_ROOM_ACTIVATION',
      targetType: 'COMPANY',
      targetId: `${company._id}`,
      previousValue: previous,
      newValue: { active: args.active, note: note ?? null },
      notes: note,
    })
  )
  return { ...(yield* buildCompanyChecklist(ctx, company)), changed: true as const }
})

export const setActivation = mutation({
  args: {
    companyId: v.id('companies'),
    active: v.boolean(),
    note: v.optional(v.string()),
  },
  handler: (ctx, args): Promise<CompanyChecklistView & { changed: boolean }> =>
    runConvex(setActivationProgram(ctx, args)),
})
