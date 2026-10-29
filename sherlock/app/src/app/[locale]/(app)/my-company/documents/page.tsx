// ============================================================================
// COMPANY DOCUMENTS PAGE (VDR MANAGEMENT)
// ============================================================================
// Página standalone para que las empresas gestionen todos sus documentos
// del Virtual Data Room (VDR) en un solo lugar.
// Solo accesible para usuarios con rol COMPANY.
// ============================================================================

import { readHandoffNonce } from '@/lib/mycroft/handoff-claim'
import type { Metadata } from 'next'
import { Effect, Schema } from 'effect'
import { runServerEffect } from '@/lib/effect/runtime'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { MyCompanyDocumentsClient } from '@/components/company/MyCompanyDocumentsClient'
import { VdrWorkspaceReloadFailure } from '@/components/company/vdr/VdrWorkspaceErrorBoundary'
import { normalizeVdrLocale } from '@/components/company/vdr/helpers'
import type { VdrDocumentView } from '@/components/company/vdr/types'
import { roomScreensFor } from '@/components/company/roomScreens'
import { loadCompanyScreen } from '../_lib/company-screen'
import { getTranslations, setRequestLocale } from 'next-intl/server'

type CompanyConvexClient = NonNullable<Awaited<ReturnType<typeof getAuthenticatedConvex>>>['client']

class InitialDocumentsUnavailable extends Schema.TaggedError<InitialDocumentsUnavailable>()(
  'InitialDocumentsUnavailable',
  { cause: Schema.Defect() }
) {}

// La lista inicial es una optimización, no un requisito: si falla, la sala
// carga como antes. Esa política vive en el propio programa —el fallo se
// atrapa y se devuelve `null`— en vez de en un try/catch alrededor.
const loadInitialDocuments = Effect.fn('MyCompanyDocuments.loadInitialDocuments')(function* (
  client: CompanyConvexClient | null,
  companyId: Id<'companies'>
) {
  if (!client) return null
  return yield* Effect.tryPromise({
    try: () => client.query(api.documents.getByCompany, { companyId }),
    catch: (cause) => new InitialDocumentsUnavailable({ cause }),
  }).pipe(
    Effect.map((documents) => documents as VdrDocumentView[]),
    Effect.catch((error) =>
      Effect.logError(
        '[MyCompanyDocuments] Error fetching initial documents:',
        error.cause ?? error
      ).pipe(Effect.as(null))
    )
  )
})

// ===== METADATA =====
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await runServerEffect(
    Effect.tryPromise({
      try: () => getTranslations({ locale, namespace: 'vdr.meta.documents' }),
      catch: (cause) => cause,
    })
  )

  return {
    title: t('title'),
    description: t('description'),
  }
}

// ===== PAGE COMPONENT =====
export default async function MyCompanyDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams?: Promise<{ handoff?: string | string[] }>
}) {
  const { locale } = await params
  setRequestLocale(locale)

  const handoff = (await searchParams)?.handoff
  const nonce = typeof handoff === 'string' ? readHandoffNonce(handoff) : null
  const screen = await loadCompanyScreen(locale, 'documents', nonce)
  const { company, accessMode, isDemo, workspaceQueryFailed } = screen
  let convexClient = screen.convexClient

  // ===== LISTA INICIAL DE LA SALA =====
  // La lista corporativa viaja en el HTML. Sin esto, el cliente hidrata, abre
  // el WebSocket y espera la primera respuesta antes de pintar nada: la lista
  // aparecia a ~1,0 s a 20 Mbps aunque el HTML llegara a 0,4 s. Va por el mismo
  // cliente autenticado que el workspace; si falla, la sala carga como antes.
  let initialDocuments: VdrDocumentView[] | null = null
  if (company && !isDemo) {
    convexClient ??= (await getAuthenticatedConvex())?.client ?? null
    initialDocuments = await runServerEffect(loadInitialDocuments(convexClient, company._id))
  }

  // ===== RENDERIZAR =====
  // Llegar hasta acá sin empresa solo pasa con la consulta caída: la sala no se
  // borró, así que la pantalla ofrece reintentar en vez de mandar al onboarding.
  return !company || workspaceQueryFailed ? (
    <VdrWorkspaceReloadFailure locale={normalizeVdrLocale(locale)} />
  ) : (
    <MyCompanyDocumentsClient
      companyId={company._id}
      companyName={company.name}
      // El handoff de la landing solo se aplica en el alta que lo originó: la
      // sala compara esta fecha contra la hora en que el sobre se parqueó.
      companyCreatedAt={company._creationTime}
      companyLogoUrl={company.logoUrl ?? null}
      // `companies.seekingType` NO es un mandato declarado: el alta automática
      // del workspace lo escribe en 'BOTH' (convex/companies.ts) sin que el
      // cliente elija nada. La portada de la sala no puede afirmar un mandato a
      // partir de un default, así que se queda en neutro hasta que exista un
      // dato de mandato elegido. El campo sigue intacto para el pitch.
      companyMandate="UNSET"
      isDemo={isDemo}
      accessMode={accessMode}
      initialDocuments={initialDocuments}
      screens={roomScreensFor({ ...screen, adminOperator: false })}
      // Sin `activityHref`: la bitácora de accesos no es superficie de cliente
      // ([F] 2026-09-01). El equipo la lee desde el panel de admin.
    />
  )
}
