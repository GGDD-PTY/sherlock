// ============================================================================
// AVANCE DE LA SALA — una sola regla de «qué falta»
// ============================================================================
// RoomShell, RoomProgressPanel y `sala_resumen` tenían cada uno su recorte
// de carpetas vacías o de casillas del cliente. El porcentaje, las
// obligatorias vacías y el siguiente paso salen todos de aquí. El nombre
// confirmado es `companyChecklist.nameConfirmedAt`, no la presencia de
// `companies.name`. Teléfono, etapas y conteos de carpeta viajan en el
// input porque la página de documentos no los contiene.

import { Schema } from 'effect'

import { getVdrShellFolderValue, VDR_SHELL_FOLDER_VALUES } from './document-taxonomy'

const ChecklistItemKeySchema = Schema.Literals([
  'nameConfirmed',
  'phone',
  'financials',
  'legal',
  'corporate',
  'financialsDepth',
  'kickoffCall',
])
export const CHECKLIST_ITEM_KEYS = ChecklistItemKeySchema.literals
export type ChecklistItemKey = typeof ChecklistItemKeySchema.Type

// El cliente solo ve lo que depende de él. «Que el equipo confirme…» y la
// llamada de arranque siguen en el checklist del backend para el admin.
const ClientItemKeySchema = Schema.Literals([
  'nameConfirmed',
  'phone',
  'financials',
  'legal',
  'corporate',
])
export const CLIENT_ITEM_KEYS = ClientItemKeySchema.literals
type ClientItemKey = typeof ClientItemKeySchema.Type
export const CHECKLIST_TOTAL = CLIENT_ITEM_KEYS.length

const ChecklistStageKeySchema = Schema.Literals([
  'MODEL_V1',
  'MODEL_V2',
  'TEASER',
  'CIM',
  'MGMT_PRESENTATION',
  'DECKS',
  'QA',
  'IRL',
])
export const STAGE_ORDER = ChecklistStageKeySchema.literals
export type ChecklistStageKey = typeof ChecklistStageKeySchema.Type
export const isChecklistStageKey = Schema.is(ChecklistStageKeySchema)

const RoomOptionalFolderSchema = Schema.Literals(['room_operations', 'room_marketing'])
export const ROOM_OPTIONAL_FOLDERS: ReadonlySet<string> = new Set(RoomOptionalFolderSchema.literals)
const isOptionalRoomFolder = Schema.is(RoomOptionalFolderSchema)

type RoomFolderCount = {
  folder: string
  count: number
}

type RoomDeliverableInput = {
  key: ChecklistStageKey
  status: string
}

type RoomLastMovement = {
  nombre: string
  at: number
}

export type RoomProgressInput = {
  folders: readonly RoomFolderCount[]
  phonePresent: boolean
  nameConfirmed: boolean
  deliverables: readonly RoomDeliverableInput[]
  lastMovement: RoomLastMovement | null
}

type RoomChecklistItemState = {
  key: ClientItemKey
  done: boolean
}

type RoomProgressDeliverable = {
  key: ChecklistStageKey
  status: string
}

export type RoomProgress = {
  percent: number
  foldersWithDocuments: readonly string[]
  emptyRequiredFolders: readonly string[]
  emptyOptionalFolders: readonly string[]
  checklist: readonly RoomChecklistItemState[]
  deliverables: readonly RoomProgressDeliverable[]
  lastMovement: RoomLastMovement | null
  siguientePaso: string
}

export function partitionEmptyRoomFolders<T extends { value: string }>(
  folders: readonly T[],
  filled: ReadonlySet<string>
): { emptyFolders: T[]; optionalEmptyFolders: T[] } {
  const empty = folders.filter((folder) => !filled.has(folder.value))
  return {
    emptyFolders: empty.filter((folder) => !isOptionalRoomFolder(folder.value)),
    optionalEmptyFolders: empty.filter((folder) => isOptionalRoomFolder(folder.value)),
  }
}

function shellCounts(folders: readonly RoomFolderCount[]): Map<string, number> {
  const counts = new Map<string, number>(VDR_SHELL_FOLDER_VALUES.map((folder) => [folder, 0]))
  for (const row of folders) {
    if (row.count <= 0) continue
    const folder = getVdrShellFolderValue(row.folder)
    counts.set(folder, (counts.get(folder) ?? 0) + row.count)
  }
  return counts
}

function clientItemDone(
  key: ClientItemKey,
  input: RoomProgressInput,
  counts: Map<string, number>
): boolean {
  if (key === 'nameConfirmed') return input.nameConfirmed
  if (key === 'phone') return input.phonePresent
  if (key === 'financials') return (counts.get('room_financial') ?? 0) > 0
  if (key === 'legal') return (counts.get('room_legal') ?? 0) > 0
  if (key === 'corporate') return (counts.get('room_corporate') ?? 0) > 0
  const _exhaustive: never = key
  return _exhaustive
}

export function roomProgressInputFromSala(sala: {
  documentos?: ReadonlyArray<{ carpeta: string; nombre: string; actualizadoEn: number }>
  phonePresent?: boolean
  nameConfirmed?: boolean
  deliverables?: readonly RoomDeliverableInput[]
  conteosPorCarpeta?: Readonly<Record<string, number>>
  ultimoMovimiento?: RoomLastMovement | null
}): RoomProgressInput {
  const folders = new Map<string, number>()
  let lastMovement: RoomLastMovement | null = sala.ultimoMovimiento ?? null
  if (sala.conteosPorCarpeta) {
    for (const [folder, count] of Object.entries(sala.conteosPorCarpeta)) {
      folders.set(folder, count)
    }
  }
  for (const document of sala.documentos ?? []) {
    if (!sala.conteosPorCarpeta) {
      folders.set(document.carpeta, (folders.get(document.carpeta) ?? 0) + 1)
    }
    if (sala.ultimoMovimiento !== undefined) continue
    if (lastMovement === null || document.actualizadoEn >= lastMovement.at) {
      lastMovement = { nombre: document.nombre, at: document.actualizadoEn }
    }
  }
  return {
    folders: [...folders.entries()].map(([folder, count]) => ({ folder, count })),
    phonePresent: sala.phonePresent === true,
    nameConfirmed: sala.nameConfirmed === true,
    deliverables: sala.deliverables ?? [],
    lastMovement,
  }
}

export function computeRoomProgress(input: RoomProgressInput): RoomProgress {
  const counts = shellCounts(input.folders)
  const foldersWithDocuments = VDR_SHELL_FOLDER_VALUES.filter(
    (folder) => (counts.get(folder) ?? 0) > 0
  )
  const empty = VDR_SHELL_FOLDER_VALUES.filter((folder) => (counts.get(folder) ?? 0) === 0)
  const emptyRequiredFolders = empty.filter((folder) => !isOptionalRoomFolder(folder))
  const emptyOptionalFolders = empty.filter((folder) => isOptionalRoomFolder(folder))
  const checklist = CLIENT_ITEM_KEYS.map((key) => ({
    key,
    done: clientItemDone(key, input, counts),
  }))
  const ready = checklist.filter((item) => item.done).length
  const byKey = new Map(input.deliverables.map((row) => [row.key, row.status]))
  const deliverables = STAGE_ORDER.map((key) => ({
    key,
    status: byKey.get(key) ?? 'PENDING',
  }))
  const firstMissing = checklist.find((item) => !item.done)
  const firstOpenStage = deliverables.find((row) => row.status !== 'DELIVERED')
  const siguientePaso = firstMissing
    ? `items.${firstMissing.key}`
    : firstOpenStage
      ? `stages.${firstOpenStage.key}`
      : 'kickoffQuestion'

  return {
    percent: Math.round((ready / CHECKLIST_TOTAL) * 100),
    foldersWithDocuments,
    emptyRequiredFolders,
    emptyOptionalFolders,
    checklist,
    deliverables,
    lastMovement: input.lastMovement,
    siguientePaso,
  }
}
