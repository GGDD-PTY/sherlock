import { Effect } from 'effect'

import { ActivitySkeleton } from '@/components/company/data-room-activity/ActivitySkeleton'
import { runServerEffectSync } from '@/lib/effect/runtime'

// El archivo no tiene entrada externa, ni props, ni lista que recorrer — solo
// delega en `ActivitySkeleton`. El programa nombrado es el camino 6 del
// llenado: ceremonia para que el archivo cuente.
const renderActivityLoading = Effect.fn('MyCompanyDocumentsActivityLoading.render')(function* () {
  return yield* Effect.sync(() => <ActivitySkeleton />)
})

export default function Loading() {
  return runServerEffectSync(renderActivityLoading())
}
