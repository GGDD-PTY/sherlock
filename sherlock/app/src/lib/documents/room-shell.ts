// ============================================================================
// ROOM SHELL — MODELO PURO DEL FILESYSTEM DEL VDR
// ============================================================================
// Proyección de `documents` a filas de shell, iconografía por MIME y orden.
// Sin React, sin Convex: todo lo que se puede probar sin navegador vive aquí.
// ============================================================================

import { Schema } from 'effect'

import { isDocumentAccessLevel, type DocumentAccessLevel } from '@/lib/documents/classification'
import { VDR_SHELL_FOLDER_VALUES, getVdrShellFolderValue } from '@/lib/vdr/document-taxonomy'

// Las uniones que solo describen (orden, ícono, estado) se escriben directas:
// nada las valida en runtime. La que SÍ estrecha entrada ajena —`sourceType`,
// que llega como string de una fila de Convex— vive como catálogo, porque antes
// existía dos veces: la unión de TypeScript y la lista escrita a mano en el
// `if`. Agregar un `sourceType` nuevo al tipo compilaba, y `resolveSourceType`
// lo seguía tirando a `null`.
export type RoomShellSort = 'process' | 'name' | 'modified'

export type RoomFileKind = 'spreadsheet' | 'pdf' | 'document' | 'presentation' | 'image' | 'other'

export type RoomDocumentStatus = 'READY' | 'PENDING' | 'SCANNING' | 'QUARANTINED' | 'ARCHIVED'

const RoomDocumentSourceSchema = Schema.Literals([
  'USER_UPLOAD',
  'PUBLIC_SOURCE',
  'SYNTHETIC_DEMO',
  'TEAM_DELIVERABLE',
])
type RoomDocumentSource = typeof RoomDocumentSourceSchema.Type

// `documents.sourceType` y `documents.accessLevel` son columnas de Convex con
// filas viejas: lo que llega es `unknown` con forma de string.
const isRoomDocumentSource = Schema.is(RoomDocumentSourceSchema)

export type RoomShellDocument = {
  id: string
  name: string
  /** Valor canónico de una de las cinco carpetas fijas. */
  folder: string
  /** Valor crudo guardado en `documents.folder` (para no perder el original). */
  rawFolder: string | null
  mimeType: string | null
  sizeBytes: number | null
  versionNumber: number | null
  versionId: string | null
  updatedAt: number
  accessLevel: DocumentAccessLevel
  status: RoomDocumentStatus
  kind: RoomFileKind
  /** Procedencia declarada del documento; ausente = subido por la empresa. */
  sourceType: RoomDocumentSource | null
  sourceName: string | null
}

export type RoomShellSourceDocument = {
  _id: string
  _creationTime?: number
  createdAt?: string | null
  name: string
  folder?: string | null
  fileType?: string | null
  fileSize?: number | null
  accessLevel?: string | null
  updatedAt?: number | null
  currentVersionNumber?: number | null
  currentVersionId?: string | null
  publishedVersionId?: string | null
  lifecycleStatus?: string | null
  sourceType?: string | null
  sourceName?: string | null
}

const SPREADSHEET_HINTS = ['spreadsheet', 'excel', 'csv', 'ms-excel']
const PRESENTATION_HINTS = ['presentation', 'powerpoint']
const DOCUMENT_HINTS = ['word', 'wordprocessing', 'rtf', 'text/plain', 'markdown']

// La extensión sale del nombre que escribió el que subió el archivo.
// `EXTENSION_KINDS['constructor']` sobre un objeto plano devolvía la función
// `Object` como si fuera un `RoomFileKind`.
const EXTENSION_KINDS = new Map<string, RoomFileKind>(
  Object.entries({
    xlsx: 'spreadsheet',
    xlsm: 'spreadsheet',
    xls: 'spreadsheet',
    csv: 'spreadsheet',
    pdf: 'pdf',
    docx: 'document',
    doc: 'document',
    md: 'document',
    txt: 'document',
    pptx: 'presentation',
    ppt: 'presentation',
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    webp: 'image',
    gif: 'image',
  })
)

export function getRoomFileKind(
  mimeType: string | null | undefined,
  name?: string | null
): RoomFileKind {
  const type = (mimeType ?? '').toLowerCase()

  if (type === 'application/pdf' || type === 'pdf') return 'pdf'
  if (type.startsWith('image/')) return 'image'
  if (SPREADSHEET_HINTS.some((hint) => type.includes(hint))) return 'spreadsheet'
  if (PRESENTATION_HINTS.some((hint) => type.includes(hint))) return 'presentation'
  if (DOCUMENT_HINTS.some((hint) => type.includes(hint))) return 'document'

  const extension = (name ?? '').toLowerCase().split('.').pop() ?? ''
  return EXTENSION_KINDS.get(extension) ?? 'other'
}

function resolveStatus(document: RoomShellSourceDocument): RoomDocumentStatus {
  if (document.lifecycleStatus === 'QUARANTINED') return 'QUARANTINED'
  if (document.lifecycleStatus === 'ARCHIVED') return 'ARCHIVED'
  if (!document.publishedVersionId && document.currentVersionId) return 'SCANNING'
  if (!document.currentVersionId) return 'PENDING'
  return 'READY'
}

function resolveSourceType(value: string | null | undefined): RoomDocumentSource | null {
  return isRoomDocumentSource(value) ? value : null
}

// `NDA_REQUIRED` es el default deliberado: un valor que no está en el catálogo
// se trata como confidencial, nunca como público.
function resolveAccessLevel(value: string | null | undefined): DocumentAccessLevel {
  return isDocumentAccessLevel(value) ? value : 'NDA_REQUIRED'
}

function resolveRoomDocumentTimestamp(document: RoomShellSourceDocument): number {
  if (typeof document.updatedAt === 'number') return document.updatedAt
  if (typeof document._creationTime === 'number') return document._creationTime
  if (typeof document.createdAt !== 'string') return 0
  const parsed = Date.parse(document.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

export function toRoomShellDocument(document: RoomShellSourceDocument): RoomShellDocument {
  const rawFolder = document.folder ?? null

  return {
    id: document._id,
    name: document.name,
    folder: getVdrShellFolderValue(rawFolder),
    rawFolder,
    mimeType: document.fileType ?? null,
    sizeBytes: typeof document.fileSize === 'number' ? document.fileSize : null,
    versionNumber:
      typeof document.currentVersionNumber === 'number' ? document.currentVersionNumber : null,
    versionId: document.publishedVersionId ?? document.currentVersionId ?? null,
    updatedAt: resolveRoomDocumentTimestamp(document),
    accessLevel: resolveAccessLevel(document.accessLevel),
    status: resolveStatus(document),
    kind: getRoomFileKind(document.fileType, document.name),
    sourceType: resolveSourceType(document.sourceType),
    sourceName: document.sourceName?.trim() || null,
  }
}

/** Último cambio registrado en la sala, para la portada del dossier. */
export function latestRoomUpdate(documents: readonly RoomShellDocument[]): number | null {
  let latest = 0
  for (const document of documents) if (document.updatedAt > latest) latest = document.updatedAt
  return latest > 0 ? latest : null
}

function compareNames(left: RoomShellDocument, right: RoomShellDocument) {
  return left.name.localeCompare(right.name, 'es', { numeric: true, sensitivity: 'base' })
}

/**
 * `process` ordena por el orden del proceso (carpeta 1 a 5, luego nombre), que
 * es el orden con el que se arma un data room, no el alfabético.
 */
export function sortRoomDocuments(
  documents: readonly RoomShellDocument[],
  sort: RoomShellSort
): RoomShellDocument[] {
  const ordered = [...documents]

  if (sort === 'name') return ordered.sort(compareNames)
  if (sort === 'modified') {
    return ordered.sort((left, right) =>
      right.updatedAt === left.updatedAt
        ? compareNames(left, right)
        : right.updatedAt - left.updatedAt
    )
  }

  return ordered.sort((left, right) => {
    const leftIndex = VDR_SHELL_FOLDER_VALUES.indexOf(left.folder)
    const rightIndex = VDR_SHELL_FOLDER_VALUES.indexOf(right.folder)
    return leftIndex === rightIndex ? compareNames(left, right) : leftIndex - rightIndex
  })
}

export function filterRoomDocuments(
  documents: readonly RoomShellDocument[],
  search: string
): RoomShellDocument[] {
  const needle = normalizeRoomSearch(search)
  if (!needle) return [...documents]
  return documents.filter((document) => normalizeRoomSearch(document.name).includes(needle))
}

function normalizeRoomSearch(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'] as const

export function formatRoomFileSize(bytes: number | null | undefined, _locale: 'es') {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} ${SIZE_UNITS[0]}`

  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value.toLocaleString('es-PA', {
    minimumFractionDigits: value < 10 ? 1 : 0,
    maximumFractionDigits: value < 10 ? 1 : 0,
  })} ${SIZE_UNITS[unit]}`
}
