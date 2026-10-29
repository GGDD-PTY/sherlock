'use client'

// La landing y el workspace temporal pintan el mismo estado por archivo
// (`lib/intake/upload-state.ts`) con las mismas piezas: una barra por bytes
// con semántica ARIA y la etiqueta del estado. Cada superficie trae su propio
// `t` porque el copy vive en su propio namespace.

import { Schema } from 'effect'

import { formatFileSize, formatTransferredBytes } from '@/lib/intake/file-size'
import type { IntakeFileUploadState } from '@/lib/intake/upload-state'

type ProgressBarProps = {
  loaded: number
  total: number
  label: string
  className?: string
}

const ByteCountSchema = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const isByteCount = Schema.is(ByteCountSchema)
const isClassName = Schema.is(Schema.String)

function toByteCount(value: number): number {
  return isByteCount(value) ? value : 0
}

const IntakeUploadStateKindSchema = Schema.Literals([
  'queued',
  'hashing',
  'uploading',
  'received',
  'failed',
  'cancelled',
])
type IntakeUploadStateKind = typeof IntakeUploadStateKindSchema.Type
const isIntakeUploadStateKind = Schema.is(IntakeUploadStateKindSchema)

// Ancho por `loaded/total`. Un archivo vacío no divide por cero: se pinta
// lleno, que es lo que el proveedor va a reportar en cuanto responda. `NaN` e
// `Infinity` que lleguen del XHR caen a cero; un total de cero sigue pintando
// lleno.
export function IntakeUploadProgressBar({ loaded, total, label, className }: ProgressBarProps) {
  const safeLoaded = toByteCount(loaded)
  const safeTotal = toByteCount(total)
  const ratio = safeTotal > 0 ? Math.min(1, Math.max(0, safeLoaded / safeTotal)) : 1
  const safeClassName = isClassName(className) ? className : ''
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeTotal}
      aria-valuenow={Math.min(safeLoaded, safeTotal)}
      className={`bg-muted h-1 w-full overflow-hidden rounded-full ${safeClassName}`}
    >
      <div
        className="bg-primary h-full transition-[width] motion-reduce:transition-none"
        style={{ width: `${Math.round(ratio * 1000) / 10}%` }}
      />
    </div>
  )
}

// El `t` de next-intl ya acotado al namespace `progress` de cada superficie.
type StateTranslator = (key: string, values?: Record<string, string | number>) => string

// La clave de copy de cada etapa, escrita entera y no armada con una plantilla.
// `t(`states.${state.kind}`)` compilaba con cualquier etapa: una nueva salía en
// pantalla como el texto crudo `states.loquesea` en las DOS superficies,
// porque ninguna de las dos listas de `es.json` está atada a la unión. Con
// la tabla exhaustiva contra el catálogo del schema, agregar una etapa no
// compila hasta que alguien diga cómo se llama. Un `kind` que no esté en el
// catálogo cae a queued en vez de pasarle `undefined` a `t`.
const STATE_LABEL_KEY = {
  queued: 'states.queued',
  hashing: 'states.hashing',
  uploading: 'states.uploading',
  received: 'states.received',
  failed: 'states.failed',
  cancelled: 'states.cancelled',
} satisfies Record<IntakeUploadStateKind, string> & Record<IntakeFileUploadState['kind'], string>

export function uploadStateLabel(t: StateTranslator, state: IntakeFileUploadState): string {
  const kind = isIntakeUploadStateKind(state.kind) ? state.kind : 'queued'
  if (kind === 'uploading' && state.kind === 'uploading') {
    return t(STATE_LABEL_KEY.uploading, {
      loaded: formatTransferredBytes(Math.min(toByteCount(state.loaded), toByteCount(state.total))),
      total: formatFileSize(toByteCount(state.total)),
    })
  }
  return t(STATE_LABEL_KEY[kind])
}
