// ============================================================================
// VDR READ MCP — minimal OOXML package reader
// ============================================================================
// DOCX and PPTX are ZIP archives of XML parts. Reading the two or three parts
// that carry text needs a central-directory walk and `inflateRaw`, both of
// which Node already ships — so this avoids pulling a general-purpose archive
// library into the server bundle.
//
// Bounded on purpose: entry count, per-entry inflated size and total inflated
// size are all capped, so a zip bomb cannot turn a document read into an OOM.
// ============================================================================

import { inflateRawSync } from 'node:zlib'

import { Effect, Schema } from 'effect'

export const ZIP_MAX_ENTRIES = 2_048
export const ZIP_MAX_ENTRY_BYTES = 32 * 1024 * 1024
export const ZIP_MAX_TOTAL_BYTES = 64 * 1024 * 1024

const SIGNATURE_EOCD = 0x06054b50
const SIGNATURE_CENTRAL = 0x02014b50
const SIGNATURE_LOCAL = 0x04034b50
const EOCD_MIN_SIZE = 22
const EOCD_MAX_COMMENT = 0xffff

export type ZipEntry = Readonly<{
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}>

export class ZipReadError extends Schema.TaggedError<ZipReadError>()('ZipReadError', {
  operation: Schema.Literals(['directory', 'entry', 'parts']),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

function zipError(
  operation: ZipReadError['operation'],
  message: string,
  cause?: unknown
): ZipReadError {
  return new ZipReadError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  })
}

function normalizeZipError(
  operation: ZipReadError['operation'],
  message: string,
  cause: unknown
): ZipReadError {
  return cause instanceof ZipReadError ? cause : zipError(operation, message, cause)
}

function findEndOfCentralDirectory(bytes: Uint8Array): number | null {
  if (bytes.byteLength < EOCD_MIN_SIZE) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const lowest = Math.max(0, bytes.byteLength - EOCD_MIN_SIZE - EOCD_MAX_COMMENT)
  for (let offset = bytes.byteLength - EOCD_MIN_SIZE; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === SIGNATURE_EOCD) return offset
  }
  return null
}

export const readZipEntriesEffect = Effect.fn('VdrZip.readEntries')(function* (
  bytes: Uint8Array
): Effect.fn.Return<ZipEntry[], ZipReadError> {
  return yield* Effect.try({
    try: () => {
      const eocd = findEndOfCentralDirectory(bytes)
      if (eocd === null) {
        throw zipError('directory', 'El paquete no contiene un directorio central válido.')
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

      const total = view.getUint16(eocd + 10, true)
      const directorySize = view.getUint32(eocd + 12, true)
      const directoryOffset = view.getUint32(eocd + 16, true)
      if (total > ZIP_MAX_ENTRIES) {
        throw zipError('directory', 'El paquete excede el máximo de entradas permitido.')
      }
      if (directoryOffset + directorySize > bytes.byteLength) {
        throw zipError('directory', 'El directorio central queda fuera del paquete.')
      }

      const entries: ZipEntry[] = []
      let cursor = directoryOffset
      for (let index = 0; index < total; index += 1) {
        if (cursor + 46 > bytes.byteLength) {
          throw zipError('directory', 'Una entrada del directorio central está truncada.')
        }
        if (view.getUint32(cursor, true) !== SIGNATURE_CENTRAL) {
          throw zipError('directory', 'Una entrada del directorio central tiene firma inválida.')
        }
        const method = view.getUint16(cursor + 10, true)
        const compressedSize = view.getUint32(cursor + 20, true)
        const uncompressedSize = view.getUint32(cursor + 24, true)
        const nameLength = view.getUint16(cursor + 28, true)
        const extraLength = view.getUint16(cursor + 30, true)
        const commentLength = view.getUint16(cursor + 32, true)
        const localHeaderOffset = view.getUint32(cursor + 42, true)
        const nameStart = cursor + 46
        if (nameStart + nameLength > bytes.byteLength) {
          throw zipError('directory', 'El nombre de una entrada queda fuera del paquete.')
        }

        const name = new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(nameStart, nameStart + nameLength)
        )
        entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset })
        cursor = nameStart + nameLength + extraLength + commentLength
      }
      return entries
    },
    catch: (cause) =>
      normalizeZipError('directory', 'No se pudo leer el directorio central del paquete.', cause),
  })
})

export const readZipEntryTextEffect = Effect.fn('VdrZip.readEntryText')(function* (
  bytes: Uint8Array,
  entry: ZipEntry
): Effect.fn.Return<string, ZipReadError> {
  return yield* Effect.try({
    try: () => {
      if (entry.uncompressedSize > ZIP_MAX_ENTRY_BYTES) {
        throw zipError('entry', 'La entrada excede el tamaño descomprimido permitido.')
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const header = entry.localHeaderOffset
      if (header + 30 > bytes.byteLength) {
        throw zipError('entry', 'La cabecera local de la entrada está truncada.')
      }
      if (view.getUint32(header, true) !== SIGNATURE_LOCAL) {
        throw zipError('entry', 'La cabecera local de la entrada tiene firma inválida.')
      }
      const nameLength = view.getUint16(header + 26, true)
      const extraLength = view.getUint16(header + 28, true)
      const dataStart = header + 30 + nameLength + extraLength
      const dataEnd = dataStart + entry.compressedSize
      if (dataEnd > bytes.byteLength) {
        throw zipError('entry', 'Los datos comprimidos de la entrada están truncados.')
      }

      const payload = bytes.subarray(dataStart, dataEnd)
      let inflated: Uint8Array
      if (entry.method === 0) {
        inflated = payload
      } else if (entry.method === 8) {
        inflated = inflateRawSync(payload, { maxOutputLength: ZIP_MAX_ENTRY_BYTES })
      } else {
        throw zipError('entry', 'La entrada usa un método de compresión no soportado.')
      }

      return new TextDecoder('utf-8', { fatal: false }).decode(inflated)
    },
    catch: (cause) => normalizeZipError('entry', 'No se pudo leer la entrada del paquete.', cause),
  })
})

export type OoxmlPart = Readonly<{ name: string; xml: string }>

/** Read the named XML parts of an OOXML package, in the order requested. */
export const readOoxmlPartsEffect = Effect.fn('VdrZip.readOoxmlParts')(function* (
  bytes: Uint8Array,
  matches: (name: string) => boolean
): Effect.fn.Return<OoxmlPart[], ZipReadError> {
  const entries = yield* readZipEntriesEffect(bytes)
  const selected = yield* Effect.try({
    try: () => entries.filter((entry) => matches(entry.name)),
    catch: (cause) => zipError('parts', 'No se pudieron seleccionar las partes OOXML.', cause),
  })
  const parts: OoxmlPart[] = []
  let total = 0
  for (const entry of selected) {
    const xml: string | null = yield* readZipEntryTextEffect(bytes, entry).pipe(
      Effect.catch(() => Effect.succeed<string | null>(null))
    )
    if (xml === null) continue
    total += xml.length
    if (total > ZIP_MAX_TOTAL_BYTES) break
    parts.push({ name: entry.name, xml })
  }
  return parts
})
