// ============================================================================
// UPLOAD HANDOFF — continuidad landing → sala autenticada (LA FACHADA)
// ============================================================================
// El contrato público del sobre: la política de TTL, los tipos que la UI pinta
// y seis funciones `async` que ya lo eran. El programa Effect que abre
// IndexedDB en un scope vive en `upload-handoff-idb.ts` y llega por `import()`
// — esa frontera de carga diferida NO se movió.
//
// ===== LA COSTURA ([F] 2026-09-08, bloqueo levantado [F] 2026-09-09) =====
// Las tres superficies que lo consumen son componentes `'use client'`. Un
// import estático del programa grande metía `effect` y el runtime de fibras
// en su first-load JS, así que el programa se quedó del otro lado del
// `import()`. Lo que cambió con el bloqueo levantado es esta fachada:
// `withHandoffProgram` nombra su fallo real (el chunk que no llegó) con
// `Effect.gen` + `UnexpectedAppError` en vez de un `try/catch` genérico.
// Ningún sitio de import cambió y ninguna firma tampoco — cada función sigue
// esperando el chunk y delegando. Todo fallo del sobre sigue siendo advisory.
// `effect/Effect` ahora viaja en el first-load JS de las tres superficies —
// medido en el reporte del lote.
//
// `withHandoffProgram` corre con `runClientEffect`, no con `runServerEffect`.
// El runtime de servidor es la costura que `upload-handoff-scope.test.ts`
// sustituye para probar las cotas del idb sin reloj real
// (`effect-runtime-seam.ts`). El de cliente no pasa por ese módulo: el logger
// conserva el nivel y la captura del programa grande sigue llegando.
// ============================================================================

import { Effect } from 'effect'

import { UnexpectedAppError } from '@/lib/effect/errors'
import { runClientEffect } from '@/lib/effect/client-runtime'

// Covers sign-up + email verification without retaining browser bytes indefinitely.
export const HANDOFF_TTL_MS = 45 * 60 * 1000

export type HandoffFileId = number

export type HandoffFile = {
  id: HandoffFileId
  file: File
}

export type HandoffStash = {
  files: readonly File[]
  companyName?: string | null
  /** Llave del sobre: viaja en el returnTo del alta (`handoff-claim.ts`). */
  nonce: string
}

/**
 * IndexedDB pertenece al navegador, no a una sesión. `nonce` es la llave del
 * sobre: la sala solo lo reclama si su URL trae el mismo. `stashedAt` es el
 * reloj del parqueo y decide únicamente si el nombre bautiza la sala (un alta
 * nueva) o se descarta (una sala que ya existía). Ambos son `null` cuando no
 * sobrevive nada que reclamar; `nonce` también lo es en un sobre heredado de
 * código anterior, que así no empareja con ninguna URL.
 */
export type HandoffPeekResult =
  | {
      status: 'READY'
      files: HandoffFile[]
      companyName: string | null
      stashedAt: number
      nonce: string | null
    }
  | {
      status: 'EMPTY' | 'EXPIRED' | 'UNAVAILABLE'
      files: []
      companyName: string | null
      stashedAt: number | null
      nonce: string | null
    }

/**
 * Lo que devuelve una lectura que no pudo mirar la base. Duplica el valor del
 * mismo nombre en `upload-handoff-idb.ts` a propósito: ese módulo es
 * justamente el que puede no haber llegado, así que el estado terminal tiene
 * que existir de este lado. (Cuando se pueda tocar el idb, que lo importe de
 * acá y quede una sola copia.)
 */
const UNAVAILABLE_HANDOFF: HandoffPeekResult = {
  status: 'UNAVAILABLE',
  files: [],
  companyName: null,
  stashedAt: null,
  nonce: null,
}

// El programa llega por chunk aparte. La promesa se memoiza: una pantalla que
// hace peek y ack seguidos no paga dos cargas.
//
// El `catch` que limpia la memo es lo que hace que la pestaña se recupere. Con
// la promesa fija, un chunk que no llegó una vez —red que se cayó, deployment
// rotado— dejaba a las seis funciones esperando para siempre esa misma promesa
// rechazada: el sobre moría en esa pestaña y ningún gesto posterior lo revivía.
let idbModule: Promise<typeof import('@/lib/mycroft/upload-handoff-idb')> | null = null

function loadHandoffProgram(): Promise<typeof import('@/lib/mycroft/upload-handoff-idb')> {
  idbModule ??= import('@/lib/mycroft/upload-handoff-idb').catch((cause: unknown): never => {
    idbModule = null
    throw cause
  })
  return idbModule
}

/**
 * El chunk que no llega es un fallo del sobre como cualquier otro, y el sobre
 * es advisory: se responde el valor terminal, nunca se tira. Sin esto la
 * promesa rechazada salía por la firma pública — y la sala la consume con
 * `Effect.promise` (`MyCompanyDocumentsClient`), donde un rechazo no es un
 * fallo tipado sino un defecto que revienta la fibra del arranque.
 *
 * Genérico en `A`, así que el programa se arma con `Effect.gen` en el propio
 * scope de la función en vez de `Effect.fn`: `Effect.fn` fija sus parámetros
 * de tipo en la definición del generador y no los vuelve a inferir por
 * llamada, y acá cada caller trae su propio `A` (`boolean`, `HandoffPeekResult`).
 */
async function withHandoffProgram<A>(
  operation: string,
  run: (program: typeof import('@/lib/mycroft/upload-handoff-idb')) => Promise<A>,
  onUnavailable: A
): Promise<A> {
  const program = Effect.gen(function* () {
    const loaded = yield* Effect.tryPromise({
      try: () => loadHandoffProgram(),
      catch: (cause) =>
        new UnexpectedAppError({
          operation: `uploadHandoff.${operation}`,
          message: `[UploadHandoff] ${operation} no pudo cargar el programa.`,
          cause,
        }),
    })
    return yield* Effect.promise(() => run(loaded))
  }).pipe(
    Effect.withSpan(`UploadHandoff.${operation}`),
    Effect.catch((error) =>
      Effect.logWarning(`[UploadHandoff] ${operation} no pudo correr:`, error).pipe(
        Effect.as(onUnavailable)
      )
    )
  )
  return runClientEffect(program)
}

// ============================================================================
// API PÚBLICA — firmas Promise intactas para los consumidores React
// ============================================================================

/**
 * Parks a new selection across hosted auth. A non-empty selection deliberately
 * replaces a previous batch; returning false means the caller must not claim the
 * bytes were preserved.
 */
export async function stashHandoff(stash: HandoffStash): Promise<boolean> {
  return withHandoffProgram('stash', (program) => program.stashHandoff(stash), false)
}

/**
 * Reads a recoverable intake without consuming it. Expiration is an explicit
 * terminal policy and is reported distinctly so the UI can ask for re-selection.
 * The company name outlives the files: a temporary-intake batch acknowledges its
 * bytes before the room ever opens, and the name still has to name that room.
 */
export async function peekHandoff(): Promise<HandoffPeekResult> {
  return withHandoffProgram('peek', (program) => program.peekHandoff(), UNAVAILABLE_HANDOFF)
}

/** Removes only records whose durable backend outcome was confirmed. */
export async function ackHandoffFiles(ids: readonly HandoffFileId[]): Promise<boolean> {
  return withHandoffProgram('ackFiles', (program) => program.ackHandoffFiles(ids), false)
}

/**
 * Tira el sobre SOLO si sigue siendo el de esta llave. Un stash que venció su
 * cota y terminó tarde escribe un sobre que ya nadie puede reclamar — la visita
 * siguió sin llave en la URL —, y borrarlo a ciegas se llevaría el sobre de un
 * gesto posterior, que ya lleva otra llave. Se borra registro por registro y
 * solo los que la traen.
 */
export async function discardHandoffWithNonce(nonce: string): Promise<boolean> {
  return withHandoffProgram(
    'discardWithNonce',
    (program) => program.discardHandoffWithNonce(nonce),
    false
  )
}

/**
 * Tira el sobre completo — bytes y nombre — sin reclamar que su contenido llegó
 * a ningún lado. Es lo contrario del ack: se usa cuando el handoff ya no le
 * pertenece a nadie (una sala que no lo originó, un stash que no se pudo
 * escribir), para que ninguna visita posterior lo vuelva a aplicar.
 */
export async function discardHandoff(): Promise<boolean> {
  return withHandoffProgram('discard', (program) => program.discardHandoff(), false)
}

/** Removes the parked name once a room actually carries it. */
export async function ackHandoffCompanyName(): Promise<boolean> {
  return withHandoffProgram('ackCompanyName', (program) => program.ackHandoffCompanyName(), false)
}
