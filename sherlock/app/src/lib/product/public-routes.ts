// ============================================================================
// RUTAS PÚBLICAS — CATÁLOGO ÚNICO
// ============================================================================
// Las rutas que un anónimo puede abrir sin sesión. Estaban escritas a mano en
// cinco archivos —`app/sitemap.ts`, `app/[locale]/not-found.tsx`,
// `app/global-not-found.tsx`, `components/layout/FooterGate.tsx` y
// `lib/navigation/registry.ts`—, cada copia con su propio `Schema.Literals` y
// ninguna atada a las demás: retirar una página dejaba cuatro listas que nadie
// obligaba a enterarse.
//
// No entra en `architecture.ts`: ese registro describe el producto (objetivo,
// CTA, gating, dueño del dato). `/ayuda` sí vive ahí; los tres documentos
// legales no. Éste es la lista de caminos, nada más.
// ============================================================================

import { Schema } from 'effect'

// El schema se exporta, no las rutas ya resueltas: cada consumidor decodifica
// las suyas al cargar su módulo, así un typo revienta con un error legible al
// levantar el server en vez de convertirse en un link roto que solo se ve
// haciendo clic. La lista, que es lo que se duplicaba, vive una sola vez acá.
export const PublicRouteSchema = Schema.Literals([
  '/',
  '/ayuda',
  '/privacy',
  '/terms',
  '/legal',
  '/sign-in',
])

// Contenido público: lo que el sitemap anuncia y lo que lleva el footer de
// marketing. `/sign-in` es una puerta, no contenido, y queda fuera. El orden es
// el del documento del sitemap.
export const PublicContentPathSchema = PublicRouteSchema.pick([
  '/',
  '/ayuda',
  '/privacy',
  '/terms',
  '/legal',
])
export type PublicContentPath = typeof PublicContentPathSchema.Type
export const PUBLIC_CONTENT_PATHS = PublicContentPathSchema.literals
