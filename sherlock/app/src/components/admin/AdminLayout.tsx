'use client'

import { useCallback, useState } from 'react'
import { Effect, Schema } from 'effect'
import { useTranslations } from 'next-intl'

import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { runClientSync } from '@/lib/effect/client-runtime'
import { AdminSidebar } from './AdminSidebar'

interface AdminLayoutProps {
  children: React.ReactNode
  /**
   * La preferencia guardada, que el layout de la ruta lee de la cookie en el
   * servidor. Llega ya resuelta para que el primer paint salga con el ancho
   * correcto: leerla en el cliente daría un salto de 256 a 48 px al montar.
   */
  defaultSidebarOpen: boolean
}

// El primitivo tipa `onOpenChange` como boolean; un valor de otro tipo habría
// pasado a `setSidebarOpen` y dejado el shell desfasado de `open={sidebarOpen}`.
const SidebarOpenSchema = Schema.Boolean
const isSidebarOpen = Schema.is(SidebarOpenSchema)

const applySidebarOpen = Effect.fn('AdminLayout.applySidebarOpen')(function* (
  open: unknown,
  apply: (next: boolean) => void
) {
  if (!isSidebarOpen(open)) return
  yield* Effect.sync(() => apply(open))
})

export function AdminLayout({ children, defaultSidebarOpen }: AdminLayoutProps) {
  const t = useTranslations('admin.sidebar')
  const [sidebarOpen, setSidebarOpen] = useState(defaultSidebarOpen)

  const onSidebarOpenChange = useCallback((open: boolean) => {
    runClientSync(applySidebarOpen(open, setSidebarOpen))
  }, [])

  return (
    // `min-h-svh` es el default del bloque; acá el shell mide viewport menos
    // navbar y pie, la misma cuenta que el resto de la app.
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={onSidebarOpenChange}
      className="bg-background min-h-[calc(100dvh-7.5rem)]"
    >
      <AdminSidebar />

      {/* Contenedor, no landmark: el `main` de la pagina lo pone
          `app/[locale]/layout.tsx` y las rutas de admin cuelgan de el. */}
      <SidebarInset>
        {/* En el flujo, debajo del navbar: un control fijo arriba a la
            izquierda quedaba detrás del header sticky z-50. Desde `md` la
            barra es una columna y el disparador vive dentro de ella. */}
        <div className="border-border-hairline border-b px-4 py-2 sm:px-6 md:hidden">
          <SidebarTrigger label={t('menu')} />
        </div>

        {/* El inset es una columna flex y las páginas de admin abren con
            `mx-auto max-w-7xl`: un margen auto en el eje cruzado apaga el
            `stretch` y el contenido se encoge a su ancho natural. Este
            contenedor toma el ancho y deja que el `mx-auto` centre adentro. */}
        <div className="w-full min-w-0 flex-1">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
