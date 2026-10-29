'use client'

import type { ReactNode } from 'react'
import { Schema } from 'effect'

import { usePathname } from '@/i18n/navigation'
import { PublicContentPathSchema } from '@/lib/product/public-routes'

// El footer de marketing (columnas, tagline, "Sube tus documentos") es del sitio
// público. Dentro del producto (sala, admin, ajustes, alta) la página termina
// en el trabajo y queda una sola línea legal. Ambos footers llegan renderizados
// del servidor; aquí solo se elige cuál mostrar según la ruta sin locale.
//
// La lista es el catálogo de contenido público: el footer de marketing va donde
// va el sitemap, así que las dos no pueden separarse.
//
// La pertenencia se pregunta con el schema y no con un `includes` sobre un
// arreglo: `usePathname()` devuelve una string cualquiera, y ésa es la
// frontera. Así desapareció el `as readonly string[]` que le quitaba el tipo a
// la lista justo en el punto donde se usaba.
const isSiteFooterPath = Schema.is(PublicContentPathSchema)

export function FooterGate({ site, product }: { site: ReactNode; product: ReactNode }) {
  const pathname = usePathname()
  return <>{isSiteFooterPath(pathname) ? site : product}</>
}
