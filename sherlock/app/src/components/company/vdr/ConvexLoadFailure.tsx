'use client'

import { Effect } from 'effect'
import { CircleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'
import { runClientSync } from '@/lib/effect/client-runtime'

const retryConvexLoad = Effect.fn('Vdr.retryConvexLoad')(function* (retry: () => void) {
  yield* Effect.sync(retry)
})

export function ConvexLoadFailure({
  message,
  onRetry,
  testId,
}: {
  message: string
  onRetry: () => void
  testId?: string
}) {
  const t = useTranslations('vdr.viewer')

  return (
    <div
      data-testid={testId}
      role="alert"
      className="border-border bg-card flex min-h-40 flex-col items-center justify-center rounded-lg border px-6 py-10 text-center"
    >
      <CircleAlert className="text-destructive mb-3 size-5" aria-hidden="true" />
      <p className="text-foreground text-sm font-semibold">{message}</p>
      <Button
        type="button"
        variant="outline"
        className="mt-4 min-h-11"
        onClick={() => runClientSync(retryConvexLoad(onRetry))}
      >
        {t('retry')}
      </Button>
    </div>
  )
}
