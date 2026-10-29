// ============================================================================
// DOCUMENT VIEWER DIALOG
// ============================================================================
// Envoltorio de AUTORIZACIÓN del visor del VDR: pide un grant single-use a
// api.documents.getDownloadUrl y se lo entrega a <DocumentViewer/>, que decide
// el renderer por MIME (Mog para XLSX, pdfjs para PDF, docx-preview para DOCX,
// rendition PDF para PPTX, <img> para imágenes, descarga para el resto).
// La intención queda persistida en el grant: VIEW cuando el archivo se
// previsualiza —así la entrega NO alimenta la alarma de descarga masiva— y
// DOWNLOAD cuando no hay renderer y bajarlo es la única opción.
// Cada apertura o reintento emite su propio grant.
// ============================================================================

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useMutation } from 'convex/react'
import { Effect, Exit, Schema } from 'effect'
import type { Fiber } from 'effect'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import {
  isDeniedDocumentAccess,
  isIssuedDocumentAccessGrant,
  type IssuedDocumentAccessGrant,
} from '../../../convex/_documents/accessResult'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CircleAlert, Clock3, Download, Eye, FileText, RefreshCw, ShieldCheck } from 'lucide-react'
import { runClientFork } from '@/lib/effect/client-runtime'
import { describeCause } from '@/lib/effect/errors'
import {
  DocumentViewer,
  type DocumentViewerNavigate,
} from '@/components/documents/viewers/DocumentViewer'
import { resolveDocumentViewerKind } from '@/components/documents/viewers/mime'
import { ViewerDownloadFallback, ViewerLoading } from '@/components/documents/viewers/ViewerChrome'
import { withGrantQuery } from '@/components/documents/viewers/useDocumentBytes'
import { cn } from '@/lib/utils'

interface DocumentViewerDialogProps {
  documentId: string
  name: string
  fileType?: string | null
  trigger: ReactNode
  notice?: ReactNode
  /**
   * Versión concreta que se abre. Solo identifica el libro dentro del sidecar
   * Mog (dos versiones del mismo documento son dos libros). Los llamadores que
   * todavía no proyectan la versión pasan `undefined` y se usa `current`.
   */
  versionId?: string
  /** Destino de una cita; puede cambiar con el diálogo ya abierto. */
  navigate?: DocumentViewerNavigate
}

type ViewerStatus = 'idle' | 'loading' | 'ready' | 'denied' | 'expired' | 'error'

/**
 * Los códigos de la policy que significan «se venció», no «no puedes».
 * Escritos como schema porque son un vocabulario compartido con
 * `convex/_documents/policy.ts`: el que no esté aquí se presenta como negación
 * genérica, así que la lista es una decisión de producto y no un detalle.
 */
const ExpiredAccessCode = Schema.Literals([
  'DENIED_DOCUMENT_EXPIRED',
  'REQUIRE_NDA_RENEWAL',
  'EXPIRED',
])

const isExpiredAccessCode = Schema.is(ExpiredAccessCode)

/**
 * El fallo del grant, con nombre y con el código que traía (si traía alguno).
 * El mensaje del proveedor NUNCA sale a pantalla: vive aquí para la traza.
 */
class DocumentAccessError extends Schema.TaggedError<DocumentAccessError>()('DocumentAccessError', {
  code: Schema.NullOr(Schema.String),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Lo que queda cuando el programa termina: el grant emitido, o por qué no. */
type GrantOutcome =
  | { readonly status: 'ready'; readonly grant: IssuedDocumentAccessGrant }
  | { readonly status: 'denied' | 'expired' | 'error' }

function accessErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null

  const directCode = Reflect.get(error, 'code')
  if (typeof directCode === 'string') return directCode

  const data = Reflect.get(error, 'data')
  if (typeof data !== 'object' || data === null) return null

  const nestedCode = Reflect.get(data, 'code')
  return typeof nestedCode === 'string' ? nestedCode : null
}

export function DocumentViewerDialog({
  documentId,
  name,
  fileType,
  trigger,
  notice,
  versionId,
  navigate,
}: DocumentViewerDialogProps) {
  const t = useTranslations('vdr.viewer')
  const getDocumentAccessGrant = useMutation(api.documents.getDocumentAccessGrant)

  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<ViewerStatus>('idle')
  const [grant, setGrant] = useState<IssuedDocumentAccessGrant | null>(null)
  // El marco del visor se expande con un `fixed inset-0`, y el `DialogContent`
  // de Radix lleva `translate-x/-y`: ese transform es el bloque contenedor de
  // cualquier `fixed` de adentro, asi que el marco expandido llena el DIALOGO,
  // no la ventana. Mientras el visor lo pida, el dialogo deja de ser una
  // tarjeta centrada y ocupa la ventana entera; apagado, sus clases son las
  // mismas de siempre.
  const [viewerExpanded, setViewerExpanded] = useState(false)
  // La petición en vuelo. Cerrar el diálogo o reintentar interrumpe la fibra, y
  // un Exit interrumpido no pinta estado: es lo que antes hacía el contador de
  // peticiones, ahora sin un número que haya que acordarse de subir.
  const grantFiberRef = useRef<Fiber.Fiber<GrantOutcome> | null>(null)
  const statusRegionRef = useRef<HTMLDivElement>(null)

  const effectiveName = grant?.displayName ?? name
  const effectiveMimeType = grant?.detectedMimeType ?? fileType
  const kind = resolveDocumentViewerKind(effectiveMimeType, effectiveName)
  const previewable = grant ? grant.action === 'VIEW' : kind !== 'download'
  // Decisión [F] 2026-08-27: ninguna VISTA lleva marca, tampoco la del PDF. Lo
  // que sigue siendo cierto de toda vista es el permiso de un solo uso y el
  // registro de la apertura, y eso es lo único que el diálogo promete.
  const auditedRendition = kind === 'pptx'

  const loadDocument = useCallback(() => {
    // Una apertura nueva reemplaza a la anterior: la fibra vieja se interrumpe
    // y su respuesta tardía ya no puede pintar nada.
    grantFiberRef.current?.interruptUnsafe()
    setStatus('loading')
    setGrant(null)

    const issueGrant = Effect.fn('DocumentViewerDialog.issueGrant')(function* (): Effect.fn.Return<
      GrantOutcome,
      DocumentAccessError
    > {
      const result = yield* Effect.tryPromise({
        try: () =>
          getDocumentAccessGrant({
            documentId: documentId as Id<'documents'>,
            ...(versionId && versionId !== 'current'
              ? { versionId: versionId as Id<'documentVersions'> }
              : {}),
            action: 'VIEW',
          }),
        catch: (cause) =>
          new DocumentAccessError({
            code: accessErrorCode(cause),
            message: describeCause(cause),
            cause,
          }),
      })

      // Un deny llega como resultado estructurado (no como throw) para que la
      // fila DENIED de auditoría persista en Convex.
      if (isDeniedDocumentAccess(result)) {
        return { status: isExpiredAccessCode(result.code) ? 'expired' : 'denied' }
      }
      if (!isIssuedDocumentAccessGrant(result)) return { status: 'error' }

      return {
        status: 'ready',
        grant: {
          ...result,
          url:
            result.action === 'VIEW'
              ? withGrantQuery(result.url, 'disposition=inline')
              : result.url,
        },
      }
    })

    const fiber = runClientFork(
      issueGrant().pipe(
        Effect.catchTag('DocumentAccessError', (failure): Effect.Effect<GrantOutcome> =>
          Effect.succeed({ status: isExpiredAccessCode(failure.code) ? 'expired' : 'error' })
        )
      )
    )
    grantFiberRef.current = fiber

    fiber.addObserver((exit) => {
      if (grantFiberRef.current === fiber) grantFiberRef.current = null
      // Interrumpida por un cierre, un reintento o el desmontaje.
      if (!Exit.isSuccess(exit)) return

      const outcome = exit.value
      setGrant(outcome.status === 'ready' ? outcome.grant : null)
      setStatus(outcome.status)
    })
  }, [documentId, getDocumentAccessGrant, versionId])

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      loadDocument()
      return
    }

    grantFiberRef.current?.interruptUnsafe()
    grantFiberRef.current = null
    setStatus('idle')
    setGrant(null)
    setViewerExpanded(false)
  }

  // Un grant que llega con el diálogo ya desmontado no tiene dónde aterrizar.
  useEffect(() => {
    return () => {
      grantFiberRef.current?.interruptUnsafe()
      grantFiberRef.current = null
    }
  }, [])

  useEffect(() => {
    if (
      open &&
      (status === 'loading' || status === 'denied' || status === 'expired' || status === 'error')
    ) {
      statusRegionRef.current?.focus()
    }
  }, [open, status])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className={cn(
          'flex h-[min(92dvh,56rem)] flex-col gap-0 overflow-y-auto overscroll-contain p-0 sm:max-w-6xl',
          viewerExpanded && 'h-dvh w-screen max-w-none rounded-none border-0 sm:max-w-none'
        )}
        aria-busy={status === 'loading'}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          statusRegionRef.current?.focus()
        }}
      >
        <DialogHeader className="border-border shrink-0 gap-1 border-b px-4 py-3 pr-12 text-left sm:px-6 sm:py-4 sm:pr-14">
          <div className="flex min-w-0 items-center gap-3">
            <FileText className="text-muted-foreground h-5 w-5 shrink-0" aria-hidden="true" />
            <DialogTitle className="min-w-0 text-base leading-6 break-words sm:text-lg">
              {effectiveName}
            </DialogTitle>
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 pl-8 text-xs">
            <span className="text-foreground inline-flex items-center gap-1.5 font-medium">
              {previewable ? (
                <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )}
              {t(previewable ? 'viewMode' : 'downloadMode')}
            </span>
            <span aria-hidden="true">·</span>
            <DialogDescription className="text-xs leading-5">
              {t(
                previewable
                  ? auditedRendition
                    ? 'renditionDescription'
                    : 'viewDescriptionFile'
                  : 'downloadDescription'
              )}
            </DialogDescription>
          </div>
        </DialogHeader>

        {notice ? <div className="shrink-0 px-4 pt-4 sm:px-6">{notice}</div> : null}

        <div
          ref={statusRegionRef}
          tabIndex={-1}
          aria-live="polite"
          aria-label={t('documentArea')}
          className="focus-visible:ring-ring/50 relative m-4 min-h-64 flex-none overflow-hidden rounded-md outline-none focus-visible:ring-2 sm:mx-6 sm:mt-4 sm:min-h-0 sm:flex-1"
        >
          {status === 'loading' || status === 'idle' ? (
            <div className="border-border h-full min-h-64 border">
              <ViewerLoading testId="document-viewer-loading" label={t('loading')} />
            </div>
          ) : status === 'denied' || status === 'expired' ? (
            <div
              data-testid={`document-viewer-${status}`}
              role="alert"
              className="border-border bg-card flex h-full min-h-64 flex-col items-center justify-center border px-6 py-12 text-center"
            >
              {status === 'expired' ? (
                <Clock3 className="text-muted-foreground mb-4 h-7 w-7" aria-hidden="true" />
              ) : (
                <ShieldCheck className="text-muted-foreground mb-4 h-7 w-7" aria-hidden="true" />
              )}
              <p className="text-foreground text-base font-semibold">
                {t(status === 'expired' ? 'expiredTitle' : 'deniedTitle')}
              </p>
              <p className="text-muted-foreground mt-2 max-w-md text-sm leading-6">
                {t(status === 'expired' ? 'expiredDescription' : 'deniedDescription')}
              </p>
              <DialogClose asChild>
                <Button className="mt-5" variant="outline">
                  {t('close')}
                </Button>
              </DialogClose>
            </div>
          ) : status === 'error' ? (
            <div
              data-testid="document-viewer-error"
              role="alert"
              className="border-border bg-card flex h-full min-h-64 flex-col items-center justify-center border px-6 py-12 text-center"
            >
              <CircleAlert className="text-destructive mb-4 h-6 w-6" aria-hidden="true" />
              <p className="text-foreground text-base font-semibold">{t('errorTitle')}</p>
              <p className="text-muted-foreground mt-2 max-w-md text-sm leading-6">
                {t('errorDescription')}
              </p>
              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <Button onClick={() => loadDocument()}>
                  <RefreshCw aria-hidden="true" />
                  {t('retry')}
                </Button>
                <DialogClose asChild>
                  <Button variant="outline">{t('close')}</Button>
                </DialogClose>
              </div>
            </div>
          ) : grant ? (
            <DocumentViewer
              documentId={documentId as Id<'documents'>}
              versionId={grant.versionId as Id<'documentVersions'>}
              fileName={grant.displayName}
              mimeType={grant.detectedMimeType}
              // El tamaño no lo proyecta este llamador; el visor no lo usa para
              // decidir el renderer, solo para telemetría futura.
              sizeBytes={0}
              viewUrl={grant.url}
              downloadUrl={grant.action === 'DOWNLOAD' ? grant.url : null}
              navigate={navigate}
              onClose={() => handleOpenChange(false)}
              onRetry={() => loadDocument()}
              onExpandedChange={setViewerExpanded}
            />
          ) : (
            <ViewerDownloadFallback fileName={effectiveName} downloadUrl={null} />
          )}
        </div>

        {(status === 'loading' || status === 'ready') && (
          <div
            role="note"
            className="border-border bg-muted/20 text-muted-foreground flex shrink-0 gap-3 border-t px-4 py-3 text-sm leading-6 sm:px-6"
          >
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="text-foreground font-medium">{t('protectionTitle')}</p>
              <p>
                {t(
                  previewable
                    ? auditedRendition
                      ? 'renditionProtection'
                      : 'viewProtectionFile'
                    : 'downloadProtection'
                )}
              </p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
