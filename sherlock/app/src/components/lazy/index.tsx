'use client'

// "use client" es necesario porque usamos `ssr: false` en algunos
// componentes. Sin esta directiva, Next.js no permite ssr:false en RSC.

import dynamic from 'next/dynamic'
import { Schema } from 'effect'
import { useTranslations } from 'next-intl'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader } from '@/components/ui/card'

const SkeletonQuadSchema = Schema.Literals([0, 1, 2, 3])
const NotificationTabSchema = Schema.Literals(['all', 'unread', 'read'])
const NotificationRowSchema = Schema.Literals([
  'row-1',
  'row-2',
  'row-3',
  'row-4',
  'row-5',
  'row-6',
])

export const LazyAdminDashboard = dynamic(
  () => import('@/components/admin/AdminDashboardClient').then((mod) => mod.AdminDashboardClient),
  {
    loading: () => (
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {SkeletonQuadSchema.literals.map((i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    ),
    ssr: false,
  }
)

export const LazyAdminSecurity = dynamic(
  () => import('@/components/admin/AdminSecurityClient').then((mod) => mod.AdminSecurityClient),
  {
    loading: () => (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    ),
    ssr: false,
  }
)

export const LazyAdminCompanies = dynamic(
  () => import('@/components/admin/AdminCompaniesClient').then((mod) => mod.AdminCompaniesClient),
  {
    loading: () => (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    ),
    ssr: false,
  }
)

// Fallback con la identidad de la página: mantiene el h1 localizado visible
// mientras se descarga el chunk client-only, igual que el loading.tsx de la
// ruta y la rama de carga del cliente.
function NotificationsPageFallback() {
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

export const LazyNotificationsPage = dynamic(
  () =>
    import('@/components/notifications/NotificationsPageClient').then(
      (mod) => mod.NotificationsPageClient
    ),
  {
    loading: NotificationsPageFallback,
    ssr: false,
  }
)
