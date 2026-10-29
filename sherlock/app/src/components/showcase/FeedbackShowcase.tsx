import { useTranslations } from 'next-intl'
import { Effect, Schema } from 'effect'
import { AlertCircle, CheckCircle2, Clock3, LockKeyhole } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { runClientSync } from '@/lib/effect/client-runtime'
import { SHOWCASE_STATES } from './showcase-fixtures'
import {
  Example,
  SHOWCASE_CONTROLS_ANCHOR_ID,
  SHOWCASE_FEEDBACK_ANCHOR_ID,
  ShowcaseSection,
} from './ShowcaseSection'

const ShowcaseStateSchema = Schema.Literals(SHOWCASE_STATES)

const showShowcaseToast = Effect.fn('FeedbackShowcase.showToast')(function* (message: string) {
  yield* Effect.sync(() => {
    toast.success(message)
  })
})

export function FeedbackShowcase() {
  const t = useTranslations('designSystem')

  return (
    <div id={SHOWCASE_FEEDBACK_ANCHOR_ID}>
      <ShowcaseSection title={t('families.feedback')} description={t('descriptions.feedback')}>
        <div
          data-testid="showcase-state-matrix"
          className="mb-4 flex flex-wrap gap-2"
          aria-label={t('examples.stateMatrix')}
        >
          {ShowcaseStateSchema.literals.map((state) => (
            <Badge key={state} variant="outline">
              {t(`states.${state}`)}
            </Badge>
          ))}
        </div>
        <Button
          data-testid="showcase-toast"
          variant="outline"
          className="mb-4"
          onClick={() => {
            runClientSync(showShowcaseToast(t('feedback.toast')))
          }}
        >
          {t('actions.showToast')}
        </Button>
        <div className="grid gap-4 lg:grid-cols-2">
          <Example label={t('states.loading')}>
            <div className="space-y-3" role="status" aria-live="polite">
              <span className="sr-only">{t('feedback.loading')}</span>
              <Skeleton className="h-5 w-1/3 motion-reduce:animate-none" />
              <Skeleton className="h-4 w-full motion-reduce:animate-none" />
              <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
            </div>
          </Example>
          <Example label={t('states.empty')}>
            <EmptyState
              icon={Clock3}
              title={t('feedback.emptyTitle')}
              description={t('feedback.emptyDescription')}
              action={{ label: t('actions.review'), href: `#${SHOWCASE_CONTROLS_ANCHOR_ID}` }}
            />
          </Example>
          <Example label={t('states.error')}>
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertTitle asChild>
                <h3>{t('feedback.errorTitle')}</h3>
              </AlertTitle>
              <AlertDescription>{t('feedback.errorDescription')}</AlertDescription>
            </Alert>
          </Example>
          <Example label={t('states.denied')}>
            <Alert>
              <LockKeyhole aria-hidden="true" />
              <AlertTitle asChild>
                <h3>{t('feedback.deniedTitle')}</h3>
              </AlertTitle>
              <AlertDescription>{t('feedback.deniedDescription')}</AlertDescription>
            </Alert>
          </Example>
          <Example label={t('states.pending')}>
            <Alert>
              <Clock3 aria-hidden="true" />
              <AlertTitle asChild>
                <h3>{t('feedback.pendingTitle')}</h3>
              </AlertTitle>
              <AlertDescription>{t('feedback.pendingDescription')}</AlertDescription>
            </Alert>
          </Example>
          <Example label={t('states.success')}>
            <Alert className="border-success/50">
              <CheckCircle2 className="text-success" aria-hidden="true" />
              <AlertTitle asChild>
                <h3>{t('feedback.successTitle')}</h3>
              </AlertTitle>
              <AlertDescription>{t('feedback.successDescription')}</AlertDescription>
            </Alert>
          </Example>
        </div>
      </ShowcaseSection>
    </div>
  )
}
