import { Schema } from 'effect'
import { setRequestLocale } from 'next-intl/server'

import { redirect } from '@/i18n/navigation'
import { CompanyProfileForm } from '@/components/company/CompanyProfileForm'
import { RoomScreenFrame } from '@/components/company/CompanyRoomHeader'
import { ROOM_SCREEN_PATH, roomScreensFor } from '@/components/company/roomScreens'
import { VdrWorkspaceReloadFailure } from '@/components/company/vdr/VdrWorkspaceErrorBoundary'
import { normalizeVdrLocale } from '@/components/company/vdr/helpers'
import { toCompanyProfileValues } from '@/lib/company/profile-values'
import { loadCompanyScreen, roomScreenMetadata } from '../_lib/company-screen'

export const generateMetadata = roomScreenMetadata('company')

const LocaleSchema = Schema.Literals(['es'])
const isLocale = Schema.is(LocaleSchema)
const ManageAccessSchema = Schema.Literals(['MANAGE'])
const isManageAccess = Schema.is(ManageAccessSchema)

// «Tu empresa»: lo que el equipo usa en el teaser, el CIM y el modelo, con el
// contacto en el mismo formulario y un solo Guardar. Solo quien administra la
// sala la edita; un miembro de solo lectura vuelve a los documentos.
export default async function CompanyScreenPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale: rawLocale } = await params
  const locale = isLocale(rawLocale) ? rawLocale : 'es'
  setRequestLocale(locale)
  const screen = await loadCompanyScreen(locale, 'company')

  if (!screen.company) return <VdrWorkspaceReloadFailure locale={normalizeVdrLocale(locale)} />
  if (!isManageAccess(screen.accessMode)) {
    redirect({ href: ROOM_SCREEN_PATH.documents, locale })
  }

  return (
    <RoomScreenFrame screens={roomScreensFor({ ...screen, adminOperator: false })}>
      <CompanyProfileForm
        companyId={screen.company._id}
        initial={toCompanyProfileValues(screen.company)}
        isDemo={screen.isDemo}
        withContact
      />
    </RoomScreenFrame>
  )
}
