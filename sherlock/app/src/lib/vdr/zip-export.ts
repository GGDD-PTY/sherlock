import { Cause, Duration, Effect, Result, Schema } from 'effect'
import { Zip, ZipPassThrough } from 'fflate'

import { runServerEffect } from '@/lib/effect/runtime'
import { getVdrShellFolderLabel, type VdrLocale } from '@/lib/vdr/document-taxonomy'

export const VDR_EXPORT_MAX_BYTES = 250 * 1024 * 1024
const ZIP_ENTRY_TIMEOUT = Duration.seconds(30)

export function sumExportableBytes(documents: readonly { byteSize: number }[]): number {
  return documents.reduce((total, document) => {
    const size = document.byteSize
    return total + (Number.isFinite(size) && size > 0 ? size : 0)
  }, 0)
}

export function isExportOverCap(bytes: number, cap: number = VDR_EXPORT_MAX_BYTES): boolean {
  return bytes > cap
}

export function sanitizeZipFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/]/g, '-')
    .replace(/[\u0000-\u001F\u007F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'documento'
}

export function buildZipEntryPath(
  folder: string,
  name: string,
  locale: VdrLocale,
  used: Set<string>
): string {
  const folderLabel = getVdrShellFolderLabel(folder, locale)
  const base = sanitizeZipFileName(name)
  const extensionMatch = /^(.*?)(\.[^.]+)$/.exec(base)
  let candidate = `${folderLabel}/${base}`
  let index = 2

  while (used.has(candidate)) {
    const nextName = extensionMatch
      ? `${extensionMatch[1]} (${index})${extensionMatch[2]}`
      : `${base} (${index})`
    candidate = `${folderLabel}/${nextName}`
    index += 1
  }

  used.add(candidate)
  return candidate
}

export type RoomZipEntry = {
  path: string
  /** Se abre tarde, una a la vez: nadie descarga la sala entera por adelantado. */
  open: () => Promise<ReadableStream<Uint8Array>>
}

const EMPTY_CHUNK = new Uint8Array(0)

class RoomZipError extends Schema.TaggedError<RoomZipError>()('RoomZipError', {
  operation: Schema.Literals(['open', 'read', 'write', 'compress', 'close', 'timeout']),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

function zipPromise<A>(
  operation: RoomZipError['operation'],
  run: () => PromiseLike<A>
): Effect.Effect<A, RoomZipError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new RoomZipError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  })
}

function withSourceTimeout<A>(effect: Effect.Effect<A, RoomZipError>) {
  return effect.pipe(
    Effect.timeout(ZIP_ENTRY_TIMEOUT),
    Effect.mapError((error) =>
      Cause.isTimeoutError(error)
        ? new RoomZipError({
            operation: 'timeout',
            message: 'La entrada del ZIP excedio el tiempo permitido',
          })
        : error
    )
  )
}

// El motivo del aborto sale tal como lo produjo el documento (el error del
// `open`, no un envoltorio): el servidor lo clasifica por su nombre.
function abortReason(cause: Cause.Cause<RoomZipError>): unknown {
  const typed = Cause.findError(cause)
  if (Result.isSuccess(typed)) return typed.success.cause ?? typed.success
  return Cause.prettyErrors(cause)[0] ?? new Error('ROOM_ZIP_ABORTED')
}

/**
 * Zip STORE armado por partes.
 *
 * Una sala de 250 MB no cabe en una respuesta bufferizada: Vercel Functions
 * rechaza cualquier cuerpo mayor a 4.5 MB (FUNCTION_PAYLOAD_TOO_LARGE) y
 * materializar el archivo entero en memoria — blob, entrada del zip y buffer de
 * salida — arriesga un OOM mucho antes del tope. Aca cada documento se lee por
 * stream y se empuja al zip chunk por chunk; lo unico vivo en memoria es el
 * pedazo en transito, y `writer.ready` propaga la contrapresion del consumidor.
 *
 * Cada lector vive en su propio scope (`Effect.acquireRelease`): el lock del
 * stream se suelta aunque el documento falle a mitad de camino.
 *
 * Si un blob falla a mitad de camino el stream se ABORTA: el cliente recibe un
 * zip truncado o un error de red, nunca un 200 limpio con documentos ausentes.
 * `onAbort` deja la evidencia del lado del servidor.
 */
export function createRoomZipStream(
  entries: readonly RoomZipEntry[],
  onAbort?: (error: unknown) => void
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()

  const pending: Uint8Array[] = []
  let zipError: Error | null = null

  const zip = new Zip((error, chunk) => {
    if (error) {
      zipError = error
      return
    }
    if (chunk.length > 0) pending.push(chunk)
  })

  const drain = Effect.fn('RoomZip.drain')(function* (): Effect.fn.Return<void, RoomZipError> {
    while (pending.length > 0) {
      const chunk = pending.shift() as Uint8Array
      yield* zipPromise('write', () => writer.ready)
      yield* zipPromise('write', () => writer.write(chunk))
    }
    if (zipError) {
      return yield* new RoomZipError({
        operation: 'compress',
        message: zipError.message,
        cause: zipError,
      })
    }
  })

  const pumpEntry = Effect.fn('RoomZip.pumpEntry')(function* (entry: RoomZipEntry) {
    const body = yield* withSourceTimeout(zipPromise('open', () => entry.open()))
    const file = new ZipPassThrough(entry.path)
    zip.add(file)

    const reader = yield* Effect.acquireRelease(
      Effect.sync(() => body.getReader()),
      (acquired) => Effect.sync(() => acquired.releaseLock())
    )

    for (;;) {
      const chunk = yield* withSourceTimeout(zipPromise('read', () => reader.read()))
      if (chunk.done) break
      if (chunk.value.length > 0) {
        file.push(chunk.value, false)
        yield* drain()
      }
    }

    return file
  }, Effect.scoped)

  const pump = Effect.fn('RoomZip.pump')(function* () {
    for (const entry of entries) {
      const file = yield* pumpEntry(entry)
      file.push(EMPTY_CHUNK, true)
      yield* drain()
    }

    zip.end()
    yield* drain()
    yield* zipPromise('close', () => writer.close())
  })

  void runServerEffect(
    pump().pipe(
      Effect.catchCause((cause) => {
        const error = abortReason(cause)
        return Effect.tryPromise({
          try: async () => {
            onAbort?.(error)
            await writer.abort(error instanceof Error ? error : new Error('ROOM_ZIP_ABORTED'))
          },
          catch: (abortError) => abortError,
        }).pipe(Effect.ignore)
      })
    )
  )

  return readable
}
