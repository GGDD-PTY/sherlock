// ============================================================================
// OFFICE CONTAINER INSPECTION
// ============================================================================
// Deep, fail-closed parser for the six Office MIME types accepted by the VDR.
// The public interface stays intentionally small; ZIP/OPC, raw deflate, CRC-32
// and OLE/CFB complexity remains private to this module.
// ============================================================================

import { Option, Schema } from 'effect'

const OFFICE_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/msword',
  'application/vnd.ms-powerpoint',
] as const

const OfficeMimeTypeSchema = Schema.Literals(OFFICE_MIME_TYPES)

// El guard narrowea el string a los seis tipos admitidos. Antes era un
// `includes` sobre la tupla casteada a `readonly string[]`: respondía la
// pregunta pero no le enseñaba nada al compilador, así que el `contentType`
// seguía siendo `string` en todo el parser de abajo.
export const isOfficeMimeType = Schema.is(OfficeMimeTypeSchema)

type OfficeSignature = 'ZIP' | 'OLE' | 'UNKNOWN'

function detectOfficeSignature(bytes: Uint8Array): OfficeSignature {
  const startsWith = (...signature: number[]) =>
    signature.every((value, index) => bytes[index] === value)

  if (startsWith(0x50, 0x4b, 0x03, 0x04)) return 'ZIP'
  if (startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return 'OLE'
  return 'UNKNOWN'
}

// Un paquete OOXML es un ZIP, pero un ZIP cualquiera NO es un paquete OOXML:
// aceptar la firma ZIP genérica para .xlsx/.docx/.pptx dejaría puentear la
// exclusión deliberada de ZIP de la allowlist renombrando el archivo.
// Se parsea la estructura REAL del ZIP sobre el archivo COMPLETO (End of
// Central Directory al final → central directory) y se exige lo que ECMA-376
// exige de un paquete del subtipo declarado:
//   1. la PARTE principal del formato en el central directory y no vacía
//      (xl/workbook.xml, word/document.xml o ppt/presentation.xml),
//   2. el manifiesto [Content_Types].xml DESCOMPRIMIDO Y VALIDADO: tiene que
//      declarar (vía <Override>) el content type principal del subtipo para
//      esa parte,
//   3. las relaciones RAÍZ del paquete (_rels/.rels) DESCOMPRIMIDAS Y
//      VALIDADAS: una <Relationship> de tipo officeDocument tiene que apuntar
//      a esa parte principal (OPC exige ese grafo — sin él, Office ni abre el
//      archivo), y
//   4. el XML REAL de la parte principal: su elemento raíz tiene que ser el
//      del subtipo (<workbook>/<document>/<presentation>) en el namespace
//      ECMA-376 correspondiente (transitional o strict).
// Historia de este validador: primero solo se exigía una ENTRADA llamada
// [Content_Types].xml (un ZIP arbitrario con una entrada vacía con ese nombre
// pasaba); validar el manifiesto cerró ese disfraz, pero la parte principal
// solo se verificaba por NOMBRE y tamaño no-cero — un ZIP genérico con un
// xl/workbook.xml de un byte, un manifiesto copiado y ejecutables como resto
// del contenido seguía pasando. Exigir el grafo de relaciones y el XML raíz
// del subtipo cierra ese segundo disfraz.
// Sin soporte ZIP64, sin cifrado y sin métodos de compresión exóticos (solo
// stored y deflate, los únicos que Office escribe): cualquier otra cosa, y
// cualquier estructura malformada, rechaza (fail closed).
const OOXML_CONTENT_TYPES_ENTRY = '[Content_Types].xml'
const OOXML_CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types'
const OOXML_PACKAGE_RELS_ENTRY = '_rels/.rels'
const OOXML_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships'

// Tipo de la relación raíz → parte principal. ECMA-376 transitional y la
// variante strict (ISO/IEC 29500 Strict, la opción "Strict Open XML" de
// Office). Comparación en minúsculas.
const OOXML_OFFICE_DOCUMENT_RELATIONSHIP_TYPES = [
  'http://schemas.openxmlformats.org/officedocument/2006/relationships/officedocument',
  'http://purl.oclc.org/ooxml/officedocument/relationships/officedocument',
]

// Techo del manifiesto descomprimido: uno real mide un par de KB; un manifiesto
// que declara megas es una bomba de descompresión, no un documento Office.
// El mismo techo acota _rels/.rels (aún más chico en un paquete real).
const OOXML_MANIFEST_MAX_BYTES = 1 << 20

// Prefijo DESCOMPRIMIDO de la parte principal que alcanza para el prólogo XML
// y el tag raíz con sus namespaces. La parte completa de un .docx real puede
// medir decenas de MB (es el texto entero del documento): inflarla toda para
// mirar el tag raíz sería la bomba de descompresión que el resto del parser
// evita.
const OOXML_MAIN_PART_SNIFF_BYTES = 64 * 1024

// Techo del tamaño DESCOMPRIMIDO declarado de la parte principal. El stream
// deflate se decodifica ENTERO para validarlo (descartando lo que excede el
// prefijo retenido), así que sin techo un central directory que declara 4GB
// obligaría a decodificar 4GB. Un document.xml real mide decenas de MB.
const OOXML_MAIN_PART_MAX_INFLATED_BYTES = 64 * 1024 * 1024

interface OoxmlSubtypeRule {
  // Parte principal que el subtipo declarado exige dentro del paquete.
  readonly requiredPart: string
  // Content type que el manifiesto tiene que declarar para esa parte.
  readonly mainPartContentType: string
  // Elemento raíz (local name) que el XML de la parte principal tiene que traer.
  readonly mainPartRootLocalName: string
  // Namespaces válidos de ese elemento raíz (ECMA-376 transitional y strict).
  readonly mainPartNamespaces: readonly string[]
}

const OOXML_SPREADSHEET_RULE: OoxmlSubtypeRule = {
  requiredPart: 'xl/workbook.xml',
  mainPartContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  mainPartRootLocalName: 'workbook',
  mainPartNamespaces: [
    'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'http://purl.oclc.org/ooxml/spreadsheetml/main',
  ],
}

const OOXML_WORD_RULE: OoxmlSubtypeRule = {
  requiredPart: 'word/document.xml',
  mainPartContentType:
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  mainPartRootLocalName: 'document',
  mainPartNamespaces: [
    'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'http://purl.oclc.org/ooxml/wordprocessingml/main',
  ],
}

const OOXML_PRESENTATION_RULE: OoxmlSubtypeRule = {
  requiredPart: 'ppt/presentation.xml',
  mainPartContentType:
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  mainPartRootLocalName: 'presentation',
  mainPartNamespaces: [
    'http://schemas.openxmlformats.org/presentationml/2006/main',
    'http://purl.oclc.org/ooxml/presentationml/main',
  ],
}

// Los tipos legacy también admiten un OOXML renombrado (un .xlsx que viaja
// como application/vnd.ms-excel): heredan la regla del subtipo moderno.
const OOXML_SUBTYPE_RULES: Readonly<Record<string, OoxmlSubtypeRule>> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': OOXML_SPREADSHEET_RULE,
  'application/vnd.ms-excel': OOXML_SPREADSHEET_RULE,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': OOXML_WORD_RULE,
  'application/msword': OOXML_WORD_RULE,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    OOXML_PRESENTATION_RULE,
  'application/vnd.ms-powerpoint': OOXML_PRESENTATION_RULE,
}

const ZIP_EOCD_SIGNATURE = 0x06054b50 // PK\x05\x06
const ZIP_CENTRAL_ENTRY_SIGNATURE = 0x02014b50 // PK\x01\x02
const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50 // PK\x03\x04
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50 // PK\x07\x08
const ZIP_EOCD_MIN_BYTES = 22
const ZIP_MAX_COMMENT_BYTES = 0xffff
const ZIP_CENTRAL_ENTRY_HEADER_BYTES = 46
const ZIP_LOCAL_HEADER_BYTES = 30
const ZIP_DATA_DESCRIPTOR_BYTES = 12
const ZIP_METHOD_STORED = 0
const ZIP_METHOD_DEFLATE = 8
const ZIP_FLAG_ENCRYPTED = 0x0001
const ZIP_FLAG_DATA_DESCRIPTOR = 0x0008

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) +
    bytes[offset + 3] * 0x1000000
  )
}

// El EOCD vive al final del archivo, seguido solo por su comentario (máx.
// 65535 bytes): se escanea hacia atrás desde el final dentro de esa ventana.
// El registro tiene que TERMINAR el archivo: su comment length declarado debe
// llegar exactamente hasta bytes.length. Sin eso, un .xlsx válido con
// contrabando anexado (o con un EOCD duplicado tras el payload) pasaba: el
// escaneo aceptaba la primera firma que encontrara dentro de la ventana.
function findZipEndOfCentralDirectory(bytes: Uint8Array): Option.Option<number> {
  const lastCandidate = bytes.length - ZIP_EOCD_MIN_BYTES
  const firstCandidate = Math.max(0, lastCandidate - ZIP_MAX_COMMENT_BYTES)
  for (let offset = lastCandidate; offset >= firstCandidate; offset--) {
    if (readUint32LE(bytes, offset) !== ZIP_EOCD_SIGNATURE) continue
    const commentLength = readUint16LE(bytes, offset + 20)
    if (offset + ZIP_EOCD_MIN_BYTES + commentLength !== bytes.length) continue
    return Option.some(offset)
  }
  return Option.none()
}

interface ZipCentralEntry {
  readonly name: string
  readonly flags: number
  readonly method: number
  readonly crc32: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localHeaderOffset: number
}

// Central directory completo, o null si la estructura está malformada
// (fail closed). Los nombres de entrada de un paquete OOXML son ASCII.
function readZipCentralDirectory(
  bytes: Uint8Array,
  eocdOffset: number
): Option.Option<ZipCentralEntry[]> {
  const diskNumber = readUint16LE(bytes, eocdOffset + 4)
  const centralDirectoryStartDisk = readUint16LE(bytes, eocdOffset + 6)
  const entriesOnThisDisk = readUint16LE(bytes, eocdOffset + 8)
  const totalEntries = readUint16LE(bytes, eocdOffset + 10)
  const centralDirectorySize = readUint32LE(bytes, eocdOffset + 12)
  const centralDirectoryOffset = readUint32LE(bytes, eocdOffset + 16)

  // Archivos multi-disco: fuera de contrato (ningún escritor Office los emite).
  if (diskNumber !== 0 || centralDirectoryStartDisk !== 0) return Option.none()
  if (entriesOnThisDisk !== totalEntries) return Option.none()
  // 0xffff/0xffffffff son los centinelas de ZIP64 — fuera de contrato aquí.
  if (totalEntries === 0 || totalEntries === 0xffff) return Option.none()
  if (centralDirectoryOffset === 0xffffffff) return Option.none()
  // El central directory tiene que ABUTIR el EOCD exactamente: con `>` como
  // única cota, un EOCD duplicado al final podía apuntar al central directory
  // original y dejar megas de contrabando en el hueco intermedio.
  if (centralDirectoryOffset + centralDirectorySize !== eocdOffset) return Option.none()

  const entries: ZipCentralEntry[] = []
  let offset = centralDirectoryOffset
  for (let entry = 0; entry < totalEntries; entry++) {
    if (offset + ZIP_CENTRAL_ENTRY_HEADER_BYTES > eocdOffset) return Option.none()
    if (readUint32LE(bytes, offset) !== ZIP_CENTRAL_ENTRY_SIGNATURE) return Option.none()

    const flags = readUint16LE(bytes, offset + 8)
    const method = readUint16LE(bytes, offset + 10)
    const crc32 = readUint32LE(bytes, offset + 16)
    const compressedSize = readUint32LE(bytes, offset + 20)
    const uncompressedSize = readUint32LE(bytes, offset + 24)
    const nameLength = readUint16LE(bytes, offset + 28)
    const extraLength = readUint16LE(bytes, offset + 30)
    const commentLength = readUint16LE(bytes, offset + 32)
    const localHeaderOffset = readUint32LE(bytes, offset + 42)
    const nameStart = offset + ZIP_CENTRAL_ENTRY_HEADER_BYTES
    if (nameStart + nameLength > eocdOffset) return Option.none()
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) return Option.none()
    if (localHeaderOffset === 0xffffffff) return Option.none()

    let name = ''
    for (let index = 0; index < nameLength; index++) {
      name += String.fromCharCode(bytes[nameStart + index])
    }

    entries.push({
      name,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    })
    offset = nameStart + nameLength + extraLength + commentLength
  }

  // Las entradas tienen que consumir el central directory EXACTO: slack al
  // final del directorio también es espacio para contrabando.
  if (offset !== eocdOffset) return Option.none()

  return Option.some(entries)
}

// ¿Los local headers y sus payloads teselan [0, centralDirectoryOffset) sin
// huecos? Con el EOCD anclado al final y el central directory abutiéndolo,
// el único espacio que quedaba para contrabando era el tramo entre el último
// payload y el central directory (anexar payload + copia del central
// directory + EOCD ajustado). Cada entrada tiene que empezar donde terminó la
// anterior; tras el payload se admite el data descriptor opcional (con o sin
// firma PK\x07\x08) solo si el flag 0x0008 lo declara, y sus valores tienen
// que coincidir con el central directory. Fail closed en cualquier hueco.
function zipLocalEntriesTileFile(
  bytes: Uint8Array,
  entries: readonly ZipCentralEntry[],
  centralDirectoryOffset: number
): boolean {
  const sorted = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset)
  let expectedOffset = 0
  for (const entry of sorted) {
    if (entry.localHeaderOffset !== expectedOffset) return false
    if (expectedOffset + ZIP_LOCAL_HEADER_BYTES > centralDirectoryOffset) return false
    if (readUint32LE(bytes, expectedOffset) !== ZIP_LOCAL_HEADER_SIGNATURE) return false

    const flags = readUint16LE(bytes, expectedOffset + 6)
    const nameLength = readUint16LE(bytes, expectedOffset + 26)
    const extraLength = readUint16LE(bytes, expectedOffset + 28)
    let cursor =
      expectedOffset + ZIP_LOCAL_HEADER_BYTES + nameLength + extraLength + entry.compressedSize
    if (cursor > centralDirectoryOffset) return false

    if ((flags & ZIP_FLAG_DATA_DESCRIPTOR) !== 0) {
      let descriptorStart = cursor
      if (
        descriptorStart + 4 <= centralDirectoryOffset &&
        readUint32LE(bytes, descriptorStart) === ZIP_DATA_DESCRIPTOR_SIGNATURE
      ) {
        descriptorStart += 4
      }
      if (descriptorStart + ZIP_DATA_DESCRIPTOR_BYTES > centralDirectoryOffset) return false
      if (readUint32LE(bytes, descriptorStart) !== entry.crc32) return false
      if (readUint32LE(bytes, descriptorStart + 4) !== entry.compressedSize) return false
      if (readUint32LE(bytes, descriptorStart + 8) !== entry.uncompressedSize) return false
      cursor = descriptorStart + ZIP_DATA_DESCRIPTOR_BYTES
    }

    expectedOffset = cursor
  }
  return expectedOffset === centralDirectoryOffset
}

// Bytes DESCOMPRIMIDOS de una entrada, o null si la entrada está cifrada,
// usa un método fuera de contrato, declara tamaños inconsistentes, su
// payload no cabe donde el central directory dice o su CRC-32 real no
// coincide con el declarado (fail closed). Los tamaños confiables son los del
// central directory: el local header puede traer ceros cuando el escritor usó
// data descriptor.
function readZipEntryData(
  bytes: Uint8Array,
  entry: ZipCentralEntry,
  eocdOffset: number
): Option.Option<Uint8Array> {
  if ((entry.flags & ZIP_FLAG_ENCRYPTED) !== 0) return Option.none()
  if (entry.uncompressedSize > OOXML_MANIFEST_MAX_BYTES) return Option.none()
  if (entry.localHeaderOffset + ZIP_LOCAL_HEADER_BYTES > eocdOffset) return Option.none()
  if (readUint32LE(bytes, entry.localHeaderOffset) !== ZIP_LOCAL_HEADER_SIGNATURE)
    return Option.none()

  const nameLength = readUint16LE(bytes, entry.localHeaderOffset + 26)
  const extraLength = readUint16LE(bytes, entry.localHeaderOffset + 28)
  const dataStart = entry.localHeaderOffset + ZIP_LOCAL_HEADER_BYTES + nameLength + extraLength
  if (dataStart + entry.compressedSize > eocdOffset) return Option.none()

  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.method === ZIP_METHOD_STORED) {
    if (entry.compressedSize !== entry.uncompressedSize) return Option.none()
    return crc32Of(data) === entry.crc32 ? Option.some(data) : Option.none()
  }
  if (entry.method === ZIP_METHOD_DEFLATE) {
    const inflated = inflateRaw(data, OOXML_MANIFEST_MAX_BYTES)
    if (inflated === null || inflated.totalBytes !== entry.uncompressedSize) return Option.none()
    if (inflated.crc32 !== entry.crc32) return Option.none()
    return Option.some(inflated.bytes)
  }
  return Option.none()
}

// PREFIJO descomprimido de una entrada (hasta maxBytes), o null si la entrada
// está cifrada, usa un método fuera de contrato o el stream completo no es
// íntegro (fail closed). A diferencia de readZipEntryData NO retiene la
// entrada completa en memoria — la parte principal de un .docx real puede
// medir decenas de MB descomprimida — pero SÍ decodifica y valida el stream
// deflate ENTERO: estructura hasta el bloque final, tamaño declarado y
// CRC-32. Un prefijo XML válido seguido de una cola corrupta o arbitraria no
// es un paquete que Office abra; antes esa cola ni se miraba.
function readZipEntryDataPrefix(
  bytes: Uint8Array,
  entry: ZipCentralEntry,
  eocdOffset: number,
  maxBytes: number
): Option.Option<Uint8Array> {
  if ((entry.flags & ZIP_FLAG_ENCRYPTED) !== 0) return Option.none()
  if (entry.uncompressedSize > OOXML_MAIN_PART_MAX_INFLATED_BYTES) return Option.none()
  if (entry.localHeaderOffset + ZIP_LOCAL_HEADER_BYTES > eocdOffset) return Option.none()
  if (readUint32LE(bytes, entry.localHeaderOffset) !== ZIP_LOCAL_HEADER_SIGNATURE)
    return Option.none()

  const nameLength = readUint16LE(bytes, entry.localHeaderOffset + 26)
  const extraLength = readUint16LE(bytes, entry.localHeaderOffset + 28)
  const dataStart = entry.localHeaderOffset + ZIP_LOCAL_HEADER_BYTES + nameLength + extraLength
  if (dataStart + entry.compressedSize > eocdOffset) return Option.none()

  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.method === ZIP_METHOD_STORED) {
    if (entry.compressedSize !== entry.uncompressedSize) return Option.none()
    if (crc32Of(data) !== entry.crc32) return Option.none()
    return Option.some(data.subarray(0, Math.min(data.length, maxBytes)))
  }
  if (entry.method === ZIP_METHOD_DEFLATE) {
    const inflated = inflateRaw(data, entry.uncompressedSize, { retainBytes: maxBytes })
    if (inflated === null || inflated.totalBytes !== entry.uncompressedSize) return Option.none()
    if (inflated.crc32 !== entry.crc32) return Option.none()
    return Option.some(inflated.bytes)
  }
  return Option.none()
}

// Valor de un atributo XML dentro del tag ya aislado (comillas dobles o
// simples), o null si no está. El nombre puede venir de contenido del archivo
// (xmlns:<prefijo>), así que se escapa antes de armar el patrón.
function readXmlAttribute(attributes: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attributes)
  if (!match) return null
  return match[2] ?? match[3] ?? null
}

// ¿El manifiesto declara (vía <Override>) el content type principal del
// subtipo para su parte principal? ECMA-376: todo escritor Office real
// (Word/Excel/PowerPoint, LibreOffice, POI) declara la parte principal con un
// Override explícito. Comparaciones case-insensitive: los nombres de parte de
// OPC se resuelven sin distinguir mayúsculas y los media types tampoco las
// distinguen.
function ooxmlManifestDeclaresMainPart(manifest: string, rule: OoxmlSubtypeRule): boolean {
  if (!manifest.includes(OOXML_CONTENT_TYPES_NAMESPACE)) return false

  const expectedPartName = `/${rule.requiredPart}`.toLowerCase()
  const expectedContentType = rule.mainPartContentType.toLowerCase()

  for (const override of manifest.matchAll(/<(?:[A-Za-z0-9._-]+:)?Override\b([^>]*)>/g)) {
    const partName = readXmlAttribute(override[1], 'PartName')
    const contentType = readXmlAttribute(override[1], 'ContentType')
    if (
      partName?.toLowerCase() === expectedPartName &&
      contentType?.trim().toLowerCase() === expectedContentType
    ) {
      return true
    }
  }

  return false
}

// ¿Las relaciones raíz del paquete (_rels/.rels) traen una <Relationship>
// de tipo officeDocument que apunta a la parte principal del subtipo? OPC
// exige ese grafo: sin la relación raíz, Office ni siquiera encuentra el
// documento dentro del paquete. Un ZIP genérico con manifiesto copiado no la
// trae. Target relativo a la raíz del paquete ("xl/workbook.xml", a veces
// "/xl/workbook.xml" o "./xl/workbook.xml"); TargetMode External no prueba
// nada (apunta fuera del paquete).
function ooxmlRootRelationshipTargetsMainPart(
  relationships: string,
  rule: OoxmlSubtypeRule
): boolean {
  if (!relationships.includes(OOXML_RELATIONSHIPS_NAMESPACE)) return false

  const expectedTarget = rule.requiredPart.toLowerCase()

  for (const relationship of relationships.matchAll(
    /<(?:[A-Za-z0-9._-]+:)?Relationship\b([^>]*)>/g
  )) {
    const type = readXmlAttribute(relationship[1], 'Type')
    const target = readXmlAttribute(relationship[1], 'Target')
    if (!type || !target) continue
    const targetMode = readXmlAttribute(relationship[1], 'TargetMode')
    if (targetMode !== null && targetMode.trim().toLowerCase() !== 'internal') continue
    if (!OOXML_OFFICE_DOCUMENT_RELATIONSHIP_TYPES.includes(type.trim().toLowerCase())) continue

    const normalizedTarget = target
      .trim()
      .replace(/^\.?\//, '')
      .toLowerCase()
    if (normalizedTarget === expectedTarget) return true
  }

  return false
}

// ¿El prefijo XML de la parte principal abre con el elemento raíz del subtipo
// en su namespace ECMA-376? Se salta BOM, espacios, declaración XML,
// comentarios y processing instructions; el primer start-tag tiene que ser el
// raíz esperado Y declarar el namespace del subtipo para su propio prefijo
// (xmlns:<p> si el tag viene prefijado, xmlns si no). Un DOCTYPE rechaza:
// OPC no lo admite en sus partes. Fail closed en cualquier malformación.
function ooxmlMainPartRootElementMatches(xmlPrefix: string, rule: OoxmlSubtypeRule): boolean {
  let index = xmlPrefix.charCodeAt(0) === 0xfeff ? 1 : 0

  while (index < xmlPrefix.length) {
    const char = xmlPrefix[index]
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      index += 1
      continue
    }
    if (char !== '<') return false
    if (xmlPrefix.startsWith('<?', index)) {
      const end = xmlPrefix.indexOf('?>', index)
      if (end < 0) return false
      index = end + 2
      continue
    }
    if (xmlPrefix.startsWith('<!--', index)) {
      const end = xmlPrefix.indexOf('-->', index)
      if (end < 0) return false
      index = end + 3
      continue
    }
    if (xmlPrefix.startsWith('<!', index)) return false

    const end = xmlPrefix.indexOf('>', index)
    if (end < 0) return false
    const tag = xmlPrefix.slice(index + 1, end)
    const nameMatch = /^([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)([\s\S]*)$/.exec(tag)
    if (!nameMatch) return false

    const qualifiedName = nameMatch[1]
    const attributes = nameMatch[2]
    const colon = qualifiedName.indexOf(':')
    const prefix = colon >= 0 ? qualifiedName.slice(0, colon) : null
    const localName = colon >= 0 ? qualifiedName.slice(colon + 1) : qualifiedName
    if (localName !== rule.mainPartRootLocalName) return false

    const namespace = readXmlAttribute(attributes, prefix ? `xmlns:${prefix}` : 'xmlns')
    if (namespace === null) return false
    return rule.mainPartNamespaces.includes(namespace.trim())
  }

  return false
}

// Requiere los bytes COMPLETOS del archivo (el central directory vive al
// final) y el content-type Office declarado (fija QUÉ subtipo tiene que
// probar el paquete). Cualquier estructura malformada rechaza: fail closed.
function looksLikeOoxmlPackage(contentType: string, bytes: Uint8Array): boolean {
  const rule = OOXML_SUBTYPE_RULES[contentType]
  if (!rule) return false
  if (detectOfficeSignature(bytes) !== 'ZIP') return false
  if (bytes.length < ZIP_EOCD_MIN_BYTES) return false

  const eocd = findZipEndOfCentralDirectory(bytes)
  if (Option.isNone(eocd)) return false
  const eocdOffset = eocd.value

  const directory = readZipCentralDirectory(bytes, eocdOffset)
  if (Option.isNone(directory)) return false
  const entries = directory.value

  // El contenedor tiene que teselar el archivo COMPLETO: EOCD anclado al
  // final (arriba), central directory abutiéndolo (readZipCentralDirectory) y
  // entradas locales cubriendo [0, central directory) sin huecos. Sin las
  // tres, quedaba espacio para anexar contrabando a un paquete válido.
  const centralDirectoryOffset = readUint32LE(bytes, eocdOffset + 16)
  if (!zipLocalEntriesTileFile(bytes, entries, centralDirectoryOffset)) return false

  // La parte principal del subtipo tiene que EXISTIR y no venir vacía: un
  // manifiesto copiado de un Office real dentro de un ZIP sin las partes no
  // convierte al ZIP en documento. Su contenido se valida más abajo.
  const requiredPart = entries.find(
    (entry) => entry.name.toLowerCase() === rule.requiredPart.toLowerCase()
  )
  if (!requiredPart || requiredPart.uncompressedSize === 0) return false

  const manifestEntry = entries.find(
    (entry) => entry.name.toLowerCase() === OOXML_CONTENT_TYPES_ENTRY.toLowerCase()
  )
  if (!manifestEntry) return false

  const manifestBytes = readZipEntryData(bytes, manifestEntry, eocdOffset)
  if (Option.isNone(manifestBytes)) return false

  // Manifiesto UTF-8 (lo exige OPC); secuencias inválidas caen a U+FFFD y no
  // pueden formar los tokens exigidos.
  const manifest = new TextDecoder().decode(manifestBytes.value)
  if (!ooxmlManifestDeclaresMainPart(manifest, rule)) return false

  // El grafo de relaciones raíz: manifiesto + nombre de entrada no alcanzan
  // (un ZIP genérico con un xl/workbook.xml de un byte y un manifiesto copiado
  // pasaba). _rels/.rels tiene que conectar el paquete con su parte principal.
  const relationshipsEntry = entries.find(
    (entry) => entry.name.toLowerCase() === OOXML_PACKAGE_RELS_ENTRY.toLowerCase()
  )
  if (!relationshipsEntry) return false

  const relationshipsBytes = readZipEntryData(bytes, relationshipsEntry, eocdOffset)
  if (Option.isNone(relationshipsBytes)) return false
  if (
    !ooxmlRootRelationshipTargetsMainPart(new TextDecoder().decode(relationshipsBytes.value), rule)
  ) {
    return false
  }

  // Y el XML REAL de la parte principal: su elemento raíz tiene que ser el del
  // subtipo declarado. Solo se RETIENE un prefijo acotado (el prólogo y el tag
  // raíz viven al inicio; acumular un document.xml completo sería la bomba de
  // descompresión que el resto del parser evita), pero el stream deflate se
  // decodifica y valida ENTERO — estructura, tamaño y CRC-32 — para que una
  // cola corrupta o arbitraria detrás de un prefijo válido rechace.
  const mainPartPrefix = readZipEntryDataPrefix(
    bytes,
    requiredPart,
    eocdOffset,
    OOXML_MAIN_PART_SNIFF_BYTES
  )
  if (Option.isNone(mainPartPrefix)) return false
  return ooxmlMainPartRootElementMatches(new TextDecoder().decode(mainPartPrefix.value), rule)
}

// ============================================================================
// INFLATE (RFC 1951) MÍNIMO Y ACOTADO — SOLO PARA ENTRADAS OOXML
// ============================================================================
// Office escribe sus partes con deflate. Este módulo tiene que seguir PURO
// (lo importan el runtime de Convex — sin node:zlib — y la ruta Next), así
// que se descomprime con esta implementación propia del algoritmo de puff
// (la referencia de zlib): bloques stored, Huffman fijo y Huffman dinámico.
// SIEMPRE decodifica el stream COMPLETO hasta su bloque final — un prefijo
// válido con la cola sin validar no prueba nada — y devuelve el largo total
// y el CRC-32 del output para contrastarlos con el central directory. Techo
// de salida explícito (maxOutputBytes) y fail closed en CUALQUIER
// malformación (código sobre-suscrito, distancia fuera del historial, bloque
// truncado, salida que excede el techo): devuelve null, jamás lanza.
// Con retainBytes se RETIENE en memoria solo ese prefijo del output (lo usa
// el sniff del tag raíz de la parte principal, que puede medir decenas de MB
// descomprimida): el resto se decodifica y valida igual, vía una ventana
// deslizante de 32KB para las back-references, pero no se acumula.

// CRC-32 (ISO 3309, polinomio reflejado 0xEDB88320): el checksum que el ZIP
// declara por entrada en el central directory.
let crc32Table: Uint32Array | null = null

function getCrc32Table(): Uint32Array {
  if (crc32Table) return crc32Table
  const table = new Uint32Array(256)
  for (let value = 0; value < 256; value++) {
    let crc = value
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    table[value] = crc >>> 0
  }
  crc32Table = table
  return table
}

function crc32Of(bytes: Uint8Array): number {
  const table = getCrc32Table()
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index++) {
    crc = table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const INFLATE_MAX_BITS = 15
// Historial máximo de una back-reference deflate (RFC 1951: distancia ≤ 32768).
const INFLATE_WINDOW_BYTES = 32768

const INFLATE_LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]
const INFLATE_LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]
const INFLATE_DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
const INFLATE_DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]
// Orden de los largos del código de largos (3.2.7 del RFC).
const INFLATE_CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

interface InflateHuffman {
  readonly counts: number[]
  readonly symbols: number[]
}

// Tabla canónica desde los largos de código. Un código SOBRE-suscrito es
// malformado (null); uno incompleto es legal (decodificar un código ausente
// falla en decodeInflateSymbol).
function buildInflateHuffman(lengths: number[]): InflateHuffman | null {
  const counts = new Array<number>(INFLATE_MAX_BITS + 1).fill(0)
  for (const length of lengths) counts[length] += 1
  counts[0] = 0

  let left = 1
  for (let length = 1; length <= INFLATE_MAX_BITS; length++) {
    left = (left << 1) - counts[length]
    if (left < 0) return null
  }

  const offsets = new Array<number>(INFLATE_MAX_BITS + 1).fill(0)
  for (let length = 1; length < INFLATE_MAX_BITS; length++) {
    offsets[length + 1] = offsets[length] + counts[length]
  }

  const symbols: number[] = []
  lengths.forEach((length, symbol) => {
    if (length !== 0) {
      symbols[offsets[length]] = symbol
      offsets[length] += 1
    }
  })

  return { counts, symbols }
}

let fixedInflateTables: { literal: InflateHuffman; distance: InflateHuffman } | null = null

function getFixedInflateTables(): { literal: InflateHuffman; distance: InflateHuffman } | null {
  if (fixedInflateTables) return fixedInflateTables
  const literalLengths = new Array<number>(288)
  for (let symbol = 0; symbol < 288; symbol++) {
    literalLengths[symbol] = symbol < 144 ? 8 : symbol < 256 ? 9 : symbol < 280 ? 7 : 8
  }
  const literal = buildInflateHuffman(literalLengths)
  const distance = buildInflateHuffman(new Array<number>(30).fill(5))
  if (!literal || !distance) return null
  fixedInflateTables = { literal, distance }
  return fixedInflateTables
}

interface InflateRawResult {
  // Prefijo retenido del output (el output completo cuando retainBytes no acota).
  readonly bytes: Uint8Array
  readonly totalBytes: number
  readonly crc32: number
}

function inflateRaw(
  input: Uint8Array,
  maxOutputBytes: number,
  options: { retainBytes?: number } = {}
): InflateRawResult | null {
  const retainBytes = Math.min(options.retainBytes ?? maxOutputBytes, maxOutputBytes)
  let bitPosition = 0

  const readBit = (): number | null => {
    const byteIndex = bitPosition >> 3
    if (byteIndex >= input.length) return null
    const bit = (input[byteIndex] >> (bitPosition & 7)) & 1
    bitPosition += 1
    return bit
  }

  const readBits = (count: number): number | null => {
    let value = 0
    for (let index = 0; index < count; index++) {
      const bit = readBit()
      if (bit === null) return null
      value |= bit << index
    }
    return value
  }

  const decodeInflateSymbol = (table: InflateHuffman): number | null => {
    let code = 0
    let first = 0
    let index = 0
    for (let length = 1; length <= INFLATE_MAX_BITS; length++) {
      const bit = readBit()
      if (bit === null) return null
      code |= bit
      const count = table.counts[length]
      if (code - first < count) return table.symbols[index + (code - first)]
      index += count
      first = (first + count) << 1
      code <<= 1
    }
    return null
  }

  const crcTable = getCrc32Table()
  const window = new Uint8Array(INFLATE_WINDOW_BYTES)
  const retained: number[] = []
  let totalBytes = 0
  let crc = 0xffffffff

  // false cuando el output excedería el techo: eso es malformación (fail
  // closed), nunca truncamiento aceptado.
  const emit = (byte: number): boolean => {
    if (totalBytes >= maxOutputBytes) return false
    if (totalBytes < retainBytes) retained.push(byte)
    window[totalBytes & (INFLATE_WINDOW_BYTES - 1)] = byte
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
    totalBytes += 1
    return true
  }

  while (true) {
    const isFinalBlock = readBit()
    if (isFinalBlock === null) return null
    const blockType = readBits(2)
    if (blockType === null) return null

    if (blockType === 0) {
      // Bloque stored: alinear a byte, LEN + ~LEN, copia literal.
      bitPosition = (bitPosition + 7) & ~7
      const byteIndex = bitPosition >> 3
      if (byteIndex + 4 > input.length) return null
      const length = input[byteIndex] | (input[byteIndex + 1] << 8)
      const inverse = input[byteIndex + 2] | (input[byteIndex + 3] << 8)
      if (length !== (~inverse & 0xffff)) return null
      const dataStart = byteIndex + 4
      if (dataStart + length > input.length) return null
      for (let index = 0; index < length; index++) {
        if (!emit(input[dataStart + index])) return null
      }
      bitPosition = (dataStart + length) << 3
    } else if (blockType === 1 || blockType === 2) {
      let literalTable: InflateHuffman
      let distanceTable: InflateHuffman

      if (blockType === 1) {
        const fixed = getFixedInflateTables()
        if (!fixed) return null
        literalTable = fixed.literal
        distanceTable = fixed.distance
      } else {
        const literalCount = readBits(5)
        const distanceCount = readBits(5)
        const codeLengthCount = readBits(4)
        if (literalCount === null || distanceCount === null || codeLengthCount === null) return null
        const totalLiterals = literalCount + 257
        const totalDistances = distanceCount + 1
        if (totalLiterals > 286 || totalDistances > 30) return null

        const codeLengthLengths = new Array<number>(19).fill(0)
        for (let index = 0; index < codeLengthCount + 4; index++) {
          const length = readBits(3)
          if (length === null) return null
          codeLengthLengths[INFLATE_CODE_LENGTH_ORDER[index]] = length
        }
        const codeLengthTable = buildInflateHuffman(codeLengthLengths)
        if (!codeLengthTable) return null

        const lengths: number[] = []
        while (lengths.length < totalLiterals + totalDistances) {
          const symbol = decodeInflateSymbol(codeLengthTable)
          if (symbol === null) return null
          if (symbol < 16) {
            lengths.push(symbol)
          } else if (symbol === 16) {
            const previous = lengths[lengths.length - 1]
            if (previous === undefined) return null
            const repeat = readBits(2)
            if (repeat === null) return null
            for (let index = 0; index < repeat + 3; index++) lengths.push(previous)
          } else if (symbol === 17) {
            const repeat = readBits(3)
            if (repeat === null) return null
            for (let index = 0; index < repeat + 3; index++) lengths.push(0)
          } else {
            const repeat = readBits(7)
            if (repeat === null) return null
            for (let index = 0; index < repeat + 11; index++) lengths.push(0)
          }
        }
        if (lengths.length !== totalLiterals + totalDistances) return null
        // Sin código para fin-de-bloque el stream no puede terminar legalmente.
        if (lengths[256] === 0) return null

        const literal = buildInflateHuffman(lengths.slice(0, totalLiterals))
        const distance = buildInflateHuffman(lengths.slice(totalLiterals))
        if (!literal || !distance) return null
        literalTable = literal
        distanceTable = distance
      }

      while (true) {
        const symbol = decodeInflateSymbol(literalTable)
        if (symbol === null) return null
        if (symbol < 256) {
          if (!emit(symbol)) return null
          continue
        }
        if (symbol === 256) break

        const lengthIndex = symbol - 257
        if (lengthIndex >= INFLATE_LENGTH_BASE.length) return null
        const lengthExtra = readBits(INFLATE_LENGTH_EXTRA[lengthIndex])
        if (lengthExtra === null) return null
        const copyLength = INFLATE_LENGTH_BASE[lengthIndex] + lengthExtra

        const distanceSymbol = decodeInflateSymbol(distanceTable)
        if (distanceSymbol === null) return null
        if (distanceSymbol >= INFLATE_DIST_BASE.length) return null
        const distanceExtra = readBits(INFLATE_DIST_EXTRA[distanceSymbol])
        if (distanceExtra === null) return null
        const distance = INFLATE_DIST_BASE[distanceSymbol] + distanceExtra

        if (distance > totalBytes) return null
        for (let index = 0; index < copyLength; index++) {
          if (!emit(window[(totalBytes - distance) & (INFLATE_WINDOW_BYTES - 1)])) return null
        }
      }
    } else {
      return null
    }

    if (isFinalBlock === 1) break
  }

  return { bytes: Uint8Array.from(retained), totalBytes, crc32: (crc ^ 0xffffffff) >>> 0 }
}

// La firma OLE (D0 CF 11 E0 A1 B1 1A E1) identifica un Compound File Binary
// (MS-CFB), pero NO un documento Office: un MSI, un MSG de Outlook o un CFB
// truncado a mano traen la misma firma. Aceptarla sola dejaba registrar
// cualquier binario OLE como .xls/.doc/.ppt. Se parsea la estructura REAL del
// contenedor (header → DIFAT → FAT → cadena del directorio) y se exige el
// stream característico del formato declarado: "Workbook"/"Book" (Excel BIFF),
// "WordDocument" (Word) y "PowerPoint Document" (PowerPoint). Los streams de
// un MSI llevan nombres re-codificados fuera de ASCII, así que no los tienen.
// Cualquier estructura malformada rechaza: fail closed. Requiere los bytes
// COMPLETOS del archivo (los sectores del directorio pueden vivir en cualquier
// offset), que los dos carriles ya leen para los tipos Office legacy.
const CFB_HEADER_BYTES = 512
const CFB_DIR_ENTRY_BYTES = 128
const CFB_HEADER_DIFAT_ENTRIES = 109
const CFB_STREAM_OBJECT_TYPE = 2
const CFB_FREE_SECT = 0xffffffff
const CFB_END_OF_CHAIN = 0xfffffffe
const CFB_FAT_SECT = 0xfffffffd
const CFB_DIFAT_SECT = 0xfffffffc

// Nombres (en minúsculas) que prueban el formato declarado. Excel escribe
// "Workbook" (BIFF8) o "Book" (BIFF5/7); la comparación es case-insensitive
// porque escritores viejos usaban "WORKBOOK"/"BOOK" (mismo criterio que los
// parsers de referencia).
const LEGACY_OFFICE_REQUIRED_STREAMS: Readonly<Record<string, readonly string[]>> = {
  'application/vnd.ms-excel': ['workbook', 'book'],
  'application/msword': ['worddocument'],
  'application/vnd.ms-powerpoint': ['powerpoint document'],
}

function isCfbSpecialSector(sector: number): boolean {
  return (
    sector === CFB_FREE_SECT ||
    sector === CFB_END_OF_CHAIN ||
    sector === CFB_FAT_SECT ||
    sector === CFB_DIFAT_SECT
  )
}

// Nombres de los streams del directorio CFB, en minúsculas, o null si la
// estructura está malformada (fail closed).
function readCfbStreamNames(bytes: Uint8Array): Option.Option<string[]> {
  if (bytes.length < CFB_HEADER_BYTES) return Option.none()

  // Versión 3 → sectores de 512 bytes; versión 4 → 4096. Cualquier otra
  // combinación está fuera del contrato MS-CFB.
  const majorVersion = readUint16LE(bytes, 26)
  const sectorShift = readUint16LE(bytes, 30)
  const validVersion =
    (majorVersion === 3 && sectorShift === 9) || (majorVersion === 4 && sectorShift === 12)
  if (!validVersion) return Option.none()

  const sectorSize = 1 << sectorShift
  const entriesPerSector = sectorSize / 4
  // El sector 0 empieza donde termina el "sector de header" (512 bytes en v3;
  // en v4 el header se rellena hasta 4096).
  const sectorOffset = (sector: number) => (sector + 1) * sectorSize

  const fatSectorCount = readUint32LE(bytes, 44)
  const firstDirectorySector = readUint32LE(bytes, 48)
  const firstDifatSector = readUint32LE(bytes, 68)
  const difatSectorCount = readUint32LE(bytes, 72)

  // DIFAT: la lista de sectores que componen la FAT. Los primeros 109 viven
  // en el header; el resto en la cadena de sectores DIFAT.
  const fatSectors: number[] = []
  for (
    let index = 0;
    index < CFB_HEADER_DIFAT_ENTRIES && fatSectors.length < fatSectorCount;
    index++
  ) {
    const sector = readUint32LE(bytes, 76 + index * 4)
    if (isCfbSpecialSector(sector)) break
    fatSectors.push(sector)
  }

  let difatSector = firstDifatSector
  const visitedDifat = new Set<number>()
  for (let index = 0; index < difatSectorCount; index++) {
    if (isCfbSpecialSector(difatSector) || visitedDifat.has(difatSector)) break
    visitedDifat.add(difatSector)
    const start = sectorOffset(difatSector)
    if (start + sectorSize > bytes.length) return Option.none()
    for (
      let entry = 0;
      entry < entriesPerSector - 1 && fatSectors.length < fatSectorCount;
      entry++
    ) {
      const sector = readUint32LE(bytes, start + entry * 4)
      if (isCfbSpecialSector(sector)) break
      fatSectors.push(sector)
    }
    difatSector = readUint32LE(bytes, start + (entriesPerSector - 1) * 4)
  }

  // Declarar más sectores FAT de los que el DIFAT realmente lista es un
  // contenedor malformado.
  if (fatSectors.length !== fatSectorCount || fatSectorCount === 0) return Option.none()

  // FAT[sector] = siguiente sector de su cadena.
  const nextInChain = (sector: number): number | null => {
    const fatIndex = Math.floor(sector / entriesPerSector)
    if (fatIndex >= fatSectors.length) return null
    const offset = sectorOffset(fatSectors[fatIndex]) + (sector % entriesPerSector) * 4
    if (offset + 4 > bytes.length) return null
    return readUint32LE(bytes, offset)
  }

  const names: string[] = []
  const visitedDirectory = new Set<number>()
  let directorySector = firstDirectorySector
  while (directorySector !== CFB_END_OF_CHAIN) {
    if (isCfbSpecialSector(directorySector) || visitedDirectory.has(directorySector))
      return Option.none()
    visitedDirectory.add(directorySector)
    const start = sectorOffset(directorySector)
    if (start + sectorSize > bytes.length) return Option.none()

    for (let entry = 0; entry < sectorSize / CFB_DIR_ENTRY_BYTES; entry++) {
      const entryStart = start + entry * CFB_DIR_ENTRY_BYTES
      const objectType = bytes[entryStart + 66]
      if (objectType !== CFB_STREAM_OBJECT_TYPE) continue

      // Nombre UTF-16LE de hasta 32 unidades; el largo declarado incluye el
      // terminador nulo. Una entrada con largo inválido no puede probar nada.
      const nameLength = readUint16LE(bytes, entryStart + 64)
      if (nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0) continue
      let name = ''
      for (let index = 0; index < nameLength - 2; index += 2) {
        name += String.fromCharCode(
          bytes[entryStart + index] | (bytes[entryStart + index + 1] << 8)
        )
      }
      names.push(name.toLowerCase())
    }

    const next = nextInChain(directorySector)
    if (next === null) return Option.none()
    directorySector = next
  }

  return Option.some(names)
}

// ¿El contenedor OLE trae el stream que el formato Office declarado exige?
// Requiere los bytes COMPLETOS del archivo. Un content-type sin regla aquí
// (no-legacy) rechaza: esta función solo responde por los tres tipos legacy.
function looksLikeLegacyOfficeFile(contentType: string, bytes: Uint8Array): boolean {
  const requiredStreams = LEGACY_OFFICE_REQUIRED_STREAMS[contentType]
  if (!requiredStreams) return false
  if (detectOfficeSignature(bytes) !== 'OLE') return false

  const streamNames = readCfbStreamNames(bytes)
  if (Option.isNone(streamNames)) return false
  return streamNames.value.some((name) => requiredStreams.includes(name))
}

export function officeBytesMatchContentType(contentType: string, bytes: Uint8Array): boolean {
  if (!isOfficeMimeType(contentType)) return false

  const signature = detectOfficeSignature(bytes)
  if (signature === 'ZIP') return looksLikeOoxmlPackage(contentType, bytes)
  if (signature === 'OLE') return looksLikeLegacyOfficeFile(contentType, bytes)
  return false
}
