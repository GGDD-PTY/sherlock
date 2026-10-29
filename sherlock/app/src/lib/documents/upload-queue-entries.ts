// ============================================================================
// COLA DE SUBIDA DEL VDR — LA PARTE PURA
// ============================================================================
// Validar un archivo, armar las filas de la tanda y filtrar las que todavía
// pueden subir son funciones puras y SÍNCRONAS: la sala las llama en el render
// del diálogo y en el mismo gesto en que el cliente suelta los archivos.
//
// Viven aparte de `upload-queue.ts` ([F] 2026-09-08) porque allá vive
// `settleWithConcurrency`, que corre la tanda con concurrencia acotada y llega
// por `import()`: son responsabilidades distintas, no una reversión.
//
// `upload-queue.ts` los re-exporta, así que ningún caller viejo cambia.
//
// El catálogo de MIME permitidos NO se vuelve a escribir acá: es el mismo
// `isDirectUploadMimeType` que valida la mutation server-side, así que las dos
// orillas aceptan exactamente lo mismo. Antes esto era un `Set` armado a mano
// desde la lista, es decir un segundo guardia sobre el mismo catálogo.
// ============================================================================

import { Schema } from 'effect'

import {
  directUploadLimitBytesForMimeType,
  isDirectUploadMimeType,
} from '../../../convex/_documents/uploadLimits'
import { inferVdrFolderFromName } from '@/lib/vdr/document-taxonomy'

type VdrQueuedUploadStatus = 'PENDING' | 'UPLOADING' | 'DONE' | 'ERROR'

export type VdrQueuedUpload = {
  id: string
  file: File
  name: string
  /** Ruteo por archivo. Sin él manda la carpeta del formulario de la sala. */
  folder?: string
  status: VdrQueuedUploadStatus
  error?: string
  retryable?: boolean
  reconciliationRequired?: boolean
}

/**
 * De dónde salió la tanda. `ROOM` es el diálogo de la sala: el cliente escogió
 * la carpeta y edita el nombre, así que el basename es el valor por defecto.
 * `INTAKE_HANDOFF` es el sobre que la landing parqueó en IndexedDB — el mismo
 * gesto que el intake temporal — y tiene que aterrizar igual que su claim
 * (`convex/_intake/claim.ts`): nombre completo y carpeta ruteada por el nombre.
 */
export type VdrUploadOrigin = 'ROOM' | 'INTAKE_HANDOFF'

export const MAX_VDR_FILES_PER_BATCH = 20
export const MAX_CONCURRENT_VDR_UPLOADS = 2

const UploadExtensionSchema = Schema.Literals([
  'pdf',
  'xls',
  'xlsx',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'csv',
])
const isUploadExtension = Schema.is(UploadExtensionSchema)

// Browsers disagree about the MIME of a .csv; the direct upload collapses these
// aliases to text/csv and the server inspects the bytes, so the queue accepts them.
const CsvDeclaredTypeAliasSchema = Schema.Literals(['text/csv', 'application/csv', 'text/plain'])
const isCsvDeclaredTypeAlias = Schema.is(CsvDeclaredTypeAliasSchema)

export type UploadQueueValidationCopy = {
  fileTypeError: string
  fileSizeError: string
}

function uploadExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : ''
}

export function stripUploadExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(0, dot) : fileName
}

export function validateQueuedUpload(file: File, copy: UploadQueueValidationCopy): string | null {
  const extension = uploadExtension(file.name)
  const declaredTypeAllowed =
    file.type.length === 0 ||
    isDirectUploadMimeType(file.type) ||
    (extension === 'csv' && isCsvDeclaredTypeAlias(file.type))

  if (!isUploadExtension(extension) || !declaredTypeAllowed) return copy.fileTypeError
  const sizeLimit = directUploadLimitBytesForMimeType(extension === 'csv' ? 'text/csv' : file.type)
  if (file.size <= 0 || file.size > sizeLimit) return copy.fileSizeError
  return null
}

export function buildUploadQueueEntries(args: {
  files: File[]
  alreadyQueued: number
  startKey: number
  copy: UploadQueueValidationCopy
  origin?: VdrUploadOrigin
}): { entries: VdrQueuedUpload[]; nextKey: number; droppedOverLimit: number } {
  const remaining = Math.max(0, MAX_VDR_FILES_PER_BATCH - args.alreadyQueued)
  const accepted = args.files.slice(0, remaining)
  const fromLanding = args.origin === 'INTAKE_HANDOFF'
  let nextKey = args.startKey

  const entries = accepted.map((file) => {
    nextKey += 1
    const error = validateQueuedUpload(file, args.copy)
    return {
      id: `${nextKey}-${file.name}`,
      file,
      name: fromLanding ? file.name : stripUploadExtension(file.name) || file.name,
      ...(fromLanding ? { folder: inferVdrFolderFromName(file.name) } : {}),
      status: error ? ('ERROR' as const) : ('PENDING' as const),
      ...(error ? { error, retryable: false } : {}),
    }
  })

  return {
    entries,
    nextKey,
    droppedOverLimit: args.files.length - accepted.length,
  }
}

export function uploadableQueueEntries(queue: readonly VdrQueuedUpload[]): VdrQueuedUpload[] {
  return queue.filter(
    (entry) =>
      entry.status === 'PENDING' ||
      (entry.status === 'ERROR' && entry.retryable === true && !entry.reconciliationRequired)
  )
}

export function isRetryableQueuedUploadFailure(result: {
  code: string
  reconciliationRequired?: true
}): boolean {
  return (
    result.reconciliationRequired !== true &&
    (result.code === 'FILE_HASH_FAILED' || result.code === 'STORAGE_UPLOAD_FAILED')
  )
}
