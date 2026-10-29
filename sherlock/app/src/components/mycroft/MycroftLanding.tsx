'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, MouseEvent as ReactMouseEvent } from 'react'
import {
  ArrowRight,
  CircleAlert,
  FileText,
  FileSpreadsheet,
  FileType,
  Presentation,
  Table,
  X,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Option, Schema } from 'effect'

import {
  LandingAgentPanel,
  LandingDocumentStack,
  LandingDetails,
} from '@/components/mycroft/MycroftLandingPresentation'
import styles from '@/components/mycroft/landing.module.css'
import { decodeCsrfToken } from '@/components/mycroft/decode-csrf-token'
import {
  IntakeUploadProgressBar,
  uploadStateLabel,
} from '@/components/mycroft/IntakeUploadProgress'
import { Button } from '@/components/ui/button'
import { trackSellSideEventOnce } from '@/lib/analytics/sell-side'
import { INTAKE_CSRF_HEADER } from '@/lib/intake/config'
import { formatFileSize, formatTransferredBytes } from '@/lib/intake/file-size'
import { readLandingDestination } from '@/lib/intake/landing-destination'
import { uploadIntakeFile, warmUploadIntakeFile } from '@/lib/intake/upload-file'
import { resolveTemporaryIntakeContentType } from '@/lib/intake/upload-policy'
import {
  receivedBytes,
  shouldSupersedePending,
  totalBytes,
  type IntakeFileUploadState,
  type IntakeUploadEntry,
} from '@/lib/intake/upload-state'
import { appendHandoffNonce, createHandoffNonce } from '@/lib/mycroft/handoff-claim'
import {
  ackHandoffFiles,
  discardHandoff,
  discardHandoffWithNonce,
  peekHandoff,
  stashHandoff,
  type HandoffFile,
  type HandoffStash,
} from '@/lib/mycroft/upload-handoff'
import { directUploadLimitBytesForMimeType } from '@/lib/storage/upload-limits'

const ACCEPTED_EXTENSIONS = [
  '.pdf',
  '.xlsx',
  '.xls',
  '.csv',
  '.docx',
  '.doc',
  '.pptx',
  '.ppt',
] as const
const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(',')
const DIRECT_UPLOAD_FORMATS = [
  { key: 'pdf', icon: FileText },
  { key: 'excel', icon: FileSpreadsheet },
  { key: 'word', icon: FileType },
  { key: 'powerpoint', icon: Presentation },
  { key: 'csv', icon: Table },
] as const
// Un stash grande en un teléfono tarda, pero termina. Safari 14 tras cerrar pestañas
// no: `indexedDB.open` no dispara ningún evento y el stash nunca resuelve. La
// cota lo suelta; un sobre que se escriba después de ella queda cancelado y se
// borra bajo su propia llave (`stashWithinBudget`), sin dejar residuo.
const STASH_TIMEOUT_MS = 30_000
// Cuánto vive el aviso de «ya está en la lista» antes de irse solo.
const DUPLICATE_NOTICE_MS = 3_000

type MycroftLandingProps = {
  secureHref: string
}

type SelectionError = 'type' | 'size' | 'handoff' | 'destination' | 'name' | null

type TemporaryStageResult =
  { mode: 'MODE_OFF' } | { mode: 'MODE_ON'; received: number; failed: number; cancelled: number }

type UploadSummary = { kind: 'cancelled' | 'partial'; received: number; total: number }

type StageCallbacks = {
  signal: AbortSignal
  onState: (key: string, state: IntakeFileUploadState) => void
  /** Estado con que terminó cada archivo en el intento anterior de esta página. */
  previousStates: Readonly<Record<string, IntakeFileUploadState>>
}

function extensionFor(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex === -1 ? '' : fileName.slice(dotIndex).toLowerCase()
}

function isSupportedFile(file: File): boolean {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(extensionFor(file.name))
}

function isTemporaryIntakeFile(file: File): boolean {
  return resolveTemporaryIntakeContentType(file) !== null
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

/**
 * Una fila de la lista de carga. El `id` es propio y único por ADICIÓN; la
 * identidad de CONTENIDO sigue siendo `fileKey` (nombre:tamaño:lastModified) y
 * es la que decide si un archivo ya está en la lista.
 *
 * Antes la lista usaba `fileKey` como `key` de React: dos filas que compartían
 * clave colapsaban en una sola mientras el conteo seguía diciendo
 * `files.length`. El conteo y las filas ahora salen del MISMO arreglo.
 */
type SelectedIntakeFile = { id: string; file: File }

let intakeFileSequence = 0

function mintIntakeFileId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  intakeFileSequence += 1
  return `intake-file-${intakeFileSequence}`
}

// La respuesta de `/api/intake/session` se leía como `Record<string, unknown>`
// casteado y se le comprobaban dos campos a mano en tres lugares distintos.
// Ahora hay una sola forma declarada: una sesión sirve si está autorizada y
// trae token CSRF, y el token de arranque tiene su propio decodificador.
const isUsableSession = Schema.is(
  Schema.Struct({ authorized: Schema.Literal(true), csrfToken: Schema.String })
)

async function readIntakeResponse(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown
  } catch {
    return {}
  }
}

async function stageTemporaryIntakeFiles(
  files: readonly File[],
  handoffFiles: readonly HandoffFile[],
  identityName: string | undefined,
  { signal, onState, previousStates }: StageCallbacks
): Promise<TemporaryStageResult> {
  const controller = new AbortController()
  const probeTimeout = setTimeout(() => controller.abort(), 2500)
  let sessionResponse: Response
  try {
    sessionResponse = await fetch('/api/intake/session', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
  } finally {
    clearTimeout(probeTimeout)
  }
  if (sessionResponse.status === 404) {
    return { mode: 'MODE_OFF' }
  }
  if (!sessionResponse.ok) throw new TypeError('INTAKE_SESSION_UNAVAILABLE')

  const session = await readIntakeResponse(sessionResponse)
  const bootstrap = Option.getOrNull(decodeCsrfToken(session))
  if (!bootstrap) throw new TypeError('INTAKE_CSRF_UNAVAILABLE')
  let csrfToken = bootstrap.csrfToken
  // Crear la sesión y rotarla con nombre eran dos bloques idénticos salvo el
  // cuerpo: sin sesión se manda el nombre si lo hay, con sesión solo se vuelve
  // a llamar cuando hay nombre que fijar. Es un POST con dos motivos.
  if (!isUsableSession(session) || identityName) {
    const rotated = await fetch('/api/intake/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        [INTAKE_CSRF_HEADER]: csrfToken,
      },
      body: JSON.stringify(identityName ? { name: identityName } : {}),
    })
    if (!rotated.ok) throw new TypeError('INTAKE_SESSION_UNAVAILABLE')
    const next = await readIntakeResponse(rotated)
    if (!isUsableSession(next)) throw new TypeError('INTAKE_SESSION_UNAVAILABLE')
    csrfToken = next.csrfToken
  }

  const handoffIds = new Map(handoffFiles.map(({ id, file }) => [fileKey(file), id]))
  for (const file of files) onState(fileKey(file), { kind: 'queued' })
  let received = 0
  let failed = 0
  let cancelled = 0
  for (const file of files) {
    const key = fileKey(file)
    // Cancelar no toca lo ya recibido: el archivo en vuelo se aborta y los
    // que esperaban en cola quedan cancelados sin pedir intent.
    if (signal.aborted) {
      onState(key, { kind: 'cancelled' })
      cancelled += 1
      continue
    }
    onState(key, { kind: 'hashing' })
    const outcome = await uploadIntakeFile(file, {
      csrfToken,
      signal,
      onProgress: (loaded, total) => onState(key, { kind: 'uploading', loaded, total }),
      supersedePending: shouldSupersedePending(previousStates[key]),
    })
    if (outcome.status === 'received') {
      onState(key, { kind: 'received' })
      received += 1
      const handoffId = handoffIds.get(key)
      // Un ack fallido no vuelve el archivo «no recibido»: los bytes ya están
      // en custodia del servidor. El sobre conserva su copia y la sala la
      // ofrece como pendiente; eso ya pasaba antes, solo que contaba como fallo.
      if (handoffId !== undefined) await ackHandoffFiles([handoffId]).catch(() => false)
      continue
    }
    if (outcome.status === 'cancelled') {
      onState(key, { kind: 'cancelled' })
      cancelled += 1
      continue
    }
    // Los bytes fallidos siguen en IndexedDB y nunca se reconocen como durables.
    onState(key, { kind: 'failed', reason: outcome.reason })
    failed += 1
  }
  return { mode: 'MODE_ON', received, failed, cancelled }
}

// Vencer la cota suelta la continuación, pero no cancela el stash: IndexedDB no
// es abortable. Lo que sí se cancela es su resultado. Un stash que termina tarde
// escribe un sobre que ninguna visita puede reclamar — la continuación ya se fue
// sin llave en la URL — y que la sala tampoco borra (no es suyo). Se borra aquí,
// bajo su propia llave, para no tocar el sobre de un gesto posterior.
function stashWithinBudget(stash: HandoffStash): Promise<boolean | 'TIMEOUT'> {
  return new Promise((resolve) => {
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      resolve('TIMEOUT')
    }, STASH_TIMEOUT_MS)
    void stashHandoff(stash).then(
      (stashed) => {
        clearTimeout(timer)
        if (expired) {
          if (stashed) void discardHandoffWithNonce(stash.nonce)
          return
        }
        resolve(stashed)
      },
      () => {
        clearTimeout(timer)
        if (!expired) resolve(false)
      }
    )
  })
}

export function MycroftLanding({ secureHref }: MycroftLandingProps) {
  const t = useTranslations('mycroft')
  const tProgress = useTranslations('mycroft.intake.progress')
  const inputRef = useRef<HTMLInputElement>(null)
  const companyInputRef = useRef<HTMLInputElement>(null)
  const continuingRef = useRef(false)
  const destinationLookupVersionRef = useRef(0)
  // Tras el aviso, «Subir documentos» confirma el Data Room de la sesión.
  const destinationConfirmedRef = useRef(false)
  // Una señal por gesto de continuar: «Cancelar carga» la aborta y con ella
  // el XHR en vuelo y los fetch de intent y registro.
  const abortRef = useRef<AbortController | null>(null)
  const [files, setFiles] = useState<SelectedIntakeFile[]>([])
  const [companyName, setCompanyName] = useState('')
  const [destinationCompany, setDestinationCompany] = useState<string | null>(null)
  const [selectionError, setSelectionError] = useState<SelectionError>(null)
  const [isDragging, setIsDragging] = useState(false)
  // Preparar muchos megabytes en un teléfono tarda; el botón lo dice sin fingir.
  const [isPreparing, setIsPreparing] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [uploadStates, setUploadStates] = useState<Record<string, IntakeFileUploadState>>({})
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null)
  // Un duplicado no es un error de selección (no hay nada que corregir): se
  // dice en línea y se va solo. El temporizador se cancela al desmontar.
  const [duplicateRejected, setDuplicateRejected] = useState(false)
  const duplicateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const analyticsLocale = 'es' as const

  // El programa de subida llega por chunk aparte para no viajar en el
  // first-load JS. Se pide al montar: cuando el usuario suelta el archivo, el
  // módulo ya está y el gesto no paga la carga.
  useEffect(() => {
    warmUploadIntakeFile()
  }, [])

  // iOS Safari restaura la página desde el bfcache con el estado de React
  // intacto: Atrás desde WorkOS dejaba el botón en "Preparando…" para siempre.
  // Una carga normal ya arranca limpia; solo la restauración necesita el reset.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      // Una carga que quedó en vuelo se aborta de verdad; soltar la referencia
      // sin abortar dejaba el XHR subiendo detrás de un formulario ya libre.
      // La corrida vieja ve que ya no es dueña de `abortRef` y no toca nada.
      abortRef.current?.abort()
      abortRef.current = null
      destinationLookupVersionRef.current += 1
      destinationConfirmedRef.current = false
      setDestinationCompany(null)
      continuingRef.current = false
      setIsPreparing(false)
      setIsCancelling(false)
      setUploadStates({})
    }
    window.addEventListener('pageshow', onPageShow)
    return () => {
      destinationLookupVersionRef.current += 1
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])

  // Los File pelados, para lo que viaja (sobre de continuidad, intake temporal).
  const selectedFiles = useMemo(() => files.map((entry) => entry.file), [files])
  const totalSize = useMemo(
    () => selectedFiles.reduce((total, file) => total + file.size, 0),
    [selectedFiles]
  )
  // Solo los archivos que ya entraron al pipeline tienen estado; antes del
  // gesto de continuar la lista es una selección, no una carga.
  const uploadEntries = useMemo<IntakeUploadEntry[]>(
    () =>
      selectedFiles.flatMap((file) => {
        const key = fileKey(file)
        const state = uploadStates[key]
        return state ? [{ key, file, state }] : []
      }),
    [selectedFiles, uploadStates]
  )
  const isUploading = isPreparing && uploadEntries.length > 0
  const uploadedBytes = receivedBytes(uploadEntries)
  const uploadTotalBytes = totalBytes(uploadEntries)
  const aggregateLabel = tProgress('states.uploading', {
    loaded: formatTransferredBytes(uploadedBytes),
    total: formatFileSize(uploadTotalBytes),
  })

  // El aviso de duplicado vive 3 s y se cancela al desmontar: un temporizador
  // suelto escribiría estado sobre un componente ya ido.
  useEffect(
    () => () => {
      if (duplicateTimerRef.current) clearTimeout(duplicateTimerRef.current)
    },
    []
  )

  const noticeDuplicate = () => {
    if (duplicateTimerRef.current) clearTimeout(duplicateTimerRef.current)
    setDuplicateRejected(true)
    duplicateTimerRef.current = setTimeout(() => {
      duplicateTimerRef.current = null
      setDuplicateRejected(false)
    }, DUPLICATE_NOTICE_MS)
  }

  const resetUploadFeedback = () => {
    setUploadStates({})
    setUploadSummary(null)
  }

  const invalidateDestinationLookup = () => {
    destinationLookupVersionRef.current += 1
    destinationConfirmedRef.current = false
    continuingRef.current = false
  }

  // Mientras el sobre se guarda, la selección es la que va a viajar: cambiarla
  // en ese instante pisaría el flujo en curso con una lista distinta.
  const addFiles = (incoming: File[]) => {
    if (isPreparing) return
    if (incoming.some((file) => !isSupportedFile(file))) {
      setSelectionError('type')
      return
    }
    if (
      incoming.some(
        (file) =>
          file.size >
          directUploadLimitBytesForMimeType(
            extensionFor(file.name) === '.csv' ? 'text/csv' : file.type
          )
      )
    ) {
      setSelectionError('size')
      return
    }

    const seenKeys = new Set(selectedFiles.map(fileKey))
    const uniqueIncoming = incoming.filter((file) => {
      const key = fileKey(file)
      if (seenKeys.has(key)) return false
      seenKeys.add(key)
      return true
    })
    // La deduplicación sigue siendo por contenido; lo nuevo es que el rechazo
    // se ve. Sin este aviso, soltar el mismo archivo otra vez no hacía nada y
    // parecía que la página se había tragado el gesto.
    if (uniqueIncoming.length < incoming.length) noticeDuplicate()
    if (uniqueIncoming.length === 0) return
    const nextCount = files.length + uniqueIncoming.length
    trackSellSideEventOnce(
      'intake_started',
      { locale: analyticsLocale, mode: 'UNRESOLVED' },
      'home'
    )
    trackSellSideEventOnce(
      'files_selected',
      { locale: analyticsLocale, mode: 'UNRESOLVED', fileCount: nextCount },
      `files-${nextCount}`
    )
    invalidateDestinationLookup()
    setFiles((current) => [
      ...current,
      ...uniqueIncoming.map((file) => ({ id: mintIntakeFileId(), file })),
    ])
    setSelectionError(null)
    resetUploadFeedback()
  }

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    addFiles(Array.from(event.dataTransfer.files))
  }

  const resetDestinationNotice = () => {
    destinationConfirmedRef.current = false
    setDestinationCompany(null)
  }

  const removeFile = (id: string) => {
    if (isPreparing) return
    const remaining = files.filter((entry) => entry.id !== id)
    invalidateDestinationLookup()
    setFiles(remaining)
    if (remaining.length === 0) resetDestinationNotice()
    setSelectionError(null)
    resetUploadFeedback()
  }

  const clearFiles = () => {
    if (isPreparing) return
    invalidateDestinationLookup()
    setFiles([])
    resetDestinationNotice()
    setSelectionError(null)
    resetUploadFeedback()
  }

  const cancelUpload = () => {
    const controller = abortRef.current
    if (!controller || controller.signal.aborted) return
    setIsCancelling(true)
    controller.abort()
  }

  const onContinue = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (files.length === 0) return
    event.preventDefault()
    // El nombre ya no es opcional: sin él no hay destino que buscar ni sobre
    // que guardar. La inferencia desde documentos sigue para MCP y salas.
    if (companyName.trim() === '') {
      setSelectionError('name')
      companyInputRef.current?.focus()
      return
    }
    if (destinationCompany) return
    const modifiedClick =
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0
    if (!destinationConfirmedRef.current) {
      if (continuingRef.current) return
      continuingRef.current = true
      setSelectionError(null)
      const lookupVersion = ++destinationLookupVersionRef.current
      void readLandingDestination().then((destination) => {
        if (lookupVersion !== destinationLookupVersionRef.current) return
        continuingRef.current = false
        if (destination.status === 'FOUND') {
          setDestinationCompany(destination.companyName)
          return
        }
        if (destination.status === 'UNAVAILABLE') {
          setSelectionError('destination')
          return
        }
        return beginContinuation(modifiedClick)
      })
      return
    }
    beginContinuation(modifiedClick)
  }

  const confirmDestinationUpload = () => {
    if (companyName.trim() === '') {
      setSelectionError('name')
      companyInputRef.current?.focus()
      return
    }
    destinationConfirmedRef.current = true
    setDestinationCompany(null)
    beginContinuation(false)
  }

  const beginContinuation = (modifiedClick: boolean) => {
    // La llave del sobre: se guarda con él y viaja dentro del returnTo, así que
    // la sala que la lee en su URL es esta misma visita. No es un token ni una
    // autoridad: sin el sobre en IndexedDB no abre nada.
    const nonce = createHandoffNonce()
    const claimHref = appendHandoffNonce(secureHref, nonce)
    const parkedName = companyName.trim() || null
    if (continuingRef.current) return
    continuingRef.current = true
    // Reservar la pestaña dentro del gesto evita el bloqueo tras esperar IndexedDB.
    // about:blank no ejecuta contenido externo y pierde su opener inmediatamente.
    const parkedWindow = modifiedClick ? window.open('about:blank', '_blank') : null
    if (parkedWindow) parkedWindow.opener = null
    const controller = new AbortController()
    abortRef.current = controller
    const navigate = (href: string) => {
      if (parkedWindow && !parkedWindow.closed) {
        parkedWindow.location.replace(href)
        setIsPreparing(false)
        continuingRef.current = false
      } else {
        window.location.assign(href)
      }
    }
    // Lo que quedó del intento anterior decide qué archivos pueden pedirle al
    // servidor que supersede su intent; se captura antes de limpiar la lista.
    const previousStates = uploadStates
    setSelectionError(null)
    setIsCancelling(false)
    resetUploadFeedback()
    setIsPreparing(true)
    // La corrida es dueña del formulario solo mientras `abortRef` sea su
    // señal. Una restauración desde el bfcache la aborta y suelta el
    // formulario; si el cliente vuelve a pulsar Siguiente, la corrida nueva
    // toma `abortRef` y esta, al terminar tarde, no pinta ni libera nada.
    const ownsForm = () => abortRef.current === controller
    // Soltar el formulario sin navegar deja sin destino la pestaña reservada
    // en el gesto: se cierra, igual que al abandonar por un error de selección.
    // La pestaña es de esta corrida aunque el formulario ya no lo sea.
    const releaseForm = () => {
      parkedWindow?.close()
      if (!ownsForm()) return
      destinationConfirmedRef.current = false
      setIsPreparing(false)
      setIsCancelling(false)
      continuingRef.current = false
    }
    const abandonContinuation = (error: SelectionError) => {
      if (!ownsForm()) return
      setSelectionError(error)
      releaseForm()
    }
    const onState = (key: string, state: IntakeFileUploadState) => {
      if (!ownsForm()) return
      setUploadStates((current) => ({ ...current, [key]: state }))
    }
    void (async () => {
      // IndexedDB is recovery only. Mode-on uploads establish server custody
      // directly; mode-off preserves the existing hosted WorkOS continuation.
      // Both end at the same hosted sign-up: [F] 2026-09-01 (DECISIONS) makes the
      // page after this button the client's own room, never a second intake screen.
      //
      // El stash se espera, no se corre contra un reloj: una carrera perdida
      // dejaba al intake con la lista vacía y al stash terminando después, así
      // que los mismos bytes llegaban a la sala dos veces — por el claim y por
      // el handoff — porque el ingest no dedupea por sha. Un solo camino.
      const stashOutcome = await stashWithinBudget({
        files: selectedFiles,
        companyName: parkedName,
        nonce,
      })
      // El bfcache pudo soltar el formulario mientras el sobre se guardaba.
      if (!ownsForm()) return
      const stashed = stashOutcome === true
      // Si el navegador de verdad no pudo guardar nada, un sobre anterior sigue
      // vivo en IndexedDB: se tira para que ninguna visita posterior lo aplique.
      // Con IndexedDB colgado el descarte colgaría igual: se dispara sin esperar.
      if (stashOutcome === 'TIMEOUT') void discardHandoff()
      else if (!stashed) await discardHandoff()
      // Sin sobre no hay llave que presentar: la sala no tiene nada que reclamar.
      const continueHref = stashed ? claimHref : secureHref
      const handoff = stashed ? await peekHandoff() : { status: 'UNAVAILABLE' as const, files: [] }
      try {
        // A MIME mismatch can make a selected extension ineligible for temporary
        // intake. Preserve the whole batch for the permanent workflow rather than
        // silently splitting custody across two lanes.
        if (selectedFiles.some((file) => !isTemporaryIntakeFile(file))) {
          if (!stashed) {
            abandonContinuation('handoff')
            return
          }
          navigate(continueHref)
          return
        }
        const result = await stageTemporaryIntakeFiles(
          selectedFiles,
          handoff.files,
          companyName.trim() || undefined,
          { signal: controller.signal, onState, previousStates }
        )
        // Una restauración desde el bfcache abortó esta corrida y ya la soltó:
        // ni resumen, ni analítica, ni navegación por su cuenta.
        if (!ownsForm()) return
        if (result.mode === 'MODE_OFF') {
          if (!stashed) {
            abandonContinuation('handoff')
            return
          }
          navigate(continueHref)
          return
        }
        if (result.received > 0) {
          trackSellSideEventOnce(
            'first_durable_upload',
            {
              locale: analyticsLocale,
              mode: 'TEMPORARY',
              fileCount: result.received,
            },
            'temporary'
          )
        }
        // Cancelar preserva lo recibido: el resumen dice cuántos quedaron
        // guardados y la selección sigue aquí para reintentar el resto.
        if (result.cancelled > 0) {
          setUploadSummary({ kind: 'cancelled', received: result.received, total: files.length })
          releaseForm()
          return
        }
        // Con fallos y sin sobre, el resumen con la cuenta es la única voz: el
        // alert genérico de «algunos sí, otros no» decía lo mismo sin números.
        if (result.failed > 0 && !stashed) {
          setUploadSummary({ kind: 'partial', received: result.received, total: files.length })
          releaseForm()
          return
        }
        navigate(continueHref)
      } catch {
        // A mode probe or staging outage must not weaken the default permanent
        // path; the unacknowledged selection remains available after WorkOS.
        if (!ownsForm()) return
        if (stashed) {
          navigate(continueHref)
          return
        }
        abandonContinuation('handoff')
      }
    })()
  }

  const errorMessage = selectionError ? t(`intake.errors.${selectionError}`) : null
  // El nombre vacío se avisa junto a su campo; en la cámara quedan los errores de archivos.
  const nameError = selectionError === 'name' ? errorMessage : null
  const fileError = selectionError === 'name' ? null : errorMessage

  const hasSelection = files.length > 0

  return (
    <div className={styles.landing}>
      <section data-testid="landing-hero">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-7">
              <h1 className={styles.title} data-testid="landing-hero-title">
                <span className={styles.titleInk}>{t('hero.title')}</span>
              </h1>
              <div id="intake" data-testid="mycroft-upload-dossier" className="mt-3 scroll-mt-24">
                <div className="space-y-2">
                  <label htmlFor="mycroft-company-name" className="text-sm font-medium">
                    {t('intake.companyLabel')}
                  </label>
                  <input
                    id="mycroft-company-name"
                    ref={companyInputRef}
                    type="text"
                    value={companyName}
                    maxLength={120}
                    autoComplete="organization"
                    placeholder={t('intake.companyPlaceholder')}
                    disabled={isPreparing}
                    required
                    aria-required="true"
                    aria-invalid={selectionError === 'name' || undefined}
                    aria-describedby={
                      selectionError === 'name' ? 'mycroft-company-name-error' : undefined
                    }
                    onChange={(event) => {
                      invalidateDestinationLookup()
                      setCompanyName(event.target.value)
                      if (selectionError === 'name') setSelectionError(null)
                    }}
                    className="border-input bg-background focus-visible:ring-ring h-11 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2"
                  />
                  {nameError ? (
                    <p
                      id="mycroft-company-name-error"
                      role="alert"
                      className="text-destructive flex items-center gap-2 text-sm"
                    >
                      <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
                      {nameError}
                    </p>
                  ) : null}
                </div>

                <input
                  ref={inputRef}
                  className="sr-only"
                  type="file"
                  accept={ACCEPT_ATTRIBUTE}
                  multiple
                  tabIndex={-1}
                  disabled={isPreparing}
                  onChange={onInputChange}
                  aria-label={t('intake.select')}
                />

                <div className="dark:border-border mt-3 grid overflow-hidden rounded-md border border-[color-mix(in_srgb,var(--brand-cream)_15%,transparent)] sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                  <div
                    className={`min-w-0 bg-[var(--brand-burgundy)] p-4 text-[var(--brand-cream)] ${
                      isDragging
                        ? 'outline-2 outline-offset-2 outline-[var(--brand-ochre)] outline-dashed'
                        : ''
                    }`}
                    onDragEnter={(event) => {
                      event.preventDefault()
                      setIsDragging(true)
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={onDrop}
                  >
                    <div className="flex flex-col gap-3">
                      <p className="text-sm font-medium">{t('intake.drop')}</p>
                      <Button
                        type="button"
                        variant="ochre"
                        size="lg"
                        className="min-h-11 w-full self-start sm:w-auto"
                        disabled={isPreparing}
                        onClick={() => inputRef.current?.click()}
                      >
                        {t('intake.select')}
                      </Button>
                      <ul
                        aria-label={t('intake.formatListLabel')}
                        className="flex flex-wrap gap-x-3 gap-y-2"
                      >
                        {DIRECT_UPLOAD_FORMATS.map(({ key, icon: Icon }) => (
                          <li key={key} className="flex items-center gap-1 text-xs">
                            <Icon className="size-4" aria-hidden="true" />
                            {t(`intake.formatNames.${key}`)}
                          </li>
                        ))}
                      </ul>
                    </div>

                    {fileError ? (
                      <p className="mt-4 flex items-start gap-2 text-sm" role="alert">
                        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                        {fileError}
                      </p>
                    ) : null}

                    {hasSelection ? (
                      <div className="mt-4 border-t border-[color-mix(in_srgb,var(--brand-cream)_15%,transparent)] pt-4">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold">
                            {t('intake.selected', { count: files.length })}
                          </p>
                          <button
                            type="button"
                            className="min-h-8 rounded-sm px-2 text-xs text-[color-mix(in_srgb,var(--brand-cream)_80%,transparent)] underline-offset-4 hover:text-[var(--brand-cream)] hover:underline focus-visible:ring-2 focus-visible:ring-[var(--brand-ochre)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={isPreparing}
                            onClick={clearFiles}
                          >
                            {t('intake.clear')}
                          </button>
                        </div>

                        {duplicateRejected ? (
                          <p
                            role="status"
                            data-testid="intake-duplicate-notice"
                            className="mt-2 text-sm text-[color-mix(in_srgb,var(--brand-cream)_80%,transparent)]"
                          >
                            {t('intake.duplicate')}
                          </p>
                        ) : null}

                        {uploadSummary ? (
                          <p
                            role="status"
                            className="mt-3 text-sm text-[color-mix(in_srgb,var(--brand-cream)_80%,transparent)]"
                          >
                            {t(`intake.progress.${uploadSummary.kind}Summary`, {
                              received: uploadSummary.received,
                              total: uploadSummary.total,
                            })}
                          </p>
                        ) : null}

                        {isUploading ? (
                          <div className="mt-3">
                            <div className="flex items-center justify-between gap-3">
                              <p className="font-data text-xs text-[color-mix(in_srgb,var(--brand-cream)_80%,transparent)]">
                                {aggregateLabel}
                              </p>
                              <button
                                type="button"
                                className="min-h-8 rounded-sm px-2 text-xs text-[color-mix(in_srgb,var(--brand-cream)_80%,transparent)] underline-offset-4 hover:text-[var(--brand-cream)] hover:underline focus-visible:ring-2 focus-visible:ring-[var(--brand-ochre)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                                disabled={isCancelling}
                                onClick={cancelUpload}
                              >
                                {tProgress('cancel')}
                              </button>
                            </div>
                            <IntakeUploadProgressBar
                              loaded={uploadedBytes}
                              total={uploadTotalBytes}
                              label={aggregateLabel}
                              className="mt-2 bg-[color-mix(in_srgb,var(--brand-cream)_25%,transparent)] [&>div]:bg-[var(--brand-ochre)] [&>div]:transition-none"
                            />
                          </div>
                        ) : null}

                        {/* El progreso por bytes cambia decenas de veces por segundo: la
                        lista no se anuncia; el resumen y el conteo de arriba sí. */}
                        <ul
                          className="mt-3 max-h-44 overflow-y-auto border-t border-[color-mix(in_srgb,var(--brand-cream)_15%,transparent)]"
                          aria-label={t('intake.fileList')}
                          aria-live="off"
                        >
                          {files.map(({ id, file }) => {
                            const state = uploadStates[fileKey(file)]
                            return (
                              <li
                                key={id}
                                className="border-b border-[color-mix(in_srgb,var(--brand-cream)_15%,transparent)] py-2"
                              >
                                <div className="flex min-w-0 items-center gap-3">
                                  <FileText className="h-4 w-4 shrink-0 text-[var(--brand-cream)]" />
                                  <span className="min-w-0 flex-1 truncate text-left text-sm">
                                    {file.name}
                                  </span>
                                  {state ? (
                                    <span className="font-data shrink-0 text-xs text-[color-mix(in_srgb,var(--brand-cream)_80%,transparent)]">
                                      {uploadStateLabel(tProgress, state)}
                                    </span>
                                  ) : null}
                                  <span className="font-data shrink-0 text-xs text-[color-mix(in_srgb,var(--brand-cream)_80%,transparent)]">
                                    {formatFileSize(file.size)}
                                  </span>
                                  <button
                                    type="button"
                                    className="flex size-8 shrink-0 items-center justify-center rounded-sm text-[color-mix(in_srgb,var(--brand-cream)_80%,transparent)] hover:text-[var(--brand-cream)] focus-visible:ring-2 focus-visible:ring-[var(--brand-ochre)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                                    disabled={isPreparing}
                                    onClick={() => removeFile(id)}
                                    aria-label={t('intake.remove', { name: file.name })}
                                  >
                                    <X className="h-4 w-4" />
                                  </button>
                                </div>
                                {state?.kind === 'uploading' ? (
                                  <IntakeUploadProgressBar
                                    loaded={state.loaded}
                                    total={state.total}
                                    label={file.name}
                                    className="mt-2 ml-7 bg-[color-mix(in_srgb,var(--brand-cream)_25%,transparent)] [&>div]:bg-[var(--brand-ochre)] [&>div]:transition-none"
                                  />
                                ) : null}
                              </li>
                            )
                          })}
                        </ul>

                        <div className="mt-4 flex flex-col gap-3">
                          <p className="font-data text-xs text-[color-mix(in_srgb,var(--brand-cream)_80%,transparent)]">
                            {t('intake.total', { size: formatFileSize(totalSize) })}
                          </p>
                          {destinationCompany ? null : (
                            <Button
                              asChild
                              variant="ochre"
                              size="lg"
                              className="min-h-11 w-full sm:w-auto"
                            >
                              <a
                                href={secureHref}
                                onClick={onContinue}
                                aria-busy={isPreparing || undefined}
                              >
                                {isPreparing ? t('intake.preparing') : t('intake.continue')}
                                {isPreparing ? null : <ArrowRight className="h-4 w-4" />}
                              </a>
                            </Button>
                          )}
                        </div>
                        {destinationCompany ? (
                          <div
                            className="mt-4 border-t border-[color-mix(in_srgb,var(--brand-cream)_15%,transparent)] pt-4"
                            data-testid="landing-destination-notice"
                            role="status"
                          >
                            <p className="text-sm leading-relaxed text-balance">
                              {t('intake.destination.notice', { company: destinationCompany })}
                            </p>
                            <div className="mt-3 flex flex-col gap-2">
                              <Button
                                type="button"
                                variant="ochre"
                                size="lg"
                                className="min-h-11 w-full sm:w-auto"
                                onClick={confirmDestinationUpload}
                              >
                                {t('intake.destination.upload')}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="lg"
                                className="min-h-11 w-full border-[var(--brand-cream)] bg-transparent text-[var(--brand-cream)] hover:bg-[var(--brand-cream)] hover:text-[var(--brand-navy)]"
                                onClick={() => window.location.assign('/logout')}
                              >
                                {t('intake.destination.signOut')}
                              </Button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <LandingAgentPanel />
                </div>
              </div>
            </div>
            <div className="lg:col-span-5">
              <LandingDocumentStack />
            </div>
          </div>
        </div>
      </section>
      <LandingDetails />
    </div>
  )
}
