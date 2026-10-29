// Next pinta el `not-found` más cercano al segmento que llamó `notFound()`. El
// 404 localizado vive en `[locale]/not-found.tsx`, que cuelga del documento
// pelado: sin este límite, el catch-all `[...rest]` y la landing con un locale
// inválido salían sin la barra ni el footer de `PublicShell` (tarjeta O2-06).

import { Effect } from 'effect'

import LocaleNotFound from '@/app/[locale]/not-found'
import { runServerEffectSync } from '@/lib/effect/runtime'

// Sin entrada externa ni props: el programa nombrado solo delega en el 404
// compartido, igual que `my-company/documents/activity/loading.tsx`.
const renderPublicNotFound = Effect.fn('PublicNotFound.render')(function* () {
  return yield* Effect.sync(() => <LocaleNotFound />)
})

export default function PublicNotFound() {
  return runServerEffectSync(renderPublicNotFound())
}
