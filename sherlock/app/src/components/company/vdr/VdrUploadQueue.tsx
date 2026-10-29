// ============================================================================
// COLA DE CARGA
// ============================================================================
// ===== LA COSTURA CON EFFECT =====
// El estado de cada archivo se leía con un ternario anidado de cuatro niveles
// —una vez para el rótulo y otra para el ícono— y las dos cadenas de ternarios
// tenían que estar de acuerdo entre sí a mano. Ahora los cuatro estados se
// definen una sola vez con `Schema.Literals` y cada uno trae su rótulo y su
// ícono en la misma fila de la tabla: agregar un estado quinto rompe la tabla
// en el compilador.
//
// La tabla sola no bastaba: la cadena de ternarios terminaba en un `else` que
// mandaba a «Pendiente» cualquier estado desconocido, y un `Record` indexado a
// secas habría devuelto `undefined` y reventado en la línea siguiente. Por eso
// el estado se DECODIFICA contra la unión y lo que no pertenece cae en
// `PENDING`, que es exactamente donde caía antes.

import { AlertTriangle, Check, Loader2, Trash2, type LucideIcon } from 'lucide-react'
import { Option, Schema } from 'effect'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { VdrQueuedUpload } from '@/lib/documents/upload-queue'
import { formatFileSize } from '@/lib/utils'
import type { VdrLocale } from './types'

type Props = {
  locale: VdrLocale
  queue: VdrQueuedUpload[]
  isUploading: boolean
  onRemove: (id: string) => void
}

const labels = {
  es: {
    selected: (count: number) =>
      `${count} ${count === 1 ? 'archivo seleccionado' : 'archivos seleccionados'}`,
    pending: 'Pendiente',
    uploading: 'Subiendo',
    done: 'Subido',
    error: 'Requiere atención',
    remove: 'Quitar',
  },
} as const

const VdrQueuedUploadStatusSchema = Schema.Literals(['PENDING', 'UPLOADING', 'DONE', 'ERROR'])
type VdrQueuedUploadStatus = typeof VdrQueuedUploadStatusSchema.Type

const decodeStatus = Schema.decodeUnknownOption(VdrQueuedUploadStatusSchema)

function queuedStatus(value: unknown): VdrQueuedUploadStatus {
  const decoded = decodeStatus(value)
  return Option.isSome(decoded) ? decoded.value : 'PENDING'
}

type StatusLabelKey = 'pending' | 'uploading' | 'done' | 'error'

const STATUS_META: Record<
  VdrQueuedUploadStatus,
  { labelKey: StatusLabelKey; icon: LucideIcon | null; spin: boolean }
> = {
  PENDING: { labelKey: 'pending', icon: null, spin: false },
  UPLOADING: { labelKey: 'uploading', icon: Loader2, spin: true },
  DONE: { labelKey: 'done', icon: Check, spin: false },
  ERROR: { labelKey: 'error', icon: AlertTriangle, spin: false },
}

export function VdrUploadQueue({ locale, queue, isUploading, onRemove }: Props) {
  if (queue.length === 0) return null
  const copy = labels[locale]

  return (
    <section className="space-y-2" aria-label={copy.selected(queue.length)}>
      <p className="text-sm font-medium">{copy.selected(queue.length)}</p>
      <ul className="divide-border max-h-[38dvh] divide-y overflow-y-auto rounded-md border">
        {queue.map((entry) => {
          const meta = STATUS_META[queuedStatus(entry.status)]
          const StatusIcon = meta.icon
          const statusLabel = copy[meta.labelKey]

          return (
            <li key={entry.id} className="flex items-start justify-between gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{entry.file.name}</p>
                <p className="text-muted-foreground font-data text-xs">
                  {formatFileSize(entry.file.size)}
                </p>
                {entry.error ? (
                  <p className="text-destructive mt-1 text-xs" role="alert">
                    {entry.error}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="outline" aria-live="polite">
                  {StatusIcon ? (
                    <StatusIcon
                      className={
                        meta.spin
                          ? 'mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none'
                          : 'mr-1 h-3.5 w-3.5'
                      }
                    />
                  ) : null}
                  {statusLabel}
                </Badge>
                {entry.status === 'UPLOADING' ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${copy.remove}: ${entry.file.name}`}
                    disabled={isUploading}
                    onClick={() => onRemove(entry.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
