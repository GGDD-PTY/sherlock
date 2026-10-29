'use client'

import { Download, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Effect, Schema } from 'effect'

import { Button } from '@/components/ui/button'
import { runClientEffect } from '@/lib/effect/client-runtime'
import { describeCause } from '@/lib/effect/errors'
import { saveBlob } from '@/lib/utils/save-blob'
import { logApiError, readApiError } from '@/lib/vdr/read-api-error'
import type { RoomLocale } from './copy'

/**
 * Los cuatro finales de una exportación, nombrados.
 *
 * Antes la ruta feliz y los tres avisos vivían entremezclados con el
 * transporte: cada `return` temprano hacía su `toast` en medio del `fetch`.
 * Ahora el programa decide CUÁL de los cuatro es, y quien lo corre decide qué
 * se le dice al cliente. Son dos preguntas distintas y se responden en dos
 * sitios distintos.
 */
type ExportOutcome = 'downloaded' | 'too-large' | 'empty' | 'failed'

/** El zip no se pudo pedir: la sala no se entera de por qué, la traza sí. */
class RoomZipExportError extends Schema.TaggedError<RoomZipExportError>()('RoomZipExportError', {
  stage: Schema.Literals(['request', 'body']),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

function transportFailure(stage: 'request' | 'body') {
  return (cause: unknown): RoomZipExportError =>
    new RoomZipExportError({
      stage,
      message: describeCause(cause),
      cause,
    })
}

function filenameFromDisposition(header: string | null): string {
  if (!header) return 'sala.zip'
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1])
    } catch {
      // El respaldo ASCII cubre clientes que no decodifican filename*.
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(header)
  return quoted?.[1] ?? 'sala.zip'
}

/** Pide el zip de la sala y, si llega, lo entrega. Devuelve cuál de los cuatro finales fue. */
const exportRoomZip = Effect.fn('RoomZip.export')(function* (
  query: string
): Effect.fn.Return<ExportOutcome, RoomZipExportError> {
  const response = yield* Effect.tryPromise({
    try: () => fetch(`/api/vdr/export?${query}`, { method: 'GET', credentials: 'same-origin' }),
    catch: transportFailure('request'),
  })

  if (!response.ok) {
    const apiError = yield* readApiError(response)
    yield* logApiError('Room ZIP export request failed', apiError)
    if (response.status === 413) return 'too-large'
    if (response.status === 404) return 'empty'
    return 'failed'
  }

  const blob = yield* Effect.tryPromise({
    try: () => response.blob(),
    catch: transportFailure('body'),
  })

  yield* saveBlob(blob, filenameFromDisposition(response.headers.get('Content-Disposition')))

  return 'downloaded'
})

type Props = {
  companyId?: string
  folder?: string
  locale: RoomLocale
  label: string
  pendingLabel: string
  successLabel: string
  errorLabel: string
  tooLargeLabel: string
  emptyLabel?: string
  testId: string
  variant?: 'outline' | 'ghost' | 'default'
  size?: 'sm' | 'default'
}

export function RoomZipExportButton({
  companyId,
  folder,
  locale,
  label,
  pendingLabel,
  successLabel,
  errorLabel,
  tooLargeLabel,
  emptyLabel,
  testId,
  variant = 'outline',
  size,
}: Props) {
  const [pending, setPending] = useState(false)
  // Lo que se dice en voz alta. El botón vuelve a su rótulo inicial cuando
  // termina, así que sin esto el éxito y el fallo mudo se ven igual.
  const [status, setStatus] = useState('')

  async function handleExport() {
    if (pending) return
    setPending(true)
    setStatus(pendingLabel)

    const params = new URLSearchParams()
    params.set('locale', locale)
    if (companyId) params.set('companyId', companyId)
    if (folder) params.set('folder', folder)

    // El programa no lanza: decide. Un fallo de transporte es el mismo final
    // que un 5xx para quien está mirando la sala.
    const outcome = await runClientEffect(
      exportRoomZip(params.toString()).pipe(
        Effect.catch(() => Effect.succeed<ExportOutcome>('failed'))
      )
    )
    setPending(false)

    if (outcome === 'downloaded') {
      toast.success(successLabel)
      setStatus(successLabel)
      return
    }

    const message =
      outcome === 'too-large'
        ? tooLargeLabel
        : outcome === 'empty'
          ? (emptyLabel ?? errorLabel)
          : errorLabel
    toast.error(message)
    setStatus(message)
  }

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={size === 'sm' ? undefined : 'h-10'}
        disabled={pending}
        data-testid={testId}
        aria-busy={pending}
        onClick={() => {
          void handleExport()
        }}
      >
        {pending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="mr-2 h-4 w-4" aria-hidden="true" />
        )}
        {pending ? pendingLabel : label}
      </Button>
      {/* El anuncio va fuera del botón: en móvil la barra de la sala pone el
          rótulo del botón en 0 px y el lector de pantalla se quedaba sin el
          final de la descarga. */}
      <span
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
        data-testid={`${testId}-status`}
      >
        {status}
      </span>
    </>
  )
}
