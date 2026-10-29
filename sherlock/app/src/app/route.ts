// ============================================================================
// ROOT REDIRECT
// ============================================================================
// Fallback para `/` cuando el middleware no corre: redirige al defaultLocale.
// Es un route handler (no page) para que ninguna página viva fuera de
// /[locale]/ — el root layout con <html lang> vive en [locale]/layout.tsx.
// ============================================================================

import { Effect } from 'effect'
import { redirect } from 'next/navigation'
import { defaultLocale } from '@/i18n/config'
import { runServerEffect } from '@/lib/effect/runtime'

const getRoot = Effect.fn('Root.GET')(function* () {
  const locale = yield* Effect.succeed(defaultLocale)
  return redirect(`/${locale}`)
})

export function GET() {
  return runServerEffect(getRoot())
}
