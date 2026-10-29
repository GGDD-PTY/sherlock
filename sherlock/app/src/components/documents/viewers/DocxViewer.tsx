'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Duration, Effect, Result, Schema } from 'effect'

import { runClientFork } from '@/lib/effect/client-runtime'
import { describeCause } from '@/lib/effect/errors'

import { PdfBytesViewer } from './PdfViewer'
import { ViewerError, ViewerFrame, ViewerLoading, type ViewerChromeProps } from './ViewerChrome'
import { useDocumentBytes } from './useDocumentBytes'

// docx-preview puede quedarse colgado en documentos con layouts que no soporta.
// Pasado este techo se abandona el intento y se cae a la rendition PDF.
//
// El plazo lo lleva `Effect.timeout`, no un `setTimeout` corriendo contra una
// promesa: antes el temporizador quedaba armado los 12 s aunque el documento
// hubiera pintado en medio segundo, uno por cada intento de render.
const DOCX_RENDER_TIMEOUT = Duration.millis(12_000)

/**
 * Por que un DOCX no se ve como DOCX.
 *
 * `stage` dice quien fallo (docx-preview o el conversor a PDF) y `reason` si
 * fue el reloj o el archivo. Antes los dos intentos compartian un `catch {}`
 * vacio y el visor caia a la rendition sin poder decir de que se cayo.
 */
class DocxRenderError extends Schema.TaggedError<DocxRenderError>()('DocxRenderError', {
  stage: Schema.Literals(['native', 'rendition']),
  reason: Schema.Literals(['timeout', 'unsupported']),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

type DocxOutcome =
  | { source: ArrayBuffer; stage: 'native' }
  | { source: ArrayBuffer; stage: 'rendition'; pdf: ArrayBuffer }
  | { source: ArrayBuffer; stage: 'error' }

export interface DocxViewerProps {
  viewUrl: string
  fileName: string
  page?: number
  chrome?: ViewerChromeProps
}

/**
 * DOCX con `docx-preview`, y rendition PDF cuando falla.
 *
 * docx-preview construye NODOS a partir del OOXML: no hace `innerHTML` con
 * marcado del productor, asi que no monta HTML no confiable en el origen
 * privilegiado. `experimental` queda apagado a proposito — es la ruta que
 * inserta `altChunk` (HTML embebido dentro del .docx) en el documento.
 *
 * El fallback NO pide un grant nuevo: reutiliza los mismos bytes ya
 * descargados y los convierte a PDF con el conversor isomorfico de
 * `lib/documents/renditions`. Un grant, una entrega auditada.
 */
export function DocxViewer({ viewUrl, fileName, page, chrome }: DocxViewerProps) {
  const t = useTranslations('vdr.viewer')
  const containerRef = useRef<HTMLDivElement>(null)
  const bytes = useDocumentBytes(viewUrl)
  const [outcome, setOutcome] = useState<DocxOutcome | null>(null)
  // Paginas que produjo docx-preview (`breakPages: true` -> una seccion por
  // pagina). Se publica en el indicador del marco.
  const [sections, setSections] = useState(0)

  const source = bytes.status === 'ready' ? bytes.bytes : null
  const settled = outcome !== null && outcome.source === source ? outcome : null
  const stage = bytes.status === 'error' ? 'error' : settled ? settled.stage : ('loading' as const)

  useEffect(() => {
    if (!source) return

    /** docx-preview sobre el OOXML. Devuelve cuantas paginas produjo. */
    const renderNative = Effect.fn('DocxViewer.renderNative')(function* (
      container: HTMLDivElement
    ): Effect.fn.Return<number, DocxRenderError> {
      const { renderAsync } = yield* Effect.tryPromise({
        try: () => import('docx-preview'),
        catch: (cause) =>
          new DocxRenderError({
            stage: 'native',
            reason: 'unsupported',
            message: describeCause(cause),
            cause,
          }),
      })

      container.replaceChildren()

      yield* Effect.tryPromise({
        try: () =>
          renderAsync(source.slice(0), container, undefined, {
            className: 'docx',
            inWrapper: true,
            breakPages: true,
            // Cierra `altChunk`: nada de HTML del productor dentro del visor.
            experimental: false,
            renderChanges: false,
            renderHeaders: true,
            renderFooters: true,
            useBase64URL: true,
          }),
        catch: (cause) =>
          new DocxRenderError({
            stage: 'native',
            reason: 'unsupported',
            message: describeCause(cause),
            cause,
          }),
      }).pipe(
        Effect.timeout(DOCX_RENDER_TIMEOUT),
        Effect.catchTag('TimeoutError', (cause) =>
          Effect.fail(
            new DocxRenderError({
              stage: 'native',
              reason: 'timeout',
              message: `docx-preview no termino en ${Duration.toSeconds(DOCX_RENDER_TIMEOUT)} s.`,
              cause,
            })
          )
        )
      )

      return container.querySelectorAll('.docx-wrapper > section.docx').length
    })

    /** El respaldo: los MISMOS bytes convertidos a PDF. Un grant, una entrega. */
    const renderRendition = Effect.fn('DocxViewer.renderRendition')(function* (): Effect.fn.Return<
      ArrayBuffer,
      DocxRenderError
    > {
      const { convertDocxToPdf } = yield* Effect.tryPromise({
        try: () => import('@/lib/documents/renditions/ooxml-to-pdf'),
        catch: (cause) =>
          new DocxRenderError({
            stage: 'rendition',
            reason: 'unsupported',
            message: describeCause(cause),
            cause,
          }),
      })

      const pdf = yield* Effect.tryPromise({
        try: () => convertDocxToPdf(source.slice(0)),
        catch: (cause) =>
          new DocxRenderError({
            stage: 'rendition',
            reason: 'unsupported',
            message: describeCause(cause),
            cause,
          }),
      })

      return pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer
    })

    const openDocx = Effect.fn('DocxViewer.open')(function* (
      container: HTMLDivElement
    ): Effect.fn.Return<void> {
      // Los dos motivos del nativo caen a la rendition: si docx-preview no
      // puede, el documento igual se ve. `Effect.result` es el dato, no un
      // catch que vuelve a mezclar número y TaggedError en el mismo canal.
      const native = yield* Effect.result(renderNative(container))
      if (Result.isSuccess(native)) {
        yield* Effect.sync(() => {
          setSections(native.success)
          setOutcome({ source, stage: 'native' })
        })
        return
      }

      containerRef.current?.replaceChildren()

      const rendition = yield* Effect.result(renderRendition())
      yield* Effect.sync(() => {
        setOutcome(
          Result.isSuccess(rendition)
            ? { source, stage: 'rendition', pdf: rendition.success }
            : { source, stage: 'error' }
        )
      })
    })

    const container = containerRef.current
    if (!container) return

    const fiber = runClientFork(openDocx(container))

    return () => {
      fiber.interruptUnsafe()
    }
  }, [source])

  const onReady = chrome?.onReady
  useEffect(() => {
    if (stage === 'native') onReady?.()
  }, [onReady, stage])

  if (stage === 'error') return <ViewerError testId="document-viewer-error" chrome={chrome} />

  if (settled?.stage === 'rendition') {
    return (
      <div data-testid="document-viewer-docx-rendition" className="h-full min-h-64">
        <PdfBytesViewer
          bytes={settled.pdf}
          fileName={fileName}
          page={page}
          loadingLabel={t('loadingRendition')}
          chrome={chrome}
        />
      </div>
    )
  }

  return (
    <ViewerFrame
      chrome={chrome}
      // El DOCX tambien reporta su tamano: sin indicador la barra queda vacia
      // al lado de un PDF que si pagina, y los cuatro visores dejan de leerse
      // como el mismo producto.
      indicator={sections > 0 ? t('pages', { count: sections }) : undefined}
    >
      {stage === 'loading' ? (
        <div className="bg-background absolute inset-0 z-10">
          <ViewerLoading testId="document-viewer-frame-loading" label={t('loadingPages')} paper />
        </div>
      ) : null}
      {/* docx-preview inyecta su CSS sin capa (gris fijo, sombra pesada), asi
          que gana a las utilidades en @layer: se neutraliza con `!`. */}
      <div
        ref={containerRef}
        data-testid="document-viewer-docx"
        aria-label={t('iframeTitle', { name: fileName })}
        className="bg-muted [&_.docx-wrapper>section.docx]:border-border h-full min-h-64 overflow-auto p-4 [&_.docx-wrapper]:bg-transparent! [&_.docx-wrapper]:p-0! [&_.docx-wrapper>section.docx]:mb-4! [&_.docx-wrapper>section.docx]:max-w-full [&_.docx-wrapper>section.docx]:border [&_.docx-wrapper>section.docx]:shadow-sm!"
      />
    </ViewerFrame>
  )
}
