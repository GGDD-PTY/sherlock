// ============================================================================
// SUBIDA DE UN ARCHIVO AL INTAKE TEMPORAL — EL PROGRAMA EFFECT
// ============================================================================
// La landing y el workspace temporal llevaban el mismo pipeline por separado:
//   1. huella SHA-256 del archivo con Web Crypto
//   2. POST /api/intake/uploads (intent; si devuelve `document`, ya estaba;
//      un 500 se reintenta, porque next dev lo dispara al compilar la ruta)
//   3. POST de los bytes a la URL de Convex Storage que el intent selló
//   4. POST /api/intake/uploads/register, hasta tres intentos
// Aquí vive una sola vez. Los bytes viajan por XMLHttpRequest porque es la
// única vía con `upload.onprogress` en todos los navegadores; intent y
// registro siguen por fetch con el mismo `signal`. Los endpoints no cambian.
//
// Las cuatro etapas son un solo programa Effect: cada motivo terminal es un
// fallo etiquetado y los reintentos van por el `retryable` de `externalCall`,
// no un `for` local. Ninguna etapa lleva techo de tiempo: un
// archivo de 50 MB sobre una red móvil, y el escaneo del registro del lado
// servidor, exceden cualquier reloj razonable de transporte.
//
// El resultado es un union discriminado: la UI pinta cada motivo con su copy
// local y NUNCA muestra el cuerpo de una respuesta del proveedor.
//
// ===== POR QUÉ VIVE APARTE DE `upload-file.ts` ([F] 2026-09-08) =====
// Lo llaman dos componentes `'use client'` — la landing y el workspace — en el
// gesto de soltar un archivo, el north star del producto. Tenerlo en el mismo
// módulo que la fachada metía `effect`, `Schema` y el runtime de fibras en el
// first-load JS de la landing. Nada se revirtió: el programa entero se mudó
// acá y `upload-file.ts` lo carga con `import()`. La firma pública era ya una
// Promise, así que ningún caller cambió; los componentes además calientan el
// chunk al montar con `warmUploadIntakeFile()`.
// ============================================================================

import { Duration, Effect, Predicate, Schema } from 'effect'

import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'
import { INTAKE_CSRF_HEADER } from '@/lib/intake/config'
import type { IntakeDocumentView } from '@/lib/intake/session'
import {
  IntakeUploadFailureReasonSchema,
  type IntakeUploadFailureReason,
} from '@/lib/intake/upload-state'
import { resolveTemporaryIntakeContentType } from '@/lib/intake/upload-policy'
import {
  isSafeStorageUploadUrl,
  type IntakeUploadOptions,
  type IntakeUploadOutcome,
} from '@/lib/intake/upload-file'
import { directUploadLimitBytesForMimeType } from '@/lib/storage/upload-limits'

const REGISTER_MAX_ATTEMPTS = 3
const INTENT_MAX_ATTEMPTS = 3

type IntakeResponse = Record<string, unknown>

/** Un motivo terminal del pipeline: el union que la UI ya sabe pintar. */
class IntakeUploadRejected extends Schema.TaggedError<IntakeUploadRejected>()(
  'IntakeUploadRejected',
  {
    reason: IntakeUploadFailureReasonSchema,
    message: Schema.String,
  }
) {}

/** La señal del usuario llegó antes de que los bytes quedaran almacenados. */
class IntakeUploadCancelled extends Schema.TaggedError<IntakeUploadCancelled>()(
  'IntakeUploadCancelled',
  { message: Schema.String }
) {}

/** El POST del intent contestó 500: se reintenta, no se tira el archivo. */
class IntakeIntentTransient extends Schema.TaggedError<IntakeIntentTransient>()(
  'IntakeIntentTransient',
  { message: Schema.String }
) {}

/**
 * El registro llegó al servidor y todavía no confirmó el documento. Un fallo
 * de red del mismo POST se reporta de una vez, igual que antes.
 */
class IntakeRegistrationPending extends Schema.TaggedError<IntakeRegistrationPending>()(
  'IntakeRegistrationPending',
  { message: Schema.String }
) {}

function rejected(reason: IntakeUploadFailureReason): IntakeUploadRejected {
  return new IntakeUploadRejected({ reason, message: `INTAKE_UPLOAD_${reason.toUpperCase()}` })
}

function cancelled(): IntakeUploadCancelled {
  return new IntakeUploadCancelled({ message: 'INTAKE_UPLOAD_CANCELLED' })
}

// Ninguna etapa se corta por reloj. El registro reintenta si no confirmó el
// documento; el intent reintenta un 500 transitorio de next dev.
function uploadCall<A>(service: string, operation: string, run: () => PromiseLike<A>) {
  return externalCall({ service, operation, retries: 0, timeout: Duration.infinity, run })
}

function parseIntakeBody(text: string): IntakeResponse {
  try {
    const body = JSON.parse(text) as unknown
    return Predicate.isObject(body) ? (body as IntakeResponse) : {}
  } catch {
    return {}
  }
}

async function readIntakeResponse(response: Response): Promise<IntakeResponse> {
  try {
    const body = (await response.json()) as unknown
    return Predicate.isObject(body) ? (body as IntakeResponse) : {}
  } catch {
    return {}
  }
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function isDocument(value: unknown): value is IntakeDocumentView {
  return Predicate.isObject(value) && Predicate.isString(value.id)
}

// POST de los bytes por XHR. Sin credenciales (el equivalente de
// `credentials: 'omit'`): la URL de Convex Storage ya lleva su propia
// autoridad y no debe recibir cookies. `signal` aborta el XHR en vuelo.
function postBytes(
  uploadUrl: string,
  file: File,
  contentType: string,
  signal: AbortSignal,
  onProgress?: (loadedBytes: number, totalBytes: number) => void
): Promise<{ status: number; body: IntakeResponse }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const xhr = new XMLHttpRequest()
    const onAbort = () => xhr.abort()
    const settle = () => signal.removeEventListener('abort', onAbort)
    xhr.open('POST', uploadUrl)
    xhr.withCredentials = false
    xhr.responseType = 'text'
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = (event) => {
      onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size)
    }
    xhr.onload = () => {
      settle()
      resolve({ status: xhr.status, body: parseIntakeBody(String(xhr.responseText ?? '')) })
    }
    xhr.onerror = () => {
      settle()
      reject(new TypeError('INTAKE_STORAGE_NETWORK'))
    }
    xhr.onabort = () => {
      settle()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    xhr.send(file)
  })
}

// `storageId` es la llave de idempotencia: cada intento registra el mismo blob
// y el servidor devuelve el documento si ya lo tenía. Sin `signal`: el
// resultado del registro manda aunque el cliente cancele.
async function registerStoredUpload(
  headers: Record<string, string>,
  intentId: string,
  storageId: string
): Promise<IntakeDocumentView> {
  const response = await fetch('/api/intake/uploads/register', {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({ intentId, storageId }),
  })
  const registration = await readIntakeResponse(response)
  if (response.ok && isDocument(registration.document)) return registration.document
  throw new IntakeRegistrationPending({ message: 'INTAKE_REGISTRATION_UNCONFIRMED' })
}

export function uploadIntakeFile(
  file: File,
  { csrfToken, signal, onProgress, supersedePending }: IntakeUploadOptions
): Promise<IntakeUploadOutcome> {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    [INTAKE_CSRF_HEADER]: csrfToken,
  }
  // Desde que el proveedor devolvió `storageId`, el intent ya puede estar en
  // INSPECTING del lado servidor: cancelar aquí ya no cancela nada y solo
  // dejaría el archivo bloqueado media hora. El registro corre entero.
  let bytesStored = false

  const uploadFile = Effect.fn('IntakeUpload.file')(function* () {
    // Tipo y tamaño se deciden antes de leer un solo byte: subir 50 MB para
    // que el servidor los rechace es el peor de los fallos.
    const declaredMimeType = resolveTemporaryIntakeContentType(file)
    if (!declaredMimeType) return yield* rejected('type')
    if (file.size > directUploadLimitBytesForMimeType(declaredMimeType)) {
      return yield* rejected('size')
    }
    if (signal.aborted) return yield* cancelled()

    const declaredSha256 = yield* uploadCall('WebCrypto', 'intake.upload.digest', () =>
      sha256Hex(file)
    )
    if (signal.aborted) return yield* cancelled()
    // La huella ya está: desde aquí el archivo se reporta como en subida,
    // con cero bytes aceptados hasta que el XHR diga otra cosa.
    onProgress?.(0, file.size)

    const intentResponse = yield* externalCall({
      service: 'Sherlock',
      operation: 'intake.upload.intent',
      retries: INTENT_MAX_ATTEMPTS - 1,
      retryDelay: Duration.millis(200),
      timeout: Duration.infinity,
      retryable: (cause) => cause instanceof IntakeIntentTransient,
      run: async () => {
        const response = await fetch('/api/intake/uploads', {
          method: 'POST',
          credentials: 'same-origin',
          headers: jsonHeaders,
          signal,
          body: JSON.stringify({
            fileName: file.name,
            declaredMimeType,
            declaredByteSize: file.size,
            declaredSha256,
            ...(supersedePending ? { supersedePending: true } : {}),
          }),
        })
        if (response.status === 500) {
          throw new IntakeIntentTransient({ message: 'INTAKE_INTENT_TRANSIENT' })
        }
        return response
      },
    })
    const intent = yield* Effect.promise(() => readIntakeResponse(intentResponse))
    if (intentResponse.ok && isDocument(intent.document)) {
      onProgress?.(file.size, file.size)
      return { status: 'received', document: intent.document } as const
    }
    if (
      !intentResponse.ok ||
      typeof intent.intentId !== 'string' ||
      !isSafeStorageUploadUrl(intent.uploadUrl)
    ) {
      return yield* rejected('intent')
    }
    // El estrechamiento de `intent.uploadUrl` no sobrevive al closure de
    // `externalCall`: se fija aquí, ya validado.
    const intentId = intent.intentId
    const uploadUrl = intent.uploadUrl

    const storage = yield* uploadCall('ConvexStorage', 'intake.upload.bytes', () =>
      postBytes(uploadUrl, file, declaredMimeType, signal, onProgress)
    )
    if (
      storage.status < 200 ||
      storage.status >= 300 ||
      typeof storage.body.storageId !== 'string'
    ) {
      return yield* rejected('bytes')
    }
    const storageId = storage.body.storageId
    bytesStored = true
    onProgress?.(file.size, file.size)

    const document = yield* externalCall({
      service: 'Sherlock',
      operation: 'intake.upload.register',
      retries: REGISTER_MAX_ATTEMPTS - 1,
      retryDelay: Duration.zero,
      timeout: Duration.infinity,
      retryable: (cause) => cause instanceof IntakeRegistrationPending,
      run: () => registerStoredUpload(jsonHeaders, intentId, storageId),
    })
    return { status: 'received', document } as const
  })

  // Un fetch abortado, un XHR abortado o una huella interrumpida: si fue por la
  // señal antes de que los bytes llegaran, es cancelación; cualquier otra
  // excepción es red. Un intent ya emitido no se cierra desde aquí: el servidor
  // supersede un ISSUED de la misma huella cuando el archivo vuelve a pedir
  // intent.
  const interrupted = (): IntakeUploadOutcome =>
    signal.aborted && !bytesStored
      ? { status: 'cancelled' }
      : { status: 'failed', reason: 'network' }

  return runServerEffect(
    uploadFile().pipe(
      Effect.match({
        onSuccess: (outcome): IntakeUploadOutcome => outcome,
        onFailure: (error): IntakeUploadOutcome => {
          if (error._tag === 'IntakeUploadRejected') {
            return { status: 'failed', reason: error.reason }
          }
          if (error._tag === 'IntakeUploadCancelled') return { status: 'cancelled' }
          // Tres registros sin confirmación: el archivo llegó, el documento no.
          if (error.operation === 'intake.upload.register' && error.retryable) {
            return { status: 'failed', reason: 'register' }
          }
          if (error.operation === 'intake.upload.intent' && error.retryable) {
            return { status: 'failed', reason: 'intent' }
          }
          return interrupted()
        },
      }),
      // Un defect cae donde caía en el `catch` anterior: nunca sale una
      // excepción de esta función.
      Effect.catchCause(() => Effect.succeed(interrupted())),
      Effect.withSpan('IntakeUpload.upload')
    )
  )
}
