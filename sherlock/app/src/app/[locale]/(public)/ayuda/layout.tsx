// El grupo `(public)` no monta Convex ni AuthKit: si vivieran en el layout
// del grupo, volverían al first-load JS de la landing (tarjeta O2-06). Este
// hub sí los necesita: `RoadmapBoard` vota y `AyudaFeedback` envía con
// `useQuery`/`useMutation`. Quedan acá, en el segmento `/ayuda`, para que
// `/es` siga sin el cliente.

import type { ReactNode } from 'react'
import { Effect } from 'effect'

import { AuthProvider } from '@/components/providers/AuthProvider'
import { ConvexClientProvider } from '@/components/providers/ConvexClientProvider'
import { runServerEffectSync } from '@/lib/effect/runtime'

// Sin entrada externa: el programa nombrado solo monta los dos providers,
// igual que `my-company/documents/activity/loading.tsx`.
const renderAyudaLayout = Effect.fn('AyudaLayout.render')(function* (children: ReactNode) {
  return yield* Effect.sync(() => (
    <AuthProvider>
      <ConvexClientProvider>{children}</ConvexClientProvider>
    </AuthProvider>
  ))
})

export default function AyudaLayout({ children }: { children: ReactNode }) {
  return runServerEffectSync(renderAyudaLayout(children))
}
