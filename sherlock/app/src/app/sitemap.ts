import type { MetadataRoute } from 'next'
import { Schema } from 'effect'

import { defaultLocale } from '@/i18n/config'
import {
  PUBLIC_CONTENT_PATHS,
  PublicRouteSchema,
  type PublicContentPath,
} from '@/lib/product/public-routes'
import { getPublicAppUrl } from '@/lib/site/brand'

// `NEXT_PUBLIC_APP_URL` llega a `getPublicAppUrl()` sin pasar por ningún
// parseo, y de ahí se interpola en TODAS las URLs que este documento anuncia:
// si el valor no es una URL, el sitemap entero apunta a ninguna parte y nada
// lo dice. Se decodifica una vez, al cargar el módulo. `origin` es además la
// normalización que le faltaba a la concatenación de antes — una barra final
// en la variable producía `https://app.example.com//es`— y es como el resto
// del repo trata esa variable (`getPublicAppHost` le lee el `hostname`).
const BASE_URL = Schema.decodeUnknownSync(Schema.URLFromString)(getPublicAppUrl()).origin

// La home es el prefijo de locale pelado: `/es`, no `/es/`.
const HOME_PATH = Schema.decodeSync(PublicRouteSchema)('/')

// El sitio ships en un solo idioma ([F] 2026-09-03) pero el prefijo se queda en
// la URL. Sale del catálogo de i18n, no de un `'/es'` escrito al lado.
const LOCALE_PREFIX = `/${defaultLocale}`

// Las superficies que se anuncian salen del catálogo de rutas públicas, en su
// orden. La tabla de abajo se ata a esa lista con `satisfies`: una ruta pública
// nueva sin prioridad deja de compilar en vez de quedarse fuera del sitemap sin
// decir nada.
//
// `changeFrequency` sigue saliendo del tipo de Next a propósito: copiar ese
// vocabulario acá crearía la segunda fuente de verdad que este trabajo borra.
type SitemapEntry = {
  readonly priority: number
  readonly changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency']
}

const PAGES = {
  '/': { priority: 1.0, changeFrequency: 'weekly' },
  '/ayuda': { priority: 0.6, changeFrequency: 'monthly' },
  '/privacy': { priority: 0.3, changeFrequency: 'yearly' },
  '/terms': { priority: 0.3, changeFrequency: 'yearly' },
  '/legal': { priority: 0.3, changeFrequency: 'yearly' },
} satisfies Record<PublicContentPath, SitemapEntry>

export default function sitemap(): MetadataRoute.Sitemap {
  // Una sola marca de tiempo para el documento entero: cinco `new Date()`
  // daban cinco instantes distintos para la misma corrida.
  const lastModified = new Date()

  return PUBLIC_CONTENT_PATHS.map((path) => ({
    url: `${BASE_URL}${LOCALE_PREFIX}${path === HOME_PATH ? '' : path}`,
    lastModified,
    changeFrequency: PAGES[path].changeFrequency,
    priority: PAGES[path].priority,
  }))
}
