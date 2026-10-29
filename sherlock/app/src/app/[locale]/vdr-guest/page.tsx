import type { Metadata } from 'next'
import { Schema } from 'effect'
import { notFound } from 'next/navigation'
import { getTranslations, setRequestLocale } from 'next-intl/server'

import { isSupportedLocale } from '@/app/[locale]/_shared/supported-locale'
import { GuestInvitationJourney } from '@/components/vdr-guest/GuestInvitationJourney'

// Corre mientras el navegador todavía está parseando el HTML, antes de que
// React, Navbar o los providers cliente hidraten. El bearer nunca entra al
// request HTTP; aquí pasa del fragmento a memoria efímera y la URL se limpia
// por History.prototype, no por el replaceState que Next parchea en la
// instancia. La CSP actual permite los scripts inline de bootstrap que Next
// también usa.
const NonEmptyTextSchema = Schema.String.pipe(Schema.check(Schema.isNonEmpty()))
const GUEST_FRAGMENT_BOOTSTRAP = Schema.decodeSync(NonEmptyTextSchema)(
  `(function(){try{var h=location.hash.charAt(0)==='#'?location.hash.slice(1):'';Object.defineProperty(window,'__SHERLOCK_VDR_GUEST_HANDLE__',{value:h,writable:true,configurable:true});History.prototype.replaceState.call(history,history.state,'',location.pathname)}catch(e){try{location.hash=''}catch(_){}}})()`
)

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'vdrGuest.meta' })
  return {
    title: t('title'),
    description: t('description'),
    referrer: 'no-referrer',
    robots: { index: false, follow: false, nocache: true },
  }
}

export default async function VdrGuestPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!isSupportedLocale(locale)) notFound()
  setRequestLocale(locale)
  return (
    <>
      <script
        data-vdr-guest-bootstrap=""
        dangerouslySetInnerHTML={{ __html: GUEST_FRAGMENT_BOOTSTRAP }}
      />
      <GuestInvitationJourney locale={locale} />
    </>
  )
}
