import { Schema } from 'effect'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { PageHeaderSkeleton, ToggleRowSkeleton } from '@/components/shared/LoadingSkeletons'

const PrivacyRightSlotSchema = Schema.Literals([
  'access',
  'portability',
  'rectification',
  'erasure',
])
const PrivacyConsentSlotSchema = Schema.Literals(['terms', 'privacy', 'marketing'])

export function PrivacySettingsSkeleton() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Skeleton className="mb-4 h-8 w-40" />
      <PageHeaderSkeleton />

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <Skeleton className="mb-2 h-6 w-40" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              {PrivacyRightSlotSchema.literals.map((slot) => (
                <div key={slot} className="flex items-start gap-3 rounded-lg border p-4">
                  <Skeleton className="mt-0.5 h-5 w-5 shrink-0" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-4 w-32 max-w-full" />
                    <Skeleton className="h-3 w-40 max-w-full" />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <Skeleton className="mb-2 h-6 w-48 max-w-full" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </CardHeader>
          <CardContent className="space-y-4">
            {PrivacyConsentSlotSchema.literals.map((slot) => (
              <ToggleRowSkeleton key={slot} descriptionClassName="h-3 w-56 max-w-full" />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <Skeleton className="mb-2 h-6 w-40" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
              <div className="min-w-0 space-y-2">
                <Skeleton className="h-4 w-40 max-w-full" />
                <Skeleton className="h-3 w-56 max-w-full" />
              </div>
              <Skeleton className="h-10 w-32 shrink-0" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-destructive/50">
          <CardHeader>
            <Skeleton className="mb-2 h-6 w-40" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border p-4">
              <Skeleton className="mb-3 h-4 w-56 max-w-full" />
              <Skeleton className="mb-2 h-3 w-full" />
              <Skeleton className="h-3 w-5/6 max-w-full" />
            </div>
            <Skeleton className="h-10 w-56 max-w-full" />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default function PrivacyLoading() {
  return <PrivacySettingsSkeleton />
}
