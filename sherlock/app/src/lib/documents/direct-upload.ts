// ============================================================================
// SUBIDA DIRECTA DE DOCUMENTOS VDR — LA FACHADA DEL CLIENTE
// ============================================================================
// El camino directo navegador → Convex Storage (decisión 6,
// DESIGN-ONBOARDING-VDR-2026-07-31) lo orquesta `direct-upload-program.ts`:
// el hash con Web Crypto, el intent sellado, el POST a *.convex.cloud y la
// action que publica la versión inmutable, con sus errores tipados por paso.
//
// Acá solo queda la fachada: los tipos se re-exportan con `export type`, que se
// erasa, y las dos funciones cargan el programa con `import()`, así que el
// pipeline entero sigue viviendo en su propio chunk.
// `warmDirectVdrUpload()` dispara esa carga en el montaje de la sala, así que
// el chunk ya está cuando llega el gesto.
// ============================================================================

import { Effect } from 'effect'

import { runClientFork } from '@/lib/effect/client-runtime'

import type {
  DirectVdrUploadDeps,
  DirectVdrUploadInput,
  DirectVdrUploadResult,
} from '@/lib/documents/direct-upload-program'

export type {
  DirectVdrUploadDeps,
  DirectVdrUploadInput,
  DirectVdrUploadResult,
} from '@/lib/documents/direct-upload-program'

// La promesa del chunk se memoiza para que una tanda de archivos no dispare
// varias cargas; un fallo la limpia y el siguiente intento vuelve a pedirlo.
let programModulePromise: Promise<typeof import('@/lib/documents/direct-upload-program')> | null =
  null

function loadProgramModule(): Promise<typeof import('@/lib/documents/direct-upload-program')> {
  programModulePromise ??= import('@/lib/documents/direct-upload-program').catch(
    (cause: unknown): never => {
      programModulePromise = null
      throw cause
    }
  )
  return programModulePromise
}

/**
 * Pide el chunk del programa sin esperarlo. La sala la llama al montar para
 * que la subida no arranque descargando código.
 *
 * Sigue siendo best-effort —si el chunk no llega ahora, la subida lo vuelve a
 * pedir y ahí sí el fallo es visible—, pero el fallo ya no cae en un `catch {}`
 * mudo: la fibra lleva span propio, así que un chunk que nunca llega se ve en
 * la traza en vez de desaparecer.
 */
export function warmDirectVdrUpload(): void {
  runClientFork(
    Effect.tryPromise({
      try: () => loadProgramModule(),
      catch: (cause) => cause,
    }).pipe(Effect.ignore, Effect.withSpan('DirectUpload.warmProgramChunk'))
  )
}

export async function performDirectVdrUpload(
  deps: DirectVdrUploadDeps,
  input: DirectVdrUploadInput
): Promise<DirectVdrUploadResult> {
  const program = await loadProgramModule()
  return program.performDirectVdrUpload(deps, input)
}

// El aborto conserva el protocolo del navegador (`DOMException` AbortError):
// es lo que cualquier consumidor de un AbortSignal espera, incluido el
// `calculateSha256` que los tests inyectan.
export async function calculateVdrFileSha256(file: File, signal?: AbortSignal): Promise<string> {
  const program = await loadProgramModule()
  return program.calculateVdrFileSha256(file, signal)
}
