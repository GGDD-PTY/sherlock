import { Effect, Option, Schema } from 'effect'
import { getTranslations } from 'next-intl/server'

import { PRODUCT_ROUTES } from '@/lib/product/architecture'

// La ruta que exige `requireRole` es un literal escrito a mano. Atarlo al
// catálogo de `architecture.ts` con `Schema.decodeSync` hace que un typo
// reviente al cargar el módulo, en vez de fallar en silencio en producción.
// Solo las rutas del panel: con el catálogo entero, `adminRoute('/my-company/documents')`
// también pasaba y el candado no distinguía una página admin de una de cliente.
const AdminRoutePathSchema = Schema.Literals(
  PRODUCT_ROUTES.filter((route) => route.surface === 'ADMIN').flatMap((route) => route.paths)
)

export function adminRoute(path: string): string {
  return Schema.decodeSync(AdminRoutePathSchema)(path)
}

class AdminPageTranslationsError extends Schema.TaggedError<AdminPageTranslationsError>()(
  'AdminPageTranslationsError',
  {
    namespace: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

export const loadAdminTranslations = Effect.fn('AdminPage.loadTranslations')(function* (
  locale: string,
  namespace: string
) {
  return yield* Effect.tryPromise({
    try: () => getTranslations({ locale, namespace }),
    catch: (cause) => new AdminPageTranslationsError({ namespace, cause }),
  })
})

// Selectores que llegan por query string: entrada del navegador. Un arreglo
// (Next lo produce cuando el parámetro viene repetido), vacío o larguísimo
// se descartan.
const BoundedSelectionSchema = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128))
)

const decodeBoundedSelection = Schema.decodeUnknownOption(BoundedSelectionSchema)

export function boundedSelection(value: string | string[] | undefined): string | undefined {
  return Option.getOrUndefined(decodeBoundedSelection(value))
}
