// El primer enlace del documento, idéntico en los dos shells. Estaba escrito
// una sola vez porque había un solo layout; ahora que hay dos, la clase y el
// destino viven acá para que no se separen (tarjeta O2-06).

import { Schema } from 'effect'

// El salto y el `<main>` al que apunta llevan el mismo id en los dos shells:
// el literal se decodifica una vez al cargar y lo leen los tres sitios.
const MainContentIdSchema = Schema.Literals(['main-content'])
export const MAIN_CONTENT_ID = Schema.decodeSync(MainContentIdSchema)('main-content')

export function SkipToContent({ label }: { label: string }) {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="focus:bg-primary focus:text-primary-foreground focus:ring-ring sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[60] focus:rounded-md focus:px-4 focus:py-2 focus:ring-2 focus:outline-none"
    >
      {label}
    </a>
  )
}
