// ============================================================================
// INTENCIÓN DE ACCESO A DOCUMENTOS (VIEW vs DOWNLOAD)
// ============================================================================
// Módulo aparte de `shared.ts` a propósito: `shared.ts` concentra el IO del VDR
// y las suites existentes lo reemplazan entero con factories de `vi.mock`.
// Estas piezas son puras y las consume la ruta caliente de emisión de grants,
// así que viven donde nadie tenga que acordarse de re-mockearlas.
// ============================================================================

import { v } from 'convex/values'
import { Schema } from 'effect'

import type { Doc } from '../_generated/dataModel'

// ES: Forma única de la intención de acceso a un documento. Ya existía inline en
// `logLocalStorageAccess`; se centraliza para que la emisión de grants, la
// entrega y la bitácora hablen exactamente del mismo vocabulario. La lista es
// la fuente: de ella salen el tipo, el guard y el validador de Convex, que
// antes se deletreaban por separado.
// EN: single shared shape for document access intent.
const DOCUMENT_ACCESS_ACTIONS = ['VIEW', 'DOWNLOAD'] as const

const DocumentAccessActionSchema = Schema.Literals(DOCUMENT_ACCESS_ACTIONS)

export type DocumentAccessAction = typeof DocumentAccessActionSchema.Type

const isDocumentAccessAction = Schema.is(DocumentAccessActionSchema)

export const documentAccessActionValidator = v.union(
  v.literal(DOCUMENT_ACCESS_ACTIONS[0]),
  v.literal(DOCUMENT_ACCESS_ACTIONS[1])
)

const INLINE_VIEW_MIMES = new Set([
  'application/pdf',
  'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'pptx',
  'text/csv',
  'csv',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
])

const INLINE_VIEW_EXTENSIONS = new Set([
  'pdf',
  'xlsx',
  'xlsm',
  'docx',
  'pptx',
  'csv',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'avif',
])

// ES: VIEW coincide con cada renderer inline real. Los formatos activos o sin
// renderer siguen en DOWNLOAD, y ambas intenciones conservan política, auditoría
// y presupuesto de extracción separados.
type DocumentAccessDescriptor = Pick<Doc<'documents'>, 'fileType' | 'name'>

export function isInlineViewableDocument(document: DocumentAccessDescriptor): boolean {
  const fileType = document.fileType?.split(';')[0].trim().toLowerCase()
  if (fileType && INLINE_VIEW_MIMES.has(fileType)) return true

  if (fileType && fileType !== 'application/octet-stream' && fileType !== 'binary/octet-stream') {
    return false
  }

  const extension = document.name?.trim().toLowerCase().split('.').pop() ?? ''
  return INLINE_VIEW_EXTENSIONS.has(extension)
}

// ES: El default es DOWNLOAD y es deliberado — sin `action`, el comportamiento
// es byte a byte el de hoy (DocumentsList, MyCompanyDocuments, grants viejos).
// El guard decodifica en vez de solo comparar contra 'VIEW': `requested` llega
// narrowed por TypeScript, pero el validador vive en el schema de CADA mutation
// que llama a esta función (`logLocalStorageAccess`, `getDocumentAccessGrant`,
// `getDownloadUrl`) — este helper compartido no puede asumir que el que lo
// llamó pasó por ahí. Cualquier valor que no sea 'VIEW' cae a DOWNLOAD, que es
// el mismo resultado que ya tenía.
// EN: unspecified (or invalid) intent means DOWNLOAD — fully backward compatible.
export function resolveDocumentAccessIntent(
  requested: DocumentAccessAction | undefined,
  document: DocumentAccessDescriptor
): DocumentAccessAction {
  if (!isDocumentAccessAction(requested) || requested === 'DOWNLOAD') {
    return 'DOWNLOAD'
  }

  return isInlineViewableDocument(document) ? 'VIEW' : 'DOWNLOAD'
}
