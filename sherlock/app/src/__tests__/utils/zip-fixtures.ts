// ============================================================================
// ZIP FIXTURES — contenedores ZIP mínimos pero ESTRUCTURALMENTE reales
// ============================================================================
// La validación OOXML parsea la estructura real del ZIP (End of Central
// Directory al final → central directory → local headers → datos de entrada,
// incluida la DESCOMPRESIÓN del manifiesto [Content_Types].xml), no un
// marcador ASCII en un prefijo. Los fixtures traen local file headers, central
// directory y EOCD de verdad, con entradas stored o deflate reales, para
// ejercitar ese parser — incluidas sus ramas de rechazo (cifrado, método
// exótico, tamaños inconsistentes, deflate corrupto).

import { deflateRawSync } from 'node:zlib'

export interface ZipFixtureEntry {
  name: string
  data?: Uint8Array
  // Overrides para ejercitar las ramas de rechazo del parser. Por defecto la
  // entrada va stored (método 0, sin flags) con los tamaños reales de `data`
  // y el CRC-32 real de `data` (el validador lo contrasta con el central
  // directory). `compressedData` define los bytes CRUDOS del payload (p. ej.
  // deflate real o basura corrupta); con él, el método por defecto pasa a 8
  // (deflate). `crc32` fuerza un checksum declarado distinto del real.
  method?: number
  flags?: number
  compressedData?: Uint8Array
  uncompressedSize?: number
  crc32?: number
  // Escribe el data descriptor opcional (firma PK\x07\x08 + CRC + tamaños)
  // tras el payload y declara el flag 0x0008, como los escritores streaming
  // (java.util.zip y derivados). El validador tesela sobre él.
  dataDescriptor?: boolean
}

export interface ZipFixtureOptions {
  // Comentario REAL del EOCD (largo declarado consistente): un ZIP legítimo
  // con comentario tiene que seguir aceptándose.
  comment?: string
}

const encoder = new TextEncoder()

// CRC-32 (ISO 3309) de los bytes descomprimidos — lo que un escritor ZIP real
// declara por entrada y el validador OOXML verifica.
function crc32Of(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index++) {
    crc ^= bytes[index]
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function asciiBytes(text: string): Uint8Array {
  return encoder.encode(text)
}

/** Entrada comprimida con deflate REAL (como escribe Office el manifiesto). */
function deflatedEntry(name: string, data: Uint8Array): ZipFixtureEntry {
  return { name, data, compressedData: new Uint8Array(deflateRawSync(data)) }
}

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff]
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
}

// Append sin spread: `push(...data)` revienta la pila con payloads grandes
// (los fixtures de bomba de descompresión declaran megas).
function appendBytes(target: number[], source: Uint8Array | number[]): void {
  for (let index = 0; index < source.length; index++) {
    target.push(source[index])
  }
}

export function buildZipFixture(
  entries: Array<string | ZipFixtureEntry>,
  options: ZipFixtureOptions = {}
): Uint8Array {
  const normalized = entries.map((entry) =>
    typeof entry === 'string' ? { name: entry, data: new Uint8Array(0) } : entry
  )

  const bytes: number[] = []
  const localOffsets: number[] = []

  const entryFields = (entry: ZipFixtureEntry) => {
    const data = entry.data ?? new Uint8Array(0)
    const payload = entry.compressedData ?? data
    return {
      payload,
      method: entry.method ?? (entry.compressedData ? 8 : 0),
      flags: (entry.flags ?? 0) | (entry.dataDescriptor ? 0x0008 : 0),
      crc32: entry.crc32 ?? crc32Of(data),
      compressedSize: payload.length,
      uncompressedSize: entry.uncompressedSize ?? data.length,
    }
  }

  for (const entry of normalized) {
    const { payload, method, flags, crc32, compressedSize, uncompressedSize } = entryFields(entry)
    const nameBytes = encoder.encode(entry.name)
    localOffsets.push(bytes.length)
    appendBytes(bytes, [
      0x50,
      0x4b,
      0x03,
      0x04, // local file header signature
      ...u16(20), // version needed to extract
      ...u16(flags), // general purpose flags
      ...u16(method), // compression method
      ...u16(0), // mod time
      ...u16(0), // mod date
      ...u32(crc32),
      ...u32(compressedSize),
      ...u32(uncompressedSize),
      ...u16(nameBytes.length),
      ...u16(0), // extra field length
    ])
    appendBytes(bytes, nameBytes)
    appendBytes(bytes, payload)
    if (entry.dataDescriptor) {
      appendBytes(bytes, [0x50, 0x4b, 0x07, 0x08]) // data descriptor signature
      appendBytes(bytes, u32(crc32))
      appendBytes(bytes, u32(compressedSize))
      appendBytes(bytes, u32(uncompressedSize))
    }
  }

  const centralDirectoryOffset = bytes.length
  normalized.forEach((entry, index) => {
    const { method, flags, crc32, compressedSize, uncompressedSize } = entryFields(entry)
    const nameBytes = encoder.encode(entry.name)
    appendBytes(bytes, [
      0x50,
      0x4b,
      0x01,
      0x02, // central directory entry signature
      ...u16(20), // version made by
      ...u16(20), // version needed to extract
      ...u16(flags),
      ...u16(method),
      ...u16(0), // mod time
      ...u16(0), // mod date
      ...u32(crc32),
      ...u32(compressedSize),
      ...u32(uncompressedSize),
      ...u16(nameBytes.length),
      ...u16(0), // extra field length
      ...u16(0), // comment length
      ...u16(0), // disk number start
      ...u16(0), // internal attributes
      ...u32(0), // external attributes
      ...u32(localOffsets[index]), // local header offset
    ])
    appendBytes(bytes, nameBytes)
  })
  const centralDirectorySize = bytes.length - centralDirectoryOffset

  const commentBytes = encoder.encode(options.comment ?? '')
  appendBytes(bytes, [
    0x50,
    0x4b,
    0x05,
    0x06, // EOCD signature
    ...u16(0), // disk number
    ...u16(0), // central directory start disk
    ...u16(normalized.length), // entries on this disk
    ...u16(normalized.length), // total entries
    ...u32(centralDirectorySize),
    ...u32(centralDirectoryOffset),
    ...u16(commentBytes.length), // comment length
  ])
  appendBytes(bytes, commentBytes)

  return new Uint8Array(bytes)
}

// ============================================================================
// VARIANTE DE CONTRABANDO — cola anexada a un ZIP válido
// ============================================================================
// Bytes sueltos después del EOCD: un validador estructural debe rechazarlos.

/** ZIP válido + bytes arbitrarios detrás del EOCD. */
export function zipWithAppendedTail(zip: Uint8Array, tail: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(zip.length + tail.length)
  bytes.set(zip)
  bytes.set(tail, zip.length)
  return bytes
}

// ============================================================================
// PAQUETES OOXML VÁLIDOS POR SUBTIPO
// ============================================================================
// La validación exige la parte principal del subtipo (no vacía y con el XML
// raíz del subtipo en su namespace ECMA-376), que el manifiesto
// [Content_Types].xml la declare vía <Override> con el content type principal
// y que las relaciones raíz (_rels/.rels) la conecten vía una <Relationship>
// officeDocument. Estos helpers construyen paquetes mínimos que cumplen
// ECMA-376 en lo que el parser verifica.

export type OoxmlFixtureKind = 'xlsx' | 'docx' | 'pptx'

const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

const OOXML_FIXTURE_RULES: Record<
  OoxmlFixtureKind,
  { part: string; contentType: string; rootXml: string }
> = {
  xlsx: {
    part: 'xl/workbook.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    rootXml:
      XML_PROLOG +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>',
  },
  docx: {
    part: 'word/document.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    rootXml:
      XML_PROLOG +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
  },
  pptx: {
    part: 'ppt/presentation.xml',
    contentType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    rootXml:
      XML_PROLOG +
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
  },
}

function ooxmlManifest(kind: OoxmlFixtureKind): string {
  const rule = OOXML_FIXTURE_RULES[kind]
  return (
    XML_PROLOG +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/${rule.part}" ContentType="${rule.contentType}"/>` +
    '</Types>'
  )
}

function ooxmlRootRels(kind: OoxmlFixtureKind): string {
  const rule = OOXML_FIXTURE_RULES[kind]
  return (
    XML_PROLOG +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"' +
    ` Target="${rule.part}"/>` +
    '</Relationships>'
  )
}

export interface OoxmlFixtureOptions {
  // El manifiesto va deflate (como lo escribe Office) en vez de stored.
  deflateManifest?: boolean
  // Sustituye el XML del manifiesto (p. ej. uno vacío o de otro subtipo).
  manifestXml?: string
  // Omite la parte principal (manifiesto copiado sin las partes reales).
  omitRequiredPart?: boolean
  // Sustituye el XML de la parte principal (p. ej. raíz de otro subtipo).
  mainPartXml?: string
  // La parte principal va deflate (como la escribe Office) en vez de stored.
  deflateMainPart?: boolean
  // Omite _rels/.rels (el grafo raíz que un ZIP disfrazado no trae).
  omitRootRels?: boolean
  // Sustituye el XML de _rels/.rels (p. ej. relación a otra parte o External).
  rootRelsXml?: string
  // Entradas adicionales, ANTES del manifiesto y la parte principal.
  extraEntries?: Array<string | ZipFixtureEntry>
  // Comentario real del EOCD (algunos escritores lo emiten; sigue siendo un
  // paquete válido mientras el largo declarado termine el archivo).
  comment?: string
}

export function buildOoxmlFixture(
  kind: OoxmlFixtureKind,
  options: OoxmlFixtureOptions = {}
): Uint8Array {
  const rule = OOXML_FIXTURE_RULES[kind]
  const manifestBytes = asciiBytes(options.manifestXml ?? ooxmlManifest(kind))
  const manifestEntry: ZipFixtureEntry = options.deflateManifest
    ? deflatedEntry('[Content_Types].xml', manifestBytes)
    : { name: '[Content_Types].xml', data: manifestBytes }

  const entries: Array<string | ZipFixtureEntry> = [...(options.extraEntries ?? []), manifestEntry]
  if (!options.omitRootRels) {
    entries.push({
      name: '_rels/.rels',
      data: asciiBytes(options.rootRelsXml ?? ooxmlRootRels(kind)),
    })
  }
  if (!options.omitRequiredPart) {
    const mainPartBytes = asciiBytes(options.mainPartXml ?? rule.rootXml)
    entries.push(
      options.deflateMainPart
        ? deflatedEntry(rule.part, mainPartBytes)
        : { name: rule.part, data: mainPartBytes }
    )
  }
  return buildZipFixture(entries, { comment: options.comment })
}
