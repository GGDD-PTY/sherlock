// ============================================================================
// STORAGE — política de assets por bucket
// ============================================================================
// Los bytes viven en Convex Storage. Aquí queda solo lo que cada bucket acepta
// (tipo MIME y tamaño). La ruta de disco local con URL firmada se borró: nadie
// acuñaba esas URLs y en Vercel no hay filesystem persistente. `STORAGE_SECRET`
// no se lee aquí: firma la prueba de entrega de grants del lado de Convex.
// ============================================================================

import { Effect } from 'effect'

import { MAX_UPLOAD_BYTES } from './upload-limits'

export type StorageBucket = 'avatars' | 'logos' | 'documents' | 'analyses'
export const VALID_BUCKETS: StorageBucket[] = ['avatars', 'logos', 'documents', 'analyses']

// ===== TIPOS DE ARCHIVO PERMITIDOS =====
const ALLOWED_MIME_TYPES: Record<StorageBucket, string[]> = {
  avatars: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  logos: ['image/jpeg', 'image/png', 'image/webp'],
  documents: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
    'application/vnd.ms-excel', // xls
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
    'application/msword', // doc
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
    'text/csv',
  ],
  analyses: [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
    'application/pdf',
    'text/csv',
    'application/json',
  ],
}

// ===== LÍMITES DE TAMAÑO POR BUCKET =====
// Todos acotados por la plataforma: Vercel corta cualquier request body en
// ~4.5MB con un 413 antes de que la ruta corra, así que anunciar más sería
// mentir. Ver src/lib/storage/upload-limits.ts (y su test de arquitectura).
const MAX_FILE_SIZE: Record<StorageBucket, number> = {
  avatars: MAX_UPLOAD_BYTES,
  logos: MAX_UPLOAD_BYTES,
  documents: MAX_UPLOAD_BYTES,
  analyses: MAX_UPLOAD_BYTES,
}

// ===== VALIDAR ARCHIVO =====
function checkBucketFile(file: File, bucket: StorageBucket): { valid: boolean; error?: string } {
  // 1. Verificar tipo MIME
  const allowedTypes = ALLOWED_MIME_TYPES[bucket]
  if (!allowedTypes.includes(file.type)) {
    return {
      valid: false,
      error: `Tipo de archivo no permitido. Tipos aceptados: ${allowedTypes.join(', ')}`,
    }
  }

  // 2. Verificar tamaño
  const maxSize = MAX_FILE_SIZE[bucket]
  if (file.size > maxSize) {
    const maxMB = maxSize / (1024 * 1024)
    return {
      valid: false,
      error: `El archivo es muy grande. Máximo ${maxMB} MB.`,
    }
  }

  return { valid: true }
}

const checkFile = Effect.fn('Storage.validateFile')((file: File, bucket: StorageBucket) =>
  Effect.sync(() => checkBucketFile(file, bucket))
)

export function validateFile(
  file: File,
  bucket: StorageBucket
): { valid: boolean; error?: string } {
  return Effect.runSync(checkFile(file, bucket))
}
