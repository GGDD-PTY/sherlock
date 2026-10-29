// ============================================================================
// EL POST DEL RECORRIDO DE LA SALA — EL PROGRAMA EFFECT
// ============================================================================
// Un evento de recorrido sale por el borde autenticado y same-origin de
// Sherlock con techo de tiempo y una sola tentativa. El borde corre con
// `runServerEffectExit`, que asienta el Exit en vez de relanzar: este módulo
// nunca rechaza.
//
// ===== POR QUÉ VIVE APARTE DE `room-journey.ts` ([F] 2026-09-08) =====
// `trackRoomJourney` la llaman seis componentes `'use client'` de la sala y
// del perfil (`DocumentViewer`, `MyCompanyDocumentsClient`, `RoomShell` vía
// `room-navigation`, `CompanyContactSection`, `CompanyFinancialDashboard`,
// `CompanyProfileForm`). Tener el programa en el mismo módulo metía el runtime
// de fibras, `Schema` y el grafo de `externalCall` en el first-load JS de las
// dos salas. Nada se revirtió: el programa entero se mudó a este hermano, que
// `room-journey.ts` carga con `import()` recién cuando hay un evento que
// mandar y el navegador no optó por no ser rastreado.
// ============================================================================

import { Effect } from 'effect'

import type { RoomJourneyTrackArgs } from '@/lib/analytics/room-journey-contract'
import { UnexpectedAppError } from '@/lib/effect/errors'
import { externalCall } from '@/lib/effect/external'
import { runServerEffectExit } from '@/lib/effect/runtime'

// El mismo techo que usa el lado servidor de este evento
// (`room-journey-server.ts`): la analítica es advisory y ningún gesto del
// producto puede quedarse colgado esperando a la ingesta.
const ROOM_JOURNEY_TIMEOUT_MS = 1_500

const postRoomJourneyEvent = Effect.fn('RoomJourney.post')(function* (
  ...[event, properties]: RoomJourneyTrackArgs
) {
  const body = yield* Effect.try({
    try: () => JSON.stringify({ event, properties }),
    catch: (cause) =>
      new UnexpectedAppError({
        operation: 'roomJourney.serializeEvent',
        message: 'No se pudo serializar el evento de recorrido de la sala.',
        cause,
      }),
  })

  return yield* externalCall({
    service: 'SherlockJourneyIngest',
    operation: `journey.${event}`,
    timeout: ROOM_JOURNEY_TIMEOUT_MS,
    // El evento no lleva llave de idempotencia, así que un reintento de
    // transporte lo duplicaría en PostHog. Una sola tentativa.
    retries: 0,
    run: (signal) =>
      fetch('/api/analytics/journey', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: true,
        signal,
      }),
  })
})

/**
 * Manda un evento de recorrido. Nunca rechaza: el Exit se asienta en el borde,
 * así que ni un fallo de red ni el timeout salen de este módulo.
 */
export async function postRoomJourney(...args: RoomJourneyTrackArgs): Promise<void> {
  await runServerEffectExit(postRoomJourneyEvent(...args))
}
