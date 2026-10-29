// ============================================================================
// VDR READ MCP — Effect runtime for the module
// ============================================================================
// Effect is the default for Sherlock's TypeScript, including React and Convex
// ([F] 2026-09-08 21:22, DECISIONS). This module keeps only the VDR-specific
// policy; transport, retry and process execution come from the shared
// `lib/effect` core.
//
// `VdrShapeError` means Convex answered something the schema rejects. That is
// a contract break between this module and `convex/vdrRead.ts`; retrying it
// burns the lambda's clock three times before failing anyway.
// ============================================================================

import { Effect, Schema } from 'effect'

import type { ExternalServiceError } from '@/lib/effect/errors'
import { decodeBoundary, externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'
import { VdrToolError } from '@/lib/vdr-mcp/errors'

const LOG_MODULE = 'VdrMcpStore'

const CONVEX_CALL_TIMEOUT = '8 seconds'
const CONVEX_RETRY_TIMES = 2
const CONVEX_RETRY_DELAY = '150 millis'

export class VdrShapeError extends Schema.TaggedError<VdrShapeError>()('VdrShapeError', {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export type VdrStoreError = ExternalServiceError | VdrShapeError

/**
 * Solo se reintenta lo idempotente, y el `retries` es explícito por eso.
 *
 * El cliente HTTP de Convex no acepta un `AbortSignal`, así que la cota de 8 s
 * abandona la promesa pero no cancela la mutación: del otro lado puede haber
 * commiteado igual. Reintentar una escritura que no es idempotente duplica su
 * efecto. Las tres lecturas y `writeTextIndex` sí lo son —esa última hace
 * upsert por `documentVersionId`— y se quedan con los dos reintentos.
 */
export function convexCall<A>(
  operation: string,
  call: () => PromiseLike<A>,
  options: { readonly retries?: number } = {}
): Effect.Effect<A, ExternalServiceError> {
  return externalCall({
    service: 'Convex',
    operation,
    run: () => call(),
    timeout: CONVEX_CALL_TIMEOUT,
    retries: options.retries ?? CONVEX_RETRY_TIMES,
    retryDelay: CONVEX_RETRY_DELAY,
  })
}

export function parseResponse<S extends Schema.Top>(
  operation: string,
  schema: S,
  input: unknown
): Effect.Effect<S['Type'], VdrShapeError, S['DecodingServices']> {
  return decodeBoundary(operation, schema, input).pipe(
    Effect.mapError(
      (cause) => new VdrShapeError({ operation, message: cause.message, cause: cause.cause })
    )
  )
}

export async function runStore<A>(effect: Effect.Effect<A, VdrStoreError>): Promise<A> {
  const outcome = await runServerEffect(
    effect.pipe(
      // El fallo se loguea dentro del programa, donde el logger de la capa lo
      // enruta con su nivel y con los spans que ya trae `externalCall`. El
      // módulo va en el payload porque es lo que `createLogger('VdrMcpStore')`
      // ponía en el prefijo de cada línea: sin él, dos módulos que fallan
      // llamando a Convex escriben lo mismo.
      Effect.tapError((error: VdrStoreError) =>
        Effect.logError('convex call failed', {
          module: LOG_MODULE,
          operation: error.operation,
          kind: error._tag,
          detail: error.message,
        })
      ),
      Effect.match({
        onSuccess: (value: A) => ({ ok: true as const, value }),
        onFailure: (error: VdrStoreError) => ({ ok: false as const, error }),
      })
    )
  )

  if (outcome.ok) return outcome.value

  throw new VdrToolError(
    'NO_DISPONIBLE',
    'La operación no está disponible.',
    'Reintenta más tarde o usa sala_resumen para verificar el estado de la sala.'
  )
}
