// ============================================================================
// COLA DE SUBIDA DEL VDR — LA FACHADA
// ============================================================================
// La parte pura y síncrona de la cola (validar, armar filas, filtrar) vive en
// `upload-queue-entries.ts` y se re-exporta acá para que ningún caller viejo
// cambie. Lo único con fallo real —correr la tanda con la concurrencia acotada
// de Effect— vive en `upload-queue-concurrency.ts`.
//
// El programa de la tanda llega por `import()` en el momento en que el cliente
// aprieta «Subir». La validación de `concurrency` corre ANTES de pedir el
// chunk, así que el `RangeError` sigue saliendo en la primera pasada, sin
// esperar red: el contrato de la firma no depende de que el chunk llegue.
// ============================================================================

import { Schema } from 'effect'

import { MAX_CONCURRENT_VDR_UPLOADS } from '@/lib/documents/upload-queue-entries'

// El `concurrency` lo escribe el caller. Un entero >= 1 o nada: el resto es un
// `RangeError` inmediato, no un `Promise.all` con `NaN` fibras.
const isValidConcurrency = Schema.is(
  Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)))
)

export {
  buildUploadQueueEntries,
  isRetryableQueuedUploadFailure,
  MAX_CONCURRENT_VDR_UPLOADS,
  MAX_VDR_FILES_PER_BATCH,
  stripUploadExtension,
  uploadableQueueEntries,
  validateQueuedUpload,
  type VdrQueuedUpload,
  type VdrUploadOrigin,
} from '@/lib/documents/upload-queue-entries'

// La promesa del chunk se memoiza para que dos tandas seguidas no disparen dos
// cargas; un fallo la limpia y la siguiente tanda vuelve a intentar.
let concurrencyModulePromise: Promise<
  typeof import('@/lib/documents/upload-queue-concurrency')
> | null = null

function loadConcurrencyModule(): Promise<
  typeof import('@/lib/documents/upload-queue-concurrency')
> {
  concurrencyModulePromise ??= import('@/lib/documents/upload-queue-concurrency').catch(
    (cause: unknown): never => {
      concurrencyModulePromise = null
      throw cause
    }
  )
  return concurrencyModulePromise
}

export async function settleWithConcurrency<Input, Output>(
  items: readonly Input[],
  mapper: (item: Input, index: number) => Promise<Output>,
  options: { concurrency?: number; signal?: AbortSignal } = {}
): Promise<PromiseSettledResult<Output>[]> {
  const concurrency = options.concurrency ?? MAX_CONCURRENT_VDR_UPLOADS
  if (!isValidConcurrency(concurrency)) {
    throw new RangeError('concurrency must be a positive integer')
  }

  const { settleQueueWithConcurrency } = await loadConcurrencyModule()
  return settleQueueWithConcurrency(items, mapper, concurrency, options.signal)
}
