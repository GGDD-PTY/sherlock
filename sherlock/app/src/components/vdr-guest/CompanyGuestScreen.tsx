'use client'

import { useMemo, useState } from 'react'
import { useQuery } from 'convex/react'
import { useTranslations } from 'next-intl'
import { Schema } from 'effect'

import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { VdrLocaleSchema } from '@/components/company/vdr/types'
import { Skeleton } from '@/components/ui/skeleton'
import { selectGuestShareableDocuments } from '@/lib/vdr/guest-documents'
import { CompanyGuestPanel } from './CompanyGuestPanel'

const isVdrLocale = Schema.is(VdrLocaleSchema)

// La pantalla de invitados carga la lista de la sala por su cuenta: no vive
// dentro del shell de documentos y no comparte su estado. La misma regla de
// elegibilidad que la sala decide qué documentos se pueden compartir.
export function CompanyGuestScreen({
  companyId,
  locale,
  className,
}: {
  companyId: Id<'companies'>
  locale: 'es'
  className?: string
}) {
  const t = useTranslations('vdrGuest')
  const documents = useQuery(api.documents.getByCompany, { companyId })
  const [now] = useState(() => Date.now())
  const safeLocale = isVdrLocale(locale) ? locale : 'es'
  const shareable = useMemo(
    () => (documents ? selectGuestShareableDocuments(documents, now) : []),
    [documents, now]
  )

  if (documents === undefined) {
    return (
      <div className={className} role="status" aria-busy="true" aria-label={t('panel.loading')}>
        <Skeleton className="h-40 motion-reduce:animate-none" />
      </div>
    )
  }

  return (
    <div className={className}>
      <CompanyGuestPanel companyId={companyId} documents={shareable} locale={safeLocale} />
    </div>
  )
}
