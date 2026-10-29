// ============================================================================
// LOADING STATE - NOTIFICATIONS
// ============================================================================
// Skeleton de la página de notificaciones: tres pestañas a tercios y las filas
// con hairline, como NotificationsPageClient.
// ============================================================================

import { Schema } from 'effect'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from 'next-intl'

const NotificationTabSchema = Schema.Literals(['all', 'unread', 'read'])
const NotificationRowSchema = Schema.Literals([
  'row-1',
  'row-2',
  'row-3',
  'row-4',
  'row-5',
  'row-6',
])

export default function NotificationsLoading() {
  const t = useTranslations('notifications')

  return (
    <div className="mx-auto flex h-[calc(100dvh-7.5rem)] max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 data-page-identity>{t('pageTitle')}</h1>
          <Skeleton className="mt-1 h-5 w-48 max-w-full" />
        </div>
        <Skeleton className="h-9 w-40 max-w-full" />
      </div>

      <div className="mt-4 mb-2 flex w-full gap-1">
        {NotificationTabSchema.literals.map((tab) => (
          <Skeleton key={tab} className="h-10 min-w-0 flex-1" />
        ))}
      </div>

      <div className="divide-border-hairline border-border-hairline divide-y border-y">
        {NotificationRowSchema.literals.map((row) => (
          <div key={row} className="flex items-center gap-3 py-2">
            <Skeleton className="h-1.5 w-1.5 shrink-0 rounded-full" />
            <Skeleton className="h-4 min-w-0 flex-1" />
            <Skeleton className="h-3 w-16 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  )
}
