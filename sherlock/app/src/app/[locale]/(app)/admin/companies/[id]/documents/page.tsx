// ============================================================================
// ADMIN — SALA (VDR) DE UNA EMPRESA CLIENTE
// ============================================================================
// Sherlock le hace el trabajo al emisor: el equipo arma y ordena el data room
// del cliente. El backend ya lo permitía (hasOwnership bypassea ownership para
// ADMIN y las mutations de documentos aceptan un companyId explícito), pero la
// única pantalla del VDR derivaba la empresa de la sesión y expulsaba a quien
// no fuera COMPANY: el equipo sólo podía operar por mutation suelta.
//
// Esta ruta abre esa misma pantalla con la empresa y el inventario acotado de
// salas del `[id]` de la URL. También conserva ese scope en los enlaces de
// actividad para que el admin no vuelva accidentalmente a su propia empresa.
//
// Autorización: `requireRole(['ADMIN'])`, que es donde vive el step-up MFA de
// admin (hasRecentAdminStepUp). No se agrega una puerta paralela ni se relaja
// ésta. Convex vuelve a verificar en cada query/mutation.
// ============================================================================

import type { Metadata } from 'next'
import { Effect, Schema } from 'effect'
import { ArrowLeft } from 'lucide-react'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { AdminPreparationWorkspace } from '@/components/admin/AdminPreparationWorkspace'
import { AdminRoomActivationPanel } from '@/components/admin/AdminRoomActivationPanel'
import { AdminRoomSections } from '@/components/admin/AdminRoomSections'
import { MyCompanyDocumentsClient } from '@/components/company/MyCompanyDocumentsClient'
import { RoomProgressPanel } from '@/components/company/RoomProgressPanel'
import { AdminCompanyGuestAccess } from '@/components/admin/AdminCompanyGuestAccess'
import { Button } from '@/components/ui/button'
import { requireRole } from '@/lib/auth/session'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { DEMO_PUBLIC_COMPANIES } from '@/lib/dev-auth/demo-data'
import { hasLocalConvexIdentity } from '@/lib/dev-auth/local-convex-identity'
import { runServerEffect } from '@/lib/effect/runtime'
import { nameAtSentenceEnd } from '@/lib/i18n/formatters'
import { createLogger } from '@/lib/logger'
import { Link, redirect } from '@/i18n/navigation'

import { boundedSelection } from '../../../_shared'

const log = createLogger('Admin:CompanyDocuments')

const HAS_LOCAL_CONVEX_IDENTITY = hasLocalConvexIdentity()
// Misma regla que useDevAuthFixtures; un use* no puede llamarse a nivel de módulo.
const USE_DEV_AUTH_FIXTURES = DEV_AUTH_ENABLED && !HAS_LOCAL_CONVEX_IDENTITY

// ===== COPY =====
// Las claves de `admin.*` viven en los catálogos compartidos; esta pantalla es
// nueva y trae su copy local, el mismo patrón que ya usan AdminCompaniesClient
// y las demás superficies admin. Español de Panamá, tuteo.
const copy = {
  metaTitle: 'Sala del cliente | Admin',
  metaDescription: 'Opera el data room de una empresa desde el panel del equipo.',
  back: 'Volver a empresas',
  roomTitle: (name: string) => `Sala de ${name} · vista del equipo`,
  roomBody: (name: string) => `Lo que subas aquí entra al Data Room de ${nameAtSentenceEnd(name)}.`,
} as const

function resolveCopy(_locale: string) {
  return copy
}

// ===== CARGA DE LA SALA =====
// Cada forma de quedarse sin sala tiene nombre. Las tres terminan en el mismo
// destino, pero el log ya no dice solo "algo falló": dice cuál de las tres.
class AdminWorkspaceUnavailable extends Schema.TaggedError<AdminWorkspaceUnavailable>()(
  'AdminWorkspaceUnavailable',
  {
    reason: Schema.Literals(['no-admin-session', 'query-failed', 'not-found']),
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

const loadAdminWorkspace = Effect.fn('AdminCompanyDocuments.loadWorkspace')(function* (
  companyId: string
) {
  const convexAuth = yield* Effect.tryPromise({
    try: () => getAuthenticatedConvex(),
    catch: (cause) => new AdminWorkspaceUnavailable({ reason: 'no-admin-session', cause }),
  })
  if (!convexAuth?.client || (!convexAuth.isAuthenticated && !HAS_LOCAL_CONVEX_IDENTITY)) {
    return yield* new AdminWorkspaceUnavailable({ reason: 'no-admin-session' })
  }

  const workspace = yield* Effect.tryPromise({
    try: () =>
      convexAuth.client.query(api.companies.getAdminVdrWorkspace, {
        companyId: companyId as Id<'companies'>,
      }),
    catch: (cause) => new AdminWorkspaceUnavailable({ reason: 'query-failed', cause }),
  })
  if (!workspace) return yield* new AdminWorkspaceUnavailable({ reason: 'not-found' })

  return workspace
})

type AdminCompanyDocumentsSearchParams = {
  intake?: string | string[]
  intakeSessionId?: string | string[]
}

// ===== METADATA =====
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; id: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = resolveCopy(locale)

  return {
    title: t.metaTitle,
    description: t.metaDescription,
  }
}

// ===== PAGE COMPONENT =====
export default async function AdminCompanyDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>
  searchParams?: Promise<AdminCompanyDocumentsSearchParams>
}) {
  const [{ locale, id }, query] = await Promise.all([
    params,
    searchParams ?? Promise.resolve<AdminCompanyDocumentsSearchParams>({}),
  ])
  setRequestLocale(locale)

  // El step-up MFA de admin se exige adentro de requireRole.
  const user = await requireRole(['ADMIN'], `/admin/companies/${id}/documents`, locale)

  // requireRole autoriza por el rol REAL: un admin en modo "ver como" pasa la
  // puerta aunque esté simulando otro rol. Operar la sala de un cliente es una
  // acción de admin con nombre y apellido — no debe ocurrir bajo una vista
  // simulada. Fail closed: de vuelta al panel del equipo hasta salir del modo.
  if (user.isViewingAs) {
    redirect({ href: '/admin', locale })
    return
  }

  const t = resolveCopy(locale)
  const tActivation = await getTranslations('adminRoomActivation')

  // ===== OBTENER EL WORKSPACE DE LA EMPRESA DEL [id] =====
  // El programa corre aquí adentro, por request: el componente ya es async.
  // `redirect()` y `requireRole` se quedan AFUERA del Effect: `Effect.exit` /
  // `either` / `result` / `catchDefect` tragan el `digest` de Next y la
  // redirección deja de ser redirección.
  const workspace: { company: { _id: string; name: string } } | null = USE_DEV_AUTH_FIXTURES
    ? (() => {
        const company = DEMO_PUBLIC_COMPANIES.find((demo) => demo._id === id) ?? null
        return company ? { company } : null
      })()
    : await runServerEffect(
        loadAdminWorkspace(id).pipe(
          Effect.match({
            onSuccess: (loaded) => loaded,
            onFailure: (error) => {
              log.error('Failed to load company data room', {
                reason: error.reason,
                errorType:
                  error.cause instanceof Error ? error.cause.name : (error.cause ?? 'UnknownError'),
              })
              return null
            },
          })
        )
      )

  if (!workspace) {
    redirect({ href: '/admin/companies', locale })
    return
  }

  const { company } = workspace
  const companyName = company.name
  const intakeSessionId = boundedSelection(query.intakeSessionId ?? query.intake)

  return (
    <div className="space-y-6">
      <div className="mx-auto max-w-7xl px-4 pt-8 sm:px-6 lg:px-8">
        <Link href="/admin/companies">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t.back}
          </Button>
        </Link>

        {/* No es una advertencia: es la identidad de la sala en la que el
            equipo está trabajando ([F] 2026-09-07). Superficie neutra del
            sistema —canvas y 1px de borde—, sin color de alerta ni icono de
            escudo, igual que los paneles de preparación de al lado. */}
        <div role="status" className="border-border mt-4 rounded-md border px-4 py-3">
          <p className="text-sm font-medium">{t.roomTitle(companyName)}</p>
          <p className="text-muted-foreground mt-1 text-sm">{t.roomBody(companyName)}</p>
        </div>
      </div>

      {/* El Data Room primero (auditoría 2026-09-06, F02): el equipo entra a
          ver documentos. Preparación y activación van debajo, plegadas, con
          su resumen a la vista. */}
      <MyCompanyDocumentsClient
        companyId={company._id}
        companyName={companyName}
        isDemo={USE_DEV_AUTH_FIXTURES}
        // La bitácora todavía cierra cualquier sesión dev-auth; no ofrecemos
        // un enlace que esa ruta devuelve inmediatamente al Data Room.
        activityHref={
          DEV_AUTH_ENABLED
            ? undefined
            : `/my-company/documents/activity?company=${encodeURIComponent(company._id)}`
        }
        adminOperator
        screens={[]}
      />
      {/* La sala del cliente es un conjunto de pantallas; el equipo sigue
          viendo todo en una (herramienta interna). `#company-preparation` lo
          enlaza la bandeja de intake. */}
      <div
        id="company-preparation"
        className="mx-auto max-w-7xl scroll-mt-24 space-y-8 px-4 sm:px-6 lg:px-8"
      >
        <p className="eyebrow">{tActivation('clientViewEyebrow')}</p>
        <RoomProgressPanel
          companyId={company._id as Id<'companies'>}
          isDemo={USE_DEV_AUTH_FIXTURES}
          supportHref={`/admin/support?company=${encodeURIComponent(company._id)}`}
          documentsHref={`/admin/companies/${encodeURIComponent(company._id)}/documents#room-shell`}
          phoneEditable={false}
        />
        {USE_DEV_AUTH_FIXTURES ? null : (
          <AdminCompanyGuestAccess companyId={company._id as Id<'companies'>} />
        )}
      </div>
      <div className="mx-auto max-w-7xl px-4 pb-8 sm:px-6 lg:px-8">
        <AdminRoomSections
          companyId={company._id as Id<'companies'>}
          isDemo={USE_DEV_AUTH_FIXTURES}
          preparation={
            <AdminPreparationWorkspace
              companyId={company._id as Id<'companies'>}
              intakeSessionId={intakeSessionId}
              isDemo={USE_DEV_AUTH_FIXTURES}
            />
          }
          activation={
            <AdminRoomActivationPanel
              companyId={company._id as Id<'companies'>}
              isDemo={USE_DEV_AUTH_FIXTURES}
            />
          }
        />
      </div>
    </div>
  )
}
