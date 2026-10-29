import { Schema } from 'effect'
import { setRequestLocale } from 'next-intl/server'

import { redirect } from '@/i18n/navigation'
import { RoomScreenFrame } from '@/components/company/CompanyRoomHeader'
import { ROOM_SCREEN_PATH, roomScreensFor } from '@/components/company/roomScreens'
import { VdrWorkspaceReloadFailure } from '@/components/company/vdr/VdrWorkspaceErrorBoundary'
import { normalizeVdrLocale } from '@/components/company/vdr/helpers'
import { CompanyGuestScreen } from '@/components/vdr-guest/CompanyGuestScreen'
import { loadCompanyScreen, roomScreenMetadata } from '../_lib/company-screen'

export const generateMetadata = roomScreenMetadata('guests')

const LocaleSchema = Schema.Literals(['es'])
const isLocale = Schema.is(LocaleSchema)
const GuestsGateSchema = Schema.Struct({
  accessMode: Schema.Literals(['MANAGE']),
  guestsAvailable: Schema.Literals([true]),
})
const isGuestsGate = Schema.is(GuestsGateSchema)

// Quién más entra a la sala. Solo existe cuando la empresa tiene NDA aprobado;
// sin eso la barra no la ofrece y la URL vuelve a los documentos.
export default async function GuestsScreenPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale: rawLocale } = await params
  const locale = isLocale(rawLocale) ? rawLocale : 'es'
  setRequestLocale(locale)
  const screen = await loadCompanyScreen(locale, 'guests')

  if (!screen.company) return <VdrWorkspaceReloadFailure locale={normalizeVdrLocale(locale)} />
  if (
    !isGuestsGate({
      accessMode: screen.accessMode,
      guestsAvailable: screen.guestsAvailable,
    })
  ) {
    redirect({ href: ROOM_SCREEN_PATH.documents, locale })
  }

  return (
    <RoomScreenFrame screens={roomScreensFor({ ...screen, adminOperator: false })}>
      <CompanyGuestScreen companyId={screen.company._id} locale={normalizeVdrLocale(locale)} />
    </RoomScreenFrame>
  )
}
