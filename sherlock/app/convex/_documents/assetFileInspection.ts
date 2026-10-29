// ============================================================================
// FIRMA REAL DE UN ACTIVO PÚBLICO (avatar / logo)
// ============================================================================
// Bytes que sube el cliente: entrada no confiable. La firma que se deduce de
// ellos y el mime que el blob declara son dos cosas distintas, y el registro
// solo procede cuando coinciden.
// ============================================================================

import { Schema } from 'effect'

const AssetFileSignatureSchema = Schema.Literals(['JPEG', 'PNG', 'GIF', 'WEBP', 'UNKNOWN'])
export type AssetFileSignature = typeof AssetFileSignatureSchema.Type
const isAssetFileSignature = Schema.is(AssetFileSignatureSchema)

/** Mime declarado → la ÚNICA firma que lo prueba. Una tabla, no una escalera. */
const ASSET_MIME_SIGNATURE: Readonly<Record<string, AssetFileSignature>> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/gif': 'GIF',
  'image/webp': 'WEBP',
}

export function detectAssetFileSignature(input: Uint8Array): AssetFileSignature {
  const startsWith = (...signature: number[]) =>
    signature.every((value, index) => input[index] === value)

  if (startsWith(0xff, 0xd8, 0xff)) return 'JPEG'
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'PNG'
  if (
    startsWith(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) ||
    startsWith(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)
  ) {
    return 'GIF'
  }
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    input[8] === 0x57 &&
    input[9] === 0x45 &&
    input[10] === 0x42 &&
    input[11] === 0x50
  ) {
    return 'WEBP'
  }
  return 'UNKNOWN'
}

// Fail closed: un mime fuera de la tabla no tiene firma que lo pruebe, y
// 'UNKNOWN' nunca es la firma de ningún mime porque no está en los valores.
// `signature` llega por dos rutas distintas — el detector de bytes de este
// mismo archivo, o `args.signature` de un cliente ya validado por Convex en
// `finalizeAssetUpload` — y esta función no puede asumir cuál de las dos la
// trajo, así que decodifica antes de comparar en vez de confiar en el tipo.
export function assetSignatureMatchesMimeType(
  mimeType: string,
  signature: AssetFileSignature
): boolean {
  if (!isAssetFileSignature(signature)) return false
  return ASSET_MIME_SIGNATURE[mimeType] === signature
}
