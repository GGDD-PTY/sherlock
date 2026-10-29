'use client'

import { useEffect } from 'react'
import { Effect } from 'effect'

import { trackSellSideEventOnce } from '@/lib/analytics/sell-side'
import { runClientSync } from '@/lib/effect/client-runtime'

/** Records only the safe fact that an authorized temporary room rendered. */
const recordTemporaryRoomEntered = Effect.fn('IntakeWorkspaceSignal.record')(
  function* (): Effect.fn.Return<void> {
    yield* Effect.sync(() => {
      trackSellSideEventOnce(
        'workspace_entered',
        { locale: 'es', mode: 'TEMPORARY' },
        'temporary-room'
      )
    })
  }
)

export function IntakeWorkspaceSignal() {
  useEffect(() => {
    runClientSync(recordTemporaryRoomEntered())
  }, [])

  return null
}
