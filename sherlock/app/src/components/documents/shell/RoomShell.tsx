'use client'

// ============================================================================
// ROOM SHELL — SISTEMA DE ARCHIVOS DEL VDR
// ============================================================================
// Dos zonas principales: árbol de carpetas (izquierda) y documento (centro).
// Un tercer panel contextual puede aparecer a la derecha, cerrado por defecto
// y con ancho acotado. El centro arranca en blanco y seleccionar un documento
// NO lo abre: muestra su tarjeta con Abrir / Descargar y sus acciones.
//
// Los datos y las mutaciones son las mismas de siempre (documents /
// documentVersions, grants VIEW/DOWNLOAD, rename, move, archive, versionado).
// Este componente es presentación y orquestación; no define permisos.
// ============================================================================

import {
  Activity,
  Archive,
  ChevronDown,
  FolderInput,
  Info,
  Loader2,
  MessageSquareText,
  PanelRightClose,
  Pencil,
  SlidersHorizontal,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from 'react'
import { useMutation } from 'convex/react'
import { toast } from 'sonner'
import { Effect, Exit, Schema } from 'effect'
import type { Fiber } from 'effect'

import { runClientFork } from '@/lib/effect/client-runtime'
import { describeCause } from '@/lib/effect/errors'
import { cn, formatShortDate } from '@/lib/utils'

import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import {
  isDeniedDocumentAccess,
  isIssuedDocumentAccessGrant,
} from '@/../convex/_documents/accessResult'
import { Link } from '@/i18n/navigation'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DocumentViewer,
  isPreviewableDocument,
  type DocumentViewerNavigate,
} from '@/components/documents/viewers/DocumentViewer'
import {
  DocumentBytesProvider,
  withGrantQuery,
} from '@/components/documents/viewers/useDocumentBytes'
import { prefetchXlsxSidecar } from '@/components/documents/viewers/xlsxSidecarPrefetch'
import {
  filterRoomDocuments,
  formatRoomFileSize,
  latestRoomUpdate,
  sortRoomDocuments,
  toRoomShellDocument,
  type RoomShellDocument,
  type RoomShellSort,
  type RoomShellSourceDocument,
} from '@/lib/documents/room-shell'
import type { RoomBulkSelection } from '@/lib/documents/room-bulk-selection'
import type { RoomDocumentMoveOutcome } from '@/lib/documents/room-tree-command-state'
import {
  inferClassificationFromAccessLevel,
  type DocumentAccessLevel,
  type DocumentClassification,
} from '@/lib/documents/classification'
import {
  ACCESS_LEVEL_REACH,
  VDR_ACCESS_LEVELS,
  VDR_CLASSIFICATIONS,
} from '@/components/company/vdr/config'
import { downloadFromGrant } from '@/lib/utils/deliver-grant'
import {
  VDR_SHELL_FOLDERS,
  VDR_SHELL_FOLDER_VALUES,
  getVdrShellFolderLabel,
} from '@/lib/vdr/document-taxonomy'
import type { VdrFolderOption } from '@/lib/vdr/document-taxonomy'
import { partitionEmptyRoomFolders } from '@/lib/vdr/room-progress'
import { ROOM_SHELL_COPY, type RoomLocale, type RoomShellCopy } from './copy'
import { RoomZipExportButton } from './RoomZipExportButton'
import {
  ROOM_TREE_MAX_WIDTH,
  ROOM_TREE_MIN_WIDTH,
  clampTreeWidth,
  getRoomLayoutServerSnapshot,
  getRoomLayoutSnapshot,
  setRoomLayout,
  subscribeRoomLayout,
  type RoomLayout,
} from './layout-storage'
import {
  RoomDocumentInfoDialog,
  roomAccessLabel,
  roomKindLabel,
  roomScanLabel,
  roomSourceLabel,
} from './RoomDocumentInfoDialog'
import { RoomDropConflictDialog } from './RoomDropConflictDialog'
import { RoomFolderTree, type RoomTreeActions } from './RoomFolderTree'
import {
  citedNavigate,
  type RoomNavigation,
  type RoomRevealDocumentTarget,
} from './room-navigation'

const DOCUMENT_WINDOW_SIZE = 50
const DESKTOP_ROOM_MEDIA_QUERY = '(min-width: 1024px)'
const COVER_TOOLBAR_ICON_ONLY =
  'max-sm:shrink-0 max-sm:[&_button]:h-10 max-sm:[&_button]:w-10 max-sm:[&_button]:min-h-10 max-sm:[&_button]:min-w-10 max-sm:[&_button]:px-0 max-sm:[&_button]:gap-0 max-sm:[&_svg]:mr-0 max-sm:[&_button]:text-[0px] max-sm:[&_button]:leading-none'

function folderCounts(documents: readonly { folder: string }[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const folder of VDR_SHELL_FOLDER_VALUES) counts[folder] = 0
  for (const document of documents) counts[document.folder] = (counts[document.folder] ?? 0) + 1
  return counts
}

function coverCountLabel(
  copy: RoomShellCopy,
  searchTerm: string,
  matchCount: number,
  totalCount: number
): string {
  if (searchTerm.length === 0) return copy.coverDocuments(totalCount)
  if (matchCount === 0) return copy.coverNoMatches(totalCount)
  return copy.coverResults(matchCount, totalCount)
}

function subscribeDesktopRoomLayout(listener: () => void) {
  const media = window.matchMedia(DESKTOP_ROOM_MEDIA_QUERY)
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

function getDesktopRoomLayoutSnapshot() {
  return window.matchMedia(DESKTOP_ROOM_MEDIA_QUERY).matches
}

function getDesktopRoomLayoutServerSnapshot() {
  return false
}

// ============================================================================
// LOS FALLOS DE LA SALA, CON NOMBRE
// ============================================================================
// `transport` es la llamada que nunca volvio (red, Convex caido): eso se
// registra del lado del cliente porque es un incidente. `refused` es la sala
// diciendo que no —un deny estructurado, o una respuesta que no es un grant—:
// eso NO es un incidente y no se loguea, pero se le avisa al cliente igual.
// Antes los dos caian en el mismo `catch` y solo se distinguian por si el
// resultado habia llegado o no.

class RoomDocumentAccessError extends Schema.TaggedError<RoomDocumentAccessError>()(
  'RoomDocumentAccessError',
  {
    reason: Schema.Literals(['transport', 'refused']),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

class RoomRenameError extends Schema.TaggedError<RoomRenameError>()('RoomRenameError', {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Tipo del error para la bitacora del cliente, nunca su mensaje. */
function errorType(cause: unknown): string {
  return cause instanceof Error ? cause.name : typeof cause
}

type CompanyRenameState =
  { status: 'idle' } | { status: 'editing'; draft: string } | { status: 'saving'; draft: string }

type ViewerState =
  | { status: 'closed' }
  | { status: 'unavailable' }
  | {
      status: 'loading'
      documentId: string
      versionId: string
      navigate?: DocumentViewerNavigate
    }
  | {
      status: 'error'
      documentId: string
      versionId: string
      navigate?: DocumentViewerNavigate
    }
  | {
      status: 'ready'
      documentId: string
      versionId: string
      fileName: string
      mimeType: string
      action: 'VIEW' | 'DOWNLOAD'
      viewUrl: string
      downloadUrl: string | null
      navigate?: DocumentViewerNavigate
    }

export type RoomShellNavigationHandle = {
  openSource: (target: RoomRevealDocumentTarget) => void
}

type Props = {
  navigationRef?: Ref<RoomShellNavigationHandle>
  locale: RoomLocale
  companyName: string
  companyLogoUrl?: string | null
  /** `UNSET` (o ausente) = el cliente no eligió mandato; la portada no lo asume. */
  companyMandate?: 'DEBT' | 'EQUITY' | 'BOTH' | 'BRIDGE' | 'UNSET' | null
  documents: readonly RoomShellSourceDocument[]
  isDemo: boolean
  search: string
  onSearchChange: (value: string) => void
  onRename: (documentId: string) => void
  onArchive: (documentId: string) => void
  /**
   * Borrado permanente de un documento de la sala. Ausente = la sala no ofrece
   * la acción (demo, sala de solo lectura); «Archivar» sigue disponible igual.
   */
  onPurge?: (documentId: string) => void
  onNewVersion: (documentId: string) => void
  onMove: (documentId: string, folder: string) => Promise<boolean>
  onMoveDocuments: (
    documentIds: readonly string[],
    targetFolderId: string
  ) => Promise<RoomDocumentMoveOutcome>
  onRenameDocument: (documentId: string, nextName: string) => Promise<boolean>
  /** Ausente = el nombre de la sala no es editable (demo, solo lectura). */
  onRenameCompany?: (nextName: string) => Promise<boolean>
  onQueueForeignFiles: (files: readonly File[], targetFolderId: string) => void
  /** La carpeta donde el visitante está parado, para quien abra la subida. */
  onActiveFolderChange?: (folder: string) => void
  pendingForeignDrop: {
    currentFolderId: string
    targetFolderId: string
  } | null
  onConfirmForeignDrop: () => void
  onCancelForeignDrop: () => void
  onOpenVersionHistory?: (documentId: string) => void
  activityHref?: string
  bulkSelection?: RoomBulkSelection
  /**
   * Acciones de la portada (la subida y el enlace a actividad). Las monta el
   * dueño de la sala: el shell solo les da el sitio al final de la barra, así
   * que desde xl la sala tiene una sola fila de herramientas y un solo CTA
   * relleno. Debajo de xl la barra puede envolver.
   */
  coverActions?: ReactNode
  /**
   * Espacio opcional para una herramienta contextual de la sala. El shell
   * controla apertura y cierre; el consumidor aporta el contenido y su nombre.
   * Arranca cerrado para reservar el ancho principal al visor.
   */
  rightPanel?: {
    title: string
    openLabel: string
    closeLabel: string
    resizeLabel: string
    content: ReactNode
    onOpen?: () => void
  }
}

export function RoomShell({
  navigationRef,
  locale,
  companyName,
  companyLogoUrl = null,
  companyMandate = null,
  documents,
  isDemo,
  search,
  onSearchChange,
  onRename,
  onArchive,
  onPurge,
  onNewVersion,
  onMove,
  onMoveDocuments,
  onRenameDocument,
  onRenameCompany,
  onQueueForeignFiles,
  onActiveFolderChange,
  pendingForeignDrop,
  onConfirmForeignDrop,
  onCancelForeignDrop,
  onOpenVersionHistory,
  activityHref,
  bulkSelection,
  coverActions,
  rightPanel,
}: Props) {
  const copy = ROOM_SHELL_COPY[locale]
  const getDocumentAccessGrant = useMutation(api.documents.getDocumentAccessGrant)

  // El layout vive en localStorage del visitante: el servidor renderiza el
  // valor por defecto y el navegador adopta el guardado al hidratar.
  const layout = useSyncExternalStore(
    subscribeRoomLayout,
    getRoomLayoutSnapshot,
    getRoomLayoutServerSnapshot
  )
  const isDesktopLayout = useSyncExternalStore(
    subscribeDesktopRoomLayout,
    getDesktopRoomLayoutSnapshot,
    getDesktopRoomLayoutServerSnapshot
  )
  // Las anchuras iniciales se leen UNA sola vez. `defaultSize` es una condición
  // de montaje del panel: si cambiara en cada paso del arrastre, el panel se
  // volvería a registrar en el grupo y la librería devolvería el tamaño al
  // valor recién guardado, así que el handle solo avanzaba ~10 px de cada 60
  // arrastrados. El ancho se sigue persistiendo en `onResize`; lo que ya no se
  // hace es realimentarlo al prop.
  const [initialLayout] = useState(getRoomLayoutSnapshot)
  const [sort, setSort] = useState<RoomShellSort>('process')
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const [activeFolder, setActiveFolder] = useState<string | null>(null)
  const [viewer, setViewer] = useState<ViewerState>({ status: 'closed' })
  const [visibleCount, setVisibleCount] = useState(DOCUMENT_WINDOW_SIZE)
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(
    () => new Set(VDR_SHELL_FOLDER_VALUES)
  )
  const [revealRequest, setRevealRequest] = useState<{ id: string; nonce: number } | undefined>()
  const [pendingRevealTarget, setPendingRevealTarget] = useState<RoomRevealDocumentTarget | null>(
    null
  )
  // En móvil el árbol es un desplegable: elegir un documento lo cierra para
  // que la tarjeta quede a la vista. En escritorio siempre está abierto.
  const [mobileTreeOpen, setMobileTreeOpen] = useState(true)
  const [companyRename, setCompanyRename] = useState<CompanyRenameState>({ status: 'idle' })
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  // La apertura en vuelo. Interrumpirla es lo que antes hacia subir un
  // contador: un Exit interrumpido no pinta visor, y el grant de un solo uso
  // que llegue tarde no reemplaza lo que el cliente esta mirando.
  const openFiberRef = useRef<Fiber.Fiber<ViewerState> | null>(null)
  const revealNonceRef = useRef(0)
  const foreignDropReturnFocusRef = useRef<HTMLElement | null>(null)

  const updateLayout = useCallback((patch: Partial<RoomLayout>) => setRoomLayout(patch), [])

  const commitCompanyRename = useCallback(() => {
    if (!onRenameCompany || companyRename.status !== 'editing') return
    const draft = companyRename.draft
    const trimmed = draft.trim()
    if (!trimmed) {
      toast.error(copy.coverRenameEmpty)
      return
    }
    if (trimmed === companyName) {
      setCompanyRename({ status: 'idle' })
      return
    }
    setCompanyRename({ status: 'saving', draft })

    // Un `await` pelado dejaba el formulario en `saving` para siempre si la
    // mutation RECHAZABA en vez de devolver `false`: campo y botones
    // deshabilitados, sin aviso y sin salida. Un rechazo es un rename fallido
    // como cualquier otro, y aqui esta escrito que lo es.
    const renameCompany = Effect.fn('RoomShell.renameCompany')(function* (): Effect.fn.Return<
      boolean,
      RoomRenameError
    > {
      return yield* Effect.tryPromise({
        try: () => onRenameCompany(trimmed),
        catch: (cause) => new RoomRenameError({ message: describeCause(cause), cause }),
      })
    })

    runClientFork(
      renameCompany().pipe(
        Effect.catch(() => Effect.succeed(false)),
        Effect.tap((ok) =>
          Effect.sync(() => {
            if (ok) {
              toast.success(copy.coverRenameSucceeded(trimmed))
              setCompanyRename({ status: 'idle' })
              return
            }
            toast.error(copy.coverRenameFailed)
            setCompanyRename({ status: 'editing', draft })
          })
        )
      )
    )
  }, [companyName, companyRename, copy, onRenameCompany])

  const rows = useMemo(() => documents.map(toRoomShellDocument), [documents])

  // Calienta la cache con el sidecar Mog (18 MB inmutables) mientras el cliente
  // mira la lista: si hay un libro en la sala, lo va a abrir, y esa primera
  // apertura no debe pagar la descarga entera al pulsar "Abrir" (9,6 s a
  // 20 Mbps contra 1,6 s con cache). En la demo sin bytes no hay visor.
  useEffect(() => {
    if (!isDemo && rows.some((row) => row.kind === 'spreadsheet')) prefetchXlsxSidecar()
  }, [isDemo, rows])
  const filtered = useMemo(() => filterRoomDocuments(rows, search), [rows, search])
  const sorted = useMemo(() => sortRoomDocuments(filtered, sort), [filtered, sort])
  const windowed = useMemo(() => sorted.slice(0, visibleCount), [sorted, visibleCount])
  const totals = useMemo(() => folderCounts(filtered), [filtered])
  const loadedTotals = useMemo(() => folderCounts(windowed), [windowed])
  const unfilteredTotals = useMemo(() => folderCounts(rows), [rows])

  const selectedDocument = useMemo(
    () => filtered.find((document) => document.id === selectedDocumentId) ?? null,
    [filtered, selectedDocumentId]
  )

  // A VIEW grant is one-use. If search hides the open document, discard the
  // viewer state and invalidate any in-flight grant response. Clearing search
  // restores the selected card, never the already-consumed URL.
  const handleSearchChange = useCallback(
    (value: string) => {
      if (
        selectedDocumentId &&
        'documentId' in viewer &&
        !filterRoomDocuments(rows, value).some((document) => document.id === selectedDocumentId)
      ) {
        openFiberRef.current?.interruptUnsafe()
        setViewer({ status: 'closed' })
        setPendingRevealTarget(null)
      }
      onSearchChange(value)
    },
    [onSearchChange, rows, selectedDocumentId, viewer]
  )

  const lastUpdate = useMemo(() => latestRoomUpdate(rows), [rows])
  const mandateLabel = roomMandateLabel(companyMandate, copy)

  const openDocumentRow = useCallback(
    (
      document: RoomShellDocument,
      navigate?: DocumentViewerNavigate,
      requestedVersionId?: string
    ) => {
      // Una apertura nueva reemplaza a la anterior.
      openFiberRef.current?.interruptUnsafe()
      const versionId = requestedVersionId ?? document.versionId ?? ''
      setSelectedDocumentId(document.id)
      setViewer({ status: 'loading', documentId: document.id, versionId, navigate })

      // La demo local no tiene bytes: el visor monta y declara que no hay vista
      // previa en vez de inventar una URL.
      if (isDemo) {
        const previewable = isPreviewableDocument(document.mimeType, document.name)
        setViewer({
          status: 'ready',
          documentId: document.id,
          versionId,
          fileName: document.name,
          mimeType: document.mimeType ?? 'application/octet-stream',
          action: previewable ? 'VIEW' : 'DOWNLOAD',
          viewUrl: '',
          downloadUrl: null,
          navigate,
        })
        return
      }

      const issueViewGrant = Effect.fn('RoomShell.issueViewGrant')(function* (): Effect.fn.Return<
        ViewerState,
        RoomDocumentAccessError
      > {
        const result = yield* Effect.tryPromise({
          try: () =>
            getDocumentAccessGrant({
              documentId: document.id as Id<'documents'>,
              ...(requestedVersionId
                ? { versionId: requestedVersionId as Id<'documentVersions'> }
                : {}),
              action: 'VIEW',
            }),
          catch: (cause) =>
            new RoomDocumentAccessError({
              reason: 'transport',
              message: describeCause(cause),
              cause,
            }),
        })

        if (isDeniedDocumentAccess(result) || !isIssuedDocumentAccessGrant(result)) {
          return yield* Effect.fail(
            new RoomDocumentAccessError({
              reason: 'refused',
              message: 'La sala no emitio un grant de vista para este documento.',
            })
          )
        }

        return {
          status: 'ready',
          documentId: document.id,
          versionId: result.versionId,
          fileName: result.displayName,
          mimeType: result.detectedMimeType,
          action: result.action,
          viewUrl:
            result.action === 'VIEW'
              ? withGrantQuery(result.url, 'disposition=inline')
              : result.url,
          downloadUrl: result.action === 'DOWNLOAD' ? result.url : null,
          navigate,
        }
      })

      const fiber = runClientFork(
        issueViewGrant().pipe(
          Effect.catchTag('RoomDocumentAccessError', (failure) =>
            // Un rechazo de la policy no es un incidente del cliente; una
            // llamada que nunca volvio si.
            (failure.reason === 'transport'
              ? Effect.logError('No se pudo abrir el documento del data room', {
                  errorType: errorType(failure.cause),
                })
              : Effect.void
            ).pipe(
              Effect.as<ViewerState>({
                status: 'error',
                documentId: document.id,
                versionId,
                navigate,
              })
            )
          )
        )
      )
      openFiberRef.current = fiber

      fiber.addObserver((exit) => {
        if (openFiberRef.current === fiber) openFiberRef.current = null
        // Interrumpida por otra apertura, por el cierre del visor o por una
        // busqueda que escondio el documento.
        if (!Exit.isSuccess(exit)) return

        const next = exit.value
        setViewer(next)
        if (next.status === 'error') toast.error(copy.openError)
      })
    },
    [copy.openError, getDocumentAccessGrant, isDemo]
  )

  const downloadDocumentRow = useCallback(
    (document: RoomShellDocument, requestedVersionId?: string) => {
      if (isDemo) {
        toast.info(copy.demoNoBytes)
        return
      }

      const issueDownloadGrant = Effect.fn('RoomShell.issueDownloadGrant')(
        function* (): Effect.fn.Return<void, RoomDocumentAccessError> {
          const result = yield* Effect.tryPromise({
            try: () =>
              getDocumentAccessGrant({
                documentId: document.id as Id<'documents'>,
                ...((requestedVersionId ?? document.versionId)
                  ? {
                      versionId: (requestedVersionId ??
                        document.versionId) as Id<'documentVersions'>,
                    }
                  : {}),
                action: 'DOWNLOAD',
              }),
            catch: (cause) =>
              new RoomDocumentAccessError({
                reason: 'transport',
                message: describeCause(cause),
                cause,
              }),
          })

          if (isDeniedDocumentAccess(result) || !isIssuedDocumentAccessGrant(result)) {
            return yield* Effect.fail(
              new RoomDocumentAccessError({
                reason: 'refused',
                message: 'La sala no emitio un grant de descarga para este documento.',
              })
            )
          }

          // Tras la espera del grant ya no hay gesto de usuario: un window.open
          // aquí es un popup y Safari/iOS lo bloquean en silencio (soporte SAMPLE_HYDRO
          // 2026-08-27). El grant es same-origin: un <a download> no lo es.
          yield* Effect.sync(() => downloadFromGrant(result.url, result.displayName))
        }
      )

      runClientFork(
        issueDownloadGrant().pipe(
          Effect.catchTag('RoomDocumentAccessError', (failure) =>
            (failure.reason === 'transport'
              ? Effect.logError('No se pudo descargar el documento del data room', {
                  errorType: errorType(failure.cause),
                })
              : Effect.void
            ).pipe(Effect.andThen(Effect.sync(() => toast.error(copy.downloadError))))
          )
        )
      )
    },
    [copy.demoNoBytes, copy.downloadError, getDocumentAccessGrant, isDemo]
  )

  // Tocar una carpeta o un documento deja la sala "parada" en esa carpeta: de
  // ahí salen la carpeta que propone la subida y la que se descarga en zip.
  const activateFolder = useCallback(
    (folder: string) => {
      setActiveFolder(folder)
      onActiveFolderChange?.(folder)
    },
    [onActiveFolderChange]
  )

  const toggleFolder = useCallback(
    (folder: string) => {
      activateFolder(folder)
      setExpandedFolders((current) => {
        const next = new Set(current)
        if (next.has(folder)) next.delete(folder)
        else next.add(folder)
        return next
      })
    },
    [activateFolder]
  )

  const moveDocument = useCallback(
    async (document: RoomShellDocument, folder: string) => {
      const moved = await onMove(document.id, folder)
      if (moved) setExpandedFolders((current) => new Set(current).add(folder))
    },
    [onMove]
  )

  const selectDocumentRow = useCallback(
    (document: RoomShellDocument, closeMobileTree: boolean) => {
      setPendingRevealTarget(null)
      setSelectedDocumentId(document.id)
      activateFolder(document.folder)
      if (closeMobileTree) setMobileTreeOpen(false)
    },
    [activateFolder]
  )

  const openDocumentFromUser = useCallback(
    (document: RoomShellDocument) => {
      const revealTarget =
        pendingRevealTarget?.documentId === document.id ? pendingRevealTarget : undefined
      setPendingRevealTarget(null)
      openDocumentRow(document, revealTarget?.navigate, revealTarget?.versionId)
    },
    [openDocumentRow, pendingRevealTarget]
  )

  const treeActions: RoomTreeActions = {
    onSelect: (document) => selectDocumentRow(document, true),
    onOpen: openDocumentFromUser,
    onMoveDocuments,
    onRenameDocument,
    onQueueForeignFiles: (files, targetFolderId) => {
      const activeElement = document.activeElement
      foreignDropReturnFocusRef.current =
        activeElement instanceof HTMLElement ? activeElement : null
      onQueueForeignFiles(files, targetFolderId)
    },
  }

  const navigation: RoomNavigation = useMemo(
    () => ({
      revealDocument: (target) => {
        const document = rows.find((row) => row.id === target.documentId)
        if (!document) {
          openFiberRef.current?.interruptUnsafe()
          setPendingRevealTarget(null)
          setRevealRequest(undefined)
          setViewer({ status: 'unavailable' })
          return
        }

        openFiberRef.current?.interruptUnsafe()
        setViewer({ status: 'closed' })
        // La cita se decodifica AQUI, donde entra, y no en cada pintada.
        setPendingRevealTarget({ ...target, navigate: citedNavigate(target.navigate) })
        setSelectedDocumentId(document.id)
        setMobileTreeOpen(true)
        setExpandedFolders((current) => new Set(current).add(document.folder))
        const documentIndex = sortRoomDocuments(rows, sort).findIndex(
          (row) => row.id === document.id
        )
        if (documentIndex >= 0) {
          setVisibleCount((current) => Math.max(current, documentIndex + 1))
        }
        if (!filtered.some((row) => row.id === document.id)) handleSearchChange('')
        setRevealRequest({ id: document.id, nonce: ++revealNonceRef.current })
      },
    }),
    [filtered, handleSearchChange, rows, sort]
  )

  useImperativeHandle(
    navigationRef,
    () => ({
      openSource(target) {
        navigation.revealDocument(target)
        const sourceDocument = rows.find((row) => row.id === target.documentId)
        if (sourceDocument) {
          openDocumentRow(sourceDocument, citedNavigate(target.navigate), target.versionId)
        }
        document
          .getElementById('room-shell')
          ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      },
    }),
    [navigation, openDocumentRow, rows]
  )

  const remaining = sorted.length - windowed.length
  const nextWindow = Math.min(DOCUMENT_WINDOW_SIZE, remaining)
  // Una búsqueda sin resultados es un estado propio: la sala tiene documentos,
  // el filtro no. No se pinta un árbol de carpetas vacías para decirlo.
  const searchTerm = search.trim()
  const searchEmpty = searchTerm.length > 0 && sorted.length === 0
  const recentDocuments = useMemo(() => sortRoomDocuments(rows, 'modified').slice(0, 3), [rows])
  // El panel vacío enseña qué carpeta sigue en cero, en vez de anunciar que no
  // hay selección: para quien acaba de subir sus estados es el siguiente paso.
  const { emptyFolders, optionalEmptyFolders } = useMemo(() => {
    const filled = new Set(rows.map((row) => row.folder))
    return partitionEmptyRoomFolders(VDR_SHELL_FOLDERS, filled)
  }, [rows])
  const visibleDocumentIds = useMemo(
    () => new Set(windowed.map((document) => document.id)),
    [windowed]
  )
  const hiddenBulkCount = bulkSelection
    ? [...bulkSelection.selectedIds].filter((id) => !visibleDocumentIds.has(id)).length
    : 0
  // Los diálogos masivos deciden destino, divulgación y borrado a partir de la
  // selección, no de constantes: sin las filas no tienen con qué derivarlo.
  const selectedBulkDocuments = useMemo(
    () => (bulkSelection ? rows.filter((row) => bulkSelection.selectedIds.has(row.id)) : []),
    [bulkSelection, rows]
  )

  // El panel del árbol se pinta a mano: `ui/sidebar.tsx` es el bloque completo
  // de shadcn y su `Sidebar` exige un `SidebarProvider` y se posiciona fijo.
  // Acá el ancho y el colapso los manda el `ResizablePanel` que lo envuelve.
  const renderFilesSidebar = () => (
    <aside
      data-slot="sidebar"
      data-side="left"
      data-testid="room-files-sidebar"
      aria-label={copy.region}
      className="border-sidebar-border bg-sidebar text-sidebar-foreground flex h-auto min-h-0 w-full flex-col border-b lg:h-full lg:overflow-hidden lg:border-r lg:border-b-0"
    >
      <div
        data-slot="sidebar-content"
        className="flex min-h-0 flex-1 flex-col overflow-auto overscroll-contain"
      >
        <button
          type="button"
          data-testid="room-tree-toggle"
          aria-expanded={mobileTreeOpen}
          aria-controls="room-tree-region"
          onClick={() => setMobileTreeOpen((open) => !open)}
          className="focus-visible:ring-ring/50 flex min-h-11 w-full items-center justify-between gap-2 px-4 text-sm font-medium outline-none focus-visible:ring-2 lg:hidden"
        >
          <span>
            {mobileTreeOpen ? copy.foldersHide : copy.foldersToggle}{' '}
            <span className="text-muted-foreground text-xs tabular-nums">
              {coverCountLabel(copy, searchTerm, sorted.length, rows.length)}
            </span>
          </span>
          <ChevronDown
            className={`h-4 w-4 transition-transform duration-[180ms] motion-reduce:transition-none ${mobileTreeOpen ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>
        {/* `@container`: las filas del árbol responden al ancho del PANEL, no al
            de la ventana. Al angostar, el nombre se queda con toda la línea y su
            metadata baja debajo, en vez de competir por 180 px. */}
        <div
          id="room-tree-region"
          data-testid="room-tree-region"
          className={`@container relative ${mobileTreeOpen ? 'block' : 'hidden'} max-h-[50dvh] overflow-y-auto lg:block lg:max-h-none lg:min-h-0 lg:flex-1`}
        >
          {searchEmpty ? (
            <RoomNoResults
              copy={copy}
              term={searchTerm}
              onClearSearch={() => handleSearchChange('')}
              testId="room-tree-no-results"
            />
          ) : (
            <>
              <RoomFolderTree
                copy={copy}
                locale={locale}
                documents={windowed}
                totals={totals}
                loadedTotals={loadedTotals}
                unfilteredTotals={unfilteredTotals}
                searchTerm={searchTerm}
                onClearSearch={() => handleSearchChange('')}
                expandedFolders={expandedFolders}
                onToggleFolder={toggleFolder}
                selectedDocumentId={selectedDocumentId}
                actions={treeActions}
                revealRequest={revealRequest}
                bulkSelection={bulkSelection}
              />
              {sorted.length === 0 ? (
                <p className="text-muted-foreground px-4 py-3 text-sm">{copy.emptyRoom}</p>
              ) : null}
              {remaining > 0 ? (
                <div className="px-2 pb-3">
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => setVisibleCount((current) => current + DOCUMENT_WINDOW_SIZE)}
                  >
                    {copy.loadMore(nextWindow)}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </aside>
  )

  const renderCanvas = () => (
    <RoomCenter
      copy={copy}
      locale={locale}
      document={selectedDocument}
      viewer={viewer}
      isDemo={isDemo}
      activityHref={activityHref}
      searchEmpty={searchEmpty}
      searchTerm={searchTerm}
      onClearSearch={() => handleSearchChange('')}
      recentDocuments={recentDocuments}
      emptyFolders={emptyFolders}
      optionalEmptyFolders={optionalEmptyFolders}
      onSelect={(document) => selectDocumentRow(document, false)}
      onOpen={openDocumentFromUser}
      onDownload={(document, versionId) => downloadDocumentRow(document, versionId)}
      onOpenVersionHistory={onOpenVersionHistory}
      onRename={(document) => onRename(document.id)}
      onNewVersion={(document) => onNewVersion(document.id)}
      onArchive={(document) => onArchive(document.id)}
      onPurge={onPurge ? (document) => onPurge(document.id) : undefined}
      onMove={(document, folder) => void moveDocument(document, folder)}
      onCloseViewer={() => {
        openFiberRef.current?.interruptUnsafe()
        setViewer({ status: 'closed' })
      }}
      onRetryViewer={(document, navigate, versionId) =>
        openDocumentRow(document, navigate, versionId)
      }
    />
  )

  const renderRightPanel = () =>
    rightPanel ? (
      <aside
        id="room-right-panel"
        aria-label={rightPanel.title}
        className="bg-background flex h-full min-h-0 flex-col"
      >
        <div className="border-border flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
          <h3 className="font-sans text-sm font-semibold">{rightPanel.title}</h3>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            aria-label={rightPanel.closeLabel}
            onClick={() => setRightPanelOpen(false)}
          >
            <PanelRightClose className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{rightPanel.content}</div>
      </aside>
    ) : null

  // El h2 nunca se desmonta: la sección lo nombra por `aria-labelledby`, así
  // que durante la edición se esconde en visual y conserva el nombre accesible.
  const coverHeading = (
    <h2
      id="room-shell-heading"
      data-testid="room-cover-name"
      className={
        companyRename.status === 'idle'
          ? 'font-display text-[2rem] leading-tight font-normal tracking-tight [overflow-wrap:anywhere] lg:text-4xl'
          : 'sr-only'
      }
    >
      {companyName}
    </h2>
  )

  const room = (
    <section
      id="room-shell"
      data-testid="vdr-room-shell"
      aria-labelledby="room-shell-heading"
      className="border-sidebar-border bg-background flex min-h-0 scroll-mt-24 flex-col rounded-md border lg:h-full lg:overflow-hidden"
    >
      {/* Portada del dossier: el nombre del cliente es el titular de la sala
            (Fraunces, con la regla editorial debajo); mandato y metadata van en
            una sola línea de datos. La barra de herramientas es una sola fila
            desde xl (el buscador cede) y termina en las acciones que monta el
            dueño de la sala. Debajo de xl puede envolver. */}
      <header className="border-sidebar-border bg-sidebar text-sidebar-foreground shrink-0 border-b px-4 pt-5 pb-4 sm:px-6">
        <div className="flex items-start gap-4">
          <RoomCoverMark name={companyName} logoUrl={companyLogoUrl} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
              {coverHeading}
              {onRenameCompany && companyRename.status !== 'idle' ? (
                <>
                  <Input
                    type="text"
                    aria-label={copy.coverRenameInput}
                    data-testid="room-cover-name-input"
                    value={companyRename.draft}
                    autoFocus
                    disabled={companyRename.status === 'saving'}
                    onChange={(event) =>
                      setCompanyRename((current) =>
                        current.status === 'editing'
                          ? { status: 'editing', draft: event.target.value }
                          : current
                      )
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        commitCompanyRename()
                      } else if (event.key === 'Escape') {
                        setCompanyRename({ status: 'idle' })
                      }
                    }}
                    className="h-10 w-full sm:w-80"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => commitCompanyRename()}
                    disabled={companyRename.status === 'saving'}
                  >
                    {copy.coverRenameSave}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setCompanyRename({ status: 'idle' })}
                    disabled={companyRename.status === 'saving'}
                  >
                    {copy.coverRenameCancel}
                  </Button>
                </>
              ) : onRenameCompany ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-testid="room-cover-rename"
                  aria-label={copy.coverRenameAction}
                  onClick={() => setCompanyRename({ status: 'editing', draft: companyName })}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
            <span className="rule-editorial mt-3" aria-hidden="true" />
            <p className="font-figure text-muted-foreground mt-3 flex flex-wrap items-center gap-x-2 text-xs">
              {mandateLabel ? (
                <>
                  <span data-testid="room-cover-mandate">{mandateLabel}</span>
                  <span aria-hidden="true">·</span>
                </>
              ) : null}
              <span
                data-testid="room-cover-metadata"
                className="flex flex-wrap items-center gap-x-2"
              >
                {searchEmpty ? (
                  <span>{copy.coverNoMatches(rows.length)}</span>
                ) : (
                  <>
                    <span>
                      {searchTerm.length > 0
                        ? copy.coverResults(sorted.length, rows.length)
                        : copy.coverDocuments(rows.length)}
                    </span>
                    <span aria-hidden="true">·</span>
                    {lastUpdate ? (
                      <span>
                        {copy.coverUpdated} {formatCoverDate(lastUpdate, locale)}
                      </span>
                    ) : (
                      <span>{copy.coverNoUpdate}</span>
                    )}
                  </>
                )}
              </span>
            </p>
            <p data-testid="room-results" role="status" className="sr-only">
              {copy.results(windowed.length, sorted.length, searchTerm.length > 0)}
            </p>
          </div>
        </div>

        <div
          data-testid="room-cover-toolbar"
          className="mt-5 flex flex-wrap items-center gap-2 xl:flex-nowrap"
        >
          <Input
            type="text"
            aria-label={copy.search}
            placeholder={copy.searchPlaceholder}
            value={search}
            onChange={(event) => handleSearchChange(event.target.value)}
            className="h-10 w-full basis-full sm:w-56 sm:basis-auto xl:w-auto xl:min-w-40 xl:flex-1"
          />
          <div className="max-sm:w-full max-sm:basis-full">
            <Select value={sort} onValueChange={(value) => setSort(value as RoomShellSort)}>
              {/* El valor solo ("Proceso") se lee como un filtro de
                    transacción. El control dice de qué habla. */}
              <SelectTrigger className="h-10 w-full sm:w-44" aria-label={copy.sort}>
                <span className="text-muted-foreground mr-1 shrink-0">{copy.sort}:</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="process">{copy.sortProcess}</SelectItem>
                <SelectItem value="name">{copy.sortName}</SelectItem>
                <SelectItem value="modified">{copy.sortModified}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {!isDemo ? (
            <CoverToolbarIconWrap label={copy.downloadZip}>
              <RoomZipExportButton
                locale={locale}
                label={copy.downloadZip}
                pendingLabel={copy.downloadZipPending}
                successLabel={copy.downloadZipStarted}
                errorLabel={copy.downloadZipError}
                tooLargeLabel={copy.downloadZipTooLarge}
                emptyLabel={copy.downloadZipEmpty}
                testId="room-zip-export"
              />
            </CoverToolbarIconWrap>
          ) : null}
          {/* La carpeta se descarga sola cuando el visitante está parado en
                ella: sin carpeta activa el botón no promete nada. */}
          {!isDemo && activeFolder ? (
            <CoverToolbarIconWrap label={copy.downloadFolderZip}>
              <RoomZipExportButton
                folder={activeFolder}
                locale={locale}
                label={copy.downloadFolderZip}
                pendingLabel={copy.downloadZipPending}
                successLabel={copy.downloadZipStarted}
                errorLabel={copy.downloadZipError}
                tooLargeLabel={copy.downloadZipTooLarge}
                emptyLabel={copy.downloadFolderZipEmpty}
                testId="room-folder-zip-export"
              />
            </CoverToolbarIconWrap>
          ) : null}
          {rightPanel ? (
            <Button
              type="button"
              variant="outline"
              className={cn(
                'h-10 max-sm:w-10 max-sm:min-w-10 max-sm:px-0',
                coverActions ? '' : 'sm:ml-auto'
              )}
              aria-controls="room-right-panel"
              aria-expanded={rightPanelOpen}
              aria-label={rightPanelOpen ? rightPanel.closeLabel : rightPanel.openLabel}
              title={rightPanelOpen ? rightPanel.closeLabel : rightPanel.openLabel}
              onClick={() => {
                if (!rightPanelOpen) rightPanel.onOpen?.()
                setRightPanelOpen(!rightPanelOpen)
              }}
            >
              <MessageSquareText className="h-4 w-4 sm:mr-2" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only sm:inline">
                {rightPanelOpen ? rightPanel.closeLabel : rightPanel.openLabel}
              </span>
            </Button>
          ) : null}
          {coverActions ? (
            <div
              className={cn(
                'flex flex-nowrap items-center gap-2',
                COVER_TOOLBAR_ICON_ONLY,
                rightPanel ? '' : 'sm:ml-auto'
              )}
            >
              {coverActions}
            </div>
          ) : null}
        </div>
      </header>

      {bulkSelection && bulkSelection.selectedIds.size > 0 ? (
        <div className="shrink-0">
          <RoomBulkActionBar
            copy={copy}
            locale={locale}
            selection={bulkSelection}
            selectedDocuments={selectedBulkDocuments}
            hiddenCount={hiddenBulkCount}
          />
        </div>
      ) : null}

      {isDesktopLayout ? (
        <ResizablePanelGroup
          id="room-desktop-layout"
          data-testid="room-desktop-layout"
          orientation="horizontal"
          className="h-auto min-h-0 flex-1 overflow-hidden"
        >
          <ResizablePanel
            id="room-files-panel"
            defaultSize={initialLayout.treeWidth}
            minSize={ROOM_TREE_MIN_WIDTH}
            maxSize={ROOM_TREE_MAX_WIDTH}
            onResize={(size) => {
              const nextWidth = clampTreeWidth(size.inPixels)
              if (nextWidth !== layout.treeWidth) updateLayout({ treeWidth: nextWidth })
            }}
          >
            {renderFilesSidebar()}
          </ResizablePanel>

          <ResizableHandle
            withHandle
            id="room-tree-resize"
            data-testid="room-tree-resize"
            data-resize-ready="true"
            aria-label={copy.resizeTree}
            className="hover:bg-accent w-1.5 focus-visible:ring-2"
          />

          <ResizablePanel
            id="room-canvas"
            data-testid="room-canvas"
            minSize={320}
            className="bg-background min-h-0 min-w-0 overflow-y-auto"
          >
            {renderCanvas()}
          </ResizablePanel>
          {rightPanel && rightPanelOpen ? (
            <>
              <ResizableHandle
                id="room-right-panel-resize"
                data-testid="room-right-panel-resize"
                aria-label={rightPanel.resizeLabel}
                className="hover:bg-accent w-1.5 focus-visible:ring-2"
              />
              <ResizablePanel
                id="room-right-panel-container"
                data-testid="room-right-panel-container"
                defaultSize={320}
                minSize={280}
                maxSize={360}
                className="min-h-0 min-w-0"
              >
                {renderRightPanel()}
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      ) : (
        <div className="flex min-h-0 flex-col">
          {renderFilesSidebar()}
          {/* El lienzo apilado es un contenedor, igual que el `ResizablePanel`
                del layout de escritorio: el unico `main` de la pagina es el del
                layout, y en movil este era un tercer landmark anidado. */}
          <div
            data-testid="room-canvas"
            className={cn(
              'bg-background min-w-0 overflow-y-auto',
              viewer.status === 'closed' ? 'min-h-72' : 'h-[min(80dvh,52rem)] min-h-[28rem]'
            )}
          >
            {renderCanvas()}
          </div>
          {rightPanel && rightPanelOpen ? (
            <div className="border-border min-h-72 border-t">{renderRightPanel()}</div>
          ) : null}
        </div>
      )}
      {pendingForeignDrop ? (
        <RoomDropConflictDialog
          open
          pending={false}
          currentFolderLabel={getVdrShellFolderLabel(pendingForeignDrop.currentFolderId, locale)}
          nextFolderLabel={getVdrShellFolderLabel(pendingForeignDrop.targetFolderId, locale)}
          copy={{
            title: copy.dropConflictTitle,
            description: copy.dropConflictDescription,
            close: copy.dropConflictClose,
            cancel: copy.dropConflictCancel,
            confirm: copy.dropConflictConfirm,
            pending: copy.dropConflictPending,
          }}
          returnFocusRef={foreignDropReturnFocusRef}
          onCancel={onCancelForeignDrop}
          onConfirm={onConfirmForeignDrop}
        />
      ) : null}
    </section>
  )
  return (
    <DocumentBytesProvider activeUrl={viewer.status === 'ready' ? viewer.viewUrl : null}>
      {room}
    </DocumentBytesProvider>
  )
}

// Un valor común solo existe si TODA la selección lo comparte; una selección
// mixta no tiene default honesto y el diálogo abre sin nada elegido.
function commonValue<T>(
  documents: readonly RoomShellDocument[],
  read: (document: RoomShellDocument) => T
): T | null {
  if (documents.length === 0) return null
  const [first] = documents
  return documents.every((document) => read(document) === read(first)) ? read(first) : null
}

function RoomBulkActionBar({
  copy,
  locale,
  selection,
  selectedDocuments,
  hiddenCount,
}: {
  copy: RoomShellCopy
  locale: RoomLocale
  selection: RoomBulkSelection
  selectedDocuments: readonly RoomShellDocument[]
  hiddenCount: number
}) {
  const [moveDialogOpen, setMoveDialogOpen] = useState(false)
  const [disclosureDialogOpen, setDisclosureDialogOpen] = useState(false)
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)
  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false)
  // Ninguno de los tres arranca en una constante de módulo: el destino se elige
  // y la divulgación se deriva de la selección al abrir el diálogo.
  const [folder, setFolder] = useState<string | null>(null)
  const [accessLevel, setAccessLevel] = useState<DocumentAccessLevel | null>(null)
  const [classification, setClassification] = useState<DocumentClassification | null>(null)
  const [seededDisclosure, setSeededDisclosure] = useState<{
    accessLevel: DocumentAccessLevel | null
    classification: DocumentClassification | null
  }>({ accessLevel: null, classification: null })
  const selectedCount = selection.selectedIds.size
  const compatibleClassifications = VDR_CLASSIFICATIONS.filter((option) =>
    accessLevel === 'PUBLIC' ? option.value === 'PUBLIC_TEASER' : option.value !== 'PUBLIC_TEASER'
  )
  const summary = copy.bulkSummary(selectedCount, hiddenCount)
  // Ampliar el alcance revoca los accesos abiertos, así que se avisa antes de
  // confirmar, igual que en el diálogo de un solo documento.
  const widening =
    accessLevel !== null &&
    selectedDocuments.some(
      (document) => ACCESS_LEVEL_REACH[accessLevel] < ACCESS_LEVEL_REACH[document.accessLevel]
    )
  const disclosureUnchanged =
    accessLevel === seededDisclosure.accessLevel &&
    classification === seededDisclosure.classification
  const teamDeliverables = selectedDocuments.filter(
    (document) => document.sourceType === 'TEAM_DELIVERABLE'
  )

  const openDisclosureDialog = () => {
    const commonAccess = commonValue(selectedDocuments, (document) => document.accessLevel)
    const commonClassification = commonAccess
      ? inferClassificationFromAccessLevel(commonAccess)
      : null
    setAccessLevel(commonAccess)
    setClassification(commonClassification)
    setSeededDisclosure({ accessLevel: commonAccess, classification: commonClassification })
    setDisclosureDialogOpen(true)
  }

  const changeAccessLevel = (nextAccessLevel: DocumentAccessLevel) => {
    if (selection.isUpdating) return
    setAccessLevel(nextAccessLevel)
    setClassification(inferClassificationFromAccessLevel(nextAccessLevel))
  }

  const changeDialogOpen = (setter: (open: boolean) => void) => (open: boolean) => {
    if (!selection.isUpdating) setter(open)
  }

  const preventPendingDismiss = (event: Event) => {
    if (selection.isUpdating) event.preventDefault()
  }

  const runAndClose = async (action: () => Promise<boolean>, close: () => void) => {
    try {
      if (await action()) close()
    } catch {
      // The hook owns localized failure feedback. A rejected adapter preserves
      // both the controlled selection and the confirmation for retry.
    }
  }

  return (
    <>
      <div
        role="region"
        aria-label={summary}
        data-testid="room-bulk-selection"
        className="border-primary/20 bg-background sticky top-2 z-20 flex min-w-0 flex-col gap-2 border-b px-3 py-2 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:px-5"
      >
        <p role="status" aria-live="polite" className="min-w-0 text-sm font-medium">
          <span className="border-border font-figure mr-2 inline-flex h-7 min-w-7 items-center justify-center rounded-sm border px-2 text-xs font-semibold">
            {selectedCount}
          </span>
          {summary}
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setFolder(null)
              setMoveDialogOpen(true)
            }}
            disabled={selection.isUpdating}
          >
            <FolderInput aria-hidden="true" />
            {copy.bulkMove}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openDisclosureDialog}
            disabled={selection.isUpdating}
          >
            <SlidersHorizontal aria-hidden="true" />
            {copy.bulkDisclosure}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setArchiveDialogOpen(true)}
            disabled={selection.isUpdating}
          >
            <Archive aria-hidden="true" />
            {copy.bulkArchive}
          </Button>
          {selection.onPurge ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-destructive"
              data-testid="room-bulk-purge"
              onClick={() => setPurgeDialogOpen(true)}
              disabled={selection.isUpdating}
            >
              <Trash2 aria-hidden="true" />
              {copy.bulkPurge}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={selection.onClear}
            disabled={selection.isUpdating}
          >
            <X aria-hidden="true" />
            {copy.bulkClear}
          </Button>
        </div>
      </div>

      <Dialog open={moveDialogOpen} onOpenChange={changeDialogOpen(setMoveDialogOpen)}>
        <DialogContent
          showCloseButton={!selection.isUpdating}
          onEscapeKeyDown={preventPendingDismiss}
          onPointerDownOutside={preventPendingDismiss}
          onInteractOutside={preventPendingDismiss}
        >
          <DialogHeader>
            <DialogTitle>{copy.bulkMoveTitle}</DialogTitle>
            <DialogDescription>{copy.bulkMoveDescription(selectedCount)}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="room-bulk-folder">{copy.bulkDestinationFolder}</Label>
            <Select
              value={folder ?? undefined}
              disabled={selection.isUpdating}
              onValueChange={(value) => {
                if (!selection.isUpdating) setFolder(value)
              }}
            >
              <SelectTrigger id="room-bulk-folder" className="min-h-11">
                <SelectValue placeholder={copy.bulkDestinationPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {VDR_SHELL_FOLDERS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label[locale]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setMoveDialogOpen(false)}
              disabled={selection.isUpdating}
            >
              {copy.bulkCancel}
            </Button>
            <Button
              type="button"
              onClick={() =>
                void (async () => {
                  if (!folder) return
                  try {
                    // Un movimiento sin nada que mover no es un fallo: se avisa
                    // y se cierra la confirmación en vez de dejarla colgada.
                    const outcome = await selection.onMove(folder)
                    if (outcome === 'FAILED') return
                    if (outcome === 'NOOP') toast.info(copy.bulkMoveNoop)
                    setMoveDialogOpen(false)
                  } catch {
                    // El hook es dueño del feedback localizado de fallo.
                  }
                })()
              }
              disabled={selection.isUpdating || folder === null}
            >
              {selection.isUpdating ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : null}
              {copy.bulkConfirmMove}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={disclosureDialogOpen} onOpenChange={changeDialogOpen(setDisclosureDialogOpen)}>
        <DialogContent
          showCloseButton={!selection.isUpdating}
          onEscapeKeyDown={preventPendingDismiss}
          onPointerDownOutside={preventPendingDismiss}
          onInteractOutside={preventPendingDismiss}
        >
          <DialogHeader>
            <DialogTitle>{copy.bulkDisclosureTitle}</DialogTitle>
            <DialogDescription>{copy.bulkDisclosureDescription(selectedCount)}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="room-bulk-access">{copy.access}</Label>
              <Select
                value={accessLevel ?? undefined}
                disabled={selection.isUpdating}
                onValueChange={(value) => changeAccessLevel(value as DocumentAccessLevel)}
              >
                <SelectTrigger id="room-bulk-access" className="min-h-11">
                  <SelectValue placeholder={copy.bulkAccessPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {VDR_ACCESS_LEVELS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label[locale]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="room-bulk-classification">{copy.bulkClassification}</Label>
              <Select
                value={classification ?? undefined}
                disabled={selection.isUpdating}
                onValueChange={(value) => {
                  if (!selection.isUpdating) {
                    setClassification(value as DocumentClassification)
                  }
                }}
              >
                <SelectTrigger id="room-bulk-classification" className="min-h-11">
                  <SelectValue placeholder={copy.bulkClassificationPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {compatibleClassifications.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label[locale]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {widening ? (
            <p className="text-destructive text-sm">{copy.bulkDeclassifyWarning(selectedCount)}</p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDisclosureDialogOpen(false)}
              disabled={selection.isUpdating}
            >
              {copy.bulkCancel}
            </Button>
            <Button
              type="button"
              onClick={() =>
                void (async () => {
                  if (accessLevel === null || classification === null) return
                  await runAndClose(
                    () => selection.onChangeDisclosure(accessLevel, classification),
                    () => setDisclosureDialogOpen(false)
                  )
                })()
              }
              disabled={
                selection.isUpdating ||
                accessLevel === null ||
                classification === null ||
                disclosureUnchanged
              }
            >
              {selection.isUpdating ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : null}
              {copy.bulkConfirmDisclosure}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={archiveDialogOpen} onOpenChange={changeDialogOpen(setArchiveDialogOpen)}>
        <AlertDialogContent onEscapeKeyDown={preventPendingDismiss}>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.bulkArchiveTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {copy.bulkArchiveDescription(selectedCount)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={selection.isUpdating}>{copy.bulkCancel}</AlertDialogCancel>
            <AlertDialogAction
              disabled={selection.isUpdating}
              onClick={(event) =>
                void (async () => {
                  event.preventDefault()
                  await runAndClose(selection.onArchive, () => setArchiveDialogOpen(false))
                })()
              }
            >
              {selection.isUpdating ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : null}
              {copy.bulkArchive}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {selection.onPurge ? (
        <AlertDialog open={purgeDialogOpen} onOpenChange={changeDialogOpen(setPurgeDialogOpen)}>
          <AlertDialogContent
            data-testid="room-bulk-purge-dialog"
            onEscapeKeyDown={preventPendingDismiss}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.bulkPurgeTitle(selectedCount)}</AlertDialogTitle>
              <AlertDialogDescription>
                {teamDeliverables.length > 0
                  ? copy.bulkPurgeTeamDeliverable(teamDeliverables.map((document) => document.name))
                  : copy.purgeDescription}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={selection.isUpdating}>
                {copy.bulkCancel}
              </AlertDialogCancel>
              <AlertDialogAction
                className={buttonVariants({ variant: 'destructive' })}
                data-testid="room-bulk-purge-confirm"
                disabled={selection.isUpdating || teamDeliverables.length > 0}
                onClick={(event) =>
                  void (async () => {
                    event.preventDefault()
                    const purge = selection.onPurge
                    if (!purge || teamDeliverables.length > 0) return
                    await runAndClose(purge, () => setPurgeDialogOpen(false))
                  })()
                }
              >
                {selection.isUpdating ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : null}
                {copy.bulkPurge}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  )
}

function RoomCenter({
  copy,
  locale,
  document,
  viewer,
  isDemo,
  activityHref,
  searchEmpty,
  searchTerm,
  onClearSearch,
  recentDocuments,
  emptyFolders,
  optionalEmptyFolders,
  onSelect,
  onOpen,
  onDownload,
  onOpenVersionHistory,
  onRename,
  onNewVersion,
  onArchive,
  onPurge,
  onMove,
  onCloseViewer,
  onRetryViewer,
}: {
  copy: RoomShellCopy
  locale: RoomLocale
  document: RoomShellDocument | null
  viewer: ViewerState
  isDemo: boolean
  activityHref?: string
  searchEmpty: boolean
  searchTerm: string
  onClearSearch: () => void
  recentDocuments: readonly RoomShellDocument[]
  emptyFolders: readonly VdrFolderOption[]
  optionalEmptyFolders: readonly VdrFolderOption[]
  onSelect: (document: RoomShellDocument) => void
  onOpen: (document: RoomShellDocument) => void
  onDownload: (document: RoomShellDocument, versionId?: string) => void
  onOpenVersionHistory?: (documentId: string) => void
  onRename: (document: RoomShellDocument) => void
  onNewVersion: (document: RoomShellDocument) => void
  onArchive: (document: RoomShellDocument) => void
  onPurge?: (document: RoomShellDocument) => void
  onMove: (document: RoomShellDocument, folder: string) => void
  onCloseViewer: () => void
  onRetryViewer: (
    document: RoomShellDocument,
    navigate: DocumentViewerNavigate | undefined,
    versionId: string
  ) => void
}) {
  // La metadata del documento vive detrás de «Información», no en un panel
  // ancho: se abre sobre la ficha y se cierra cuando el cliente termina.
  const [infoDocumentId, setInfoDocumentId] = useState<string | null>(null)
  // Abrir un documento salta a él: el panel del visor arranca muy abajo en la
  // página y sin este salto solo se ve una tira del archivo.
  const viewerRef = useRef<HTMLDivElement>(null)
  const readyDocumentId = viewer.status === 'ready' ? viewer.documentId : null
  useEffect(() => {
    if (!readyDocumentId) return
    viewerRef.current?.scrollIntoView?.({ block: 'start' })
  }, [readyDocumentId])

  // La confirmación del borrado vive aquí, junto a la fila que la dispara: el
  // dueño de la sala confirma sobre el documento que está mirando, con su
  // nombre en el título. Se cierra sola al confirmar; el hook dueño de la
  // mutation es quien avisa del resultado.
  const [purgeOpen, setPurgeOpen] = useState(false)

  if (viewer.status === 'unavailable') {
    return (
      <div
        role="alert"
        className="flex h-full min-h-64 flex-col items-center justify-center px-6 py-12 text-center"
      >
        <p className="text-foreground max-w-md text-sm leading-6">{copy.openError}</p>
      </div>
    )
  }

  if (!document) {
    return (
      <div
        data-testid="room-center-empty"
        data-variant={searchEmpty ? 'no-results' : 'empty'}
        className="flex h-full min-h-48 flex-col items-center justify-start gap-2 px-6 pt-10 pb-8 text-center lg:min-h-64"
      >
        {searchEmpty ? (
          <RoomNoResults copy={copy} term={searchTerm} onClearSearch={onClearSearch} centered />
        ) : (
          <>
            <p className="font-display text-foreground text-xl leading-tight">
              {copy.centerEmptyTitle}
            </p>
            <p className="text-muted-foreground max-w-sm text-sm leading-6">
              {copy.centerEmptyDescription}
            </p>
            {emptyFolders.length > 0 ? (
              <div data-testid="room-center-missing" className="mt-6 w-full max-w-md text-left">
                <h3 className="text-sm font-medium">{copy.centerMissing}</h3>
                <ul className="divide-border border-border mt-2 divide-y border-t">
                  {emptyFolders.map((folder) => (
                    <li
                      key={folder.value}
                      className="flex min-h-11 flex-col justify-center px-2 py-2"
                    >
                      <span className="text-sm">{folder.label[locale]}</span>
                      <span className="text-muted-foreground text-xs leading-5">
                        {copy.emptyFolder(folder.value)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {optionalEmptyFolders.length > 0 ? (
              <p
                data-testid="room-center-optional"
                className="text-muted-foreground mt-3 w-full max-w-md text-left text-xs leading-5"
              >
                {copy.centerOptional(optionalEmptyFolders.map((folder) => folder.label[locale]))}
              </p>
            ) : null}
            {recentDocuments.length > 0 ? (
              <div className="mt-6 w-full max-w-md text-left">
                <h3 className="text-sm font-medium">{copy.centerRecent}</h3>
                <ul className="divide-border border-border mt-2 divide-y border-t">
                  {recentDocuments.map((recent) => (
                    <li key={recent.id}>
                      <button
                        type="button"
                        data-testid="room-recent-document"
                        onClick={() => onSelect(recent)}
                        className="hover:bg-primary/8 focus-visible:ring-ring flex min-h-11 w-full items-center justify-between gap-3 rounded-sm px-2 text-left text-sm outline-none focus-visible:ring-2"
                      >
                        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                          {recent.name}
                        </span>
                        <span className="text-muted-foreground font-figure shrink-0 text-xs">
                          {formatCoverDate(recent.updatedAt, locale)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>
    )
  }

  const viewerIsOpen = viewer.status !== 'closed' && viewer.documentId === document.id

  if (viewerIsOpen) {
    const displayedName = viewer.status === 'ready' ? viewer.fileName : document.name
    return (
      <div
        ref={viewerRef}
        data-testid="room-viewer"
        // The navigation target is published on the shell, not on the viewer:
        // the renderers lane replaces DocumentViewer.tsx wholesale, and a
        // citation chip still has to be provably navigable without it.
        data-document-id={document.id}
        {...(viewer.status === 'ready' && viewer.navigate?.sheet
          ? { 'data-navigate-sheet': viewer.navigate.sheet }
          : {})}
        {...(viewer.status === 'ready' && viewer.navigate?.range
          ? { 'data-navigate-range': viewer.navigate.range }
          : {})}
        {...(viewer.status === 'ready' && viewer.navigate?.page !== undefined
          ? { 'data-navigate-page': String(viewer.navigate.page) }
          : {})}
        {...(viewer.status === 'ready' ? { 'data-version-id': viewer.versionId } : {})}
        className="flex h-full min-h-96 scroll-mt-24 flex-col"
      >
        <div className="border-border flex items-center justify-between gap-3 border-b px-4 py-2">
          <p className="min-w-0 truncate text-sm font-medium" title={displayedName}>
            {displayedName}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            {/* La descarga pide su propio grant al pulsarla: abrir el visor no
                debe registrar una descarga que nadie hizo. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDownload(document, viewer.versionId)}
              aria-label={`${copy.download}: ${displayedName}`}
              data-testid="room-viewer-download"
            >
              {copy.download}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onCloseViewer}
              data-testid="room-viewer-close"
            >
              <X className="mr-1 h-4 w-4" aria-hidden="true" />
              {copy.closeViewer}
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          {viewer.status === 'ready' ? (
            <DocumentViewer
              documentId={document.id as Id<'documents'>}
              versionId={viewer.versionId as Id<'documentVersions'>}
              fileName={viewer.fileName}
              mimeType={viewer.mimeType}
              sizeBytes={document.sizeBytes ?? 0}
              viewUrl={viewer.viewUrl}
              downloadUrl={viewer.downloadUrl}
              navigate={viewer.navigate}
              onClose={onCloseViewer}
              onRetry={() => onRetryViewer(document, viewer.navigate, viewer.versionId)}
              // A pantalla completa el marco tapa esta fila: la misma descarga
              // (un grant nuevo al pulsarla) viaja al marco en vez de quedarse
              // debajo.
              onDownload={() => onDownload(document, viewer.versionId)}
            />
          ) : viewer.status === 'error' ? (
            <div
              role="alert"
              className="flex h-full min-h-64 flex-col items-center justify-center px-6 py-12 text-center"
            >
              <p className="text-foreground max-w-md text-sm leading-6">{copy.openError}</p>
              <Button
                className="mt-5 min-h-11"
                variant="outline"
                onClick={() => onRetryViewer(document, viewer.navigate, viewer.versionId)}
              >
                {copy.retryOpen}
              </Button>
            </div>
          ) : (
            <div role="status" aria-live="polite" className="space-y-3 p-6">
              <span className="sr-only">{copy.loadingDocument}</span>
              <Skeleton className="h-5 w-2/3 motion-reduce:animate-none" />
              <Skeleton className="h-64 w-full motion-reduce:animate-none" />
              <Skeleton className="h-4 w-1/2 motion-reduce:animate-none" />
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full items-start justify-center px-4 py-8 sm:px-8">
      <article
        data-testid="room-document-card"
        aria-label={copy.documentCard}
        className="border-border bg-card w-full max-w-3xl rounded-md border p-6"
      >
        <p className="text-muted-foreground text-xs">
          {getVdrShellFolderLabel(document.folder, locale)}
        </p>
        <h3 className="mt-2 text-lg leading-snug font-semibold [overflow-wrap:anywhere]">
          {document.name}
        </h3>
        <p className="text-muted-foreground mt-2 text-sm leading-6">
          {roomSourceLabel(document, copy)}
        </p>
        <dl className="divide-border mt-4 divide-y text-sm">
          <Row term={copy.fileType} valueTestId="room-file-type">
            {roomKindLabel(document.kind, copy)}
          </Row>
          <Row term={copy.fileSize}>
            <span className="font-figure">{formatRoomFileSize(document.sizeBytes, locale)}</span>
          </Row>
          <Row term={copy.version}>
            <span className="font-figure">
              {document.versionNumber ? copy.versionShort(document.versionNumber) : '—'}
            </span>
          </Row>
          <Row term={copy.access}>{roomAccessLabel(document.accessLevel, copy)}</Row>
          <Row term={copy.scanStatus}>{roomScanLabel(document.status, copy)}</Row>
        </dl>

        <div className="mt-6 flex flex-wrap gap-2">
          {/* Red de seguridad del precalentamiento: si el cliente llegó al
              documento antes de que el efecto de la lista corriera, el sidecar
              empieza a bajar al apuntar el botón y no al pulsarlo. El helper es
              idempotente. */}
          <Button
            className="min-h-11"
            aria-label={`${copy.open}: ${document.name}`}
            onPointerEnter={
              !isDemo && document.kind === 'spreadsheet' ? () => prefetchXlsxSidecar() : undefined
            }
            onClick={() => onOpen(document)}
          >
            {copy.open}
          </Button>
          <Button
            variant="outline"
            className="min-h-11"
            aria-label={`${copy.download}: ${document.name}`}
            onClick={() => onDownload(document, document.versionId ?? undefined)}
          >
            {copy.download}
          </Button>
        </div>

        {/* Zona densa de mantenimiento: controles de 36px, no de 44px, y la
            acción destructiva separada al final de la fila. */}
        <div className="border-border mt-5 flex flex-wrap items-center gap-2 border-t pt-5">
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            aria-label={`${copy.rename}: ${document.name}`}
            onClick={() => onRename(document)}
          >
            <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
            {copy.rename}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            data-testid="room-document-info-open"
            aria-label={`${copy.info}: ${document.name}`}
            onClick={() => setInfoDocumentId(document.id)}
          >
            <Info className="mr-2 h-4 w-4" aria-hidden="true" />
            {copy.info}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            aria-label={`${copy.newVersion}: ${document.name}`}
            onClick={() => onNewVersion(document)}
          >
            <UploadCloud className="mr-2 h-4 w-4" aria-hidden="true" />
            {copy.newVersion}
          </Button>
          <Select
            value={document.folder}
            onValueChange={(folder) => {
              if (folder !== document.folder) onMove(document, folder)
            }}
          >
            <SelectTrigger
              className="h-9 w-52"
              aria-label={`${copy.moveTo}: ${document.name}`}
              data-testid="room-move-folder"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VDR_SHELL_FOLDERS.map((folder) => (
                <SelectItem key={folder.value} value={folder.value}>
                  {folder.label[locale]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {activityHref && !isDemo ? (
            <Button variant="ghost" size="sm" className="h-9" asChild>
              <Link
                href={`${activityHref}${activityHref.includes('?') ? '&' : '?'}document=${encodeURIComponent(document.id)}`}
                aria-label={`${copy.activity}: ${document.name}`}
              >
                <Activity className="mr-2 h-4 w-4" aria-hidden="true" />
                {copy.activity}
              </Link>
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive border-border ml-auto h-9 border-l pl-4"
            aria-label={`${copy.archive}: ${document.name}`}
            onClick={() => onArchive(document)}
          >
            <Archive className="mr-2 h-4 w-4" aria-hidden="true" />
            {copy.archive}
          </Button>
          {onPurge ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive h-9"
              aria-label={`${copy.purge}: ${document.name}`}
              data-testid="room-document-purge"
              onClick={() => setPurgeOpen(true)}
            >
              <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
              {copy.purge}
            </Button>
          ) : null}
        </div>

        {onPurge ? (
          <AlertDialog open={purgeOpen} onOpenChange={setPurgeOpen}>
            <AlertDialogContent data-testid="room-document-purge-dialog">
              <AlertDialogHeader>
                <AlertDialogTitle>{copy.purgeTitle(document.name)}</AlertDialogTitle>
                <AlertDialogDescription>{copy.purgeDescription}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{copy.bulkCancel}</AlertDialogCancel>
                <AlertDialogAction
                  className={buttonVariants({ variant: 'destructive' })}
                  data-testid="room-document-purge-confirm"
                  onClick={() => {
                    setPurgeOpen(false)
                    onPurge(document)
                  }}
                >
                  {copy.purge}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </article>

      {infoDocumentId === document.id ? (
        <RoomDocumentInfoDialog
          copy={copy}
          locale={locale}
          isDemo={isDemo}
          document={document}
          open
          onOpenChange={(open) => {
            if (!open) setInfoDocumentId(null)
          }}
          versionHistory={
            onOpenVersionHistory
              ? {
                  copy: {
                    open: copy.versionHistoryOpen,
                    unavailable: copy.versionHistoryUnavailable,
                  },
                  onOpen: (documentId) => {
                    setInfoDocumentId(null)
                    onOpenVersionHistory(documentId)
                  },
                }
              : undefined
          }
        />
      ) : null}
    </div>
  )
}

function CoverToolbarIconWrap({ label, children }: { label: string; children: ReactNode }) {
  const setLabel = (node: HTMLDivElement | null) => {
    const button = node?.querySelector('button')
    if (!button) return
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label)
  }
  return (
    <div title={label} className={COVER_TOOLBAR_ICON_ONLY} ref={setLabel}>
      {children}
    </div>
  )
}

/**
 * Búsqueda sin coincidencias: dice qué se buscó y ofrece la única salida. Se
 * usa dos veces (árbol y centro) para que no queden dos mensajes distintos.
 */
function RoomNoResults({
  copy,
  term,
  onClearSearch,
  centered = false,
  testId,
}: {
  copy: RoomShellCopy
  term: string
  onClearSearch: () => void
  centered?: boolean
  testId?: string
}) {
  return (
    <div
      data-testid={testId}
      className={centered ? 'flex flex-col items-center gap-2' : 'space-y-2 px-4 py-6'}
    >
      {/* El título grande vive en el centro; el panel del árbol solo repite el
          término y la salida, para no gritar dos veces lo mismo. */}
      {centered ? (
        <p className="font-display text-foreground text-xl leading-tight">{copy.noResultsTitle}</p>
      ) : null}
      <p className="text-muted-foreground max-w-sm text-sm leading-6 [overflow-wrap:anywhere]">
        {copy.noResultsFor(term)}
      </p>
      {/* Desde `lg` el árbol y el centro se ven juntos, y el centro ya trae la
          salida: dos «Limpiar búsqueda» lado a lado eran el mismo botón dos
          veces. En móvil el árbol es el único panel a la vista y se la queda. */}
      <Button
        variant="outline"
        size="sm"
        className={centered ? 'mt-2 h-9' : 'mt-2 h-9 lg:hidden'}
        onClick={onClearSearch}
      >
        {copy.clearSearch}
      </Button>
    </div>
  )
}

// La portada solo nombra el mandato que el cliente declaró. `UNSET`, `null` y
// `undefined` no pintan nada: una sala sin mandato elegido no es una sala de
// equity, y afirmarlo en la cabecera es una asunción que el cliente lee como un
// hecho sobre su transacción. Tampoco se rellena con un estado de acceso
// («Sala activa»): eso lo dice el panel de activación, con una sola voz
// (auditoría 2026-09-06, F07).
function roomMandateLabel(mandate: Props['companyMandate'], copy: RoomShellCopy): string | null {
  if (!mandate) return null
  // Tabla exhaustiva, no escalera con un `return null` al final: un mandato
  // nuevo en el modelo tiene que decidir aqui si se nombra en la portada o no,
  // en vez de desaparecer sin que nadie se entere.
  const labels: Record<NonNullable<Props['companyMandate']>, string | null> = {
    DEBT: copy.mandateDebt,
    EQUITY: copy.mandateEquity,
    BOTH: copy.mandateBoth,
    BRIDGE: copy.mandateBridge,
    UNSET: null,
  }
  return labels[mandate]
}

function formatCoverDate(value: number, locale: RoomLocale) {
  return formatShortDate(value, locale)
}

/** Logo de la empresa o sus iniciales en un cuadro sobrio, como portada de dossier. */
function RoomCoverMark({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  const initials = name
    .split(/\s+/)
    .filter((part) => /^[\p{L}\p{N}]/u.test(part))
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')

  return (
    <div
      data-testid="room-cover-mark"
      className="border-border bg-background mt-1 flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md border lg:h-12 lg:w-12"
    >
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- logo remoto de la empresa, sin dominio fijo
        <img src={logoUrl} alt="" className="h-full w-full object-contain p-1.5" />
      ) : (
        <span aria-hidden="true" className="font-display text-primary text-base sm:text-lg">
          {initials || '—'}
        </span>
      )}
    </div>
  )
}

function Row({
  term,
  children,
  valueTestId,
}: {
  term: string
  children: React.ReactNode
  valueTestId?: string
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <dt className="text-muted-foreground">{term}</dt>
      <dd
        {...(valueTestId ? { 'data-testid': valueTestId } : {})}
        className="text-right font-medium [overflow-wrap:anywhere]"
      >
        {children}
      </dd>
    </div>
  )
}
