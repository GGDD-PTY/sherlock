// ============================================================================
// CFB FIXTURES — contenedores OLE (MS-CFB) mínimos pero ESTRUCTURALMENTE reales
// ============================================================================
// La validación de Office legacy parsea la estructura real del Compound File
// (header → DIFAT → FAT → cadena del directorio) y busca el stream
// característico del formato declarado. Los fixtures tienen que traer header,
// FAT y directorio de verdad (versión 3, sectores de 512 bytes) para
// ejercitar ese parser — un prefijo con la firma D0 CF 11 E0 no alcanza.

const CFB_SECTOR_BYTES = 512
const CFB_DIR_ENTRY_BYTES = 128
const CFB_FREE_SECT = 0xffffffff
const CFB_END_OF_CHAIN = 0xfffffffe
const CFB_FAT_SECT = 0xfffffffd
const CFB_NO_STREAM = 0xffffffff

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >> 8) & 0xff
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >> 8) & 0xff
  target[offset + 2] = (value >> 16) & 0xff
  target[offset + 3] = (value >>> 24) & 0xff
}

// Entrada de directorio (128 bytes): nombre UTF-16LE + largo (incluye el
// terminador nulo) + object type + sibling ids en NOSTREAM.
function writeDirectoryEntry(
  target: Uint8Array,
  offset: number,
  name: string,
  objectType: number
): void {
  const nameUnits = Math.min(name.length, 31)
  for (let index = 0; index < nameUnits; index++) {
    writeU16(target, offset + index * 2, name.charCodeAt(index))
  }
  writeU16(target, offset + 64, (nameUnits + 1) * 2)
  target[offset + 66] = objectType
  target[offset + 67] = 1 // color: black
  writeU32(target, offset + 68, CFB_NO_STREAM) // left sibling
  writeU32(target, offset + 72, CFB_NO_STREAM) // right sibling
  writeU32(target, offset + 76, objectType === 5 ? 1 : CFB_NO_STREAM) // child
  writeU32(target, offset + 116, CFB_END_OF_CHAIN) // starting sector
}

// Compound File v3 mínimo y válido: header (512B) + sector 0 (FAT) + sector 1
// (directorio con Root Entry + un stream por nombre). Hasta 3 streams por
// fixture (el sector de directorio trae 4 entradas de 128B).
export function buildCfbFixture(streamNames: readonly string[]): Uint8Array {
  if (streamNames.length > 3) {
    throw new Error('buildCfbFixture soporta hasta 3 streams (un sector de directorio)')
  }

  const bytes = new Uint8Array(CFB_SECTOR_BYTES * 3)

  // --- Header ---
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0)
  writeU16(bytes, 24, 0x003e) // minor version
  writeU16(bytes, 26, 3) // major version
  writeU16(bytes, 28, 0xfffe) // byte order (little-endian)
  writeU16(bytes, 30, 9) // sector shift: 512B
  writeU16(bytes, 32, 6) // mini sector shift
  writeU32(bytes, 44, 1) // FAT sector count
  writeU32(bytes, 48, 1) // first directory sector
  writeU32(bytes, 56, 4096) // mini stream cutoff
  writeU32(bytes, 60, CFB_END_OF_CHAIN) // first mini FAT sector
  writeU32(bytes, 64, 0) // mini FAT sector count
  writeU32(bytes, 68, CFB_END_OF_CHAIN) // first DIFAT sector
  writeU32(bytes, 72, 0) // DIFAT sector count
  writeU32(bytes, 76, 0) // DIFAT[0]: la FAT vive en el sector 0
  for (let index = 1; index < 109; index++) {
    writeU32(bytes, 76 + index * 4, CFB_FREE_SECT)
  }

  // --- Sector 0: FAT ---
  const fatStart = CFB_SECTOR_BYTES
  writeU32(bytes, fatStart, CFB_FAT_SECT) // sector 0 es la propia FAT
  writeU32(bytes, fatStart + 4, CFB_END_OF_CHAIN) // sector 1: fin de la cadena del directorio
  for (let index = 2; index < CFB_SECTOR_BYTES / 4; index++) {
    writeU32(bytes, fatStart + index * 4, CFB_FREE_SECT)
  }

  // --- Sector 1: directorio ---
  const directoryStart = CFB_SECTOR_BYTES * 2
  writeDirectoryEntry(bytes, directoryStart, 'Root Entry', 5)
  streamNames.forEach((name, index) => {
    writeDirectoryEntry(bytes, directoryStart + (index + 1) * CFB_DIR_ENTRY_BYTES, name, 2)
  })

  return bytes
}
