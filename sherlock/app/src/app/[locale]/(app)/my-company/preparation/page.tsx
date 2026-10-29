import { Schema } from 'effect'
import { setRequestLocale } from 'next-intl/server'

import { redirect } from '@/i18n/navigation'
import { CompanyPreparationScreen } from '@/components/company/CompanyPreparationScreen'
import { RoomScreenFrame } from '@/components/company/CompanyRoomHeader'
import { ROOM_SCREEN_PATH, roomScreensFor } from '@/components/company/roomScreens'
import { VdrWorkspaceReloadFailure } from '@/components/company/vdr/VdrWorkspaceErrorBoundary'
import { normalizeVdrLocale } from '@/components/company/vdr/helpers'
import { loadCompanyScreen, roomScreenMetadata } from '../_lib/company-screen'

export const generateMetadata = roomScreenMetadata('preparation')

const LocaleSchema = Schema.Literals(['es'])
const isLocale = Schema.is(LocaleSchema)
const ManageAccessSchema = Schema.Literals(['MANAGE'])
const isManageAccess = Schema.is(ManageAccessSchema)

// Qué falta y qué entregó el equipo, con las cifras publicadas cuando las hay.
export default async function PreparationScreenPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale: rawLocale } = await params
  const locale = isLocale(rawLocale) ? rawLocale : 'es'
  setRequestLocale(locale)
  const screen = await loadCompanyScreen(locale, 'preparation')

  if (!screen.company) return <VdrWorkspaceReloadFailure locale={normalizeVdrLocale(locale)} />
  if (!isManageAccess(screen.accessMode)) {
    redirect({ href: ROOM_SCREEN_PATH.documents, locale })
  }

  return (
    <RoomScreenFrame screens={roomScreensFor({ ...screen, adminOperator: false })}>
      <CompanyPreparationScreen companyId={screen.company._id} isDemo={screen.isDemo} />
    </RoomScreenFrame>
  )
}
