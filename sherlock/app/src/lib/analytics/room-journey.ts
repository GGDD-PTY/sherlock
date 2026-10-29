'use client'

// ============================================================================
// RECORRIDO DE LA SALA — LA FACHADA DEL CLIENTE
// ============================================================================
// Este módulo lo importan seis componentes `'use client'` de la sala y del
// perfil, así que viaja en el first-load JS de las dos salas. El programa
// pesado —el `externalCall`, el techo de 1,5 s, la única tentativa y sus
// errores tipados— sigue viviendo en `room-journey-drain.ts` y llega por un
// chunk aparte con `import()`: esa frontera de carga diferida NO se movió.
//
// [F] 2026-09-09 levantó el bloqueo de peso de bundle que mantenía este
// módulo sin Effect. Lo que cambió es esta fachada: su único fallo real (el
// chunk que no llegó, o el envío mismo aunque hoy nunca rechace) ahora tiene
// nombre con `Effect.fn` + `UnexpectedAppError` en vez de un `try/catch`
// genérico. Eso trae `effect/Effect` al first-load JS de la sala — medido en
// el reporte del lote.
//
// Corre con `runClientEffect`, no con `runServerEffect`. El runtime de
// servidor es la costura que `room-journey-client.test.ts` sustituye para
// probar la cota de 1,5 s del drenaje sin reloj real
// (`effect-runtime-seam.ts`). El de cliente no pasa por ese módulo: el logger
// conserva el nivel y la captura del drain sigue llegando.
//
// El chequeo de opt-out corre ANTES de pedir ese chunk: un navegador que dijo
// que no quiere ser rastreado ni siquiera lo descarga.
// ============================================================================

import { Effect } from 'effect'

import type { RoomJourneyTrackArgs } from '@/lib/analytics/room-journey-contract'
import { UnexpectedAppError } from '@/lib/effect/errors'
import { runClientEffect } from '@/lib/effect/client-runtime'

declare global {
  interface Navigator {
    readonly globalPrivacyControl?: boolean
  }
}

function browserOptsOut(): boolean {
  return navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true
}

// La promesa del chunk se memoiza para que una ráfaga de eventos no dispare
// varias cargas; un fallo la limpia y el siguiente evento vuelve a intentar.
let drainModulePromise: Promise<typeof import('@/lib/analytics/room-journey-drain')> | null = null

function loadDrainModule(): Promise<typeof import('@/lib/analytics/room-journey-drain')> {
  drainModulePromise ??= import('@/lib/analytics/room-journey-drain').catch(
    (cause: unknown): never => {
      drainModulePromise = null
      throw cause
    }
  )
  return drainModulePromise
}

const trackRoomJourneyEffect = Effect.fn('RoomJourney.track')(function* (
  ...args: RoomJourneyTrackArgs
) {
  const { postRoomJourney } = yield* Effect.tryPromise({
    try: () => loadDrainModule(),
    catch: (cause) =>
      new UnexpectedAppError({
        operation: 'roomJourney.loadDrainModule',
        message: 'No se pudo cargar el módulo de envío del recorrido de la sala.',
        cause,
      }),
  })
  // `postRoomJourney` nunca rechaza (asienta su propio Exit en el borde), así
  // que acá es `Effect.promise`, no `Effect.tryPromise`.
  yield* Effect.promise(() => postRoomJourney(...args))
})

/**
 * Records a closed-schema VDR journey event through Sherlock's authenticated,
 * same-origin server boundary. Failures never interrupt the product action:
 * un chunk que no llegó, o un fallo de envío, se traga acá — la analítica es
 * advisory.
 */
export async function trackRoomJourney(...args: RoomJourneyTrackArgs): Promise<void> {
  if (typeof window === 'undefined' || browserOptsOut()) return

  await runClientEffect(
    trackRoomJourneyEffect(...args).pipe(
      Effect.catch((error) =>
        Effect.logWarning('[RoomJourney] No se pudo cargar el módulo de envío:', error)
      )
    )
  )
}
