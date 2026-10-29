import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Effect, Exit, Schema } from 'effect'
import type { Fiber } from 'effect'

import { runClientEffectExit, runClientFork } from '@/lib/effect/client-runtime'

import { api } from '@/../convex/_generated/api'
import { adminVdrTarget } from '@/../convex/_adminVdr/capabilityFormat'
import type { Id } from '@/../convex/_generated/dataModel'
import type { DirectVdrUploadInput, DirectVdrUploadResult } from '@/hooks/useDirectVdrUpload'
import { useAuth } from '@/hooks/useAuth'
import { usePathname, useRouter } from '@/i18n/navigation'
import {
  addDemoDocument,
  getDemoDocuments,
  removeDemoDocument,
  updateDemoDocument,
} from '@/lib/dev-auth/demo-browser-store'
import {
  inferClassificationFromAccessLevel,
  type DocumentClassification,
} from '@/lib/documents/classification'
import { calculateVdrFileSha256 } from '@/lib/documents/direct-upload'
import {
  buildUploadQueueEntries,
  isRetryableQueuedUploadFailure,
  settleWithConcurrency,
  uploadableQueueEntries,
  validateQueuedUpload,
  type VdrQueuedUpload,
  type VdrUploadOrigin,
} from '@/lib/documents/upload-queue'
import { HANDOFF_QUERY_PARAM } from '@/lib/mycroft/handoff-claim'
import {
  planForeignFileDrop,
  resolveRoomDocumentMove,
  roomUploadScopeKey,
  type ForeignDropQueueResult,
  type RoomDocumentMoveOutcome,
} from '@/lib/documents/room-tree-command-state'
import {
  actionableBusinessMessage,
  businessErrorMessage,
  isTeamDeliverableRejection,
  withDocumentNames,
  VDR_COPY,
} from './config'
import {
  mapDemoVdrDocument,
  resolveCompanyUploadFolder,
  roomQueryArgs,
  runVdrDocumentCommand,
  vdrCommandCause,
} from './helpers'
import type { VdrAccessLevel, VdrCopy, VdrDocumentView, VdrLocale } from './types'
import { useVdrDocumentActions } from './useVdrDocumentActions'
import { useAdminVdrCapability, useAdminVdrOperator } from './AdminVdrCapabilityContext'
import {
  COMPANY_ROOM,
  VDR_CATEGORY_VALUES,
  resolveWorkspaceUrlState,
  sanitizeSearch,
  serializeWorkspaceUrlState,
  type VdrWorkspaceUrlState,
} from './workspace-url-state'

type DirectUpload = (input: DirectVdrUploadInput) => Promise<DirectVdrUploadResult>

type PendingForeignDrop = {
  files: readonly File[]
  currentFolderId: string
  targetFolderId: string
}

/**
 * Falla de carga cuyo mensaje YA es copy nuestro y localizado (lo redacta
 * `uploadFailureMessage` a partir del código estable del resultado), no un
 * payload del backend. El catch de `handleUpload` la distingue de un error de
 * negocio para no descartar esa redacción — en particular la advertencia de
 * reconciliación, que es la única señal de "no reintentes este archivo".
 *
 * No fija `name`: el log sigue reportando `errorType: 'Error'` y no filtra el
 * nombre de la clase.
 */
class LocalizedVdrUploadError extends Error {}

// ============================================================================
// LA COSTURA CON EFFECT
// ============================================================================
// Tres cosas viven acá abajo como programas con nombre, y las tres eran
// promesas anónimas que se perdían en una traza.
//
// La huella del archivo es la que traía un bug de verdad. `handleFileSelect`
// abría el hash del archivo y se guardaba con un contador de época para no
// pisar el formulario si el cliente elegía otro archivo. Pero el contador no
// sabe nada del desmontaje: si el cliente salía de la sala mientras se hasheaba
// un archivo grande, el `await` volvía igual y escribía estado —y en la rama
// del error, un toast— de un componente que ya no estaba. Y el hash seguía
// corriendo completo, porque el `AbortSignal` que `calculateVdrFileSha256`
// acepta desde hace rato nunca se le pasaba: nadie lo cancelaba.
//
// Ahora la huella es una fibra. Una selección nueva, un reset del formulario o
// el desmontaje la interrumpen, y la interrupción viaja hasta el `AbortSignal`
// que `Effect.tryPromise` le entrega al cálculo: el hash se corta en su próximo
// punto de control en vez de terminar para nadie. Un Exit interrumpido no pinta
// estado, así que el contador de época se fue con el bug.

class VdrFileFingerprintError extends Schema.TaggedError<VdrFileFingerprintError>()(
  'VdrFileFingerprintError',
  { cause: Schema.Defect() }
) {}

/** El programa no falla: decide. La UI solo necesita saber si hubo huella. */
type FileFingerprint = { readonly ok: true; readonly sha256: string } | { readonly ok: false }

const fingerprintFile = Effect.fn('CompanyVdr.fingerprintFile')(
  function* (file: File): Effect.fn.Return<string, VdrFileFingerprintError> {
    return yield* Effect.tryPromise({
      try: (signal) => calculateVdrFileSha256(file, signal),
      catch: (cause) => new VdrFileFingerprintError({ cause }),
    })
  },
  Effect.match({
    onSuccess: (sha256): FileFingerprint => ({ ok: true, sha256 }),
    onFailure: (): FileFingerprint => ({ ok: false }),
  })
)

// La URL de la sala también carga la llave del sobre de la landing. No es
// estado del workspace y la normalización no la entiende, pero tampoco es suya
// para tirarla: `MyCompanyDocumentsClient` la quita cuando el reclamo asienta o
// cuando decide descartarlo. Quitarla antes deja el sobre huérfano — la sala
// tarda en cargar, la llave se va de la URL, el cliente recarga y la visita
// siguiente ve un sobre que ya no puede reclamar y no sube nada.
function carryHandoffNonce(href: string, currentParams: URLSearchParams): string {
  const nonce = currentParams.get(HANDOFF_QUERY_PARAM)
  if (!nonce) return href
  const [path, query = ''] = href.split('?')
  const params = new URLSearchParams(query)
  params.set(HANDOFF_QUERY_PARAM, nonce)
  return `${path}?${params.toString()}`
}

type Params = {
  companyId: string
  isDemo: boolean
  accessMode: 'MANAGE' | 'READ_ONLY'
  locale: VdrLocale
  copy: VdrCopy
  /**
   * Lista de la sala corporativa resuelta en el servidor (`documents.getByCompany`
   * con scope COMPANY). Cubre el hueco entre el HTML y la primera respuesta de
   * la suscripcion viva: la sala pinta con documentos desde el primer render en
   * vez de un esqueleto, y la consulta viva manda en cuanto responde.
   */
  initialDocuments?: VdrDocumentView[] | null
  uploadDocument: DirectUpload
  onBatchUploadSuccess?: (files: readonly File[]) => Promise<void> | void
}

export function useCompanyVdr(params: Params) {
  const t = useTranslations('vdr')
  const isReadOnly = params.accessMode === 'READ_ONLY'
  const { user, isSignedIn } = useAuth()
  const { push, replace } = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const searchParamsSnapshot = searchParams.toString()
  // La misma señal que decide el formulario de subida (`VdrUploadDialog` lee
  // este contexto): cuando el equipo opera la sala de otra empresa, su carpeta
  // elegida a mano manda y no pasa por el clasificador de nombres.
  const adminOperator = useAdminVdrOperator()
  const initialWorkspaceState = resolveWorkspaceUrlState(
    new URLSearchParams(searchParamsSnapshot)
  )
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadQueueKeyRef = useRef(0)
  const uploadQueueRef = useRef<VdrQueuedUpload[]>([])
  const folderRef = useRef('other')
  const replacingDocumentRef = useRef<VdrDocumentView | null>(null)
  const isUploadingRef = useRef(false)
  const pendingForeignDropRef = useRef<PendingForeignDrop | null>(null)
  const uploadOperationAbortControllerRef = useRef<AbortController | null>(null)
  // La huella del archivo en vuelo. Es lo que se interrumpe cuando llega otra
  // selección, cuando el formulario se limpia o cuando la sala se desmonta.
  const fileFingerprintFiberRef = useRef<Fiber.Fiber<FileFingerprint> | null>(null)
  // Ledger de feedback inmediato: sobrevive cerrar/reabrir el diálogo. Un
  // reload lo borra, pero la mutation de emisión repite la misma clave exacta
  // contra el ledger durable del backend y bloquea o reconcilia antes del POST.
  const uncertainSingleUploadFingerprintsRef = useRef(new Set<string>())
  const [workspaceState, setWorkspaceState] = useState<VdrWorkspaceUrlState>(initialWorkspaceState)
  const [demoVersion, setDemoVersion] = useState(0)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadQueue, setUploadQueue] = useState<VdrQueuedUpload[]>([])
  const [docName, setDocName] = useState('')
  const [folder, setFolder] = useState('other')
  const [accessLevel, setAccessLevel] = useState<VdrAccessLevel>('NDA_REQUIRED')
  const [classification, setClassification] = useState<DocumentClassification>('CONFIDENTIAL')
  const [replacingDocument, setReplacingDocument] = useState<VdrDocumentView | null>(null)
  const [versionHistoryDocument, setVersionHistoryDocument] = useState<VdrDocumentView | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [pendingForeignDrop, setPendingForeignDrop] = useState<PendingForeignDrop | null>(null)
  // Un resultado incierto puede haber comprometido los mismos bytes. Este
  // latch refleja el ledger criptográfico del scope actual; nombres y objetos
  // File nunca deciden si un replay es seguro.
  const [singleUploadReconciliationRequired, setSingleUploadReconciliationRequired] =
    useState(false)
  const activeRoom = COMPANY_ROOM
  const activeRoomUploadScopeKey = roomUploadScopeKey(params.companyId, activeRoom)
  const uploadRoomScopeKeyRef = useRef(activeRoomUploadScopeKey)
  // Generación de carga: cambia cada vez que la sala activa abandona una
  // operación en vuelo. Una carga vieja que responde tarde compara contra
  // ella antes de escribir cualquier estado del formulario actual.
  const uploadGenerationRef = useRef(0)
  const activeView = 'documents' as const
  const activeCategory = VDR_CATEGORY_VALUES.has(workspaceState.category)
    ? workspaceState.category
    : 'all'
  const search = sanitizeSearch(workspaceState.search)

  useEffect(() => {
    const currentParams = new URLSearchParams(searchParamsSnapshot)
    const resolved = resolveWorkspaceUrlState(currentParams)
    setWorkspaceState((current) =>
      current.category === resolved.category && current.search === resolved.search
        ? current
        : resolved
    )

    const normalizedUrl = carryHandoffNonce(
      serializeWorkspaceUrlState(pathname, resolved),
      currentParams
    )
    const currentUrl = searchParamsSnapshot ? `${pathname}?${searchParamsSnapshot}` : pathname
    if (normalizedUrl !== currentUrl) replace(normalizedUrl, { scroll: false })
  }, [pathname, replace, searchParamsSnapshot])

  function navigateWorkspace(state: VdrWorkspaceUrlState, history: 'push' | 'replace') {
    setWorkspaceState(state)
    const href = carryHandoffNonce(
      serializeWorkspaceUrlState(pathname, state),
      new URLSearchParams(searchParamsSnapshot)
    )
    if (history === 'push') push(href, { scroll: false })
    else replace(href, { scroll: false })
  }

  const activeRoomQueryArgs = roomQueryArgs(params.companyId as Id<'companies'>, activeRoom)
  const liveDocuments = useQuery(
    api.documents.getByCompany,
    params.isDemo ? 'skip' : activeRoomQueryArgs
  )
  const initialDocuments = params.initialDocuments ?? undefined
  const documents = liveDocuments ?? initialDocuments
  const bulkUpdateDocuments = useMutation(api.documents.bulkUpdate)
  const purgeDocumentsMutation = useMutation(api.documents.purge)
  const authorizeAdminVdr = useAdminVdrCapability()

  const [demoDocuments, setDemoDocuments] = useState<VdrDocumentView[]>([])
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<string>>(new Set())
  const [isBulkUpdating, setIsBulkUpdating] = useState(false)
  useEffect(() => {
    if (!params.isDemo) return
    setDemoDocuments(getDemoDocuments({ companyId: params.companyId }).map(mapDemoVdrDocument))
  }, [demoVersion, params.companyId, params.isDemo])

  useEffect(
    () => () => {
      uploadOperationAbortControllerRef.current?.abort()
      // Sin esto, un hash abierto sobrevivía al desmontaje: terminaba de correr
      // y escribía formulario, latch o toast de una sala que ya no existe.
      fileFingerprintFiberRef.current?.interruptUnsafe()
      fileFingerprintFiberRef.current = null
    },
    []
  )

  const effectiveDocuments = (
    params.isDemo ? demoDocuments : (documents ?? [])
  ) as VdrDocumentView[]
  const activeRoomTitle = params.copy.companyLibrary
  const documentActions = useVdrDocumentActions({
    copy: params.copy,
    locale: params.locale,
    isDemo: params.isDemo,
    bumpDemoVersion: () => setDemoVersion((version) => version + 1),
  })

  function singleUploadScopeKey() {
    // Refleja el scope sellado del intent: compañía + sala + documento que se
    // reemplaza.
    const target = replacingDocument ? `version:${replacingDocument._id}` : 'new-document'
    return [params.companyId, activeRoom.kind, activeRoom.id, target].join('\u0000')
  }

  function singleUploadFingerprintKey(scopeKey: string, fileSha256: string) {
    return `${scopeKey}\u0000${fileSha256}`
  }

  const clearUploadForm = useCallback(() => {
    fileFingerprintFiberRef.current?.interruptUnsafe()
    fileFingerprintFiberRef.current = null
    setSelectedFile(null)
    uploadQueueRef.current = []
    setUploadQueue([])
    setDocName('')
    folderRef.current = 'other'
    setFolder('other')
    setAccessLevel('NDA_REQUIRED')
    setClassification('CONFIDENTIAL')
    replacingDocumentRef.current = null
    setReplacingDocument(null)
    pendingForeignDropRef.current = null
    setPendingForeignDrop(null)
    setSingleUploadReconciliationRequired(false)
    setUploadDialogOpen(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  const resetUploadForScope = useCallback(
    (nextScopeKey: string) => {
      if (uploadRoomScopeKeyRef.current === nextScopeKey) return false
      uploadOperationAbortControllerRef.current?.abort()
      uploadOperationAbortControllerRef.current = null
      uploadGenerationRef.current += 1
      uploadRoomScopeKeyRef.current = nextScopeKey
      isUploadingRef.current = false
      setIsUploading(false)
      clearUploadForm()
      return true
    },
    [clearUploadForm]
  )

  useEffect(() => {
    resetUploadForScope(activeRoomUploadScopeKey)
  }, [activeRoomUploadScopeKey, resetUploadForScope])

  function stopUploads() {
    uploadOperationAbortControllerRef.current?.abort()
  }

  function resetUpload() {
    if (resetUploadForScope(activeRoomUploadScopeKey)) return
    if (pendingForeignDropRef.current) return
    if (isUploadingRef.current) {
      stopUploads()
      return
    }
    clearUploadForm()
  }

  function updateQueueEntry(id: string, patch: Partial<VdrQueuedUpload>) {
    const next = uploadQueueRef.current.map((entry) =>
      entry.id === id ? { ...entry, ...patch } : entry
    )
    uploadQueueRef.current = next
    setUploadQueue(next)
  }

  function removeQueuedFile(id: string) {
    if (resetUploadForScope(activeRoomUploadScopeKey)) return
    if (isUploadingRef.current || pendingForeignDropRef.current) return
    const next = uploadQueueRef.current.filter((entry) => entry.id !== id)
    uploadQueueRef.current = next
    setUploadQueue(next)
    setSelectedFile(next[0]?.file ?? null)
    setDocName(next.length === 1 ? next[0].name : '')
  }

  function changeUploadName(value: string) {
    if (resetUploadForScope(activeRoomUploadScopeKey)) return
    if (pendingForeignDropRef.current) return
    setDocName(value)
    if (uploadQueueRef.current.length === 1 && replacingDocumentRef.current === null) {
      updateQueueEntry(uploadQueueRef.current[0].id, { name: value })
    }
  }

  function appendFilesToQueue(files: readonly File[], origin?: VdrUploadOrigin) {
    const result = buildUploadQueueEntries({
      files: [...files],
      alreadyQueued: uploadQueueRef.current.length,
      startKey: uploadQueueKeyRef.current,
      copy: params.copy,
      ...(origin ? { origin } : {}),
    })
    uploadQueueKeyRef.current = result.nextKey
    const nextQueue = [...uploadQueueRef.current, ...result.entries]
    uploadQueueRef.current = nextQueue
    setUploadQueue(nextQueue)
    setSelectedFile(nextQueue[0]?.file ?? null)
    setDocName(nextQueue.length === 1 ? nextQueue[0].name : '')
    if (result.droppedOverLimit > 0) {
      toast.error(t('toasts.batchLimit', { count: result.droppedOverLimit }))
    }
    return {
      queuedCount: result.entries.length,
      droppedOverLimit: result.droppedOverLimit,
    }
  }

  function queueFiles(files: File[], origin?: VdrUploadOrigin) {
    resetUploadForScope(activeRoomUploadScopeKey)
    if (files.length === 0 || isUploadingRef.current || pendingForeignDropRef.current !== null) {
      return
    }
    appendFilesToQueue(files, origin)
  }

  function setForeignDropPending(next: PendingForeignDrop | null) {
    pendingForeignDropRef.current = next
    setPendingForeignDrop(next)
  }

  function queueForeignFiles(
    files: readonly File[],
    targetFolderId: string
  ): ForeignDropQueueResult {
    resetUploadForScope(activeRoomUploadScopeKey)
    const plan = planForeignFileDrop({
      files,
      targetFolderId,
      queueLength: uploadQueueRef.current.length,
      currentFolderId: folderRef.current,
      isReadOnly,
      isUploading: isUploadingRef.current,
      isReplacingVersion: replacingDocumentRef.current !== null,
      hasPendingConfirmation: pendingForeignDropRef.current !== null,
    })
    if (plan.status === 'REJECTED') return plan
    if (plan.status === 'CONFIRMATION_REQUIRED') {
      setForeignDropPending({
        files: [...files],
        currentFolderId: plan.currentFolderId,
        targetFolderId: plan.targetFolderId,
      })
      return plan
    }

    folderRef.current = plan.targetFolderId
    setFolder(plan.targetFolderId)
    const queued = appendFilesToQueue(files)
    setUploadDialogOpen(true)
    return { status: 'QUEUED', targetFolderId: plan.targetFolderId, ...queued }
  }

  function confirmForeignDrop(): ForeignDropQueueResult {
    if (resetUploadForScope(activeRoomUploadScopeKey)) {
      return { status: 'REJECTED', reason: 'ROOM_SCOPE_CHANGED' }
    }
    const pending = pendingForeignDropRef.current
    if (!pending) return { status: 'REJECTED', reason: 'NO_PENDING_CONFIRMATION' }
    const guard = planForeignFileDrop({
      files: pending.files,
      targetFolderId: pending.targetFolderId,
      queueLength: 0,
      currentFolderId: pending.currentFolderId,
      isReadOnly,
      isUploading: isUploadingRef.current,
      isReplacingVersion: replacingDocumentRef.current !== null,
    })
    if (guard.status === 'REJECTED') return guard

    setForeignDropPending(null)
    folderRef.current = pending.targetFolderId
    setFolder(pending.targetFolderId)
    const queued = appendFilesToQueue(pending.files)
    setUploadDialogOpen(true)
    return { status: 'QUEUED', targetFolderId: pending.targetFolderId, ...queued }
  }

  function cancelForeignDrop() {
    if (!pendingForeignDropRef.current) return false
    setForeignDropPending(null)
    return true
  }

  function changeUploadFolder(value: string) {
    if (resetUploadForScope(activeRoomUploadScopeKey)) return
    if (pendingForeignDropRef.current) return
    folderRef.current = value
    setFolder(value)
  }

  // La carpeta donde el cliente está parado en la sala es la que el diálogo
  // propone: subir es un paso, no un formulario. Solo se mueve un formulario
  // inactivo — una cola ya armada o una versión en curso conservan su carpeta.
  function setActiveRoomFolder(value: string) {
    if (resetUploadForScope(activeRoomUploadScopeKey)) return
    if (isUploadingRef.current) return
    if (replacingDocumentRef.current) return
    if (pendingForeignDropRef.current) return
    if (uploadQueueRef.current.length > 0) return
    folderRef.current = value
    setFolder(value)
  }

  async function handleFileSelect(event: ChangeEvent<HTMLInputElement>) {
    if (resetUploadForScope(activeRoomUploadScopeKey)) {
      event.target.value = ''
      return
    }
    if (isUploadingRef.current || pendingForeignDropRef.current) {
      event.target.value = ''
      return
    }
    const files = Array.from(event.target.files ?? [])
    if (files.length === 0) return

    const allowMultiple = replacingDocument === null
    if (allowMultiple) {
      queueFiles(files)
      event.target.value = ''
      return
    }

    const file = files[0]
    const validationError = validateQueuedUpload(file, params.copy)
    if (validationError) {
      toast.error(validationError)
      event.target.value = ''
      return
    }
    event.target.value = ''
    const scopeKey = singleUploadScopeKey()
    setSelectedFile(null)
    // Nueva versión: conservar `document.name` (startVersionUpload) o el edit del admin.
    // Documento nuevo: el basename lo pone queueFiles → stripUploadExtension.
    if (replacingDocumentRef.current === null) {
      setDocName(file.name.replace(/\.[^/.]+$/, ''))
    }

    // Una huella nueva reemplaza a la anterior: la fibra vieja se interrumpe y
    // su Exit interrumpido no pinta nada.
    fileFingerprintFiberRef.current?.interruptUnsafe()
    const fiber = runClientFork(fingerprintFile(file))
    fileFingerprintFiberRef.current = fiber

    const exit = await new Promise<Exit.Exit<FileFingerprint>>((resolve) => {
      fiber.addObserver(resolve)
    })
    if (fileFingerprintFiberRef.current === fiber) fileFingerprintFiberRef.current = null
    // Interrumpida por otra selección, por un reset o por el desmontaje: no hay
    // estado que pintar y no hay toast que dar.
    if (!Exit.isSuccess(exit)) return

    const fingerprint = exit.value
    if (!fingerprint.ok) {
      toast.error(params.copy.uploadErrorFallback)
      return
    }

    setSelectedFile(file)
    setSingleUploadReconciliationRequired(
      uncertainSingleUploadFingerprintsRef.current.has(
        singleUploadFingerprintKey(scopeKey, fingerprint.sha256)
      )
    )
  }

  function uploadFailureMessage(result: Exclude<DirectVdrUploadResult, { ok: true }>) {
    if (result.code === 'FILE_TOO_LARGE') return params.copy.fileSizeError
    if (result.code === 'INVALID_FILE_TYPE') return params.copy.fileTypeError
    if (
      result.code === 'INVALID_FILE_SIGNATURE' ||
      result.code === 'INVALID_ARCHIVE' ||
      result.code === 'ENCRYPTED_ARCHIVE' ||
      result.code === 'ZIP_BOMB' ||
      result.code === 'MALWARE_DETECTED' ||
      result.code === 'SCAN_UNAVAILABLE'
    ) {
      return params.copy.unsafeFileError
    }
    if (result.reconciliationRequired) {
      return t('upload.reconciliation')
    }
    return params.copy.uploadErrorFallback
  }

  async function handleBatchUpload() {
    const candidates = uploadableQueueEntries(uploadQueue)
    if (candidates.length === 0 || candidates.some((entry) => entry.name.trim().length === 0)) {
      return toast.error(params.copy.missingFile)
    }
    const existingBlockedFailures = uploadQueue.filter(
      (entry) =>
        entry.status === 'ERROR' && !candidates.some((candidate) => candidate.id === entry.id)
    ).length

    isUploadingRef.current = true
    setIsUploading(true)
    const batchController = new AbortController()
    uploadOperationAbortControllerRef.current = batchController
    const results = await settleWithConcurrency(
      candidates,
      async (entry) => {
        updateQueueEntry(entry.id, {
          status: 'UPLOADING',
          error: undefined,
          retryable: false,
          reconciliationRequired: false,
        })

        try {
          if (params.isDemo) {
            addDemoDocument({
              companyId: params.companyId,
              name: entry.name.trim(),
              fileType: entry.file.type || 'application/pdf',
              folder:
                entry.folder ?? resolveCompanyUploadFolder(entry.file.name, folder, adminOperator),
              accessLevel,
              classification,
            })
            updateQueueEntry(entry.id, { status: 'DONE' })
            return { ok: true as const, documentId: `demo-${entry.id}` }
          }

          const result = await params.uploadDocument({
            file: entry.file,
            companyId: params.companyId,
            name: entry.name.trim(),
            accessLevel,
            classification,
            // La tanda parqueada por la landing trae su carpeta por archivo; el
            // diálogo de la sala manda una sola para toda la tanda, y si el
            // cliente dejó «Ruteo automático» la decide el nombre del archivo.
            folder:
              entry.folder ?? resolveCompanyUploadFolder(entry.file.name, folder, adminOperator),
            signal: batchController.signal,
          })
          if (result.ok) {
            updateQueueEntry(entry.id, { status: 'DONE' })
            return result
          }

          if (result.code === 'UPLOAD_ABORTED' && result.reconciliationRequired !== true) {
            updateQueueEntry(entry.id, {
              status: 'PENDING',
              error: undefined,
              reconciliationRequired: false,
              retryable: false,
            })
          } else {
            updateQueueEntry(entry.id, {
              status: 'ERROR',
              error: uploadFailureMessage(result),
              reconciliationRequired: result.reconciliationRequired === true,
              retryable: isRetryableQueuedUploadFailure(result),
            })
          }
          return result
        } catch (error) {
          updateQueueEntry(entry.id, {
            status: 'ERROR',
            error: params.copy.uploadErrorFallback,
            retryable: false,
            reconciliationRequired: false,
          })
          runClientFork(
            Effect.logError('VDR batch upload failed', {
              errorType: error instanceof Error ? error.name : typeof error,
            })
          )
          return { ok: false as const, code: 'REGISTRATION_FAILED' as const }
        }
      },
      { signal: batchController.signal }
    )

    if (uploadOperationAbortControllerRef.current === batchController) {
      uploadOperationAbortControllerRef.current = null
    }
    isUploadingRef.current = false
    setIsUploading(false)
    if (params.isDemo) setDemoVersion((version) => version + 1)

    const successful = results.filter(
      (result) => result.status === 'fulfilled' && result.value.ok
    ).length
    const successfulFiles = candidates
      .filter((_, index) => {
        const result = results[index]
        return result?.status === 'fulfilled' && result.value.ok
      })
      .map((entry) => entry.file)
    if (successfulFiles.length > 0) {
      await Promise.resolve(params.onBatchUploadSuccess?.(successfulFiles)).catch(() => undefined)
    }
    const safeStopped = results.filter(
      (result) =>
        result.status === 'fulfilled' &&
        !result.value.ok &&
        result.value.code === 'UPLOAD_ABORTED' &&
        result.value.reconciliationRequired !== true
    ).length
    const failed = results.length - successful - safeStopped + existingBlockedFailures
    const pending = candidates.length - successful - (failed - existingBlockedFailures)
    if (batchController.signal.aborted) {
      toast.info(
        `${successful} ${successful === 1 ? 'subido' : 'subidos'}; ` +
          `${pending} ${pending === 1 ? 'pendiente' : 'pendientes'}; ` +
          `${failed} ${failed === 1 ? 'requiere' : 'requieren'} atención.`
      )
      return
    }
    if (failed === 0) {
      toast.success(
        `${successful} ${successful === 1 ? 'documento subido' : 'documentos subidos'}.`
      )
      clearUploadForm()
      return
    }

    // Concordancia: el lote de un archivo es el caso común de este toast, y
    // «1 subidos; 1 requieren atención» se lee como un bug del producto.
    toast.error(
      `${successful} ${successful === 1 ? 'subido' : 'subidos'}; ` +
        `${failed} ${failed === 1 ? 'requiere' : 'requieren'} atención.`
    )
  }

  async function handleUpload() {
    if (resetUploadForScope(activeRoomUploadScopeKey)) return
    if (isReadOnly || pendingForeignDropRef.current) return
    if (!isSignedIn || !user) return toast.error(params.copy.signInRequired)
    if (replacingDocument === null) return handleBatchUpload()
    if (singleUploadReconciliationRequired) return
    if (!selectedFile || !docName.trim()) return toast.error(params.copy.missingFile)
    const operationScopeKey = singleUploadScopeKey()
    const operationController = new AbortController()
    const operationGeneration = uploadGenerationRef.current
    uploadOperationAbortControllerRef.current = operationController
    isUploadingRef.current = true
    setIsUploading(true)
    // Solo la operación que sigue siendo la activa de esta sala puede escribir
    // formulario, latch, feedback o el flag de "subiendo".
    const ownsUpload = () =>
      uploadGenerationRef.current === operationGeneration &&
      uploadOperationAbortControllerRef.current === operationController
    try {
      // Con «Ruteo automático» la carpeta la decide el nombre del archivo, no
      // el centinela que la sala no sabe dibujar.
      const uploadFolder = resolveCompanyUploadFolder(selectedFile.name, folder, adminOperator)
      if (params.isDemo) {
        addDemoDocument({
          companyId: params.companyId,
          name: docName.trim(),
          fileType: selectedFile.type || 'application/pdf',
          folder: uploadFolder,
          accessLevel,
          classification,
        })
        setDemoVersion((version) => version + 1)
      } else {
        const result = await params.uploadDocument({
          file: selectedFile,
          companyId: params.companyId,
          replaceDocumentId: replacingDocument?._id,
          name: docName.trim(),
          accessLevel,
          classification,
          folder: uploadFolder,
          signal: operationController.signal,
        })
        if (!result.ok) {
          if (result.code === 'UPLOAD_ABORTED' && result.reconciliationRequired !== true) {
            if (ownsUpload()) {
              toast.info(t('toasts.uploadStopped'))
            }
            return
          }
          if (result.reconciliationRequired === true) {
            // La huella queda registrada siempre: está sellada con el scope de
            // su propia operación y protege un reintento futuro en esa sala.
            uncertainSingleUploadFingerprintsRef.current.add(
              singleUploadFingerprintKey(operationScopeKey, result.fileSha256)
            )
            if (ownsUpload()) setSingleUploadReconciliationRequired(true)
            return
          }
          throw new LocalizedVdrUploadError(uploadFailureMessage(result))
        }
      }
      if (!ownsUpload()) return
      toast.success(params.copy.uploadSuccess)
      clearUploadForm()
    } catch (error) {
      runClientFork(
        Effect.logError('VDR upload failed', {
          errorType: error instanceof Error ? error.name : typeof error,
        })
      )
      if (!ownsUpload()) return
      toast.error(
        error instanceof LocalizedVdrUploadError
          ? error.message
          : businessErrorMessage(
              error,
              VDR_COPY[params.locale].mutationErrors,
              params.copy.uploadErrorFallback
            )
      )
    } finally {
      const owned = ownsUpload()
      if (uploadOperationAbortControllerRef.current === operationController) {
        uploadOperationAbortControllerRef.current = null
      }
      if (owned) {
        isUploadingRef.current = false
        setIsUploading(false)
      }
    }
  }

  function startVersionUpload(document: VdrDocumentView) {
    resetUploadForScope(activeRoomUploadScopeKey)
    if (isReadOnly || pendingForeignDropRef.current) return
    uploadQueueRef.current = []
    setUploadQueue([])
    replacingDocumentRef.current = document
    setReplacingDocument(document)
    setSelectedFile(null)
    setDocName(document.name)
    folderRef.current = document.folder ?? 'other'
    setFolder(folderRef.current)
    setAccessLevel(document.accessLevel ?? 'NDA_REQUIRED')
    setClassification(
      document.classification ??
        inferClassificationFromAccessLevel(document.accessLevel ?? 'NDA_REQUIRED')
    )
    setSingleUploadReconciliationRequired(false)
    setUploadDialogOpen(true)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function changeCategory(category: string) {
    const safeCategory = VDR_CATEGORY_VALUES.has(category) ? category : 'all'
    navigateWorkspace(
      { room: activeRoom, view: activeView, category: safeCategory, search },
      'replace'
    )
  }

  function changeSearch(value: string) {
    navigateWorkspace(
      {
        room: activeRoom,
        view: activeView,
        category: activeCategory,
        search: sanitizeSearch(value),
      },
      'replace'
    )
  }

  function toggleDocumentSelection(documentId: string, selected: boolean) {
    if (isReadOnly) return
    if (selected && selectedDocumentIds.size >= 50 && !selectedDocumentIds.has(documentId)) {
      toast.error(t('toasts.selectionLimit'))
      return
    }
    setSelectedDocumentIds((current) => {
      const next = new Set(current)
      if (selected) {
        next.add(documentId)
      } else {
        next.delete(documentId)
      }
      return next
    })
  }

  function selectAllFilteredDocuments(documentIds: string[], selected: boolean) {
    if (isReadOnly) return
    const next = new Set(selectedDocumentIds)
    if (!selected) {
      for (const documentId of documentIds) next.delete(documentId)
      setSelectedDocumentIds(next)
      return
    }

    let reachedLimit = false
    for (const documentId of documentIds) {
      if (next.size >= 50 && !next.has(documentId)) {
        reachedLimit = true
        continue
      }
      next.add(documentId)
    }
    if (reachedLimit) {
      toast.error(t('toasts.selectionCapped'))
    }
    setSelectedDocumentIds(next)
  }

  async function runBulkUpdate(
    operation:
      | { type: 'ARCHIVE' }
      | { type: 'MOVE_FOLDER'; folder: string }
      | {
          type: 'CHANGE_DISCLOSURE'
          accessLevel: VdrAccessLevel
          classification: DocumentClassification
        },
    explicitDocumentIds?: readonly string[]
  ): Promise<boolean> {
    if (isReadOnly) return false
    const documentIds = explicitDocumentIds
      ? [...explicitDocumentIds]
      : Array.from(selectedDocumentIds)
    if (!isSignedIn || !user || documentIds.length === 0) return false

    setIsBulkUpdating(true)
    const exit = await runClientEffectExit(
      runVdrDocumentCommand(async () => {
        if (params.isDemo) {
          for (const documentId of documentIds) {
            if (operation.type === 'ARCHIVE') {
              removeDemoDocument(documentId)
            } else if (operation.type === 'MOVE_FOLDER') {
              updateDemoDocument(documentId, { folder: operation.folder })
            } else {
              updateDemoDocument(documentId, {
                accessLevel: operation.accessLevel,
                classification: operation.classification,
              })
            }
          }
          setDemoVersion((version) => version + 1)
          return
        }

        const mutationInput = {
          ...activeRoomQueryArgs,
          documentIds: documentIds as Id<'documents'>[],
          operation,
        }
        await bulkUpdateDocuments(
          await authorizeAdminVdr(
            'DOCUMENT_BULK_UPDATE',
            adminVdrTarget('COMPANY', params.companyId),
            mutationInput
          )
        )
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError('Error en operación documental en lote', error.cause)
        ),
        Effect.withSpan('CompanyVdr.bulkUpdate')
      )
    )
    setIsBulkUpdating(false)

    if (!Exit.isSuccess(exit)) {
      toast.error(
        'No pudimos actualizar la selección. Revisa que todos los documentos sigan en esta sala.'
      )
      return false
    }

    toast.success(
      documentIds.length === 1
        ? '1 documento actualizado.'
        : `${documentIds.length} documentos actualizados.`
    )
    setSelectedDocumentIds((current) => {
      const next = new Set(current)
      for (const documentId of documentIds) next.delete(documentId)
      return next
    })
    return true
  }

  /**
   * Borrado PERMANENTE de los documentos que el cliente eligió en su sala.
   * No pasa por `runBulkUpdate`: `documents.bulkUpdate` archiva y conserva
   * bytes, y esto es lo contrario — `documents.purge` borra filas y blobs.
   * La sala demo no tiene backend: ahí se quita del store del navegador.
   */
  async function purgeDocuments(documentIds: readonly string[]): Promise<boolean> {
    if (isReadOnly) return false
    const ids = [...documentIds]
    if (!isSignedIn || !user || ids.length === 0) return false

    setIsBulkUpdating(true)
    const exit = await runClientEffectExit(
      runVdrDocumentCommand(async () => {
        if (params.isDemo) {
          for (const documentId of ids) removeDemoDocument(documentId)
          setDemoVersion((version) => version + 1)
          return
        }

        // La capability delegada es la misma que exige archivar: el borrado se
        // ata a la sala de la empresa porque el servidor resuelve la empresa
        // desde los propios documentos.
        await purgeDocumentsMutation(
          await authorizeAdminVdr('DOCUMENT_PURGE', adminVdrTarget('COMPANY', params.companyId), {
            documentIds: ids as Id<'documents'>[],
          })
        )
      }).pipe(
        Effect.tapError((error) => Effect.logError('Error al borrar documentos', error.cause)),
        Effect.withSpan('CompanyVdr.purge')
      )
    )
    setIsBulkUpdating(false)

    if (!Exit.isSuccess(exit)) {
      // El borrado masivo era la única acción del módulo que tragaba la causa y
      // mostraba una constante. El servidor valida el lote entero antes de la
      // primera escritura y dice por qué; eso es lo que se muestra. Solo cuando
      // ESE motivo es la entrega del equipo la nombra el cliente, que sí tiene
      // el nombre a mano: si no, un 429 o la red caída se contarían como una
      // entrega bloqueada nada más por estar en la selección.
      const cause = vdrCommandCause(exit)
      const blocked = isTeamDeliverableRejection(cause)
        ? effectiveDocuments.filter(
            (document) =>
              ids.includes(document._id) &&
              Reflect.get(document, 'sourceType') === 'TEAM_DELIVERABLE'
          )
        : []
      toast.error(
        blocked.length > 0
          ? params.copy.purgeTeamDeliverableError(blocked.map((document) => document.name))
          : withDocumentNames(
              actionableBusinessMessage(
                cause,
                VDR_COPY[params.locale].mutationErrors,
                params.copy.purgeErrorFallback
              ),
              effectiveDocuments
            )
      )
      return false
    }

    toast.success(t('toasts.documentDeleted', { count: ids.length }))
    setSelectedDocumentIds((current) => {
      const next = new Set(current)
      for (const documentId of ids) next.delete(documentId)
      return next
    })
    return true
  }

  async function moveDocuments(
    documentIds: readonly string[],
    targetFolderId: string
  ): Promise<RoomDocumentMoveOutcome> {
    if (isReadOnly) return 'FAILED'
    const move = resolveRoomDocumentMove({
      documents: effectiveDocuments,
      documentIds,
      targetFolderId,
    })
    if (move.status === 'INVALID') return 'FAILED'
    if (move.status === 'NOOP') return 'NOOP'

    // Un solo documento va por la misma mutation de lote: `documents.update`
    // no lleva el scope de la empresa y se saltaría el chequeo.
    const updated = await runBulkUpdate(
      { type: 'MOVE_FOLDER', folder: move.targetFolderId },
      move.documentIds
    )
    return updated ? 'MOVED' : 'FAILED'
  }

  return {
    isLoading: !params.isDemo && documents === undefined,
    fileInputRef,
    activeRoom,
    activeRoomTitle,
    activeView,
    documents: effectiveDocuments,
    uploadDialogOpen,
    setUploadDialogOpen,
    selectedFile,
    uploadQueue,
    pendingForeignDrop: pendingForeignDrop
      ? {
          currentFolderId: pendingForeignDrop.currentFolderId,
          targetFolderId: pendingForeignDrop.targetFolderId,
          fileCount: pendingForeignDrop.files.length,
        }
      : null,
    allowMultipleUpload: replacingDocument === null,
    docName,
    setDocName: changeUploadName,
    folder,
    setFolder: changeUploadFolder,
    setActiveRoomFolder,
    accessLevel,
    setAccessLevel: (value: VdrAccessLevel) => {
      setAccessLevel(value)
      setClassification(inferClassificationFromAccessLevel(value))
    },
    classification,
    setClassification,
    isUploading,
    singleUploadReconciliationRequired,
    handleFileSelect,
    queueFiles,
    queueForeignFiles,
    confirmForeignDrop,
    cancelForeignDrop,
    handleUpload,
    resetUpload,
    stopUploads,
    removeQueuedFile,
    activeCategory,
    setActiveCategory: changeCategory,
    search,
    setSearch: changeSearch,
    selectedDocumentIds,
    toggleDocumentSelection,
    selectAllFilteredDocuments,
    clearDocumentSelection: () => setSelectedDocumentIds(new Set()),
    isBulkUpdating,
    bulkArchiveDocuments: () => runBulkUpdate({ type: 'ARCHIVE' }),
    purgeDocuments,
    bulkPurgeDocuments: () => purgeDocuments(Array.from(selectedDocumentIds)),
    moveDocuments,
    bulkMoveDocuments: (nextFolder: string) =>
      moveDocuments(Array.from(selectedDocumentIds), nextFolder),
    bulkChangeDisclosure: (
      nextAccessLevel: VdrAccessLevel,
      nextClassification: DocumentClassification
    ) =>
      runBulkUpdate({
        type: 'CHANGE_DISCLOSURE',
        accessLevel: nextAccessLevel,
        classification: nextClassification,
      }),
    replacingDocument,
    startVersionUpload,
    versionHistoryDocument,
    setVersionHistoryDocument,
    ...documentActions,
  }
}
