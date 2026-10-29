// ============================================================================
// AVANCE DE LA SALA PARA EL MCP — misma fuente que el panel
// ============================================================================
// `sala_resumen` no puede inferir teléfono, confirmación de nombre ni etapas
// desde la página de 200 documentos. Esta proyección sale de companyChecklist,
// el perfil del dueño, deliverables y TODOS los documentos activos, con el
// mismo criterio que `RoomProgressPanel`.

import { Effect } from 'effect'

import {
  getVdrShellFolderValue,
  VDR_SHELL_FOLDER_VALUES,
} from '../../src/lib/vdr/document-taxonomy'
import { STAGE_ORDER, type ChecklistStageKey } from '../../src/lib/vdr/room-progress'
import {
  DELIVERABLE_KINDS,
  type DeliverableKind,
  type DeliverableStatus,
} from '../_deliverables/model'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { convexPromise } from '../_helpers/effect'

type DbCtx = Pick<QueryCtx, 'db'>
type ChecklistStageStatus = DeliverableStatus | 'PENDING'

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

type RoomProgressEntregable = {
  etapa: ChecklistStageKey
  estado: string
  publicadoEn?: number
}

type RoomProgressProjection = {
  telefonoPresente: boolean
  nombreConfirmado: boolean
  entregables: RoomProgressEntregable[]
  conteosPorCarpeta: Record<string, number>
  ultimoMovimiento: { nombre: string; actualizadoEn: number } | null
}

function phonePresent(profile: Doc<'profiles'> | null): boolean {
  return typeof profile?.phone === 'string' && profile.phone.trim().length > 0
}

function stageOf(row: Doc<'deliverables'> | undefined): {
  status: ChecklistStageStatus
  updatedAt: number | null
} {
  if (!row) return { status: 'PENDING', updatedAt: null }
  return { status: row.status, updatedAt: row.updatedAt }
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

const modelVersionCeiling = Effect.fn('VdrRead.modelVersionCeiling')(function* (
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
    const currentVersionId = document.currentVersionId
    if (currentVersionId) {
      const version: { deliveryLabel?: string } | null = yield* convexPromise(() =>
        ctx.db.get(currentVersionId)
      )
      maxVersion = Math.max(maxVersion, versionFromLabel(version?.deliveryLabel))
    }
  }
  return maxVersion
})

function combineDeckStages(
  parts: Array<{ status: ChecklistStageStatus; updatedAt: number | null }>
): { status: ChecklistStageStatus; updatedAt: number | null } {
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
  }
}

function toEntregable(
  key: ChecklistStageKey,
  stage: { status: ChecklistStageStatus; updatedAt: number | null }
): RoomProgressEntregable {
  return {
    etapa: key,
    estado: stage.status,
    ...(stage.updatedAt !== null ? { publicadoEn: stage.updatedAt } : {}),
  }
}

const collectCompanyDocuments = Effect.fn('VdrRead.collectCompanyDocuments')(function* (
  ctx: DbCtx,
  companyId: Id<'companies'>
) {
  return yield* convexPromise(() =>
    ctx.db
      .query('documents')
      .withIndex('by_companyId', (q) => q.eq('companyId', companyId))
      .collect()
  )
})

const buildDeliverableStages = Effect.fn('VdrRead.buildDeliverableStages')(function* (
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
    { status: ChecklistStageStatus; updatedAt: number | null }
  > = {
    MODEL_V1: modelV1,
    MODEL_V2: modelV2,
    TEASER: stageOf(byKind.get('TEASER')),
    CIM: stageOf(byKind.get('CIM')),
    MGMT_PRESENTATION: stageOf(byKind.get('MGMT_PRESENTATION')),
    DECKS: combineDeckStages(DECK_KINDS.map((kind) => stageOf(byKind.get(kind)))),
    QA: stageOf(byKind.get('QA')),
    IRL: stageOf(byKind.get('IRL')),
  }
  return STAGE_ORDER.map((key) => toEntregable(key, byKey[key]))
})

export const loadRoomProgressProjection = Effect.fn('VdrRead.loadRoomProgressProjection')(
  function* (ctx: DbCtx, company: Doc<'companies'>) {
    const [checklist, owner, documents, entregables] = yield* Effect.all(
      [
        convexPromise(() =>
          ctx.db
            .query('companyChecklist')
            .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
            .first()
        ),
        convexPromise(() => ctx.db.get(company.ownerId)),
        collectCompanyDocuments(ctx, company._id),
        buildDeliverableStages(ctx, company._id),
      ],
      { concurrency: 'unbounded' }
    )

    const conteosPorCarpeta: Record<string, number> = Object.fromEntries(
      VDR_SHELL_FOLDER_VALUES.map((folder) => [folder, 0])
    )
    let ultimoMovimiento: RoomProgressProjection['ultimoMovimiento'] = null
    for (const document of documents) {
      if (document.lifecycleStatus !== 'ACTIVE') continue
      const folder = getVdrShellFolderValue(document.folder)
      conteosPorCarpeta[folder] = (conteosPorCarpeta[folder] ?? 0) + 1
      const actualizadoEn = document.updatedAt ?? document._creationTime
      if (ultimoMovimiento === null || actualizadoEn >= ultimoMovimiento.actualizadoEn) {
        ultimoMovimiento = { nombre: document.name, actualizadoEn }
      }
    }

    return {
      telefonoPresente: phonePresent(owner),
      nombreConfirmado: typeof checklist?.nameConfirmedAt === 'number',
      entregables,
      conteosPorCarpeta,
      ultimoMovimiento,
    } satisfies RoomProgressProjection
  }
)
