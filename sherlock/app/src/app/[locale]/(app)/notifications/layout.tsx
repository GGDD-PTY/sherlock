import { Schema } from 'effect'

import { AppShell } from '@/components/providers/AppShell'

const DynamicRenderingSchema = Schema.Literals(['auto', 'error', 'force-dynamic', 'force-static'])

// El cromo y los providers viven acá, no en `(app)/layout.tsx`: un entry con
// Convex a nivel de grupo arrastraba sus chunks a la landing (tarjeta O2-06).
// Force dynamic rendering (uses WorkOS auth).
// El export tiene que ser un literal: Next lo lee con análisis estático y, si
// ve una llamada, avisa «can't recognize the exported dynamic field» y usa el
// default (el segmento se cachea). El schema valida el literal al cargar.
export const dynamic = 'force-dynamic'
Schema.decodeSync(DynamicRenderingSchema)(dynamic)

export default function Layout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}
