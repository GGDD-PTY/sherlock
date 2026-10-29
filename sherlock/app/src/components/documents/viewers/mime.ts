// ============================================================================
// DESPACHO POR MIME DEL VISOR DEL VDR
// ============================================================================
// Decide QUE renderer abre un archivo. Es una funcion pura y sin React para
// que el contrato quede probado sin montar nada, y para que el shell del VDR
// pueda anticipar la accion (Abrir vs Descargar) antes de pedir el grant.
//
// Regla de seguridad que no se negocia: cualquier tipo que pudiera ejecutarse
// en el origen privilegiado (HTML, SVG, XML con hojas de estilo) cae a
// `download`. El precedente vive en `DeliverableViewer.tsx:30-32`, donde el
// HTML de un entregable se sirve como `text/plain` a proposito.
// ============================================================================

import { Schema } from 'effect'

/**
 * El vocabulario de renderers, escrito UNA vez. El tipo sale de esta lista, y
 * `isViewerKind` la usa para cerrar el hueco de las dos tablas de abajo: son
 * `Record<string, ...>`, y TypeScript no comprueba que una clave exista antes
 * de devolver su valor, asi que un fallo de tecleo entregaba un "kind" que no
 * esta en la union y el `switch` del despacho lo mandaba al default sin decir
 * nada.
 */
const ViewerKind = Schema.Literals(['xlsx', 'pdf', 'docx', 'pptx', 'image', 'csv', 'download'])

export type DocumentViewerKind = typeof ViewerKind.Type

const isViewerKind = Schema.is(ViewerKind)

/** El valor de la tabla si es un renderer conocido; `null` si no hay entrada. */
function lookupKind(
  table: Record<string, DocumentViewerKind>,
  key: string
): DocumentViewerKind | null {
  if (!key) return null
  const kind: unknown = table[key]
  return isViewerKind(kind) ? kind : null
}

const MIME_KINDS: Record<string, DocumentViewerKind> = {
  'application/pdf': 'pdf',
  // El grant heredado a veces guarda la extension en vez del MIME. La lista de
  // alias cubre estos cinco; una extension de imagen o `xlsm` guardada asi no
  // se reconoce y cae a descarga por la regla del MIME especifico de abajo.
  pdf: 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  xlsx: 'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  docx: 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  pptx: 'pptx',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'image/avif': 'image',
  'text/csv': 'csv',
  csv: 'csv',
}

const EXTENSION_KINDS: Record<string, DocumentViewerKind> = {
  pdf: 'pdf',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  docx: 'docx',
  pptx: 'pptx',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  avif: 'image',
  csv: 'csv',
}

// Formatos binarios heredados (BIFF/CFB) y todo lo que pueda ejecutarse: no hay
// vista previa, se descargan. Se listan explicitamente para que quede claro que
// la ausencia de renderer es una decision y no un olvido.
const FORCED_DOWNLOAD_MIMES = new Set([
  'application/vnd.ms-excel',
  'application/msword',
  'application/vnd.ms-powerpoint',
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
])

const FORCED_DOWNLOAD_EXTENSIONS = new Set([
  'xls',
  'xlsb',
  'doc',
  'ppt',
  'htm',
  'html',
  'xhtml',
  'svg',
  'xml',
])

function normalizeMime(mimeType: string | null | undefined): string {
  return (mimeType ?? '').split(';')[0].trim().toLowerCase()
}

export function fileExtension(fileName: string | null | undefined): string {
  const name = (fileName ?? '').trim().toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

/**
 * El MIME declarado manda; la extension solo desempata cuando el MIME es
 * generico (`application/octet-stream`) o viene vacio, que es lo que pasa con
 * subidas hechas desde clientes que no lo declaran.
 */
export function resolveDocumentViewerKind(
  mimeType: string | null | undefined,
  fileName: string | null | undefined
): DocumentViewerKind {
  const mime = normalizeMime(mimeType)
  const extension = fileExtension(fileName)

  if (FORCED_DOWNLOAD_MIMES.has(mime)) return 'download'
  const byMime = lookupKind(MIME_KINDS, mime)
  if (byMime) return byMime

  if (FORCED_DOWNLOAD_EXTENSIONS.has(extension)) return 'download'
  if (mime && mime !== 'application/octet-stream' && mime !== 'binary/octet-stream') {
    // Un MIME especifico que no conocemos no se re-interpreta por extension:
    // renderizar contra lo que dice el nombre es justo el disfraz que el
    // inspector de subidas (`officeFileInspection.ts`) existe para cerrar.
    return 'download'
  }

  return lookupKind(EXTENSION_KINDS, extension) ?? 'download'
}

/** True cuando el visor puede mostrar el archivo sin bajarlo al disco. */
export function isPreviewableDocument(
  mimeType: string | null | undefined,
  fileName: string | null | undefined
): boolean {
  return resolveDocumentViewerKind(mimeType, fileName) !== 'download'
}
