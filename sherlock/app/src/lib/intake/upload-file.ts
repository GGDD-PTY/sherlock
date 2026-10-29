// ============================================================================
// SUBIDA DE UN ARCHIVO AL INTAKE TEMPORAL — LA FACHADA
// ============================================================================
// El contrato público del pipeline: los tipos del resultado y de las opciones,
// la regla de la URL de almacenamiento y una `uploadIntakeFile` que ya era
// Promise. El programa Effect de las cuatro etapas vive en
// `upload-file-program.ts` y llega por `import()`.
//
// ===== LA COSTURA ([F] 2026-09-08) =====
// La landing y el workspace son componentes `'use client'`: un import estático
// del programa metía `effect`, `Schema` y el runtime de fibras en su first-load
// JS. El `import()` lo saca a su propio chunk. Para que ese chunk no se pague
// en el gesto de soltar el archivo, ambos componentes llaman a
// `warmUploadIntakeFile()` al montar y la promesa del módulo se memoiza acá.
// ============================================================================

import { Option, Schema } from 'effect'

import type { IntakeDocumentView } from '@/lib/intake/session'
import type { IntakeUploadFailureReason } from '@/lib/intake/upload-state'

export type IntakeUploadOutcome =
  | { status: 'received'; document: IntakeDocumentView }
  | { status: 'failed'; reason: IntakeUploadFailureReason }
  | { status: 'cancelled' }

export type IntakeUploadOptions = {
  csrfToken: string
  signal: AbortSignal
  /** Bytes del archivo que el proveedor ya aceptó; `total` es el tamaño real. */
  onProgress?: (loadedBytes: number, totalBytes: number) => void
  /**
   * Este archivo ya tuvo un intento terminal no recibido en esta página: el
   * servidor puede supersedir su intent ISSUED. Ver `shouldSupersedePending`.
   */
  supersedePending?: boolean
}

const MAX_STORAGE_UPLOAD_URL_LENGTH = 2_048

// La URL la devuelve el intent: es una respuesta de red, o sea entrada ajena.
// El largo y el parseo se deciden con schemas — el `catch {}` que envolvía
// `new URL` tapaba por igual una URL mal formada y cualquier otro fallo.
const decodeBoundedUrlText = Schema.decodeUnknownOption(
  Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_STORAGE_UPLOAD_URL_LENGTH)))
)
const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)

// La misma regla que `validUploadUrl` en `/api/intake/uploads`: el origin de
// `NEXT_PUBLIC_CONVEX_URL` (https, o http fuera de producción, que es como
// corre `dev:local` en 127.0.0.1:3210), o un `*.convex.cloud` / `*.convex.site`
// en https. Nunca credenciales ni fragmento en la URL.
export function isSafeStorageUploadUrl(
  value: unknown,
  env: { NEXT_PUBLIC_CONVEX_URL?: string; NODE_ENV?: string } = {
    NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
    NODE_ENV: process.env.NODE_ENV,
  }
): value is string {
  const text = decodeBoundedUrlText(value)
  if (Option.isNone(text)) return false

  const parsed = decodeUrl(text.value)
  if (Option.isNone(parsed)) return false
  const url = parsed.value

  if (url.username !== '' || url.password !== '' || url.hash !== '') return false
  const https = url.protocol === 'https:'
  const httpAllowed = url.protocol === 'http:' && env.NODE_ENV !== 'production'

  if (env.NEXT_PUBLIC_CONVEX_URL) {
    const configured = decodeUrl(env.NEXT_PUBLIC_CONVEX_URL)
    // Se conserva el fail-closed de siempre: un `NEXT_PUBLIC_CONVEX_URL` mal
    // formado rechaza la subida entera en vez de caer al caso de la nube.
    if (Option.isNone(configured)) return false
    if (url.origin === configured.value.origin && (https || httpAllowed)) return true
  }

  return https && (url.hostname.endsWith('.convex.cloud') || url.hostname.endsWith('.convex.site'))
}

// El programa llega por chunk aparte. La promesa se memoiza para que una tanda
// de archivos no dispare varias cargas.
let programModule: Promise<typeof import('@/lib/intake/upload-file-program')> | null = null

function loadUploadProgram(): Promise<typeof import('@/lib/intake/upload-file-program')> {
  programModule ??= import('@/lib/intake/upload-file-program')
  return programModule
}

/**
 * Pide el chunk del programa sin esperarlo. La landing y el workspace lo
 * llaman al montar: cuando el usuario suelta el archivo, el módulo ya llegó.
 */
export function warmUploadIntakeFile(): void {
  void loadUploadProgram()
}

/**
 * Sube un archivo al intake temporal. Misma firma y mismo contrato de siempre:
 * un union discriminado, nunca una excepción.
 */
export async function uploadIntakeFile(
  file: File,
  options: IntakeUploadOptions
): Promise<IntakeUploadOutcome> {
  const { uploadIntakeFile: run } = await loadUploadProgram()
  return run(file, options)
}
