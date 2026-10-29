import { Schema } from 'effect'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { ListRowSkeleton } from '@/components/shared/LoadingSkeletons'
import { useTranslations } from 'next-intl'

const StatCardSchema = Schema.Literals(['stat-1', 'stat-2', 'stat-3', 'stat-4'])
const TableRowSchema = Schema.Literals(['row-1', 'row-2', 'row-3', 'row-4', 'row-5'])

export default function AdminLoading() {
  const t = useTranslations('admin.operations')

  return (
    <div className="container mx-auto px-4 py-8" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{t('loading')}</span>

      <div className="mb-8">
        <Skeleton className="mb-2 h-9 w-56" />
        <Skeleton className="h-5 w-80" />
      </div>

      <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {StatCardSchema.literals.map((stat) => (
          <Card key={stat}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-4 rounded" />
            </CardHeader>
            <CardContent>
              <Skeleton className="mb-2 h-8 w-16" />
              <Skeleton className="h-3 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <Skeleton className="mb-2 h-6 w-40" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {TableRowSchema.literals.map((row) => (
              <ListRowSkeleton key={row} avatarClassName="h-10 w-10 rounded-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
