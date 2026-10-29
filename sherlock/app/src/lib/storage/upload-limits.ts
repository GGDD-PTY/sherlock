// ============================================================================
// UPLOAD LIMITS — LÍMITE EFECTIVO DE SUBIDA
// ============================================================================
// Este módulo es importable desde Client Components (no toca fs, a diferencia
// de src/lib/storage/index.ts).
//
// POR QUÉ EXISTE (bug de producción, 2026-07-31): en Vercel, las serverless
// functions rechazan cualquier request body mayor a ~4.5MB con un
// `413 FUNCTION_PAYLOAD_TOO_LARGE` en TEXTO PLANO, antes de que corran el
// middleware o la ruta — sin auth, sin log de app y sin auditoría. Los
// uploaders anunciaban 50MB y hacían `await response.json()` sobre esa
// respuesta no-JSON, así que subir un pitch deck de 6MB fallaba con un error
// críptico o genérico. Maintainer lo vivió en el onboarding de empresa.
//
// El techo real de archivos grandes es la subida directa del navegador a
// Convex Storage (generateUploadUrl → POST directo a *.convex.cloud, que el
// CSP ya permite). Esa migración EXISTE desde la decisión 6
// (DESIGN-ONBOARDING-VDR-2026-07-31): los uploaders del VDR usan
// useDirectVdrUpload y declaran MAX_DIRECT_UPLOAD_BYTES (50MB, validado
// server-side en registerDirectUpload contra el blob real). El techo de 4MB de
// este módulo queda SOLO para las superficies que siguen viajando por una ruta
// Next en Vercel (avatar, logo).
// ============================================================================

// Techo del camino directo navegador → Convex Storage. La fuente de verdad
// vive en convex/_documents/uploadLimits.ts (módulo puro) para que la mutation
// server-side y la UI validen exactamente el mismo número.
export {
  directUploadLimitBytesForMimeType,
  MAX_CSV_UPLOAD_BYTES,
  MAX_DIRECT_UPLOAD_BYTES,
  MAX_DIRECT_UPLOAD_MB,
} from '../../../convex/_documents/uploadLimits'

import { Schema } from 'effect'

// Límite documentado de Vercel para el body de una serverless function.
export const PLATFORM_REQUEST_BODY_LIMIT_BYTES = Math.floor(4.5 * 1024 * 1024)

// Margen mínimo que hay que dejarle a los boundaries de multipart y a los
// campos de metadata del FormData.
const MULTIPART_MARGIN_BYTES = 256 * 1024

// El techo efectivo no es un número suelto: es un número que TIENE que caber
// bajo el límite de la plataforma con su margen. Ese es el bug de producción
// del 2026-07-31 escrito como invariante ejecutable — subirlo de más ya no
// compila un 413 en texto plano, revienta al importar el módulo.
const EffectiveUploadCapSchema = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(PLATFORM_REQUEST_BODY_LIMIT_BYTES - MULTIPART_MARGIN_BYTES)
  )
)

// Límite efectivo que anunciamos y validamos: 4MB.
export const MAX_UPLOAD_BYTES = Schema.decodeSync(EffectiveUploadCapSchema)(4 * 1024 * 1024)
export const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / 1024 / 1024
