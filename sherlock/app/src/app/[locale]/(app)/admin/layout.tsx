import { cookies } from 'next/headers'
import { Option, Schema } from 'effect'

import { AdminLayout } from '@/components/admin/AdminLayout'
import { AppShell } from '@/components/providers/AppShell'

// Next acepta cuatro valores en `dynamic`. Un typo aquí no se ve hasta que el
// segmento se cachea; el catálogo revienta al cargar el módulo.
const DynamicRenderingSchema = Schema.Literals(['auto', 'error', 'force-dynamic', 'force-static'])

// Auth de WorkOS: sin esto Next podría cachear el segmento y servir el panel
// a quien no toca.
// El export tiene que ser un literal: Next lo lee con análisis estático y, si
// ve una llamada, avisa «can't recognize the exported dynamic field» y usa el
// default (el segmento se cachea). El schema valida el literal al cargar.
export const dynamic = 'force-dynamic'
Schema.decodeSync(DynamicRenderingSchema)(dynamic)

// `SidebarProvider` (`components/ui/sidebar.tsx`) guarda acá si la barra quedó
// abierta. El nombre se repite a propósito: ese módulo es `'use client'` y sus
// exports llegan al servidor como referencias de cliente, no como el string.
const SIDEBAR_STATE_COOKIE = 'sidebar_state'

// Se lee en el servidor, no en el cliente: así el primer paint ya sale con el
// ancho que el usuario dejó, sin el salto de 256 a 48 px al montar.
const decodeSidebarState = Schema.decodeUnknownOption(Schema.Literals(['true', 'false']))

export default async function AdminSectionLayout({ children }: { children: React.ReactNode }) {
  const stored = decodeSidebarState((await cookies()).get(SIDEBAR_STATE_COOKIE)?.value)
  const defaultSidebarOpen = Option.isSome(stored) ? stored.value === 'true' : true

  // El cromo y los providers viven acá, no en `(app)/layout.tsx`: un entry con
  // Convex a nivel de grupo arrastraba sus chunks a la landing (tarjeta O2-06).
  return (
    <AppShell>
      <AdminLayout defaultSidebarOpen={defaultSidebarOpen}>{children}</AdminLayout>
    </AppShell>
  )
}
