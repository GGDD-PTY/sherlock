// ============================================================================
// CONTENT-DISPOSITION PARA ENTREGA DE DOCUMENTOS (RFC 6266 / RFC 5987)
// ============================================================================
// El nombre del archivo lo escribe el emisor y en LATAM trae acentos y eñes:
// "Presentación.pdf". El saneo solo-ASCII del parámetro `filename=` los
// convertía en "Presentaci_n.pdf" para TODOS los navegadores. RFC 6266 permite
// mandar ambos: `filename=` queda como respaldo ASCII para clientes viejos y
// `filename*=UTF-8''...` conserva el nombre real (los navegadores modernos lo
// prefieren). Los caracteres peligrosos para el header o el filesystem se
// sanean en las dos variantes.
// ============================================================================

import { Schema } from 'effect'

const MAX_FILE_NAME_LENGTH = 120

/** Las dos disposiciones que el producto emite. */
export type ContentDisposition = 'attachment' | 'inline'

// Separadores de path, metacaracteres de shell/filesystem y delimitadores del
// propio header. Aplica a AMBAS variantes: filename* conserva acentos, no
// comillas ni backslashes.
const DANGEROUS_FILE_NAME_CHARS = /[\\/:*?"<>|;]/g

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g

// Un respaldo sirve solo si le queda algo legible. La condición vive en el
// schema, no en un `RegExp.test` suelto al lado del saneo.
const hasAsciiAlphanumeric = Schema.is(
  Schema.String.pipe(Schema.check(Schema.isPattern(/[A-Za-z0-9]/)))
)

/** Respaldo ASCII puro para el parámetro `filename=` (clientes legacy). */
export function sanitizeDownloadFileName(
  fileName: string | null | undefined,
  fallback: string
): string {
  const safeName = (fileName || fallback)

    .replace(/[^\x20-\x7E]/g, '_')
    .replace(DANGEROUS_FILE_NAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH)

  // Un nombre solo-no-ASCII colapsa a puros guiones bajos ("ñá" → "__"): eso no
  // es un respaldo útil, el fallback sí.
  if (!hasAsciiAlphanumeric(safeName)) {
    return fallback
  }

  return safeName
}

// Variante UTF-8 para `filename*`: conserva acentos/eñes y solo quita
// controles y caracteres peligrosos.
function sanitizeUtf8DownloadFileName(
  fileName: string | null | undefined,
  fallback: string
): string {
  const safeName = (fileName || fallback)
    .replace(CONTROL_CHARS, '_')
    .replace(DANGEROUS_FILE_NAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH)

  return safeName || fallback
}

function ensureExtension(name: string, extension?: string): string {
  if (!extension) {
    return name
  }

  return new RegExp(`\\.${extension}$`, 'i').test(name) ? name : `${name}.${extension}`
}

// RFC 5987: `encodeURIComponent` deja pasar `'()*`, que NO son attr-char y
// romperían o ambigüarían el value del parámetro extendido.
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/**
 * Compone el header completo con las dos variantes:
 * `attachment; filename="Presentaci_n.pdf"; filename*=UTF-8''Presentaci%C3%B3n.pdf`
 */
export function buildContentDisposition(
  disposition: ContentDisposition,
  fileName: string | null | undefined,
  fallback: string,
  options: { extension?: string } = {}
): string {
  const asciiName = ensureExtension(sanitizeDownloadFileName(fileName, fallback), options.extension)
  const utf8Name = ensureExtension(
    sanitizeUtf8DownloadFileName(fileName, fallback),
    options.extension
  )

  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeRfc5987(utf8Name)}`
}
