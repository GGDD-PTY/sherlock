// Next pinta el `not-found` más cercano al segmento que llamó `notFound()`. El
// cromo de la app vive en el layout de cada sección, y este límite cuelga del
// grupo, así que la pantalla se sirve con el cromo público: barra y footer del
// sitio en vez de un documento pelado (tarjeta O2-06, decisión de la estación
// 2026-09-12). `PublicShell` no monta Convex ni AuthKit, así que este entry
// tampoco arrastra sesión al manifest del grupo.

import { Effect } from 'effect'

import LocaleNotFound from '@/app/[locale]/not-found'
import { PublicShell } from '@/components/providers/PublicShell'
import { runServerEffectSync } from '@/lib/effect/runtime'

const renderAppNotFound = Effect.fn('AppNotFound.render')(function* () {
  return yield* Effect.sync(() => (
    <PublicShell>
      <LocaleNotFound />
    </PublicShell>
  ))
})

export default function AppNotFound() {
  return runServerEffectSync(renderAppNotFound())
}
