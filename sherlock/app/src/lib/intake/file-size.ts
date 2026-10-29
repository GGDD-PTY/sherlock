// ============================================================================
// TAMAÑOS DE ARCHIVO EN EL INTAKE
// ============================================================================
// El tamaño lo reporta el navegador y el avance lo reporta un XHR: los dos son
// números ajenos. Un `NaN` o un `Infinity` que llegue acá pintaba «NaN MB» en
// la fila del documento; el schema los deja fuera y la fila cae a «0 KB».
// ============================================================================

import { Schema } from 'effect'

const numberFormatter = new Intl.NumberFormat('es-PA', { maximumFractionDigits: 1 })

const isRealByteCount = Schema.is(Schema.Number.pipe(Schema.check(Schema.isFinite())))

// Bajo 1 MB el redondeo a MB muestra "0 MB"; un documento financiero jamás
// debe presentarse con tamaño cero, así que baja a KB con piso de 1.
export function formatFileSize(bytes: number): string {
  if (!isRealByteCount(bytes)) return '0 KB'
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${numberFormatter.format(bytes / 1024 / 1024)} MB`
}

// Bytes transferidos: antes del primer byte se dice «0 KB», no «1 KB». El piso
// de arriba es para el tamaño de un documento, no para el avance de una carga.
export function formatTransferredBytes(bytes: number): string {
  return bytes <= 0 ? '0 KB' : formatFileSize(bytes)
}
