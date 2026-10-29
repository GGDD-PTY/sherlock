import { Schema } from 'effect'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { PageHeaderSkeleton } from '@/components/shared/LoadingSkeletons'

const DangerActionSchema = Schema.Literals(['pause', 'delete'])

export default function SettingsLoading() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeaderSkeleton />

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <Skeleton className="mb-2 h-6 w-40" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <div className="flex items-center gap-2">
                <Skeleton className="h-10 min-w-0 flex-1" />
                <Skeleton className="h-4 w-24" />
              </div>
            </div>
            <Skeleton className="h-10 w-48 max-w-full" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <Skeleton className="mb-2 h-6 w-40" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-2">
                <Skeleton className="h-4 w-48 max-w-full" />
                <Skeleton className="h-3 w-56 max-w-full" />
              </div>
              <Skeleton className="h-5 w-5 shrink-0" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-destructive/50">
          <CardHeader>
            <Skeleton className="mb-2 h-6 w-40" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </CardHeader>
          <CardContent className="space-y-4">
            {DangerActionSchema.literals.map((action) => (
              <div
                key={action}
                className={
                  action === 'delete'
                    ? 'border-destructive/30 flex items-center justify-between gap-4 border-t pt-4'
                    : 'flex items-center justify-between gap-4'
                }
              >
                <div className="space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56 max-w-full" />
                </div>
                <Skeleton className="h-10 w-32 shrink-0" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
