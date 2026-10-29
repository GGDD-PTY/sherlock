// ============================================================================
// ONBOARDING LAYOUT
// ============================================================================
// Layout for onboarding flow
// Forces dynamic rendering for all onboarding pages (uses WorkOS auth)
// ============================================================================

import { Effect } from 'effect'

import { AppShell } from '@/components/providers/AppShell'
import { runServerEffectSync } from '@/lib/effect/runtime'

// El cromo y los providers viven acá, no en `(app)/layout.tsx`: un entry con
// Convex a nivel de grupo arrastraba sus chunks a la landing (tarjeta O2-06).
// Force dynamic rendering (uses WorkOS auth via requireAuth).
// El literal se queda escrito: Next lo lee en estático y un decode lo
// escondería.
export const dynamic = 'force-dynamic'

const passOnboardingChildren = Effect.fn('OnboardingLayout.pass')(function* (
  children: React.ReactNode
) {
  return yield* Effect.sync(() => <AppShell>{children}</AppShell>)
})

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return runServerEffectSync(passOnboardingChildren(children))
}
