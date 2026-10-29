'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Schema } from 'effect'

import {
  ViewerError,
  ViewerFrame,
  ViewerLoading,
  type ViewerChromeProps,
  type ViewerStatus,
} from './ViewerChrome'

export interface ImageViewerProps {
  viewUrl: string
  fileName: string
  chrome?: ViewerChromeProps
}

/**
 * Lo unico que el navegador reporta de un raster: cargo o no cargo. No hay
 * "por que": `onError` no distingue un PNG truncado de un grant vencido, asi
 * que el visor no inventa un motivo que no tiene. La union se guarda en el
 * schema y el handler la comprueba: un string que no sea uno de los dos cae
 * a error en vez de dejar el visor en loading.
 */
const ImageOutcomeSchema = Schema.Literals(['ready', 'error'])
type ImageOutcome = typeof ImageOutcomeSchema.Type
const isImageOutcome = Schema.is(ImageOutcomeSchema)

const isImageViewUrl = Schema.is(Schema.NonEmptyString)

/** El desenlace ATADO a la URL que lo produjo. */
type SettledImage = { url: string; outcome: ImageOutcome }

/**
 * Imagenes rasterizadas con el `<img>` nativo. No pasa por `next/image`: la URL
 * es un grant de un solo uso y el optimizador la volveria a pedir desde el
 * servidor, gastando el permiso y rompiendo la bitacora de entrega.
 *
 * SVG no llega aqui — el despacho lo manda a descarga porque es contenido
 * activo (`mime.ts`).
 *
 * El desenlace se guarda junto a la URL que lo produjo y el estado se DERIVA de
 * comparar las dos, como en los otros cuatro visores. Guardado suelto, un
 * reintento (que emite un grant nuevo, o sea una URL nueva) seguia pintando el
 * error del intento anterior: el componente no se desmonta al reintentar, asi
 * que `error` se quedaba pegado y el `<img>` nuevo no llegaba a pedirse.
 */
export function ImageViewer({ viewUrl, fileName, chrome }: ImageViewerProps) {
  const t = useTranslations('vdr.viewer')
  const [settled, setSettled] = useState<SettledImage | null>(null)
  const onReady = chrome?.onReady
  const safeViewUrl = isImageViewUrl(viewUrl) ? viewUrl : null

  const settleImage = (outcome: unknown) => {
    const safeOutcome = isImageOutcome(outcome) ? outcome : 'error'
    setSettled({ url: viewUrl, outcome: safeOutcome })
    if (safeOutcome === 'ready') onReady?.()
  }

  const status: ViewerStatus =
    safeViewUrl === null ? 'error' : settled?.url === safeViewUrl ? settled.outcome : 'loading'

  if (status === 'error' || safeViewUrl === null) {
    return <ViewerError testId="document-viewer-error" chrome={chrome} />
  }

  return (
    <ViewerFrame chrome={chrome}>
      {status === 'loading' ? (
        <div className="bg-background absolute inset-0 z-10">
          <ViewerLoading testId="document-viewer-frame-loading" label={t('loading')} />
        </div>
      ) : null}
      <div className="flex h-full overflow-auto p-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- grant de un solo uso: el optimizador lo consumiria de nuevo. */}
        <img
          src={safeViewUrl}
          alt={fileName}
          data-testid="document-viewer-image"
          referrerPolicy="no-referrer"
          onLoad={() => settleImage('ready')}
          onError={() => settleImage('error')}
          className="m-auto block max-h-full max-w-full object-contain"
        />
      </div>
    </ViewerFrame>
  )
}
