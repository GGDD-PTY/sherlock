// ============================================================================
// GLOBAL 404
// ============================================================================
// Página 404 global para rutas que no matchean ningún route del app — es lo
// que Vercel sirve cuando el proxy reescribe rutas desconocidas con status
// 404. Renderiza su propio <html>/<body> (convención global-not-found de
// Next). El sitio sirve un solo idioma, así que la página va entera en
// español y el documento declara `lang="es"`.
// ============================================================================

import type { Metadata } from 'next'
import Link from 'next/link'
import { Schema } from 'effect'
import { getRootFontClassName } from '@/lib/fonts/font-config'
import { rootFontVariables } from '@/lib/fonts/root-fonts'
import { PublicRouteSchema } from '@/lib/product/public-routes'
import { THEME_BOOT_SCRIPT } from '@/lib/theme/boot-script'
import esMessages from '@/messages/es.json'
import './globals.css'

const global404 = esMessages.errors.global404

// Los dos destinos que esta página pinta se decodifican contra el catálogo
// compartido al cargar el módulo: un typo, o una ruta que se retire de
// `public-routes.ts`, revienta con un error legible al levantar el server en
// vez de convertirse en un link roto que solo se ve haciendo clic.
const decodePublicRoute = Schema.decodeSync(PublicRouteSchema)
const HOME_PATH = decodePublicRoute('/')
const HELP_PATH = decodePublicRoute('/ayuda')

export const metadata: Metadata = {
  title: `${global404.title} | Sherlock`,
  robots: { index: false, follow: false },
}

export default function GlobalNotFound() {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        {/* Sin esto la 404 global ignora el tema: reemplaza el layout raíz, así
            que no hereda ni el ThemeProvider ni su boot script. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className={getRootFontClassName({ remoteFontVariables: rootFontVariables })}>
        <main className="bg-background text-foreground flex min-h-screen flex-col items-center justify-center px-6 text-center">
          <p className="font-data text-muted-foreground text-sm tracking-widest">404</p>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight">{global404.title}</h1>
          <p className="text-muted-foreground mt-6 max-w-md text-sm">{global404.body}</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3 text-sm">
            {/*
            Sin prefijo de locale a propósito: esta página vive FUERA de
            [locale] y no tiene contexto de routing que leer. El proxy resuelve
            una ruta sin prefijo al único locale del sitio.
            */}
            <Link
              href={HOME_PATH}
              className="bg-primary text-primary-foreground rounded-lg px-4 py-2 font-medium"
            >
              {global404.cta}
            </Link>
            <Link
              href={HELP_PATH}
              className="border-border rounded-lg border px-4 py-2 font-medium"
            >
              {global404.help}
            </Link>
          </div>
        </main>
      </body>
    </html>
  )
}
