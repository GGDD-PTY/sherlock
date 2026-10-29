// ============================================================================
// LÍMITES DE LA SUBIDA DIRECTA NAVEGADOR → CONVEX STORAGE
// ============================================================================
// Fuente de verdad ÚNICA del techo del camino directo (decisión 6,
// DESIGN-ONBOARDING-VDR-2026-07-31). Este módulo es puro (sin imports de
// Convex ni de Node), así que lo importan las dos orillas:
//   - convex/_documents/mutations.ts → validación server-side contra el blob real
//   - src/lib/storage/upload-limits.ts → re-export para la UI (mismo patrón que
//     accessResult.ts, que src ya importa directamente)
//
// El techo de 4MB de src/lib/storage/upload-limits.ts NO aplica aquí: ese es el
// límite de las superficies que viajan por una ruta Next en Vercel (la
// serverless function corta el body en ~4.5MB con un 413). El camino directo
// hace POST a *.convex.cloud (CSP ya lo permite) y jamás toca Vercel.
// ============================================================================

import { Schema } from 'effect'

// Techo de producto del camino directo: 50MB (lo que la UI siempre anunció).
export const MAX_DIRECT_UPLOAD_BYTES = 50 * 1024 * 1024
export const MAX_DIRECT_UPLOAD_MB = MAX_DIRECT_UPLOAD_BYTES / 1024 / 1024

// Misma allowlist que /api/documents/upload (PDF + Office). El contentType
// server-side sale de ctx.db.system.get(storageId) — lo que Convex registró en
// el POST — nunca de lo que declare el cliente en los args de la mutation.
export const DIRECT_UPLOAD_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
] as const

/** El mismo allowlist como schema: narrowea sin castear a `readonly string[]`. */
const DirectUploadMimeTypeSchema = Schema.Literals(DIRECT_UPLOAD_ALLOWED_MIME_TYPES)

export const isDirectUploadMimeType = Schema.is(DirectUploadMimeTypeSchema)

// Un CSV (balance de comprobación, tape) es texto delimitado: su techo propio es
// más bajo que el de un PDF u Office y la inspección lo decodifica completo.
export const MAX_CSV_UPLOAD_BYTES = 20 * 1024 * 1024

export function directUploadLimitBytesForMimeType(mimeType: string): number {
  return mimeType.trim().toLowerCase() === 'text/csv'
    ? MAX_CSV_UPLOAD_BYTES
    : MAX_DIRECT_UPLOAD_BYTES
}

// La lectura MCP carga el archivo entero en una action de Convex y otra vez en
// el store. Subir ese techo al de la sala (50 MB) metería el blob en el aislado.
// La subida web sigue en 50 MB / 20 MB; el MCP no puede prometer una lectura
// de lo que ese techo rechaza con NOT_FOUND.
export const VDR_MCP_READ_MAX_BYTES = 16 * 1024 * 1024

export function mcpReadableUploadLimitBytes(mimeType: string): number {
  return Math.min(directUploadLimitBytesForMimeType(mimeType), VDR_MCP_READ_MAX_BYTES)
}

// ============================================================================
// RECHAZO ESTRUCTURADO DEL REGISTRO DIRECTO
// ============================================================================
// Mismo razonamiento que accessResult.ts (verificado 2026-07-28): en Convex un
// `throw` revierte TODOS los efectos de la mutation — incluido el
// ctx.storage.delete() del blob inválido — y ctx.scheduler.runAfter no es
// escape (el scheduling se descarta con el throw). Para que el borrado del
// blob COMMITEE, la rama de rechazo devuelve este resultado discriminado en
// vez de lanzar. Los throws de authz/integridad (rol, ownership, rate limit,
// empresa ajena, storageId inexistente o ya registrado) se mantienen: no tienen
// ningún efecto que deba sobrevivir.

const DIRECT_UPLOAD_REJECTION_CODES = [
  'FILE_TOO_LARGE',
  'INVALID_FILE_TYPE',
  'INVALID_FILE_SIGNATURE',
  'INVALID_ARCHIVE',
  'ENCRYPTED_ARCHIVE',
  'ZIP_BOMB',
  'MALWARE_DETECTED',
  'SCAN_UNAVAILABLE',
] as const

const DirectUploadRejectionCodeSchema = Schema.Literals(DIRECT_UPLOAD_REJECTION_CODES)

export type DirectUploadRejectionCode = typeof DirectUploadRejectionCodeSchema.Type

const DirectUploadRejectionSchema = Schema.Struct({
  registered: Schema.Literal(false),
  /** Código estable para que la UI mapee a su copy bilingüe local. */
  code: DirectUploadRejectionCodeSchema,
})

export type DirectUploadRejection = typeof DirectUploadRejectionSchema.Type

export function directUploadRejection(code: DirectUploadRejectionCode): DirectUploadRejection {
  return { registered: false, code }
}

// Solo los literales del union: aceptar cualquier string narrowearía a
// DirectUploadRejectionCode códigos que la UI no sabe mapear. Antes eso se
// comprobaba con un `includes` sobre un `readonly unknown[]` casteado a mano;
// ahora la lista y el guard son el mismo objeto.
export const isDirectUploadRejection = Schema.is(DirectUploadRejectionSchema)
