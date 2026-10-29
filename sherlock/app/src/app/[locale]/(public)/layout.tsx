// ============================================================================
// PUBLIC ROUTE GROUP LAYOUT
// ============================================================================
// Landing, ayuda, los tres documentos legales, sign-in y el 404 localizado.
// Sin `force-dynamic` a propósito: el shell público no lee cookies ni sesión,
// así que las páginas que tampoco las leen se prerenderizan (tarjeta O2-06).
// ============================================================================

import type { ReactNode } from 'react'
import { Effect } from 'effect'

import { PublicShell } from '@/components/providers/PublicShell'
import { runServerEffectSync } from '@/lib/effect/runtime'

// Sin entrada externa: el programa nombrado solo monta el shell, igual que
// `my-company/documents/activity/loading.tsx`.
const renderPublicLayout = Effect.fn('PublicLayout.render')(function* (children: ReactNode) {
  return yield* Effect.sync(() => <PublicShell>{children}</PublicShell>)
})

export default function PublicLayout({ children }: { children: ReactNode }) {
  return runServerEffectSync(renderPublicLayout(children))
}
