// ============================================================================
// ONBOARDING / PROVISION — HOJA DE APROVISIONAMIENTO
// ============================================================================
// Única page del onboarding. El root (/onboarding, route.ts) ya decidió por
// HTTP que este usuario no tiene workspace; aquí se monta
// <WorkspaceProvisioning />, que llama a `companies.ensureCompanyWorkspace`
// con la identidad Convex del navegador, muestra el estado de error con
// reintento y aterriza en /my-company/documents con navegación de cliente
// (sin redirect() de servidor en medio del stream). No hay `loading.tsx`
// propio: el skeleton de `(app)` basta.
// ============================================================================

import { readHandoffNonce } from '@/lib/mycroft/handoff-claim'
import type { Metadata } from 'next'
import { Effect, Schema } from 'effect'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import { WorkspaceProvisioning } from '@/components/onboarding/WorkspaceProvisioning'
import { requireWorkosSession } from '@/lib/auth/session'
import { runServerEffect } from '@/lib/effect/runtime'

class ProvisionCopyError extends Schema.TaggedError<ProvisionCopyError>()('ProvisionCopyError', {
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const loadProvisionCopy = Effect.fn('ProvisionWorkspace.loadCopy')(function* (locale: string) {
  return yield* Effect.tryPromise({
    try: () => getTranslations({ locale, namespace: 'onboarding' }),
    catch: (cause) => new ProvisionCopyError({ cause }),
  })
})

// `requireWorkosSession` arriba se queda fuera de cualquier programa Effect
// (effect-brief-react.md: envolver una compuerta en Effect.exit/either/result
// le borra el `digest` que Next necesita para el redirect, y la página
// renderizaría como si el visitante ya tuviera workspace). Después de la
// compuerta no queda nada que Effect deba envolver: es JSX sin props ni
// ramas, así que se retorna directo (revisión 2026-09-09,
// research/revision/01-compuertas.md: el `Effect.sync`/`Effect.runSync` que
// tenía esta línea no hacía trabajo real).

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await runServerEffect(loadProvisionCopy(locale))

  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
  }
}

export default async function ProvisionWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams?: Promise<{ handoff?: string | string[] }>
}) {
  const { locale } = await params
  setRequestLocale(locale)

  // Variante suave: el perfil de Convex todavía puede no existir; es
  // exactamente el caso que esta hoja atiende.
  await requireWorkosSession(locale)

  const handoff = (await searchParams)?.handoff
  const nonce = typeof handoff === 'string' ? readHandoffNonce(handoff) : null
  return <WorkspaceProvisioning handoffNonce={nonce} />
}
