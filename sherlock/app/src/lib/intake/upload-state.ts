// ============================================================================
// ESTADO POR ARCHIVO DE UNA CARGA AL INTAKE TEMPORAL
// ============================================================================
// Lo que la UI sabe de cada archivo mientras `uploadIntakeFile` lo lleva por
// huella → intent → bytes → registro. Un union discriminado: la fila pinta su
// etiqueta y su barra a partir de él y nada más. Los motivos de fallo son los
// que el pipeline ya distingue; no hay más granularidad que la que el servidor
// devuelve.
// ============================================================================

import { Schema } from 'effect'

/**
 * Los seis motivos terminales. Es la fuente única: `upload-file-program.ts`
 * los declaraba otra vez en su `TaggedError` y las dos listas coincidían por
 * casualidad — agregar un motivo allá y no acá compilaba, y la fila de la UI
 * se quedaba sin etiqueta.
 */
export const IntakeUploadFailureReasonSchema = Schema.Literals([
  'type',
  'size',
  'intent',
  'bytes',
  'register',
  'network',
])
export type IntakeUploadFailureReason = typeof IntakeUploadFailureReasonSchema.Type

/** Las seis etapas por las que pasa la fila. `isTerminal` sale de este mismo
 *  catálogo, no de una segunda lista escrita a mano. */
const IntakeUploadStateKindSchema = Schema.Literals([
  'queued',
  'hashing',
  'uploading',
  'received',
  'failed',
  'cancelled',
])
const isTerminalKind = Schema.is(
  IntakeUploadStateKindSchema.pick(['received', 'failed', 'cancelled'])
)

export type IntakeFileUploadState =
  | { kind: 'queued' }
  | { kind: 'hashing' }
  | { kind: 'uploading'; loaded: number; total: number }
  | { kind: 'received' }
  | { kind: 'failed'; reason: IntakeUploadFailureReason }
  | { kind: 'cancelled' }

export type IntakeUploadEntry = {
  key: string
  file: File
  state: IntakeFileUploadState
}

// Bytes que ya llegaron al proveedor: un archivo recibido cuenta entero y uno
// en vuelo cuenta lo que su XHR reportó. Los demás no aportan.
export function receivedBytes(entries: readonly IntakeUploadEntry[]): number {
  return entries.reduce((total, { file, state }) => {
    if (state.kind === 'received') return total + file.size
    if (state.kind === 'uploading') return total + Math.min(state.loaded, file.size)
    return total
  }, 0)
}

export function totalBytes(entries: readonly IntakeUploadEntry[]): number {
  return entries.reduce((total, { file }) => total + file.size, 0)
}

export function isTerminal(state: IntakeFileUploadState): boolean {
  return isTerminalKind(state.kind)
}

// Huella con la que un archivo se reconoce de una selección a la siguiente:
// nombre, tamaño y fecha de modificación. La posición NO entra, porque entre
// cancelar y reintentar el cliente puede agregar o quitar archivos y el mismo
// PDF cae en otro índice. Es la llave para buscar el estado previo de un
// archivo, no la key de React de su fila.
export function fileFingerprint(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}|${file.size}|${file.lastModified}`
}

// Estado terminal previo de cada archivo del lote anterior, por huella. Con
// dos entradas de la misma huella gana la última: el servidor de todos modos
// reconcilia por sha256, así que el flag solo necesita acertar el archivo.
export function previousStatesByFingerprint(
  entries: readonly IntakeUploadEntry[]
): Map<string, IntakeFileUploadState> {
  return new Map(entries.map((entry) => [fileFingerprint(entry.file), entry.state]))
}

// El servidor solo supersede un intent ISSUED de la misma huella cuando el
// cliente se lo pide, y el cliente se lo pide únicamente cuando ese mismo
// archivo ya tuvo en esta página un intento terminal no recibido: cancelado,
// o fallido después de pedir intent (bytes, red o registro). Un fallo de tipo,
// tamaño o intent nunca dejó un ISSUED atrás, y otra pestaña a mitad de XHR
// no es asunto de esta.
export function shouldSupersedePending(previous: IntakeFileUploadState | undefined): boolean {
  if (!previous) return false
  if (previous.kind === 'cancelled') return true
  return (
    previous.kind === 'failed' &&
    (previous.reason === 'bytes' || previous.reason === 'network' || previous.reason === 'register')
  )
}
