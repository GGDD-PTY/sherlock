'use client'

import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, LockKeyhole, RotateCcw, RotateCw } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Effect, Schema } from 'effect'

import { Button } from '@/components/ui/button'
import { runClientFork } from '@/lib/effect/client-runtime'
import { describeCause } from '@/lib/effect/errors'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ViewerError, ViewerFrame, ViewerLoading, type ViewerChromeProps } from './ViewerChrome'
import { useDocumentBytes } from './useDocumentBytes'

// Assets servidos por URL desde `public/pdfjs/` (los genera
// `scripts/build-viewer-assets.mjs`). El worker NO entra al grafo de webpack:
// asi el presupuesto de chunks de Next queda intacto y el worker se cachea
// aparte del bundle de la app.
const PDFJS_BASE = '/pdfjs/'

// El zoom tiene dos modos y el control los nombra por separado. `fit` llena el
// ancho del marco; un porcentaje es tamano real de la hoja, porque un punto del
// PDF mide 1/72" y la pantalla cuenta 96 px por pulgada. Antes los pasos eran
// multiplos del ancho disponible y "100%" significaba una cosa distinta en cada
// ancho de panel.
const PDF_POINT_TO_CSS_PX = 96 / 72
const MAX_CANVAS_PIXELS = 8_000_000
const ZOOM_FIT = 'fit'
const ZOOM_PERCENTS = [75, 90, 100, 125, 150, 200] as const
type ZoomLevel = typeof ZOOM_FIT | number

// El giro es de la SESIÓN del visor, no del documento: nadie escribe nada y
// cerrar el visor lo devuelve a 0. pdf.js gira dentro del viewport, así que
// el mismo ángulo tiene que ir a TODOS los `getViewport` — el base que decide
// el ajuste al ancho, el del raster y el de la capa de texto. Pasarlo a unos
// sí y a otros no descalza la capa seleccionable de la hoja pintada.
type Rotation = 0 | 90 | 180 | 270

function rotateBy(current: Rotation, quarterTurns: number): Rotation {
  const next = (current + quarterTurns * 90 + 360) % 360
  return next as Rotation
}

/**
 * El giro del visor se COMPONE con el `/Rotate` de la hoja, no lo reemplaza.
 * Un escaneo apaisado ya viene con `rotate: 90` en el PDF y `getViewport` sin
 * `rotation` lo respeta; pasarle `0` lo enderezaba y mostraba de costado
 * justamente la hoja que el archivo pedía girar.
 */
function composedRotation(pageRotate: number | undefined, viewerRotation: Rotation): number {
  return ((((pageRotate ?? 0) + viewerRotation) % 360) + 360) % 360
}

type Pdfjs = typeof import('pdfjs-dist')
type TextLayerOptions = ConstructorParameters<Pdfjs['TextLayer']>[0]
type PdfViewport = TextLayerOptions['viewport']
type PdfTextContent = Exclude<TextLayerOptions['textContentSource'], ReadableStream>

type PdfDocumentProxy = {
  numPages: number
  getPage(page: number): Promise<PdfPageProxy>
}

// En pdfjs 6 `destroy()` vive en la tarea de carga, no en el documento: destruir
// la tarea cierra el documento y libera el worker.
type PdfLoadingTask = { promise: Promise<unknown>; destroy(): Promise<void> }

type PdfPageProxy = {
  /** `/Rotate` de la hoja, en grados. pdf.js lo expone como `page.rotate`. */
  rotate?: number
  getViewport(options: { scale: number; rotation: number }): PdfViewport
  render(options: {
    canvas: HTMLCanvasElement
    canvasContext: CanvasRenderingContext2D
    viewport: PdfViewport
  }): { promise: Promise<void>; cancel(): void }
  getTextContent(): Promise<PdfTextContent>
}

// ============================================================================
// LOS DOS FALLOS DEL VISOR, SEPARADOS
// ============================================================================
// Antes los dos vivian en sendos `catch {}` y lo unico que los distinguia era
// EN QUE bloque estaba escrito el catch. Ahora cada uno tiene tag, y quien
// compone el programa decide por tag: el que deja la hoja sin abrir reemplaza
// el visor; el de la capa de texto deja el lienzo solo y no dice nada, porque
// un escaneo no tiene texto que extraer y eso no es un fallo del documento.
//
// `stage` distingue el PDF que no abre (`document`, pdf.js rechaza el archivo)
// del que abre pero no se puede rasterizar (`raster`).

class PdfDocumentError extends Schema.TaggedError<PdfDocumentError>()('PdfDocumentError', {
  stage: Schema.Literals(['document', 'raster']),
  reason: Schema.Literals(['password', 'generic']),
  page: Schema.Number,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

function pdfDocumentFailureReason(pdfjs: Pdfjs, cause: unknown): 'password' | 'generic' {
  if (!(cause instanceof pdfjs.PasswordException)) return 'generic'
  return cause.code === pdfjs.PasswordResponses.NEED_PASSWORD ||
    cause.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD
    ? 'password'
    : 'generic'
}

class PdfTextLayerError extends Schema.TaggedError<PdfTextLayerError>()('PdfTextLayerError', {
  page: Schema.Number,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const PDFJS_WORKER_URL = `${PDFJS_BASE}pdf.worker.min.mjs`

let pdfjsPromise: Promise<Pdfjs> | null = null
let workerWarmed = false

/**
 * pdfjs-dist entra por import dinamico para que su chunk sea perezoso: el visor
 * de PDF no debe pesar en la carga inicial de ninguna pagina del VDR.
 *
 * Se memoiza porque arranca al MONTAR el visor, en paralelo con la descarga de
 * los bytes, y no cuando los bytes ya llegaron: en frio, el chunk (130 KB) y el
 * worker (1,2 MB) iban en serie detras de un informe de 5 MB.
 */
function loadPdfjs() {
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL
    return pdfjs
  })
  return pdfjsPromise
}

/**
 * Calienta pdf.js mientras bajan los bytes. El worker lo crea pdf.js dentro de
 * `getDocument`, asi que no se puede adelantar su fetch desde aqui; un
 * `<link rel="prefetch">` lo deja en la cache HTTP (`/pdfjs/*` es inmutable) y
 * de ahi sale cuando pdf.js lo pida. Una sola vez por pagina.
 */
function warmPdfjs() {
  void loadPdfjs().catch(() => {})
  if (workerWarmed || typeof document === 'undefined') return
  workerWarmed = true
  const link = document.createElement('link')
  link.rel = 'prefetch'
  link.href = PDFJS_WORKER_URL
  document.head.append(link)
}

export interface PdfViewerProps {
  /** URL del grant VIEW ya emitido. Se consume una sola vez. */
  viewUrl: string
  fileName: string
  /** Pagina a la que saltar; puede cambiar despues de montado (citas). */
  page?: number
  /** Etiqueta del estado de carga; el flujo PPTX/DOCX usa la suya. */
  loadingLabel?: string
  testId?: string
  chrome?: ViewerChromeProps
}

export function PdfViewer({
  viewUrl,
  fileName,
  page,
  loadingLabel,
  testId = 'document-viewer-pdf',
  chrome,
}: PdfViewerProps) {
  const t = useTranslations('vdr.viewer')
  const bytes = useDocumentBytes(viewUrl)

  return (
    <PdfBytesViewer
      bytes={bytes.status === 'ready' ? bytes.bytes : null}
      failed={bytes.status === 'error'}
      fileName={fileName}
      page={page}
      loadingLabel={loadingLabel ?? t('loadingPages')}
      testId={testId}
      chrome={chrome}
    />
  )
}

export interface PdfBytesViewerProps {
  /** Bytes ya en mano (grant consumido antes, o rendition generada aqui). */
  bytes: ArrayBuffer | null
  failed?: boolean
  fileName: string
  page?: number
  loadingLabel: string
  testId?: string
  chrome?: ViewerChromeProps
}

type PdfFailure = { source: ArrayBuffer; reason: 'password' | 'generic' }

type LoadedPdf = {
  source: ArrayBuffer
  document: PdfDocumentProxy
  pageCount: number
  /**
   * Texto de cada pagina, pedido al worker una sola vez por documento: el zoom
   * y el ancho rehacen la capa de texto, no la extraccion. Vive con el
   * documento porque muere con el; nunca se lee al renderizar.
   */
  textContent: Map<number, Promise<PdfTextContent>>
}

/** Lo que la capa de texto necesita para calzar sobre la hoja ya pintada. */
type PaintedPage = { pdfPage: PdfPageProxy; cssScale: number; cssViewport: PdfViewport }

function textContentOf(pdf: LoadedPdf, pdfPage: PdfPageProxy, pageNumber: number) {
  let content = pdf.textContent.get(pageNumber)
  if (!content) {
    content = pdfPage.getTextContent()
    pdf.textContent.set(pageNumber, content)
  }
  return content
}

/**
 * Un PDF escaneado trae `items` vacios o puros espacios: ahi no hay capa que
 * montar y el lienzo sigue siendo lo unico que describe la hoja.
 */
function hasSelectableText(content: PdfTextContent): boolean {
  return content.items.some((item) => 'str' in item && item.str.trim() !== '')
}

export function PdfBytesViewer({
  bytes,
  failed = false,
  fileName,
  page,
  loadingLabel,
  testId = 'document-viewer-pdf',
  chrome,
}: PdfBytesViewerProps) {
  const t = useTranslations('vdr.viewer')
  const onReady = chrome?.onReady
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null)
  // Que pagina de que documento tiene capa de texto montada. Se deriva, no se
  // sincroniza: al cambiar de pagina deja de coincidir y el lienzo vuelve a
  // describir la hoja hasta que la capa nueva diga lo contrario.
  const [textLayer, setTextLayer] = useState<{ source: ArrayBuffer; page: number } | null>(null)
  // La capa montada, con su escala CSS, para el efecto de render: un repintado
  // del lienzo a la misma escala (ancho nuevo con zoom fijo, otro DPR) la
  // reusa en vez de rehacerla. Es un ref porque lo lee el efecto, no el render.
  const laidTextRef = useRef<{
    source: ArrayBuffer
    page: number
    cssScale: number
    rotation: Rotation
  } | null>(null)
  const [failure, setFailure] = useState<PdfFailure | null>(null)
  const [zoom, setZoom] = useState<ZoomLevel>(ZOOM_FIT)
  const [rotation, setRotation] = useState<Rotation>(0)
  // Ancho util del marco; se mide con ResizeObserver para que la pagina
  // siempre llene el ancho (fit-width) y se vuelva a rasterizar al redimensionar.
  const [frameWidth, setFrameWidth] = useState(0)
  // `anchor` recuerda con que valor de `page` se hizo el ultimo salto manual.
  // Cuando la prop cambia (una cita nueva del asistente) el ancla deja de
  // coincidir y la prop vuelve a mandar, sin sincronizar estado en un efecto.
  const [manual, setManual] = useState<{ page: number; anchor: number | undefined }>({
    page: 1,
    anchor: undefined,
  })

  // Todo el estado visible se DERIVA de las props y de lo ya cargado: nada de
  // setState sincrono dentro de un efecto (cascadas de render).
  const ready = loaded !== null && loaded.source === bytes
  const currentFailure = bytes !== null && failure?.source === bytes ? failure : null
  const errored = failed || currentFailure?.reason === 'generic'
  const pageCount = ready ? loaded.pageCount : 0
  const requestedPage = manual.anchor === page ? manual.page : (page ?? 1)
  const currentPage =
    pageCount > 0 ? Math.min(Math.max(Math.trunc(requestedPage) || 1, 1), pageCount) : 1
  const hasTextLayer =
    ready && textLayer?.source === loaded.source && textLayer.page === currentPage

  const goTo = (next: number) => setManual({ page: next, anchor: page })

  useEffect(() => {
    warmPdfjs()
  }, [])

  useEffect(() => {
    if (!bytes) return

    let task: PdfLoadingTask | null = null

    // Abrir el archivo. La fibra se interrumpe al cambiar de bytes o al
    // desmontar; la tarea de carga se destruye aparte porque es de pdf.js y es
    // la que cierra el worker.
    const openDocument = Effect.fn('PdfViewer.openDocument')(function* (): Effect.fn.Return<
      PdfDocumentProxy,
      PdfDocumentError
    > {
      const pdfjs = yield* Effect.tryPromise({
        try: () => loadPdfjs(),
        catch: (cause) =>
          new PdfDocumentError({
            stage: 'document',
            reason: 'generic',
            page: 0,
            message: describeCause(cause),
            cause,
          }),
      })

      // pdf.js se queda con el buffer (lo transfiere al worker), asi que se
      // le pasa una copia: el original puede reusarse en un fallback.
      const loading = pdfjs.getDocument({
        data: bytes.slice(0),
        cMapUrl: `${PDFJS_BASE}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_BASE}standard_fonts/`,
        wasmUrl: `${PDFJS_BASE}wasm/`,
        iccUrl: `${PDFJS_BASE}iccs/`,
      })
      task = loading

      return yield* Effect.tryPromise({
        try: () => loading.promise as Promise<PdfDocumentProxy>,
        catch: (cause) =>
          new PdfDocumentError({
            stage: 'document',
            reason: pdfDocumentFailureReason(pdfjs, cause),
            page: 0,
            message: describeCause(cause),
            cause,
          }),
      })
    })

    const fiber = runClientFork(
      openDocument().pipe(
        Effect.tap((document) =>
          Effect.sync(() => {
            setLoaded({
              source: bytes,
              document,
              pageCount: document.numPages,
              textContent: new Map(),
            })
          })
        ),
        Effect.catchTag('PdfDocumentError', (error) =>
          Effect.sync(() => setFailure({ source: bytes, reason: error.reason }))
        )
      )
    )

    return () => {
      fiber.interruptUnsafe()
      void task?.destroy().catch(() => {})
    }
  }, [bytes])

  useEffect(() => {
    const frame = scrollRef.current
    if (!ready || !frame || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry?.contentRect.width ?? 0)
      setFrameWidth((previous) => (previous === width ? previous : width))
    })
    observer.observe(frame)
    return () => observer.disconnect()
  }, [ready])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!ready || !canvas) return

    const pdf = loaded
    let renderTask: { cancel(): void } | null = null
    let textLayerTask: { cancel(): void } | null = null

    // Rasteriza la pagina en el lienzo visible. Devuelve lo que la capa de
    // texto necesita para calzar encima, o null si no hay contexto 2d.
    const paint = Effect.fn('PdfViewer.paint')(function* (): Effect.fn.Return<
      PaintedPage | null,
      PdfDocumentError
    > {
      const pdfPage = yield* Effect.tryPromise({
        try: () => pdf.document.getPage(currentPage),
        catch: (cause) =>
          new PdfDocumentError({
            stage: 'document',
            reason: 'generic',
            page: currentPage,
            message: describeCause(cause),
            cause,
          }),
      })
      // Antes de que el ResizeObserver mida, el marco de scroll da el ancho: el
      // padre directo del lienzo es ahora el envoltorio de la hoja, que mide lo
      // que el lienzo, no lo que hay disponible.
      const available = Math.max(240, frameWidth || scrollRef.current?.clientWidth || 900)
      const pageRotation = composedRotation(pdfPage.rotate, rotation)
      const base = pdfPage.getViewport({ scale: 1, rotation: pageRotation })
      const cssScale =
        zoom === ZOOM_FIT ? available / base.width : (zoom / 100) * PDF_POINT_TO_CSS_PX
      // Se rasteriza a la densidad del dispositivo mientras el backing store
      // quepa en el presupuesto. En zoom extremo la densidad puede bajar de
      // 1x, pero el tamano CSS de la hoja no cambia.
      const cssViewport = pdfPage.getViewport({ scale: cssScale, rotation: pageRotation })
      const cssPixelArea = Math.max(1, cssViewport.width * cssViewport.height)
      const clampedDeviceDpr = Math.min(3, window.devicePixelRatio || 1)
      let effectiveDpr = Math.min(clampedDeviceDpr, Math.sqrt(MAX_CANVAS_PIXELS / cssPixelArea))
      let viewport = pdfPage.getViewport({ scale: cssScale * effectiveDpr, rotation: pageRotation })
      let rasterWidth = Math.max(1, Math.floor(viewport.width))
      let rasterHeight = Math.max(1, Math.floor(viewport.height))

      // La raiz limita el area continua. Este ajuste sobre dimensiones
      // enteras cubre cualquier exceso marginal por redondeo de pdf.js o del
      // punto flotante antes de crear el canvas.
      while (rasterWidth * rasterHeight > MAX_CANVAS_PIXELS) {
        effectiveDpr *= Math.sqrt(
          MAX_CANVAS_PIXELS / (rasterWidth * rasterHeight + rasterWidth + rasterHeight)
        )
        viewport = pdfPage.getViewport({
          scale: cssScale * effectiveDpr,
          rotation: pageRotation,
        })
        rasterWidth = Math.max(1, Math.floor(viewport.width))
        rasterHeight = Math.max(1, Math.floor(viewport.height))
      }
      // Se rasteriza FUERA de pantalla. Asignar `canvas.width` borra el lienzo,
      // y hacerlo antes de pintar dejaba un fotograma en blanco en cada cambio
      // de zoom o de ancho: ese parpadeo era el que se veia al hacer zoom.
      const offscreen = document.createElement('canvas')
      offscreen.width = rasterWidth
      offscreen.height = rasterHeight
      const offscreenContext = offscreen.getContext('2d')
      if (!offscreenContext) return null
      const render = pdfPage.render({
        canvas: offscreen,
        canvasContext: offscreenContext,
        viewport,
      })
      renderTask = render
      yield* Effect.tryPromise({
        try: () => render.promise,
        catch: (cause) =>
          new PdfDocumentError({
            stage: 'raster',
            reason: 'generic',
            page: currentPage,
            message: describeCause(cause),
            cause,
          }),
      })
      // `onReady` va DESPUES del punto de interrupcion: una pagina cuyo raster
      // se cancelo (otro zoom, otra pagina, el visor cerrado) no llego a
      // pintarse, y avisar de que esta lista registraba una apertura que el
      // cliente nunca vio.
      yield* Effect.sync(() => onReady?.())
      const context = canvas.getContext('2d')
      if (!context) return null
      // El lienzo visible se toca una sola vez, ya con la pagina rasterizada.
      canvas.width = offscreen.width
      canvas.height = offscreen.height
      canvas.style.width = `${viewport.width / effectiveDpr}px`
      canvas.style.height = `${viewport.height / effectiveDpr}px`
      context.drawImage(offscreen, 0, 0)
      return { pdfPage, cssScale, cssViewport }
    })

    // La capa de texto va DESPUES de pintar: la hoja visible manda y el texto
    // (transparente, seleccionable, legible por lector de pantalla) llega
    // detras sin retrasarla. Corre en la MISMA fibra que el raster, asi que se
    // interrumpe con el.
    const layText = Effect.fn('PdfViewer.layText')(function* ({
      pdfPage,
      cssScale,
      cssViewport,
    }: PaintedPage): Effect.fn.Return<void, PdfTextLayerError> {
      const host = textLayerRef.current
      if (!host) return
      // Misma pagina a la misma escala CSS: la capa montada sigue calzando (las
      // posiciones van en % de la hoja y el tamano por `--scale-factor`), asi
      // que se queda. Se rehace solo por pagina, escala o documento nuevos.
      const laid = laidTextRef.current
      if (
        laid?.source === pdf.source &&
        laid.page === currentPage &&
        laid.cssScale === cssScale &&
        laid.rotation === rotation
      ) {
        return
      }
      // La capa de la pagina o escala anterior no puede quedar sobre la hoja nueva.
      laidTextRef.current = null
      host.replaceChildren()
      const textContent = yield* Effect.tryPromise({
        try: () => textContentOf(pdf, pdfPage, currentPage),
        catch: (cause) =>
          new PdfTextLayerError({ page: currentPage, message: describeCause(cause), cause }),
      })
      if (!hasSelectableText(textContent)) {
        setTextLayer(null)
        return
      }
      const { TextLayer } = yield* Effect.tryPromise({
        try: () => loadPdfjs(),
        catch: (cause) =>
          new PdfTextLayerError({ page: currentPage, message: describeCause(cause), cause }),
      })
      // `TextLayer` posiciona en unidades PDF y deja el tamano a CSS (contrato
      // de `pdf_viewer.css`, ver `.pdf-text-layer` en globals.css): recibe la
      // escala CSS de la hoja, no la del raster, que ya lleva el DPR.
      host.style.setProperty('--scale-factor', String(cssScale))
      host.style.setProperty('--user-unit', String(cssViewport.userUnit))
      const layer = new TextLayer({
        textContentSource: textContent,
        container: host,
        viewport: cssViewport,
      })
      textLayerTask = layer
      yield* Effect.tryPromise({
        try: () => layer.render(),
        catch: (cause) =>
          new PdfTextLayerError({ page: currentPage, message: describeCause(cause), cause }),
      })
      laidTextRef.current = { source: pdf.source, page: currentPage, cssScale, rotation }
      setTextLayer((previous) =>
        previous?.source === pdf.source && previous.page === currentPage
          ? previous
          : { source: pdf.source, page: currentPage }
      )
    })

    const fiber = runClientFork(
      paint().pipe(
        Effect.flatMap((painted) => (painted ? layText(painted) : Effect.void)),
        // El documento que no se puede pintar reemplaza el visor.
        Effect.catchTag('PdfDocumentError', (error) =>
          Effect.sync(() => setFailure({ source: pdf.source, reason: error.reason }))
        ),
        // Sin texto que extraer (un escaneo, un PDF roto a medias): el lienzo
        // se queda solo y sigue describiendo la hoja. Sin aviso.
        Effect.catchTag('PdfTextLayerError', () =>
          Effect.sync(() => {
            laidTextRef.current = null
            textLayerRef.current?.replaceChildren()
            setTextLayer(null)
          })
        )
      )
    )

    return () => {
      fiber.interruptUnsafe()
      renderTask?.cancel()
      textLayerTask?.cancel()
    }
  }, [onReady, currentPage, frameWidth, loaded, ready, rotation, zoom])

  // Al cambiar de pagina se vuelve al inicio de la hoja.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [currentPage])

  // Flechas para paginar, sin robar el teclado a campos de texto.
  useEffect(() => {
    if (!ready) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'ArrowRight' && currentPage < pageCount) {
        event.preventDefault()
        setManual({ page: currentPage + 1, anchor: page })
      } else if (event.key === 'ArrowLeft' && currentPage > 1) {
        event.preventDefault()
        setManual({ page: currentPage - 1, anchor: page })
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [ready, currentPage, pageCount, page])

  if (currentFailure?.reason === 'password') {
    return (
      <ViewerFrame chrome={chrome}>
        <div
          data-testid="document-viewer-password-error"
          role="alert"
          className="bg-card flex h-full min-h-64 flex-col items-center justify-center px-6 py-12 text-center"
        >
          <LockKeyhole className="text-destructive mb-4 h-6 w-6" aria-hidden="true" />
          <p className="text-foreground text-base font-semibold">{t('passwordTitle')}</p>
          <p className="text-muted-foreground mt-2 max-w-md text-sm leading-6">
            {t('passwordBody')}
          </p>
        </div>
      </ViewerFrame>
    )
  }
  if (errored) return <ViewerError testId="document-viewer-error" chrome={chrome} />
  if (!ready) {
    // El esqueleto vive DENTRO del marco: al terminar la carga no aparece de
    // golpe una barra de 44 px que empuja todo el contenido hacia abajo.
    return (
      <ViewerFrame testId={testId} chrome={chrome}>
        <ViewerLoading testId="document-viewer-frame-loading" label={loadingLabel} paper />
      </ViewerFrame>
    )
  }

  return (
    <ViewerFrame
      testId={testId}
      chrome={chrome}
      indicator={
        <span
          data-testid="document-viewer-pdf-pagination"
          className="flex items-center gap-1.5 whitespace-nowrap"
        >
          <input
            // `key` reinicia el campo cuando la pagina cambia por otra via
            // (flechas, teclado, una cita del asistente): sin estado extra.
            key={currentPage}
            type="number"
            inputMode="numeric"
            min={1}
            max={pageCount}
            defaultValue={currentPage}
            aria-label={t('pageOf', { page: currentPage, total: pageCount })}
            data-testid="document-viewer-pdf-page-input"
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            onBlur={(event) => {
              const next = Math.trunc(Number(event.currentTarget.value))
              if (Number.isFinite(next) && next >= 1 && next <= pageCount) goTo(next)
              else event.currentTarget.value = String(currentPage)
            }}
            className="border-border bg-background focus-visible:ring-ring/50 h-11 w-14 [appearance:textfield] rounded-sm border text-center font-mono text-xs tabular-nums outline-none focus-visible:ring-2 sm:h-7 sm:w-12 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span aria-hidden="true">{t('pageOfTotal', { total: pageCount })}</span>
        </span>
      }
      controls={
        <>
          <Select
            value={zoom === ZOOM_FIT ? ZOOM_FIT : String(zoom)}
            onValueChange={(value) => setZoom(value === ZOOM_FIT ? ZOOM_FIT : Number(value))}
          >
            <SelectTrigger
              className="h-11 w-28 font-mono text-xs tabular-nums sm:h-9"
              aria-label={t('zoom')}
              data-testid="document-viewer-pdf-zoom"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ZOOM_FIT}>{t('zoomFit')}</SelectItem>
              {ZOOM_PERCENTS.map((percent) => (
                <SelectItem key={percent} value={String(percent)}>
                  {percent}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 sm:size-9"
            data-testid="document-viewer-pdf-rotate-left"
            onClick={() => setRotation((current) => rotateBy(current, -1))}
            aria-label={t('rotateLeft')}
          >
            <RotateCcw aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 sm:size-9"
            data-testid="document-viewer-pdf-rotate-right"
            onClick={() => setRotation((current) => rotateBy(current, 1))}
            aria-label={t('rotateRight')}
          >
            <RotateCw aria-hidden="true" />
          </Button>
          <span className="bg-border mx-1 hidden h-5 w-px sm:block" aria-hidden="true" />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 sm:size-9"
            data-testid="document-viewer-pdf-previous"
            onClick={() => goTo(currentPage - 1)}
            disabled={currentPage <= 1}
            aria-label={t('previousPage')}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 sm:size-9"
            data-testid="document-viewer-pdf-next"
            onClick={() => goTo(currentPage + 1)}
            disabled={currentPage >= pageCount}
            aria-label={t('nextPage')}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </>
      }
    >
      {/* La bandeja necesita una superficie propia: en oscuro una capa alfa se
          disuelve contra el lienzo y la hoja blanca queda flotando sola.
          `scrollbar-gutter: stable` reserva la canaleta siempre: sin ella la
          barra vertical aparecia al crecer la hoja, encogia el ancho medido y
          disparaba un segundo render — el otro medio parpadeo del zoom. */}
      <div
        ref={scrollRef}
        role="region"
        aria-label={t('documentArea')}
        tabIndex={0}
        className="bg-muted focus-visible:ring-ring/50 h-full [scrollbar-gutter:stable] overflow-auto p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        {/* La hoja: lienzo rasterizado y, encima, la capa de texto de pdf.js
            (spans transparentes que se leen, se buscan y se seleccionan). El
            borde y la sombra van en el envoltorio para que `inset: 0` de la
            capa calce con el lienzo pixel a pixel. Con capa, el lienzo sale
            del arbol de accesibilidad y la capa lleva el nombre del archivo;
            sin texto (un escaneo), el lienzo conserva su etiqueta. */}
        <div className="border-border relative mx-auto w-max border shadow-sm">
          <canvas
            ref={canvasRef}
            data-testid="document-viewer-pdf-canvas"
            data-page={currentPage}
            data-page-count={pageCount}
            aria-label={hasTextLayer ? undefined : t('iframeTitle', { name: fileName })}
            aria-hidden={hasTextLayer ? true : undefined}
            className="block"
          />
          <div
            ref={textLayerRef}
            data-testid="document-viewer-pdf-text-layer"
            role={hasTextLayer ? 'document' : undefined}
            aria-label={hasTextLayer ? t('iframeTitle', { name: fileName }) : undefined}
            className="pdf-text-layer"
          />
        </div>
      </div>
    </ViewerFrame>
  )
}
