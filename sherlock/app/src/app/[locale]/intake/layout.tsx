// Fuera de los dos grupos de rutas, así que monta el shell de la app a mano:
// los providers y el cromo que esta página tenía cuando vivían en el layout
// raíz (tarjeta O2-06).

import type { ReactNode } from 'react'
import { Schema } from 'effect'

import { AppShell } from '@/components/providers/AppShell'

const DynamicRenderingSchema = Schema.Literals(['auto', 'error', 'force-dynamic', 'force-static'])

// Dinámica como en `(app)/layout.tsx`: evita validar el env de auth durante el
// prerender. El export tiene que ser un literal: Next lo lee con análisis
// estático. El schema valida el literal al cargar.
export const dynamic = 'force-dynamic'
Schema.decodeSync(DynamicRenderingSchema)(dynamic)

export default function IntakeLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>
}
