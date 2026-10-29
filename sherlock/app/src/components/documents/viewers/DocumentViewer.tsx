'use client'

// ============================================================================
// DOCUMENT VIEWER — despacho por tipo del visor del VDR
// ============================================================================
// Punto de entrada unico de los renderers. Recibe un grant YA emitido (la
// autorizacion no vive aqui: la emite quien monta el visor) y decide con que
// renderer se abre el archivo:
//
//   XLSX  -> sidecar Mog (iframe estatico, bytes por MessagePort)
//   PDF   -> pdfjs-dist sobre canvas
//   DOCX  -> docx-preview, con rendition PDF de respaldo
//   PPTX  -> rendition PDF
//   PNG/JPG/WEBP/GIF/AVIF -> <img> nativo
//   CSV   -> tabla inerte (texto parseado en cliente, sin HTML del productor)
//   resto -> descarga del original
//
// Ningun renderer monta HTML del productor en un contexto activo: HTML, SVG y
// XML caen a descarga por diseno (`mime.ts`, precedente en
// `DeliverableViewer.tsx:30-32`).
// ============================================================================

import { useCallback, useRef, useState } from 'react'
import { Effect } from 'effect'

import type { Id } from '@/../convex/_generated/dataModel'
import { trackRoomJourney } from '@/lib/analytics/room-journey'
import type { RoomJourneyEvent } from '@/lib/analytics/room-journey-contract'
import { runClientFork } from '@/lib/effect/client-runtime'

import { CsvViewer } from './CsvViewer'
import { DocxViewer } from './DocxViewer'
import { ImageViewer } from './ImageViewer'
import { PdfViewer } from './PdfViewer'
import { PptxViewer } from './PptxViewer'
import { ViewerDownloadFallback } from './ViewerChrome'
import { XlsxViewer } from './XlsxViewer'
import { resolveDocumentViewerKind, type DocumentViewerKind } from './mime'

/**
 * Destino de una cita: hoja y rango en una hoja de calculo, pagina en un PDF.
 * Puede cambiar DESPUES del montaje — es como el asistente de sala lleva al
 * lector a la celda exacta sin reabrir el documento.
 *
 * La cita entra por el shell, y ahi se decodifica antes de llegar aqui:
 * `shell/room-navigation.tsx` tiene el schema y `citedNavigate`.
 */
export type DocumentViewerNavigate = { sheet?: string; range?: string; page?: number }

/** Extension plausible tras el ultimo punto del nombre del archivo. */
const EXTENSION = /^[a-z0-9]{1,5}$/i

type RoomJourneyDocumentKind = Extract<
  RoomJourneyEvent,
  { event: 'document_opened' }
>['properties']['documentKind']

/**
 * Como se reporta cada renderer a la analitica. La tabla es exhaustiva a
 * proposito: antes era un ternario que mandaba a `other` todo lo que no fuera
 * PDF o XLSX, asi que un renderer nuevo entraba en `other` sin que nadie lo
 * decidiera. Ahora agregar un tipo de visor no compila hasta que alguien diga
 * como se llama en el embudo.
 */
const JOURNEY_DOCUMENT_KIND: Record<DocumentViewerKind, RoomJourneyDocumentKind> = {
  pdf: 'pdf',
  xlsx: 'spreadsheet',
  docx: 'other',
  pptx: 'other',
  image: 'other',
  csv: 'other',
  download: 'other',
}

/**
 * El aviso de apertura al embudo de la sala. La analitica es advisory: si no
 * sale, no pasa nada — `Effect.ignore` lo deja escrito, no es un `void` delante
 * de una promesa suelta.
 */
const reportDocumentOpened = Effect.fn('DocumentViewer.reportOpened')(function* (
  kind: DocumentViewerKind
): Effect.fn.Return<void> {
  yield* Effect.tryPromise({
    try: () => trackRoomJourney('document_opened', { documentKind: JOURNEY_DOCUMENT_KIND[kind] }),
    catch: (cause) => cause,
  }).pipe(Effect.ignore)
})

export type DocumentViewerProps = {
  documentId: Id<'documents'>
  versionId: Id<'documentVersions'>
  fileName: string
  mimeType: string
  sizeBytes: number
  /** URL del grant VIEW. Se consume una sola vez. */
  viewUrl: string
  /** URL de descarga del original, o `null` si el acceso no la autoriza. */
  downloadUrl: string | null
  navigate?: DocumentViewerNavigate
  onClose?: () => void
  /**
   * Reintento tras un error de entrega. El grant es de un solo uso: reintentar
   * exige emitir uno nuevo, y eso solo lo puede hacer quien monta el visor.
   */
  onRetry?: () => void
  /**
   * Descarga del original. La pide el marco cuando la pantalla completa tapa la
   * fila de la sala, y la resuelve quien monta el visor: el grant de la vista es
   * de un solo uso y ya se gasto, asi que bajar el archivo exige uno nuevo.
   */
  onDownload?: () => void
  /**
   * Aviso de que el marco paso a pantalla completa. Lo necesita quien monta el
   * visor dentro de un contenedor con `transform` (el dialogo de Radix), que es
   * el bloque contenedor del `fixed` del marco. Ver `ViewerChromeProps`.
   */
  onExpandedChange?: (expanded: boolean) => void
}

export function DocumentViewer({
  documentId,
  versionId,
  fileName,
  mimeType,
  viewUrl,
  downloadUrl,
  navigate,
  onClose,
  onRetry,
  onDownload,
  onExpandedChange,
}: DocumentViewerProps) {
  const kind = resolveDocumentViewerKind(mimeType, fileName)
  const reportedView = useRef<string | null>(null)
  // Que el documento este en pantalla se guarda como la URL que lo entrego, no
  // como un booleano: un grant nuevo (el reintento emite uno) es otra apertura,
  // y comparar contra `viewUrl` la devuelve a «cargando» sin un efecto que
  // tenga que acordarse de apagarla.
  const [readyUrl, setReadyUrl] = useState<string | null>(null)
  const onReady = useCallback(() => {
    if (!viewUrl) return
    // Mismo valor: React no encola un render, asi que el aviso repetido de un
    // renderer no cuesta nada.
    setReadyUrl(viewUrl)
    if (reportedView.current === viewUrl) return
    reportedView.current = viewUrl
    if (window.location.pathname !== '/es/my-company/documents') return
    runClientFork(reportDocumentOpened(kind))
  }, [kind, viewUrl])
  // El sello de tipo es la extension real del archivo, en mono. Solo se acepta
  // si PARECE una extension: 'Estados financieros v1.2 auditados' no tiene una,
  // y el sello no puede terminar diciendo '2 AUDITADOS'.
  const extension = fileName.split('.').pop()
  const kindStamp =
    extension && extension !== fileName && EXTENSION.test(extension) ? extension : kind
  const chrome = {
    fileName,
    kind: kindStamp,
    downloadUrl,
    onClose,
    onRetry,
    onDownload,
    onReady,
    ready: readyUrl === viewUrl,
    onExpandedChange,
  }

  // Sin bytes autorizados no hay vista previa: el shell pasa viewUrl vacio en
  // modo demo y cuando el grant VIEW no se pudo emitir.
  if (!viewUrl) {
    return <ViewerDownloadFallback fileName={fileName} downloadUrl={downloadUrl} />
  }

  switch (kind) {
    case 'xlsx':
      return (
        <XlsxViewer
          viewUrl={viewUrl}
          fileName={fileName}
          // La identidad del libro dentro del sidecar sigue a la VERSION: dos
          // versiones del mismo documento son dos libros distintos.
          workbookId={`vdr://${documentId}/${versionId}`}
          sheet={navigate?.sheet}
          range={navigate?.range}
          chrome={chrome}
        />
      )
    case 'pdf':
      return (
        <PdfViewer viewUrl={viewUrl} fileName={fileName} page={navigate?.page} chrome={chrome} />
      )
    case 'docx':
      return (
        <DocxViewer viewUrl={viewUrl} fileName={fileName} page={navigate?.page} chrome={chrome} />
      )
    case 'pptx':
      return (
        <PptxViewer viewUrl={viewUrl} fileName={fileName} page={navigate?.page} chrome={chrome} />
      )
    case 'image':
      return <ImageViewer viewUrl={viewUrl} fileName={fileName} chrome={chrome} />
    case 'csv':
      return <CsvViewer viewUrl={viewUrl} chrome={chrome} />
    default:
      return <ViewerDownloadFallback fileName={fileName} downloadUrl={downloadUrl ?? viewUrl} />
  }
}

export { isPreviewableDocument } from './mime'
