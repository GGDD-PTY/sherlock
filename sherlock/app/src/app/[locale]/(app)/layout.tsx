// ============================================================================
// APP ROUTE GROUP LAYOUT
// ============================================================================
// Pasa de largo a propósito. El cromo y los providers viven un nivel más abajo,
// en el layout de cada sección, porque el manifest de Next mezcla por grupo sin
// mirar los paréntesis: `entryNameToGroupName()` borra `(app)` y `(public)` del
// nombre, así que un entry con Convex acá arrastraba sus 26 chunks a la landing
// (tarjeta O2-06, decisión de la estación 2026-09-12).
// ============================================================================

import type { ReactNode } from 'react'
import { Schema } from 'effect'

const DynamicRenderingSchema = Schema.Literals(['auto', 'error', 'force-dynamic', 'force-static'])

// Auth de WorkOS en todo el grupo: sin esto Next podría cachear el segmento.
// El export tiene que ser un literal: Next lo lee con análisis estático y, si
// ve una llamada, avisa «can't recognize the exported dynamic field» y usa el
// default. El schema valida el literal al cargar.
export const dynamic = 'force-dynamic'
Schema.decodeSync(DynamicRenderingSchema)(dynamic)

export default function AppLayout({ children }: { children: ReactNode }) {
  return <>{children}</>
}
