'use client'

import { Effect, Schema } from 'effect'

import type { Id } from '@/../convex/_generated/dataModel'
import { runClientSync } from '@/lib/effect/client-runtime'
import { useRouter } from '@/i18n/navigation'
import { CompanyFinancialDashboard, type FinancialSource } from './CompanyFinancialDashboard'
import { RoomProgressPanel } from './RoomProgressPanel'
import { ROOM_SCREEN_PATH } from './roomScreens'
import { serializeOpenSourceRequest } from './vdr/workspace-url-state'

const isDemoFlag = Schema.is(Schema.Boolean)

function navigateFromSource(source: FinancialSource) {
  if (source.locator.kind === 'PAGE') return { page: source.locator.page }
  return { sheet: source.locator.sheet, range: source.locator.range }
}

const openPublishedSource = Effect.fn('CompanyPreparationScreen.openPublishedSource')(function* (
  source: FinancialSource,
  push: (href: string) => void
) {
  const query = serializeOpenSourceRequest({
    documentId: source.documentId,
    versionId: source.versionId,
    navigate: navigateFromSource(source),
  })
  yield* Effect.sync(() => {
    push(`${ROOM_SCREEN_PATH.documents}?${query}`)
  })
})

// Qué falta y qué entregó el equipo. Las cifras publicadas van encima cuando
// existen (el dashboard se esconde solo si no hay snapshot); una cifra citada
// abre su fuente en la pantalla de documentos.
export function CompanyPreparationScreen({
  companyId,
  isDemo,
}: {
  companyId: Id<'companies'>
  isDemo: boolean
}) {
  const router = useRouter()
  const safeIsDemo = isDemoFlag(isDemo) ? isDemo : false

  return (
    <div className="space-y-10">
      <CompanyFinancialDashboard
        companyId={companyId}
        isDemo={safeIsDemo}
        onOpenSource={(source) => {
          runClientSync(openPublishedSource(source, (href) => router.push(href)))
        }}
      />
      <RoomProgressPanel
        companyId={companyId}
        isDemo={safeIsDemo}
        contactHref={ROOM_SCREEN_PATH.company}
      />
    </div>
  )
}
