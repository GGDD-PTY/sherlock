// ============================================================================
// COLA DE SUBIDA DEL VDR — LA TANDA CON CONCURRENCIA ACOTADA
// ============================================================================
// La tanda corre con la concurrencia acotada de Effect en vez de un pool de
// promesas a mano: cada subida se liquida por separado (una falla no cancela a
// las demás), el orden del resultado es el de la cola y, si el lote se detiene,
// no se empieza ninguna subida nueva — las que ya estaban en vuelo terminan.
//
// ===== POR QUÉ VIVE APARTE DE `upload-queue.ts` ([F] 2026-09-08) =====
// `upload-queue.ts` lo importa la sala en el render del diálogo por sus
// helpers puros y síncronos, así que viaja en el first-load JS. Este programa
// es lo único con Effect y llega por un chunk aparte con `import()`, recién
// cuando el cliente aprieta «Subir». El runtime de fibras no viaja con la
// sala; llega justo cuando hace falta.
// ============================================================================

import { Effect } from 'effect'

import { runServerEffect } from '@/lib/effect/runtime'

// `Effect.forEach(items, fn, { concurrency })` arrancaría el resto de la tanda
// al abortar; el contrato pinneado es no empezar ninguna subida nueva y devolver
// solo las que ya estaban en vuelo. Por eso el pool de workers se queda.
const settleQueue = Effect.fn('UploadQueue.settle')(function* <Input, Output>(
  items: readonly Input[],
  mapper: (item: Input, index: number) => Promise<Output>,
  concurrency: number,
  signal?: AbortSignal
): Effect.fn.Return<PromiseSettledResult<Output>[]> {
  const results = new Array<PromiseSettledResult<Output>>(items.length)
  let nextIndex = 0

  const runWorker = Effect.fn('UploadQueue.settle.worker')(function* () {
    while (nextIndex < items.length) {
      if (signal?.aborted === true) break
      const index = nextIndex
      nextIndex += 1
      results[index] = yield* Effect.tryPromise({
        try: () => mapper(items[index], index),
        catch: (reason) => reason,
      }).pipe(
        Effect.match({
          onSuccess: (value) => ({ status: 'fulfilled' as const, value }),
          onFailure: (reason) => ({ status: 'rejected' as const, reason }),
        })
      )
    }
  })

  yield* Effect.forEach(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()),
    (queueWorker) => queueWorker,
    { concurrency: 'unbounded', discard: true }
  )

  return results.slice(0, nextIndex)
})

/**
 * Corre la tanda en el borde `runServerEffect`. La validación de `concurrency`
 * ya ocurrió en `upload-queue.ts`, antes de pedir este chunk.
 */
export function settleQueueWithConcurrency<Input, Output>(
  items: readonly Input[],
  mapper: (item: Input, index: number) => Promise<Output>,
  concurrency: number,
  signal?: AbortSignal
): Promise<PromiseSettledResult<Output>[]> {
  return runServerEffect(settleQueue(items, mapper, concurrency, signal))
}
