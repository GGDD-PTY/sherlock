// Barril de la superficie `analytics:*`. Convex direcciona por path TODO lo que
// un módulo de `convex/` exporte, así que la lista de nombres es un contrato de
// seguridad y no documentación. Se declara una vez como `Schema.Literals` y el
// chequeo de abajo rompe el typecheck si el barril y la lista se separan —en
// cualquiera de las dos direcciones.
import { Schema } from 'effect'

export { getOperationsOverview, getRecentActivity } from './_analytics/admin'

const DeclaredSchema = Schema.Literals(['getOperationsOverview', 'getRecentActivity'])

const isDeclaredAnalyticsExport = Schema.is(DeclaredSchema)

// Corre al cargar el módulo: un literal repetido o mal escrito en el catálogo
// de arriba falla acá en cada cold start del isolate, no solo cuando alguien
// corre `tsc`.
if (!DeclaredSchema.literals.every(isDeclaredAnalyticsExport)) {
  console.error('[convex/analytics] catálogo de exports mal formado')
}

type Exported = keyof typeof import('./analytics')
type Assert<T extends true> = T
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export type _SurfaceMatchesDeclaration = Assert<Exact<Exported, typeof DeclaredSchema.Type>>
