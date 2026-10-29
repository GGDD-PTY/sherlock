// ============================================================================
// INSPECCIÓN DE LOS BYTES QUE SUBE EL CLIENTE
// ============================================================================
// Todo lo de este módulo mira entrada no confiable, así que cada veredicto es
// una unión de literales declarada una sola vez y cada fallo tiene nombre: el
// `TextDecoder` que revienta ya no se pierde en un `catch {}` mudo, sale como
// un `Option.none()` que la única rama de rechazo convierte en INVALID_CSV.
//
// Las tres inspecciones asíncronas leen bytes del `Blob` y por eso viven como
// programas Effect: el IO cruza por `convexPromise` y `runConvex` devuelve la
// promesa que el llamador —una action de Convex o la ruta Next de subida— ya
// esperaba. Las firmas públicas no cambian.
// ============================================================================

import { Effect, Option } from 'effect'

import { convexPromise, runConvex } from '../_helpers/effect'
import { isDirectUploadMimeType, MAX_CSV_UPLOAD_BYTES } from './uploadLimits'
import { isOfficeMimeType, officeBytesMatchContentType } from './officeFileInspection'

export type FileSignature = 'PDF' | 'ZIP' | 'OLE' | 'TEXT' | 'UNKNOWN'

export type CsvInspectionResult = { safe: true } | { safe: false; code: 'INVALID_CSV' }

const CSV_DELIMITERS = [',', ';', '\t']

const INVALID_CSV = { safe: false, code: 'INVALID_CSV' } as const satisfies CsvInspectionResult

function isTextByte(byte: number): boolean {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte !== 0x7f)
}

/** UTF-8 estricto: la secuencia inválida es un veredicto, no una excepción. */
function decodeStrictUtf8(bytes: Uint8Array): Option.Option<string> {
  try {
    return Option.some(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return Option.none()
  }
}

/**
 * A CSV is the only allowlisted source without magic bytes, so it is verified by
 * shape: bounded size, strict UTF-8, no control bytes, a delimited header and at
 * least one data row. Anything else (a zip, a PDF, a binary renamed .csv) fails.
 */
const inspectCsvProgram = Effect.fn('DocumentInspection.csv')(function* (
  blob: Blob,
  options: { maxBytes?: number }
) {
  const maxBytes = options.maxBytes ?? MAX_CSV_UPLOAD_BYTES
  if (blob.size === 0 || blob.size > maxBytes) return INVALID_CSV

  const buffer = yield* convexPromise(() => blob.arrayBuffer())
  const bytes = new Uint8Array(buffer)
  if (detectFileSignature(bytes.subarray(0, 16)) !== 'TEXT') return INVALID_CSV

  const decoded = decodeStrictUtf8(bytes)
  if (Option.isNone(decoded)) return INVALID_CSV
  const text = decoded.value

  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return INVALID_CSV

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 2) return INVALID_CSV
  const header = lines[0].replace(/^\uFEFF/, '')
  if (!CSV_DELIMITERS.some((delimiter) => header.includes(delimiter))) return INVALID_CSV

  return { safe: true } satisfies CsvInspectionResult
})

export function inspectCsvFile(
  blob: Blob,
  options: { maxBytes?: number } = {}
): Promise<CsvInspectionResult> {
  return runConvex(inspectCsvProgram(blob, options))
}

export type ZipSafetyResult =
  | { safe: true; entries: number; compressedBytes: number; uncompressedBytes: number }
  | { safe: false; code: 'INVALID_ARCHIVE' | 'ENCRYPTED_ARCHIVE' | 'ZIP_BOMB' }

type ZipSafetyRejectionCode = 'INVALID_ARCHIVE' | 'ENCRYPTED_ARCHIVE' | 'ZIP_BOMB'

const zipUnsafe = (code: ZipSafetyRejectionCode) =>
  ({ safe: false, code }) satisfies ZipSafetyResult

// These limits are intentionally independent from the upload-size ceiling.
// A tiny compressed OOXML container can still expand into an unsafe amount of
// work. They are conservative enough for real Office files while rejecting the
// high-ratio / high-entry shapes used by decompression bombs.
const ZIP_SAFETY_LIMITS = {
  maxEntries: 10_000,
  maxEntryUncompressedBytes: 512 * 1024 * 1024,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxEocdSearchBytes: 65_557,
} as const

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50

function findEndOfCentralDirectory(bytes: Uint8Array): Option.Option<number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return Option.some(offset)
  }
  return Option.none()
}

/**
 * Reads ZIP metadata only; it never decompresses attacker-controlled bytes.
 * OOXML files (docx/xlsx/pptx) are ZIP containers, so this check happens before
 * a version can become active or reach any viewer/indexer/scanner.
 */
const inspectZipSafetyProgram = Effect.fn('DocumentInspection.zip')(function* (blob: Blob) {
  const tailStart = Math.max(0, blob.size - ZIP_SAFETY_LIMITS.maxEocdSearchBytes)
  const tailBuffer = yield* convexPromise(() => blob.slice(tailStart).arrayBuffer())
  const tail = new Uint8Array(tailBuffer)
  const eocd = findEndOfCentralDirectory(tail)
  if (Option.isNone(eocd) || eocd.value + 22 > tail.byteLength) {
    return zipUnsafe('INVALID_ARCHIVE')
  }
  const eocdOffset = eocd.value

  const header = new DataView(tail.buffer, tail.byteOffset + eocdOffset)
  const diskNumber = header.getUint16(4, true)
  const centralDirectoryDisk = header.getUint16(6, true)
  const entriesOnDisk = header.getUint16(8, true)
  const totalEntries = header.getUint16(10, true)
  const centralDirectorySize = header.getUint32(12, true)
  const centralDirectoryOffset = header.getUint32(16, true)
  const commentLength = header.getUint16(20, true)

  // Multi-disk and ZIP64 sentinels are unsupported and therefore fail closed.
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== totalEntries ||
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff ||
    eocdOffset + 22 + commentLength > tail.byteLength ||
    totalEntries > ZIP_SAFETY_LIMITS.maxEntries ||
    centralDirectoryOffset + centralDirectorySize > blob.size
  ) {
    return zipUnsafe('INVALID_ARCHIVE')
  }

  const centralBuffer = yield* convexPromise(() =>
    blob.slice(centralDirectoryOffset, centralDirectoryOffset + centralDirectorySize).arrayBuffer()
  )
  const centralBytes = new Uint8Array(centralBuffer)
  const central = new DataView(
    centralBytes.buffer,
    centralBytes.byteOffset,
    centralBytes.byteLength
  )
  let cursor = 0
  let parsedEntries = 0
  let compressedBytes = 0
  let uncompressedBytes = 0

  while (parsedEntries < totalEntries) {
    if (
      cursor + 46 > centralBytes.byteLength ||
      central.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE
    ) {
      return zipUnsafe('INVALID_ARCHIVE')
    }

    const flags = central.getUint16(cursor + 8, true)
    const compressedSize = central.getUint32(cursor + 20, true)
    const uncompressedSize = central.getUint32(cursor + 24, true)
    const filenameLength = central.getUint16(cursor + 28, true)
    const extraLength = central.getUint16(cursor + 30, true)
    const fileCommentLength = central.getUint16(cursor + 32, true)
    const recordLength = 46 + filenameLength + extraLength + fileCommentLength

    if ((flags & 0x1) !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      return (flags & 0x1) !== 0 ? zipUnsafe('ENCRYPTED_ARCHIVE') : zipUnsafe('INVALID_ARCHIVE')
    }
    if (cursor + recordLength > centralBytes.byteLength) {
      return zipUnsafe('INVALID_ARCHIVE')
    }

    compressedBytes += compressedSize
    uncompressedBytes += uncompressedSize
    const entryRatio =
      compressedSize === 0
        ? uncompressedSize > 0
          ? Infinity
          : 1
        : uncompressedSize / compressedSize
    const totalRatio =
      compressedBytes === 0
        ? uncompressedBytes > 0
          ? Infinity
          : 1
        : uncompressedBytes / compressedBytes
    if (
      uncompressedSize > ZIP_SAFETY_LIMITS.maxEntryUncompressedBytes ||
      uncompressedBytes > ZIP_SAFETY_LIMITS.maxTotalUncompressedBytes ||
      entryRatio > ZIP_SAFETY_LIMITS.maxCompressionRatio ||
      totalRatio > ZIP_SAFETY_LIMITS.maxCompressionRatio
    ) {
      return zipUnsafe('ZIP_BOMB')
    }

    cursor += recordLength
    parsedEntries += 1
  }

  if (parsedEntries !== totalEntries) return zipUnsafe('INVALID_ARCHIVE')
  return {
    safe: true,
    entries: parsedEntries,
    compressedBytes,
    uncompressedBytes,
  } satisfies ZipSafetyResult
})

export function inspectZipSafety(blob: Blob): Promise<ZipSafetyResult> {
  return runConvex(inspectZipSafetyProgram(blob))
}

export function detectFileSignature(input: Uint8Array): FileSignature {
  const startsWith = (...signature: number[]) =>
    signature.every((value, index) => input[index] === value)

  if (startsWith(0x25, 0x50, 0x44, 0x46)) return 'PDF'
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) return 'ZIP'
  if (startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return 'OLE'
  // Text has no magic: a UTF-8 BOM or a window of printable bytes with no
  // control byte. The CSV inspection still decodes the whole file afterwards.
  const window = startsWith(0xef, 0xbb, 0xbf) ? input.subarray(3) : input
  if (window.length > 0 && window.every(isTextByte)) return 'TEXT'
  return 'UNKNOWN'
}

export function matchesDeclaredMimeType(mimeType: string, signature: FileSignature): boolean {
  // El guard del allowlist narrowea el string; antes era un `includes` sobre la
  // tupla casteada a `readonly string[]`, que aceptaba cualquier cosa y no
  // enseñaba nada al compilador.
  if (!isDirectUploadMimeType(mimeType)) return false
  if (mimeType === 'text/csv') return signature === 'TEXT'
  if (signature === 'TEXT') return false
  if (mimeType === 'application/pdf') return signature === 'PDF'

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return signature === 'ZIP'
  }

  return signature === 'OLE' || signature === 'ZIP'
}

/**
 * Validates the complete Office container, not only its magic bytes. A generic
 * ZIP, an OLE installer or a different Office subtype must fail closed.
 */
const inspectOfficeProgram = Effect.fn('DocumentInspection.office')(function* (
  blob: Blob,
  mimeType: string
) {
  if (!isOfficeMimeType(mimeType)) return false
  const buffer = yield* convexPromise(() => blob.arrayBuffer())
  return officeBytesMatchContentType(mimeType, new Uint8Array(buffer))
})

export function inspectOfficeFile(blob: Blob, mimeType: string): Promise<boolean> {
  return runConvex(inspectOfficeProgram(blob, mimeType))
}
