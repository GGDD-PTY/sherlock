// ============================================================================
// LOCALIZED CATCH-ALL 404
// ============================================================================
// Cualquier ruta bajo /{locale}/ que el router no matchee renderiza el
// not-found localizado con status HTTP 404 real. El proxy reescribe los
// segmentos desconocidos hacia aquí (fail-closed): una ruta nueva que no
// esté en las listas pública/protegida da 404 en vez de quedar expuesta.
//
// `notFound()` es la compuerta: lanza una excepción con un `digest` que Next
// reconoce para decidir el 404. Envolverla en Effect.exit/either/result se
// traga esa excepción y la ruta terminaría sirviendo 200 (o 500) donde debía
// dar 404 — así que se queda sola, fuera de todo programa Effect
// (effect-brief-react.md).
import { Schema } from 'effect'
import { notFound } from 'next/navigation'

const CatchAllParamsSchema = Schema.Struct({
  locale: Schema.String,
  rest: Schema.Array(Schema.String),
})
const decodeCatchAllParams = Schema.decodeUnknownOption(CatchAllParamsSchema)

export default async function CatchAllNotFound({
  params,
}: {
  params: Promise<{ locale: string; rest: string[] }>
}) {
  const decoded = decodeCatchAllParams(await params)
  if (decoded._tag === 'None') {
    notFound()
  }
  notFound()
}
