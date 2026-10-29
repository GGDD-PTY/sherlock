// ============================================================================
// SUBIDA DIRECTA DE DOCUMENTOS VDR — EL PROGRAMA (testeable sin React)
// ============================================================================
// Orquesta el camino directo navegador → Convex Storage (decisión 6,
// DESIGN-ONBOARDING-VDR-2026-07-31):
//   1. valida tamaño/tipo y calcula SHA-256 con Web Crypto durante PREPARING
//      (máximo 50MB; el digest solo sale en outcomes inciertos internos para
//      impedir replays locales, jamás como respuesta de proveedor/backend)
//   2. emite un intent corto ligado a room+metadata+hash y recibe su única URL
//   3. POST del archivo DIRECTO a *.convex.cloud — jamás toca Vercel, así que
//      el 413 FUNCTION_PAYLOAD_TOO_LARGE de ~4.5MB deja de existir aquí
//   4. una action autenticada recibe solo intentId+storageId, lee la firma real,
//      revalida ownership/scope y consume el intent al publicar atómicamente
//      una versión inmutable; el mutation legacy solo puede crear cuarentena
//
// El resultado es un union discriminado con códigos estables: la UI mapea cada
// código a su copy bilingüe local y NUNCA muestra internals de proveedor.
//
// ===== POR QUÉ VIVE APARTE DE `direct-upload.ts` ([F] 2026-09-08) =====
// `MyCompanyDocumentsClient` importa la fachada, así que este grafo —Effect,
// `Schema` y sus errores tipados por paso— viajaba en el first-load JS de las
// dos salas para una función que solo corre cuando el cliente suelta archivos.
// Nada se revirtió: el programa entero se mudó acá y la fachada lo carga con
// `import()`, precalentado en el montaje de la sala.
// ============================================================================

import { Effect, Predicate, Schema } from 'effect'

import {
  directUploadLimitBytesForMimeType,
  isDirectUploadRejection,
  MAX_DIRECT_UPLOAD_BYTES,
  type DIRECT_UPLOAD_ALLOWED_MIME_TYPES,
  type DirectUploadRejectionCode,
} from '../../../convex/_documents/uploadLimits'
import { runServerEffect } from '@/lib/effect/runtime'
import type { DocumentClassification } from '@/lib/documents/classification'

// File.type sale del mapa MIME del OS/navegador y puede venir VACÍO para
// PDF/Office perfectamente válidos. POSTear con Content-Type vacío haría que
// Convex registre un contentType vacío y la inspección borre el blob y
// rechace INVALID_FILE_TYPE. Cuando falta, se infiere de la extensión; los
// valores se tipan contra la allowlist compartida para no divergir de ella.
const EXTENSION_CONTENT_TYPES: Readonly<
  Record<string, (typeof DIRECT_UPLOAD_ALLOWED_MIME_TYPES)[number]>
> = {
  pdf: 'application/pdf',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
}

// Browsers and OS MIME maps disagree about .csv (Windows reports Excel's MIME,
// others text/plain or application/csv). The extension is the honest signal and
// the server re-inspects the bytes, so every alias collapses to text/csv.
const CSV_TYPE_ALIASES = new Set([
  '',
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
])

function fileExtension(file: File): string | undefined {
  const dot = file.name.lastIndexOf('.')
  return dot < 0 ? undefined : file.name.slice(dot + 1).toLowerCase()
}

function resolveUploadContentType(file: File): string | undefined {
  const extension = fileExtension(file)
  if (extension === 'csv' && CSV_TYPE_ALIASES.has(file.type)) return 'text/csv'
  if (file.type.length > 0) return file.type
  return extension ? EXTENSION_CONTENT_TYPES[extension] : undefined
}

type DirectVdrUploadFailureCode =
  | DirectUploadRejectionCode
  | 'UPLOAD_INTENT_ACTIVE'
  | 'UPLOAD_INTENT_UNCERTAIN'
  | 'UPLOAD_INTENT_EXPIRED'
  | 'UPLOAD_INTENT_REJECTED'
  | 'UPLOAD_INTENT_MISMATCH'
  | 'FILE_HASH_FAILED'
  | 'UPLOAD_ABORTED'
  | 'STORAGE_UPLOAD_FAILED'
  | 'REGISTRATION_FAILED'

type DirectVdrUploadFailureResult =
  | {
      ok: false
      code: DirectVdrUploadFailureCode
      reconciliationRequired?: undefined
      storageCommitted?: undefined
      fileSha256?: undefined
    }
  | {
      ok: false
      code: DirectVdrUploadFailureCode
      /** El proveedor pudo aceptar bytes, pero no existe confirmación durable del documento. */
      reconciliationRequired: true
      /** Fingerprint client-side para impedir replays del mismo archivo dentro del mismo scope. */
      fileSha256: string
      /** El storage devolvió un storageId; el blob sí llegó al proveedor. */
      storageCommitted?: true
    }

export type DirectVdrUploadResult = { ok: true; documentId: string } | DirectVdrUploadFailureResult

type DirectVdrUploadStage =
  'PREPARING' | 'UPLOADING' | 'REGISTERING' | 'COMPLETE' | 'FAILED' | 'CANCELED'

interface DirectVdrUploadProgress {
  stage: DirectVdrUploadStage
  /** Reintentos del paso actual. No es un porcentaje de bytes. */
  attempt: number
  maxAttempts: number
}

export interface DirectVdrUploadInput {
  file: File
  companyId: string
  replaceDocumentId?: string
  name: string
  accessLevel: 'PUBLIC' | 'NDA_REQUIRED' | 'PRIVATE'
  classification?: DocumentClassification
  folder: string
  /** La cancelación es best-effort. Tras aceptar el blob puede requerir reconciliación. */
  signal?: AbortSignal
  /** Progreso por etapas; fetch no ofrece progreso de bytes portable. */
  onProgress?: (progress: DirectVdrUploadProgress) => void
}

export interface DirectVdrUploadDeps {
  /** Mutation autenticada que sella scope+metadata y emite una sola URL. */
  issueUploadIntent: (args: {
    companyId: string
    replaceDocumentId?: string
    fileName: string
    declaredMimeType: string
    declaredByteSize: number
    declaredSha256: string
    name: string
    accessLevel: 'PUBLIC' | 'NDA_REQUIRED' | 'PRIVATE'
    classification?: DocumentClassification
    folder: string
  }) => Promise<
    | { intentId: string; uploadUrl: string; expiresAt: number }
    | { registered: true; documentId: string }
    | {
        registered: false
        code:
          | 'UPLOAD_INTENT_ACTIVE'
          | 'UPLOAD_INTENT_UNCERTAIN'
          | 'UPLOAD_INTENT_EXPIRED'
          | 'UPLOAD_INTENT_REJECTED'
          | 'UPLOAD_INTENT_MISMATCH'
          | 'FILE_TOO_LARGE'
          | 'INVALID_FILE_TYPE'
      }
  >
  /** Cierra autoridad emitida solo si el backend confirma que aún no hubo bytes. */
  abandonUploadIntent: (args: {
    intentId: string
  }) => Promise<{ aborted: true } | { aborted: false; code: 'UPLOAD_INTENT_UNCERTAIN' }>
  /** Inyectable en tests; producción usa Web Crypto SHA-256. */
  calculateSha256?: (file: File, signal?: AbortSignal) => Promise<string>
  /** Action autenticada que inspecciona firma y registra la versión inmutable. */
  registerDirectUpload: (args: { intentId: string; storageId: string }) => Promise<unknown>
  /** Inyectable en tests; en producción es el fetch del navegador. */
  fetchFn?: typeof fetch
  /** Inyectable para probar el backoff sin esperar tiempo real. */
  waitFn?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  /** Clasificador conservador; fallos de authz/validación jamás se reintentan. */
  isRetryableError?: (error: unknown) => boolean
}

const ISSUE_UPLOAD_INTENT_MAX_ATTEMPTS = 2
const REGISTRATION_MAX_ATTEMPTS = 3
// Total máximo 350 ms: mejora resiliencia sin congelar el feedback de la UI.
const RETRY_DELAYS_MS = [100, 250] as const

const UPLOAD_INTENT_REJECTION_CODES = new Set<DirectVdrUploadFailureCode>([
  'UPLOAD_INTENT_ACTIVE',
  'UPLOAD_INTENT_UNCERTAIN',
  'UPLOAD_INTENT_EXPIRED',
  'UPLOAD_INTENT_REJECTED',
  'UPLOAD_INTENT_MISMATCH',
  'FILE_TOO_LARGE',
  'INVALID_FILE_TYPE',
])

function isUploadIntentRejection(
  value: unknown
): value is { registered: false; code: DirectVdrUploadFailureCode } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { registered?: unknown; code?: unknown }
  return (
    candidate.registered === false &&
    typeof candidate.code === 'string' &&
    UPLOAD_INTENT_REJECTION_CODES.has(candidate.code as DirectVdrUploadFailureCode)
  )
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

// La misma regla que `isSafeStorageUploadUrl` del intake, un poco más
// estricta: https a `*.convex.cloud` / `*.convex.site`, o —solo fuera de
// producción— el origin exacto de `NEXT_PUBLIC_CONVEX_URL` cuando es http en
// loopback, que es como `bun run dev:local` sirve `generateUploadUrl()`
// (`http://127.0.0.1:3210/api/storage/upload?token=…`). Sin esto la sala local
// rechazaba su propio intent como «Invalid upload intent response».
function isSafeConvexUploadUrl(
  value: string,
  env: { NEXT_PUBLIC_CONVEX_URL?: string; NODE_ENV?: string } = {
    NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
    NODE_ENV: process.env.NODE_ENV,
  }
): boolean {
  try {
    const url = new URL(value)
    if (url.username !== '' || url.password !== '') return false
    if (
      url.protocol === 'https:' &&
      (url.hostname.endsWith('.convex.cloud') || url.hostname.endsWith('.convex.site'))
    ) {
      return true
    }
    if (url.protocol !== 'http:' || env.NODE_ENV === 'production' || !env.NEXT_PUBLIC_CONVEX_URL) {
      return false
    }
    const configured = new URL(env.NEXT_PUBLIC_CONVEX_URL)
    return (
      configured.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(configured.hostname) &&
      url.origin === configured.origin
    )
  } catch {
    return false
  }
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (Predicate.isObject(error) && 'name' in error && error.name === 'AbortError')
  )
}

function defaultIsRetryableError(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (!(error instanceof Error)) return false

  const normalized = error.message.toLowerCase()
  if (
    /unauthor|forbidden|permiso|dueño|rate.?limit|too many|invalid|validation|integrity|infected|malware|scanner|security/.test(
      normalized
    )
  ) {
    return false
  }

  return /network|fetch|timeout|timed out|connection|temporar|unavailable|server error/.test(
    normalized
  )
}

function defaultWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeoutId)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function bytesToHex(bytes: Uint8Array): string {
  let result = ''
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0')
  return result
}

// ===== ERRORES TIPADOS POR PASO =====
// Cada dependencia (hash, mutation del intent, POST del blob, action de
// registro) falla con el mismo error tipado y conserva el error crudo del
// proveedor en `cause`. La clasificación —aborto o reintentable— lee esa causa,
// así que un contrato roto de una dependencia («respuesta inválida») ya no se
// confunde con una caída de red, y hacia la UI sigue saliendo solo un código
// estable, nunca el error del proveedor.
class DirectUploadStepError extends Schema.TaggedError<DirectUploadStepError>()(
  'DirectUploadStepError',
  {
    step: Schema.Literals([
      'hash',
      'issueIntent',
      'abandonIntent',
      'upload',
      'readReceipt',
      'register',
      'wait',
    ]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

type DirectUploadStep = DirectUploadStepError['step']

function stepPromise<A>(
  step: DirectUploadStep,
  run: () => PromiseLike<A>
): Effect.Effect<A, DirectUploadStepError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new DirectUploadStepError({
        step,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  })
}

/** Una dependencia que responde fuera de su contrato también falla el paso. */
function stepViolation(step: DirectUploadStep, message: string): DirectUploadStepError {
  return new DirectUploadStepError({ step, message })
}

/** El clasificador mira el error del proveedor, no el envoltorio tipado. */
function stepCause(failure: DirectUploadStepError): unknown {
  return failure.cause ?? failure
}

function attempted<A>(effect: Effect.Effect<A, DirectUploadStepError>) {
  return effect.pipe(
    Effect.match({
      onSuccess: (value) => ({ ok: true as const, value }),
      onFailure: (error) => ({ ok: false as const, error }),
    })
  )
}

// El aborto conserva el protocolo del navegador (`DOMException` AbortError):
// es lo que cualquier consumidor de un AbortSignal espera, incluido el
// `calculateSha256` que los tests inyectan.
export async function calculateVdrFileSha256(file: File, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const bytes =
    typeof file.arrayBuffer === 'function'
      ? await file.arrayBuffer()
      : await new Response(file).arrayBuffer()
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if (!globalThis.crypto?.subtle) throw stepViolation('hash', 'Web Crypto unavailable')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return bytesToHex(new Uint8Array(digest))
}

function emitProgress(
  input: DirectVdrUploadInput,
  stage: DirectVdrUploadStage,
  attempt: number,
  maxAttempts: number
): void {
  try {
    input.onProgress?.({ stage, attempt, maxAttempts })
  } catch {
    // La telemetría/UI no puede romper el camino de integridad del upload.
  }
}

function waitBeforeRetry(
  waitFn: NonNullable<DirectVdrUploadDeps['waitFn']>,
  completedAttempts: number,
  signal?: AbortSignal
): Effect.Effect<void, DirectUploadStepError> {
  const delay = RETRY_DELAYS_MS[Math.min(completedAttempts - 1, RETRY_DELAYS_MS.length - 1)]
  return stepPromise('wait', () => waitFn(delay, signal))
}

type IssuedUploadIntent = { intentId: string; uploadUrl: string; expiresAt: number }

type UploadIntentOutcome =
  | { kind: 'registered'; documentId: string }
  | { kind: 'rejected'; code: DirectVdrUploadFailureCode }
  | { kind: 'issued'; intent: IssuedUploadIntent }

const runDirectVdrUpload = Effect.fn('DirectUpload.perform')(function* (
  deps: DirectVdrUploadDeps,
  input: DirectVdrUploadInput
): Effect.fn.Return<DirectVdrUploadResult> {
  emitProgress(input, 'PREPARING', 1, ISSUE_UPLOAD_INTENT_MAX_ATTEMPTS)

  if (input.signal?.aborted) {
    emitProgress(input, 'CANCELED', 1, 1)
    return { ok: false, code: 'UPLOAD_ABORTED' }
  }

  const contentType = resolveUploadContentType(input.file)
  const sizeLimit = contentType
    ? directUploadLimitBytesForMimeType(contentType)
    : MAX_DIRECT_UPLOAD_BYTES

  // Techo client-side por formato: evita pedir intent o subir bytes que el
  // servidor rechazará. El servidor re-valida el mismo límite compartido.
  if (input.file.size > sizeLimit) {
    emitProgress(input, 'FAILED', 1, 1)
    return { ok: false, code: 'FILE_TOO_LARGE' }
  }

  // Sin File.type ni extensión conocida no hay Content-Type que declarar: el
  // servidor lo rechazaría igual — fallar rápido evita subir 50MB para nada.
  if (contentType === undefined) {
    emitProgress(input, 'FAILED', 1, 1)
    return { ok: false, code: 'INVALID_FILE_TYPE' }
  }

  const doFetch = deps.fetchFn ?? fetch
  const waitFn = deps.waitFn ?? defaultWait
  const isRetryableError = deps.isRetryableError ?? defaultIsRetryableError
  const calculateSha256 = deps.calculateSha256 ?? calculateVdrFileSha256

  const hashed = yield* attempted(
    stepPromise('hash', () => calculateSha256(input.file, input.signal)).pipe(
      Effect.flatMap((digest) => {
        const normalized = digest.toLowerCase()
        return /^[a-f0-9]{64}$/.test(normalized)
          ? Effect.succeed(normalized)
          : Effect.fail(stepViolation('hash', 'Invalid SHA-256'))
      })
    )
  )
  if (!hashed.ok) {
    const canceled = isAbortError(stepCause(hashed.error), input.signal)
    emitProgress(input, canceled ? 'CANCELED' : 'FAILED', 1, 1)
    return { ok: false, code: canceled ? 'UPLOAD_ABORTED' : 'FILE_HASH_FAILED' }
  }
  const declaredSha256 = hashed.value

  let uploadIntent: IssuedUploadIntent | undefined

  const intentArgs = {
    companyId: input.companyId,
    ...(input.replaceDocumentId ? { replaceDocumentId: input.replaceDocumentId } : {}),
    fileName: input.file.name,
    declaredMimeType: contentType,
    declaredByteSize: input.file.size,
    declaredSha256,
    name: input.name,
    accessLevel: input.accessLevel,
    classification: input.classification,
    folder: input.folder,
  }

  for (let attempt = 1; attempt <= ISSUE_UPLOAD_INTENT_MAX_ATTEMPTS; attempt += 1) {
    const issued = yield* attempted(
      stepPromise('issueIntent', () => deps.issueUploadIntent(intentArgs)).pipe(
        Effect.flatMap((value): Effect.Effect<UploadIntentOutcome, DirectUploadStepError> => {
          if (Predicate.isObject(value) && 'registered' in value && value.registered === true) {
            return typeof value.documentId === 'string' && value.documentId.length > 0
              ? Effect.succeed({ kind: 'registered', documentId: value.documentId })
              : Effect.fail(stepViolation('issueIntent', 'Invalid reconciled upload response'))
          }
          if (isUploadIntentRejection(value)) {
            return Effect.succeed({ kind: 'rejected', code: value.code })
          }
          if (
            !('intentId' in value) ||
            typeof value.intentId !== 'string' ||
            value.intentId.length === 0 ||
            !isSafeConvexUploadUrl(value.uploadUrl) ||
            !Number.isFinite(value.expiresAt) ||
            value.expiresAt <= Date.now()
          ) {
            return Effect.fail(stepViolation('issueIntent', 'Invalid upload intent response'))
          }
          return Effect.succeed({ kind: 'issued', intent: value })
        })
      )
    )

    if (issued.ok) {
      if (issued.value.kind === 'registered') {
        emitProgress(input, 'COMPLETE', attempt, ISSUE_UPLOAD_INTENT_MAX_ATTEMPTS)
        return { ok: true, documentId: issued.value.documentId }
      }
      if (issued.value.kind === 'rejected') {
        const code = issued.value.code
        emitProgress(input, 'FAILED', attempt, ISSUE_UPLOAD_INTENT_MAX_ATTEMPTS)
        if (code === 'FILE_TOO_LARGE' || code === 'INVALID_FILE_TYPE') {
          return { ok: false, code }
        }
        return {
          ok: false,
          code,
          reconciliationRequired: true,
          fileSha256: declaredSha256,
        }
      }
      uploadIntent = issued.value.intent
      break
    }

    const cause = stepCause(issued.error)
    if (
      isAbortError(cause, input.signal) ||
      !isRetryableError(cause) ||
      attempt === ISSUE_UPLOAD_INTENT_MAX_ATTEMPTS
    ) {
      const canceled = isAbortError(cause, input.signal)
      emitProgress(
        input,
        canceled ? 'CANCELED' : 'FAILED',
        attempt,
        ISSUE_UPLOAD_INTENT_MAX_ATTEMPTS
      )
      return { ok: false, code: canceled ? 'UPLOAD_ABORTED' : 'STORAGE_UPLOAD_FAILED' }
    }

    const waited = yield* attempted(waitBeforeRetry(waitFn, attempt, input.signal))
    if (!waited.ok) {
      emitProgress(input, 'CANCELED', attempt, attempt)
      return { ok: false, code: 'UPLOAD_ABORTED' }
    }
    emitProgress(input, 'PREPARING', attempt + 1, ISSUE_UPLOAD_INTENT_MAX_ATTEMPTS)
  }

  // uploadIntent solo puede faltar si una dependencia viola su contrato.
  if (!uploadIntent) {
    emitProgress(input, 'FAILED', 1, 1)
    return { ok: false, code: 'STORAGE_UPLOAD_FAILED' }
  }
  const intent = uploadIntent

  // El intent no contiene bytes. Si la operación se detuvo mientras el
  // backend lo emitía, no iniciamos el POST; solo declaramos aborto seguro
  // después de que el backend terminalice esa autoridad todavía intacta.
  if (input.signal?.aborted) {
    // Sin confirmación del backend, el intent puede estar preparado o
    // consumido. Nunca lo presentamos como un aborto seguro.
    const abandoned = yield* attempted(
      stepPromise('abandonIntent', () => deps.abandonUploadIntent({ intentId: intent.intentId }))
    )
    if (abandoned.ok && abandoned.value.aborted) {
      emitProgress(input, 'CANCELED', 1, 1)
      return { ok: false, code: 'UPLOAD_ABORTED' }
    }
    emitProgress(input, 'FAILED', 1, 1)
    return {
      ok: false,
      code: 'UPLOAD_INTENT_UNCERTAIN',
      reconciliationRequired: true,
      fileSha256: declaredSha256,
    }
  }

  emitProgress(input, 'UPLOADING', 1, 1)
  // No se reintenta el POST del blob: ante una respuesta perdida, repetirlo
  // podría crear un segundo blob. El outcome se declara como incierto.
  const posted = yield* attempted(
    stepPromise('upload', () =>
      doFetch(intent.uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: input.file,
        ...(input.signal ? { signal: input.signal } : {}),
      })
    )
  )
  if (!posted.ok) {
    const canceled = isAbortError(stepCause(posted.error), input.signal)
    emitProgress(input, canceled ? 'CANCELED' : 'FAILED', 1, 1)
    return {
      ok: false,
      code: canceled ? 'UPLOAD_ABORTED' : 'STORAGE_UPLOAD_FAILED',
      reconciliationRequired: true,
      fileSha256: declaredSha256,
    }
  }

  const response = posted.value
  if (!response.ok) {
    emitProgress(input, 'FAILED', 1, 1)
    return { ok: false, code: 'STORAGE_UPLOAD_FAILED' }
  }

  // Un recibo 2xx que no trae storageId legible deja los bytes del lado del
  // proveedor: se declara storage confirmado y pendiente de reconciliación.
  const receipt = yield* attempted(
    stepPromise('readReceipt', () => response.json() as Promise<unknown>).pipe(
      Effect.flatMap((payload) => {
        const candidate = Predicate.isObject(payload) ? payload.storageId : undefined
        return typeof candidate === 'string' && candidate.length > 0
          ? Effect.succeed(candidate)
          : Effect.fail(stepViolation('readReceipt', 'Invalid storage receipt'))
      })
    )
  )
  if (!receipt.ok) {
    emitProgress(input, 'FAILED', 1, 1)
    return {
      ok: false,
      code: 'STORAGE_UPLOAD_FAILED',
      reconciliationRequired: true,
      fileSha256: declaredSha256,
      storageCommitted: true,
    }
  }

  const registrationArgs = { intentId: intent.intentId, storageId: receipt.value }

  if (input.signal?.aborted) {
    emitProgress(input, 'CANCELED', 1, 1)
    return {
      ok: false,
      code: 'UPLOAD_ABORTED',
      reconciliationRequired: true,
      fileSha256: declaredSha256,
      storageCommitted: true,
    }
  }

  // `storageId` es la llave natural de idempotencia. Cada reintento registra
  // exactamente el mismo blob; el backend devuelve el documento existente si
  // el primer intento commiteó pero su respuesta se perdió.
  for (let attempt = 1; attempt <= REGISTRATION_MAX_ATTEMPTS; attempt += 1) {
    emitProgress(input, 'REGISTERING', attempt, REGISTRATION_MAX_ATTEMPTS)
    const registered = yield* attempted(
      stepPromise('register', () => deps.registerDirectUpload(registrationArgs))
    )

    if (registered.ok) {
      const result = registered.value

      // Rechazo estructurado del servidor: el intent queda terminal y el blob
      // conocido permanece en cuarentena hasta reconciliación/GC atribuible.
      if (isDirectUploadRejection(result) || isUploadIntentRejection(result)) {
        emitProgress(input, 'FAILED', attempt, REGISTRATION_MAX_ATTEMPTS)
        return {
          ok: false,
          code: result.code,
          reconciliationRequired: true,
          fileSha256: declaredSha256,
          storageCommitted: true,
        }
      }

      if (typeof result !== 'string' || result.length === 0) {
        emitProgress(input, 'FAILED', attempt, REGISTRATION_MAX_ATTEMPTS)
        return {
          ok: false,
          code: 'REGISTRATION_FAILED',
          reconciliationRequired: true,
          fileSha256: declaredSha256,
          storageCommitted: true,
        }
      }

      emitProgress(input, 'COMPLETE', attempt, REGISTRATION_MAX_ATTEMPTS)
      return { ok: true, documentId: result }
    }

    const cause = stepCause(registered.error)
    const canceled = isAbortError(cause, input.signal)
    if (canceled || !isRetryableError(cause) || attempt === REGISTRATION_MAX_ATTEMPTS) {
      emitProgress(input, canceled ? 'CANCELED' : 'FAILED', attempt, REGISTRATION_MAX_ATTEMPTS)
      return {
        ok: false,
        code: canceled ? 'UPLOAD_ABORTED' : 'REGISTRATION_FAILED',
        reconciliationRequired: true,
        fileSha256: declaredSha256,
        storageCommitted: true,
      }
    }

    const waited = yield* attempted(waitBeforeRetry(waitFn, attempt, input.signal))
    if (!waited.ok) {
      emitProgress(input, 'CANCELED', attempt, attempt)
      return {
        ok: false,
        code: 'UPLOAD_ABORTED',
        reconciliationRequired: true,
        fileSha256: declaredSha256,
        storageCommitted: true,
      }
    }
  }

  // Inalcanzable por el límite del loop; mantiene el contrato fail-closed.
  emitProgress(input, 'FAILED', REGISTRATION_MAX_ATTEMPTS, REGISTRATION_MAX_ATTEMPTS)
  return {
    ok: false,
    code: 'REGISTRATION_FAILED',
    reconciliationRequired: true,
    fileSha256: declaredSha256,
    storageCommitted: true,
  }
})

export function performDirectVdrUpload(
  deps: DirectVdrUploadDeps,
  input: DirectVdrUploadInput
): Promise<DirectVdrUploadResult> {
  return runServerEffect(runDirectVdrUpload(deps, input))
}
