'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Effect, Option, Schema } from 'effect'

import { runClientEffect } from '@/lib/effect/client-runtime'
import type { IntakeWorkspaceView } from '@/lib/intake/session'
import type { IntakeSupportMessage } from '@/lib/intake/support'
import { INTAKE_CSRF_HEADER } from '@/lib/intake/config'
import { formatFileSize, formatTransferredBytes } from '@/lib/intake/file-size'
import { uploadIntakeFile, warmUploadIntakeFile } from '@/lib/intake/upload-file'
import {
  fileFingerprint,
  isTerminal,
  previousStatesByFingerprint,
  receivedBytes,
  shouldSupersedePending,
  totalBytes,
  type IntakeFileUploadState,
  type IntakeUploadEntry,
  type IntakeUploadFailureReason,
} from '@/lib/intake/upload-state'
import { Link } from '@/i18n/navigation'
import { ackHandoffFiles, peekHandoff, type HandoffFile } from '@/lib/mycroft/upload-handoff'
import { decodeCsrfToken } from '@/components/mycroft/decode-csrf-token'
import {
  IntakeUploadProgressBar,
  uploadStateLabel,
} from '@/components/mycroft/IntakeUploadProgress'
import { IntakeWorkspaceSignal } from '@/components/mycroft/IntakeWorkspaceSignal'
import { formatDateTime } from '@/lib/utils'

type IntakeWorkspaceProps = {
  initialWorkspace: IntakeWorkspaceView | null
}

// ===== LA COSTURA CON EFFECT =====
// Todo lo que este componente sabe del servidor entra por `/api/intake/*`. Lo
// leia como un solo tipo con todos los campos opcionales que describia cinco
// respuestas distintas a la vez, y del que se sacaban campos a fuerza de
// casteo. Ahora cada respuesta tiene su schema y el casteo no existe.
//
// El evaluado, ademas, se validaba a mano con una lista de categorias copiada
// del tipo de `lib/intake/session.ts`: dos definiciones de la misma regla que
// coincidian por cuidado de quien las editara. La lista ahora es del schema.

const safeInteger = Schema.Int.pipe(
  Schema.check(Schema.makeFilter(Number.isSafeInteger, { title: 'safeInteger' }))
)

const intakeDocumentSchema = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  declaredMimeType: Schema.String,
  byteSize: Schema.Number,
  inspectionStatus: Schema.Literals(['CLEAN', 'NOT_CONFIGURED', 'UNINSPECTED', 'SUSPICIOUS']),
  claimable: Schema.Boolean,
  createdAt: Schema.Number,
})

const intakeAssessmentSchema = Schema.Struct({
  id: Schema.String,
  intakeSessionId: Schema.String,
  status: Schema.Literals(['PENDING', 'NEEDS_REVIEW', 'READY']),
  source: Schema.Literals(['TEAM', 'EXTERNAL']),
  findings: Schema.optionalKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          category: Schema.Literals([
            'financialStatements',
            'notes',
            'businessExplanation',
            'language',
            'businessModel',
            'pitch',
            'teaserCim',
            'loanPaymentTape',
            'financialModel',
            'portfolioDetail',
            'legalDetail',
            'country',
          ]),
          evidenceDocumentIds: Schema.mutable(Schema.Array(Schema.String)),
          confidence: Schema.Finite.pipe(
            Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))
          ),
          reviewState: Schema.Literals(['PENDING', 'CONFIRMED', 'REJECTED']),
        })
      )
    )
  ),
  createdAt: safeInteger,
  updatedAt: safeInteger,
})

// El cuerpo de una sesion autorizada. `documents` y `assessment` los proyecta
// el servidor con reglas MAS estrictas que estas (largos y rangos incluidos),
// asi que nada que el emita se cae aca: lo que este schema quita es el casteo.
const authorizedSessionSchema = Schema.Struct({
  authorized: Schema.Literal(true),
  documents: Schema.mutable(Schema.Array(intakeDocumentSchema)),
  accessExpiresAt: Schema.optionalKey(Schema.Number),
  identityName: Schema.optionalKey(Schema.String),
  assessment: Schema.optionalKey(Schema.NullOr(intakeAssessmentSchema)),
})

// `Id<'supportMessages'>` es un `string` con la marca de Convex encima: el
// schema valida lo que hay en el cable y el tipo conserva la marca.
const supportMessageSchema = Schema.Struct({
  messageId: Schema.declare(
    (value: unknown): value is IntakeSupportMessage['messageId'] => typeof value === 'string'
  ),
  sequence: Schema.Number,
  authorKind: Schema.Literals(['COMPANY', 'ADMIN', 'INTAKE']),
  body: Schema.String,
  createdAt: Schema.Number,
})

const decodeAuthorizedSession = Schema.decodeUnknownOption(authorizedSessionSchema)
const decodeUnauthorizedSession = Schema.decodeUnknownOption(
  Schema.Struct({
    authorized: Schema.Literal(false),
    retainedOnly: Schema.optionalKey(Schema.Boolean),
  })
)
const decodeSupportMessages = Schema.decodeUnknownOption(
  Schema.Struct({ messages: Schema.mutable(Schema.Array(supportMessageSchema)) })
)
const decodeSupportMessage = Schema.decodeUnknownOption(
  Schema.Struct({ message: supportMessageSchema })
)

type IntakeResponse = { readonly ok: boolean; readonly status: number; readonly body: unknown }

/** Un fallo de red o un cuerpo ilegible: el unico error que la UI distingue. */
class IntakeRequestError extends Schema.TaggedError<IntakeRequestError>()('IntakeRequestError', {
  path: Schema.String,
}) {}

const intakeRequest = Effect.fn('Intake.request')(function* (
  path: string,
  init: RequestInit
): Effect.fn.Return<IntakeResponse, IntakeRequestError> {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init, signal }),
    catch: () => new IntakeRequestError({ path }),
  })
  // Un cuerpo que no es JSON no necesita rama propia: `{}` no pasa ningun
  // schema, asi que cae en el mismo camino generico de siempre.
  const body = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: () => new IntakeRequestError({ path }),
  }).pipe(Effect.orElseSucceed((): unknown => ({})))
  return { ok: response.ok, status: response.status, body }
})

function workspaceFrom(body: unknown, fallbackIdentityName?: string): IntakeWorkspaceView | null {
  const session = Option.getOrNull(decodeAuthorizedSession(body))
  if (!session) return null
  const assessment = session.assessment
  return {
    authorized: true,
    accessExpiresAt: session.accessExpiresAt,
    identityName: session.identityName ?? fallbackIdentityName,
    documents: session.documents,
    // Un evaluado sin hallazgos llega sin la clave; la sala pinta una lista.
    assessment: assessment ? { ...assessment, findings: assessment.findings ?? [] } : null,
  }
}

function batchKey(file: File, index: number): string {
  return `${index}:${file.name}:${file.size}:${file.lastModified}`
}

export function IntakeWorkspace({ initialWorkspace }: IntakeWorkspaceProps) {
  const locale = useLocale()
  const t = useTranslations('intakeWorkspace')
  const tProgress = useTranslations('intakeWorkspace.progress')
  const genericError = t('genericError')
  // Tipo y tamaño son fallos que el cliente puede corregir y se nombran; el
  // resto se resume sin filtrar nada del proveedor.
  const failureNotice = (reason: IntakeUploadFailureReason) => {
    if (reason === 'size') return t('uploadErrors.size')
    if (reason === 'type') return t('uploadErrors.type')
    return genericError
  }
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Una señal por carga: «Cancelar carga» aborta el XHR en vuelo y los fetch
  // de intent y registro del archivo que va; la cola queda cancelada.
  const uploadAbortRef = useRef<AbortController | null>(null)
  // Estado con que terminó cada archivo pendiente del sobre en su último
  // reintento: decide si el siguiente puede pedir que se supersede su intent.
  const handoffOutcomesRef = useRef(new Map<number, IntakeFileUploadState>())
  const [workspace, setWorkspace] = useState<IntakeWorkspaceView | null>(initialWorkspace)
  const [csrfToken, setCsrfToken] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [pendingFiles, setPendingFiles] = useState<HandoffFile[]>([])
  const [pendingFileId, setPendingFileId] = useState<number | null>(null)
  const [pendingFileState, setPendingFileState] = useState<IntakeFileUploadState | null>(null)
  const [batch, setBatch] = useState<IntakeUploadEntry[]>([])
  const [isCancelling, setIsCancelling] = useState(false)
  const [retainedOnly, setRetainedOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [supportMessages, setSupportMessages] = useState<IntakeSupportMessage[]>([])
  const [supportBody, setSupportBody] = useState('')
  const [supportBusy, setSupportBusy] = useState(false)
  const accessExpiry = workspace?.accessExpiresAt
    ? formatDateTime(workspace.accessExpiresAt, locale)
    : null

  const refresh = useCallback(async () => {
    const { ok, body } = await runClientEffect(
      intakeRequest('/api/intake/session', { method: 'GET' })
    )
    const csrf = Option.getOrNull(decodeCsrfToken(body))
    if (csrf) setCsrfToken(csrf.csrfToken)
    const projectedWorkspace = workspaceFrom(body)
    if (ok && projectedWorkspace) {
      setRetainedOnly(false)
      setWorkspace(projectedWorkspace)
      return
    }
    const ended = ok ? Option.getOrNull(decodeUnauthorizedSession(body)) : null
    if (!ended) throw new TypeError('INTAKE_REFRESH_FAILED')
    setRetainedOnly(ended.retainedOnly === true)
    setWorkspace(null)
    setPendingFiles([])
    setSupportMessages([])
  }, [])

  const refreshHandoff = useCallback(async () => {
    const handoff = await peekHandoff()
    setPendingFiles(handoff.status === 'READY' ? handoff.files : [])
  }, [])

  const refreshSupport = useCallback(async () => {
    const { ok, body } = await runClientEffect(
      intakeRequest('/api/intake/support', { method: 'GET' })
    )
    const thread = ok ? Option.getOrNull(decodeSupportMessages(body)) : null
    if (!thread) throw new TypeError('INTAKE_SUPPORT_FAILED')
    setSupportMessages(thread.messages)
  }, [])

  // El programa de subida llega por chunk aparte para no viajar en el
  // first-load JS. Se pide al montar: cuando el usuario suelta el archivo, el
  // módulo ya está y el gesto no paga la carga.
  useEffect(() => {
    warmUploadIntakeFile()
  }, [])

  useEffect(() => {
    void refresh().catch(() => setNotice(genericError))
  }, [genericError, refresh])

  useEffect(() => {
    if (!workspace?.authorized) return
    void refreshSupport().catch(() => setNotice(genericError))
  }, [genericError, refreshSupport, workspace?.authorized])

  useEffect(() => {
    if (!workspace?.authorized) {
      setPendingFiles([])
      return
    }
    void refreshHandoff().catch(() => setNotice(genericError))
  }, [genericError, refreshHandoff, workspace?.authorized])

  const startSession = async (identityName?: string) => {
    if (!csrfToken) return
    const normalizedIdentityName = identityName?.trim() || undefined
    setBusy(true)
    setNotice(null)
    const started = await runClientEffect(
      intakeRequest('/api/intake/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INTAKE_CSRF_HEADER]: csrfToken,
        },
        body: JSON.stringify(normalizedIdentityName ? { name: normalizedIdentityName } : {}),
      }).pipe(Effect.orElseSucceed((): IntakeResponse | null => null))
    )
    setBusy(false)
    const projectedWorkspace =
      started && started.ok ? workspaceFrom(started.body, normalizedIdentityName) : null
    if (!started || !projectedWorkspace) {
      setNotice(genericError)
      return
    }
    const csrf = Option.getOrNull(decodeCsrfToken(started.body))
    if (csrf) setCsrfToken(csrf.csrfToken)
    setRetainedOnly(false)
    setWorkspace(projectedWorkspace)
  }

  const cancelUpload = () => {
    const controller = uploadAbortRef.current
    if (!controller || controller.signal.aborted) return
    setIsCancelling(true)
    controller.abort()
  }

  const uploadFiles = async () => {
    const files = Array.from(fileInputRef.current?.files ?? [])
    if (!csrfToken || files.length === 0) return
    const controller = new AbortController()
    uploadAbortRef.current = controller
    // Lo que quedó del lote anterior decide qué archivos pueden pedirle al
    // servidor que supersede su intent. Se busca por huella del archivo, no
    // por key de fila: si entre cancelar y reintentar el cliente agrega o
    // quita archivos, el mismo PDF cambia de índice y aun así tiene que
    // mandar el flag (F13, auditoría 2026-09-06).
    const previousStates = previousStatesByFingerprint(batch)
    const entries: IntakeUploadEntry[] = files.map((file, index) => ({
      key: batchKey(file, index),
      file,
      state: { kind: 'queued' },
    }))
    const setEntryState = (key: string, state: IntakeFileUploadState) =>
      setBatch((current) =>
        current.map((entry) => (entry.key === key ? { ...entry, state } : entry))
      )
    setBatch(entries)
    setIsCancelling(false)
    setBusy(true)
    setNotice(null)
    let received = 0
    let cancelled = 0
    const reasons: IntakeUploadFailureReason[] = []
    try {
      for (const { key, file } of entries) {
        // Cancelar no toca lo ya recibido: el archivo en vuelo se aborta y
        // los que esperaban en cola quedan cancelados sin pedir intent.
        if (controller.signal.aborted) {
          setEntryState(key, { kind: 'cancelled' })
          cancelled += 1
          continue
        }
        setEntryState(key, { kind: 'hashing' })
        const outcome = await uploadIntakeFile(file, {
          csrfToken,
          signal: controller.signal,
          onProgress: (loaded, total) => setEntryState(key, { kind: 'uploading', loaded, total }),
          supersedePending: shouldSupersedePending(previousStates.get(fileFingerprint(file))),
        })
        if (outcome.status === 'received') {
          setEntryState(key, { kind: 'received' })
          received += 1
        } else if (outcome.status === 'cancelled') {
          setEntryState(key, { kind: 'cancelled' })
          cancelled += 1
        } else {
          setEntryState(key, { kind: 'failed', reason: outcome.reason })
          reasons.push(outcome.reason)
        }
      }
      if (received > 0) await refresh()
      if (cancelled > 0) {
        setNotice(tProgress('cancelledSummary', { received, total: entries.length }))
      } else if (reasons.includes('size')) {
        setNotice(t('uploadErrors.size'))
      } else if (reasons.includes('type')) {
        setNotice(t('uploadErrors.type'))
      } else if (reasons.length > 0) {
        setNotice(tProgress('partialSummary', { received, total: entries.length }))
      } else {
        // Todo llegó: el lote ya se ve en la lista de documentos y el
        // selector queda libre. Con fallos, la selección sigue para reintentar.
        setBatch([])
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    } catch {
      setNotice(genericError)
    } finally {
      uploadAbortRef.current = null
      setIsCancelling(false)
      setBusy(false)
    }
  }

  const retryHandoffFile = async (handoff: HandoffFile) => {
    if (!csrfToken || pendingFileId !== null) return
    const controller = new AbortController()
    uploadAbortRef.current = controller
    setPendingFileId(handoff.id)
    setPendingFileState({ kind: 'hashing' })
    setIsCancelling(false)
    setBusy(true)
    setNotice(null)
    try {
      const outcome = await uploadIntakeFile(handoff.file, {
        csrfToken,
        signal: controller.signal,
        onProgress: (loaded, total) => setPendingFileState({ kind: 'uploading', loaded, total }),
        supersedePending: shouldSupersedePending(handoffOutcomesRef.current.get(handoff.id)),
      })
      handoffOutcomesRef.current.set(
        handoff.id,
        outcome.status === 'received'
          ? { kind: 'received' }
          : outcome.status === 'cancelled'
            ? { kind: 'cancelled' }
            : { kind: 'failed', reason: outcome.reason }
      )
      if (outcome.status === 'received') {
        setPendingFileState({ kind: 'received' })
        if (!(await ackHandoffFiles([handoff.id]))) throw new TypeError('INTAKE_HANDOFF_ACK_FAILED')
        setPendingFiles((current) => current.filter(({ id }) => id !== handoff.id))
        await refresh()
      } else if (outcome.status === 'failed') {
        setNotice(failureNotice(outcome.reason))
      }
      // Cancelado: el archivo sigue pendiente, sin aviso que corregir.
    } catch {
      setNotice(genericError)
    } finally {
      uploadAbortRef.current = null
      setPendingFileId(null)
      setPendingFileState(null)
      setIsCancelling(false)
      setBusy(false)
    }
  }

  const isUploadingBatch = busy && batch.some((entry) => !isTerminal(entry.state))
  const isRetryingHandoff = busy && pendingFileId !== null
  const batchLabel = tProgress('states.uploading', {
    loaded: formatTransferredBytes(receivedBytes(batch)),
    total: formatFileSize(totalBytes(batch)),
  })

  const removeHandoffFile = async (handoff: HandoffFile) => {
    if (pendingFileId !== null) return
    setPendingFileId(handoff.id)
    setNotice(null)
    try {
      if (!(await ackHandoffFiles([handoff.id])))
        throw new TypeError('INTAKE_HANDOFF_REMOVE_FAILED')
      setPendingFiles((current) => current.filter(({ id }) => id !== handoff.id))
    } catch {
      setNotice(genericError)
    } finally {
      setPendingFileId(null)
    }
  }

  const assessment = workspace?.authorized ? workspace.assessment : undefined
  const assessmentNextActionNeedsSupport = assessment?.status === 'NEEDS_REVIEW'

  const sendSupportMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const body = supportBody.trim()
    if (!csrfToken || !body || supportBusy) return
    setSupportBusy(true)
    setNotice(null)
    const sent = await runClientEffect(
      intakeRequest('/api/intake/support', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INTAKE_CSRF_HEADER]: csrfToken,
        },
        body: JSON.stringify({ body }),
      }).pipe(Effect.orElseSucceed((): IntakeResponse | null => null))
    )
    setSupportBusy(false)
    const accepted = sent?.ok ? Option.getOrNull(decodeSupportMessage(sent.body)) : null
    if (!accepted) {
      setNotice(t('support.sendError'))
      return
    }
    setSupportMessages((current) => [...current, accepted.message])
    setSupportBody('')
  }

  const closeOrDelete = async (path: '/api/intake/session' | '/api/intake/data') => {
    if (!csrfToken) return
    setBusy(true)
    setNotice(null)
    const closed = await runClientEffect(
      intakeRequest(path, {
        method: 'DELETE',
        headers: { [INTAKE_CSRF_HEADER]: csrfToken },
      }).pipe(Effect.orElseSucceed((): IntakeResponse | null => null))
    )
    setBusy(false)
    if (!closed?.ok) {
      setNotice(genericError)
      return
    }
    const deleting = path === '/api/intake/data'
    setWorkspace(null)
    setRetainedOnly(!deleting)
    if (deleting) setCsrfToken(null)
    setSupportMessages([])
    setSupportBody('')
    setNotice(deleting ? t('deleted') : t('ended'))
  }

  return (
    <div className="bg-background text-foreground px-4 py-6 sm:px-6">
      <section className="mx-auto max-w-3xl">
        <p className="text-muted-foreground text-sm font-medium tracking-wide uppercase">
          {t('eyebrow')}
        </p>
        <h1 className="mt-2">{t('title')}</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl text-base leading-7">{t('intro')}</p>

        {notice ? (
          <p className="border-border bg-muted mt-6 border p-3 text-sm" role="status">
            {notice}
          </p>
        ) : null}

        {!workspace?.authorized ? (
          retainedOnly ? (
            <div className="mt-8 space-y-4">
              <p className="text-muted-foreground text-sm">{t('ended')}</p>
              <button
                type="button"
                className="text-destructive border-destructive border px-4 py-2 text-sm font-medium disabled:opacity-50"
                disabled={busy || !csrfToken}
                onClick={() => void closeOrDelete('/api/intake/data')}
              >
                {t('deleteData')}
              </button>
            </div>
          ) : (
            <div className="mt-8 space-y-4">
              <label className="block text-sm font-medium" htmlFor="intake-name">
                {t('nameLabel')}
              </label>
              <input
                id="intake-name"
                className="border-input bg-background focus-visible:ring-ring w-full border px-3 py-2 outline-none focus-visible:ring-2"
                maxLength={120}
                value={name}
                placeholder={t('namePlaceholder')}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
              />
              <div className="flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  className="bg-primary text-primary-foreground px-4 py-2 font-medium disabled:opacity-50"
                  disabled={busy || !csrfToken}
                  onClick={() => void startSession(name.trim() || undefined)}
                >
                  {busy ? t('starting') : t('continue')}
                </button>
                <button
                  type="button"
                  className="border-border border px-4 py-2 font-medium disabled:opacity-50"
                  disabled={busy || !csrfToken}
                  onClick={() => void startSession()}
                >
                  {t('skip')}
                </button>
              </div>
            </div>
          )
        ) : (
          <div className="mt-8 space-y-8">
            <IntakeWorkspaceSignal />
            {accessExpiry ? (
              <p className="text-muted-foreground text-sm">
                {t('expiresAt', { date: accessExpiry })}
              </p>
            ) : null}
            {workspace.identityName ? (
              <p className="text-muted-foreground text-sm">
                {t('identityName', { name: workspace.identityName })}
              </p>
            ) : null}
            <section
              className="border-border rounded-md border p-5"
              aria-labelledby="intake-assessment-title"
            >
              <h2 id="intake-assessment-title" className="text-lg font-semibold">
                {assessment ? t('assessment.title') : t('assessment.pendingTitle')}
              </h2>
              <p role="status" className="text-muted-foreground mt-2 text-sm leading-6">
                {assessment
                  ? t(`assessment.states.${assessment.status}`)
                  : t('assessment.pendingDescription')}
              </p>
              <h3 className="mt-4 text-sm font-semibold">{t('assessment.inventoryTitle')}</h3>
              {assessment?.findings.length ? (
                <ul className="border-border mt-4 divide-y border-y">
                  {assessment.findings.map((finding, index) => (
                    <li key={`${finding.category}-${index}`} className="py-3">
                      <h3 className="text-sm font-semibold">
                        {t(`assessment.categories.${finding.category}`)}
                      </h3>
                      <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                        <span>
                          {t('assessment.evidence', {
                            count: finding.evidenceDocumentIds.length,
                          })}
                        </span>
                        <span>
                          {t('assessment.confidence', {
                            percentage: Math.round(finding.confidence * 100),
                          })}
                        </span>
                        <span>{t(`assessment.review.${finding.reviewState}`)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground mt-2 text-sm">
                  {t('assessment.inventoryPending')}
                </p>
              )}
              <div className="mt-4">
                <button
                  type="button"
                  className="border-border border px-4 py-2 text-sm font-medium disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    if (assessmentNextActionNeedsSupport) {
                      document.getElementById('intake-support-message')?.focus()
                    } else {
                      fileInputRef.current?.click()
                    }
                  }}
                >
                  {assessmentNextActionNeedsSupport
                    ? t('assessment.nextAction.support')
                    : t('assessment.nextAction.upload')}
                </button>
              </div>
            </section>
            {pendingFiles.length > 0 ? (
              <section
                className="border-destructive/30 bg-destructive/5 rounded-md border p-5"
                aria-labelledby="intake-handoff-title"
              >
                <h2 id="intake-handoff-title" className="text-lg font-semibold">
                  {t('handoff.title')}
                </h2>
                <p className="text-muted-foreground mt-1 text-sm leading-6">
                  {t('handoff.description')}
                </p>
                <ul className="mt-4 space-y-3" aria-live="polite">
                  {pendingFiles.map((handoff) => (
                    <li
                      key={handoff.id}
                      className="border-border bg-background flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {handoff.file.name}
                        </span>
                        {pendingFileId === handoff.id && pendingFileState ? (
                          <>
                            <span className="font-data text-muted-foreground mt-1 block text-xs">
                              {uploadStateLabel(tProgress, pendingFileState)}
                            </span>
                            {pendingFileState.kind === 'uploading' ? (
                              <IntakeUploadProgressBar
                                loaded={pendingFileState.loaded}
                                total={pendingFileState.total}
                                label={handoff.file.name}
                                className="mt-2"
                              />
                            ) : null}
                          </>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          className="border-border border px-3 py-2 text-xs font-medium disabled:opacity-50"
                          disabled={busy || pendingFileId !== null}
                          onClick={() => void retryHandoffFile(handoff)}
                          aria-label={t('handoff.retry', { name: handoff.file.name })}
                        >
                          {pendingFileId === handoff.id ? t('uploading') : t('handoff.retryAction')}
                        </button>
                        <button
                          type="button"
                          className="text-destructive border-destructive border px-3 py-2 text-xs font-medium disabled:opacity-50"
                          disabled={busy || pendingFileId !== null}
                          onClick={() => void removeHandoffFile(handoff)}
                          aria-label={t('handoff.remove', { name: handoff.file.name })}
                        >
                          {t('handoff.removeAction')}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <div className="space-y-3">
              <label className="block text-sm font-medium" htmlFor="intake-files">
                {t('uploadLabel')}
              </label>
              <input
                ref={fileInputRef}
                id="intake-files"
                type="file"
                multiple
                accept=".pdf,.xls,.xlsx,.doc,.docx,.ppt,.pptx,.csv"
                disabled={busy}
                className="border-border block w-full border p-3 text-sm"
              />
              <p className="text-muted-foreground text-xs">{t('uploadLimits')}</p>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="bg-primary text-primary-foreground px-4 py-2 font-medium disabled:opacity-50"
                  disabled={busy || !csrfToken}
                  onClick={() => void uploadFiles()}
                >
                  {busy ? t('uploading') : t('upload')}
                </button>
                {isUploadingBatch || isRetryingHandoff ? (
                  <button
                    type="button"
                    className="border-border border px-4 py-2 text-sm font-medium disabled:opacity-50"
                    disabled={isCancelling}
                    onClick={cancelUpload}
                  >
                    {tProgress('cancel')}
                  </button>
                ) : null}
              </div>
              {batch.length > 0 ? (
                <div className="space-y-3">
                  {isUploadingBatch ? (
                    <div>
                      <p className="font-data text-muted-foreground text-xs">{batchLabel}</p>
                      <IntakeUploadProgressBar
                        loaded={receivedBytes(batch)}
                        total={totalBytes(batch)}
                        label={batchLabel}
                        className="mt-2"
                      />
                    </div>
                  ) : null}
                  <ul className="divide-border border-border divide-y border">
                    {batch.map(({ key, file, state }) => (
                      <li key={key} className="p-3">
                        <div className="flex items-center gap-3">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {file.name}
                          </span>
                          <span className="font-data text-muted-foreground shrink-0 text-xs">
                            {uploadStateLabel(tProgress, state)}
                          </span>
                          <span className="font-data text-muted-foreground shrink-0 text-xs">
                            {formatFileSize(file.size)}
                          </span>
                        </div>
                        {state.kind === 'uploading' ? (
                          <IntakeUploadProgressBar
                            loaded={state.loaded}
                            total={state.total}
                            label={file.name}
                            className="mt-2"
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            <div aria-live="polite">
              {workspace.documents.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t('empty')}</p>
              ) : (
                <ul className="divide-border border-border divide-y border">
                  {workspace.documents.map((document) => (
                    <li key={document.id} className="flex items-center justify-between gap-4 p-4">
                      <span className="min-w-0 truncate text-sm font-medium">
                        {document.displayName}
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {document.inspectionStatus === 'CLEAN'
                          ? t('clean')
                          : document.inspectionStatus === 'NOT_CONFIGURED'
                            ? t('notConfigured')
                            : document.inspectionStatus === 'UNINSPECTED'
                              ? t('uninspected')
                              : t('suspicious')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <section className="border-border border-t pt-6" aria-labelledby="intake-support-title">
              <h2 id="intake-support-title" className="text-lg font-semibold">
                {t('support.title')}
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">{t('support.description')}</p>
              <div className="mt-4 space-y-3" aria-live="polite">
                {supportMessages.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t('support.empty')}</p>
                ) : (
                  supportMessages.map((message) => (
                    <article
                      key={message.messageId}
                      className="border-border rounded-md border p-3"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="text-xs font-semibold">
                          {message.authorKind === 'ADMIN'
                            ? t('support.author.team')
                            : t('support.author.client')}
                        </p>
                        <time
                          className="text-muted-foreground text-xs"
                          dateTime={new Date(message.createdAt).toISOString()}
                        >
                          {formatDateTime(message.createdAt, locale)}
                        </time>
                      </div>
                      <p className="mt-2 text-sm leading-6 break-words whitespace-pre-wrap">
                        {message.body}
                      </p>
                    </article>
                  ))
                )}
              </div>
              <form
                className="mt-4 space-y-3"
                onSubmit={(...args) => void sendSupportMessage(...args)}
              >
                <label className="block text-sm font-medium" htmlFor="intake-support-message">
                  {t('support.messageLabel')}
                </label>
                <textarea
                  id="intake-support-message"
                  className="border-input bg-background focus-visible:ring-ring min-h-24 w-full border p-3 text-sm outline-none focus-visible:ring-2"
                  value={supportBody}
                  maxLength={2_000}
                  placeholder={t('support.placeholder')}
                  disabled={supportBusy}
                  onChange={(event) => setSupportBody(event.target.value)}
                />
                <button
                  type="submit"
                  className="bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50"
                  disabled={supportBusy || !csrfToken || supportBody.trim().length === 0}
                >
                  {supportBusy ? t('support.sending') : t('support.send')}
                </button>
              </form>
            </section>

            <section className="border-primary/25 bg-primary/5 rounded-md border p-5">
              <h2 className="text-lg font-semibold">{t('claim.title')}</h2>
              <p className="text-muted-foreground mt-1 text-sm leading-6">
                {t('claim.description')}
              </p>
              <Link
                href={`/sign-up?returnTo=${encodeURIComponent(`/${locale}/my-company/documents`)}`}
                className="bg-primary text-primary-foreground hover:bg-primary/90 mt-4 inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors"
              >
                {t('claim.action')}
              </Link>
              <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
                {t('disclaimer')}
              </p>
            </section>

            <div className="border-border flex flex-col gap-3 border-t pt-6 sm:flex-row">
              <button
                type="button"
                className="border-border border px-4 py-2 text-sm font-medium disabled:opacity-50"
                disabled={busy || !csrfToken}
                onClick={() => void closeOrDelete('/api/intake/session')}
              >
                {t('endAccess')}
              </button>
              <button
                type="button"
                className="text-destructive border-destructive border px-4 py-2 text-sm font-medium disabled:opacity-50"
                disabled={busy || !csrfToken}
                onClick={() => void closeOrDelete('/api/intake/data')}
              >
                {t('deleteData')}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
