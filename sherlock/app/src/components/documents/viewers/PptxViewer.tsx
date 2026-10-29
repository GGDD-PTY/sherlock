'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Effect, Schema } from 'effect'

import { runClientFork } from '@/lib/effect/client-runtime'
import { describeCause } from '@/lib/effect/errors'

import { PdfBytesViewer } from './PdfViewer'
import { ViewerError, type ViewerChromeProps } from './ViewerChrome'
import { useDocumentBytes, withGrantQuery } from './useDocumentBytes'

/**
 * Por que no hay rendition del PPTX en el cliente. `stage` separa el conversor
 * que no llego a cargar (un chunk que no baja) del que cargo y no pudo con el
 * archivo. Antes los dos eran el mismo `catch {}` y la sala no podia distinguir
 * un problema de red de una presentacion que el conversor no soporta.
 */
class PptxRenditionError extends Schema.TaggedError<PptxRenditionError>()('PptxRenditionError', {
  stage: Schema.Literals(['converter', 'convert']),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface PptxViewerProps {
  viewUrl: string
  fileName: string
  page?: number
  chrome?: ViewerChromeProps
}

type PptxOutcome = { source: ArrayBuffer; pdf: ArrayBuffer } | { source: ArrayBuffer; pdf: null }

/**
 * PPTX por rendition PDF. El original se conserva intacto en el VDR: la
 * rendition es una VISTA, nunca la version custodiada.
 *
 * Se pide el PDF a la misma ruta del grant con `rendition=pdf`, asi que el
 * mismo permiso de un solo uso que autoriza el original autoriza su rendition,
 * y la conversion corre en el servidor. Si esa ruta devuelve el original (el
 * conversor del servidor no pudo), se convierte con esos mismos bytes en el
 * cliente: nunca un iframe de un tercero, nunca una URL publica.
 */
export function PptxViewer({ viewUrl, fileName, page, chrome }: PptxViewerProps) {
  const t = useTranslations('vdr.viewer')
  const delivered = useDocumentBytes(withGrantQuery(viewUrl, 'rendition=pdf'))
  const [converted, setConverted] = useState<PptxOutcome | null>(null)

  const source = delivered.status === 'ready' ? delivered.bytes : null
  const serverRendition = source !== null && isPdf(source) ? source : null
  const clientRendition = converted !== null && converted.source === source ? converted.pdf : null
  const conversionFailed =
    converted !== null && converted.source === source && converted.pdf === null

  useEffect(() => {
    if (!source || isPdf(source)) return

    const convertInBrowser = Effect.fn('PptxViewer.convert')(function* (
      bytes: ArrayBuffer
    ): Effect.fn.Return<ArrayBuffer, PptxRenditionError> {
      const { convertPptxToPdf } = yield* Effect.tryPromise({
        try: () => import('@/lib/documents/renditions/ooxml-to-pdf'),
        catch: (cause) =>
          new PptxRenditionError({ stage: 'converter', message: describeCause(cause), cause }),
      })

      const pdf = yield* Effect.tryPromise({
        try: () => convertPptxToPdf(bytes.slice(0)),
        catch: (cause) =>
          new PptxRenditionError({ stage: 'convert', message: describeCause(cause), cause }),
      })

      return pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer
    })

    const fiber = runClientFork(
      convertInBrowser(source).pipe(
        Effect.match({
          onSuccess: (pdf): PptxOutcome => ({ source, pdf }),
          // El fallo nombrado se resuelve en el mismo sitio: sin rendition, el
          // visor ofrece el original en vez de una pantalla en blanco.
          onFailure: (): PptxOutcome => ({ source, pdf: null }),
        }),
        Effect.tap((outcome) => Effect.sync(() => setConverted(outcome)))
      )
    )

    return () => {
      fiber.interruptUnsafe()
    }
  }, [source])

  if (delivered.status === 'error' || conversionFailed) {
    return <ViewerError testId="document-viewer-error" chrome={chrome} />
  }

  return (
    <div data-testid="document-viewer-pptx" className="h-full min-h-64">
      <PdfBytesViewer
        bytes={serverRendition ?? clientRendition}
        fileName={fileName}
        page={page}
        loadingLabel={t('loadingRendition')}
        chrome={chrome}
      />
    </div>
  )
}

function isPdf(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false
  const header = new Uint8Array(bytes, 0, 4)
  // %PDF
  return header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46
}
