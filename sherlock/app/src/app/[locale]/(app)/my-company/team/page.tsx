import { Schema } from 'effect'
import { setRequestLocale } from 'next-intl/server'

import { redirect } from '@/i18n/navigation'
import { CompanyConnectAgentRow } from '@/components/company/CompanyConnectAgentRow'
import { RoomScreenFrame } from '@/components/company/CompanyRoomHeader'
import { SupportThread } from '@/components/company/SupportThread'
import { ROOM_SCREEN_PATH, roomScreensFor } from '@/components/company/roomScreens'
import { VdrWorkspaceReloadFailure } from '@/components/company/vdr/VdrWorkspaceErrorBoundary'
import { normalizeVdrLocale } from '@/components/company/vdr/helpers'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { loadCompanyScreen, roomScreenMetadata } from '../_lib/company-screen'

export const generateMetadata = roomScreenMetadata('team')

const LocaleSchema = Schema.Literals(['es'])
const isLocale = Schema.is(LocaleSchema)
const ManageAccessSchema = Schema.Literals(['MANAGE'])
const isManageAccess = Schema.is(ManageAccessSchema)

// El hilo con el equipo. Pertenece al cliente (`support:getCompanyThread`
// rechaza a ADMIN); el equipo contesta desde /admin/support.
export default async function TeamScreenPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params
  const locale = isLocale(rawLocale) ? rawLocale : 'es'
  setRequestLocale(locale)
  const screen = await loadCompanyScreen(locale, 'team')

  if (!screen.company) return <VdrWorkspaceReloadFailure locale={normalizeVdrLocale(locale)} />
  if (!isManageAccess(screen.accessMode)) {
    redirect({ href: ROOM_SCREEN_PATH.documents, locale })
  }

  return (
    <RoomScreenFrame screens={roomScreensFor({ ...screen, adminOperator: false })}>
      {/* Dev-auth no tiene identidad Convex por navegador: el hilo se queda en
          su transporte local. */}
      <SupportThread companyId={screen.company._id} isDemo={screen.isDemo || DEV_AUTH_ENABLED} />
      {/* El agente del cliente entra por el MCP de SU sala con su misma
          cuenta; el comando vive al pie de esta pantalla, debajo del hilo. */}
      <CompanyConnectAgentRow className="mt-8" />
    </RoomScreenFrame>
  )
}
