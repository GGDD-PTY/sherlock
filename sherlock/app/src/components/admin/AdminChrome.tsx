'use client'

import dynamic from 'next/dynamic'
import { Schema } from 'effect'

const ViewAsBanner = dynamic(
  () => import('@/components/admin/ViewAsBanner').then((mod) => mod.ViewAsBanner),
  { ssr: false }
)

const DevToolbar = dynamic(
  () => import('@/components/dev/DevToolbar').then((mod) => mod.DevToolbar),
  { ssr: false }
)

// Los dos slots del chrome admin. `dynamic()` parte el chunk. `NODE_ENV` se
// compara literal para que el bundler elimine DevToolbar en producción;
// envolverlo en Effect.Config le quitaría esa eliminación.
const AdminChromeSlotSchema = Schema.Literals(['view-as-banner', 'dev-toolbar'])

export function AdminChrome() {
  return (
    <>
      {AdminChromeSlotSchema.literals.map((slot) => {
        if (slot === 'view-as-banner') {
          return <ViewAsBanner key={slot} />
        }
        return process.env.NODE_ENV !== 'production' ? <DevToolbar key={slot} /> : null
      })}
    </>
  )
}
