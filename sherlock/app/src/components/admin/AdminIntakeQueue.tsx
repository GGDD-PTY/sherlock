'use client'

// ============================================================================
// COLA DE INTAKE DEL EQUIPO
// ============================================================================
// Los cuatro nombres de señal ('missingEvidence', 'unreadSupport', …) vivían
// tres veces: como llaves del objeto que devuelve la query, como unión escrita
// a mano en el parámetro de `countSignal`, y como prefijo de la llave de
// traducción `signals.<señal>.<one|many>`. Renombrar una en el backend dejaba
// la fila pintando la llave cruda. Ahora la lista se define una vez con
// `Schema.Literals`, el tipo sale de ella, y el compilador verifica que sea el
// mismo conjunto de llaves que trae la proyección.
// ============================================================================

import { useQuery } from 'convex/react'
import { makeFunctionReference } from 'convex/server'
import { Schema } from 'effect'
import { ClipboardCheck, ExternalLink } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { Id } from '@/../convex/_generated/dataModel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Link } from '@/i18n/navigation'

// Las cuatro señales que la fila sabe contar. Cada una es a la vez una llave de
// `QueueItem` y el prefijo de su llave de copy, y ahora la fila las recorre en
// vez de repetir cuatro bloques iguales.
const SignalKeySchema = Schema.Literals([
  'missingEvidence',
  'unreadSupport',
  'assessmentReview',
  'draftReview',
])
const SIGNAL_KEYS = SignalKeySchema.literals
type SignalKey = typeof SignalKeySchema.Type

type QueueItem = {
  scopeKey: string
  scopeKind: 'COMPANY' | 'INTAKE'
  roomLabel: string | null
  companyId: Id<'companies'> | null
  intakeSessionId: Id<'intakeSessions'> | null
  supportThreadId: Id<'supportThreads'> | null
  actionAt: number
  readiness: {
    available: boolean
    missingCount: number
    completedCount: number
    totalCount: number
  }
  missingEvidence: { available: boolean; count: number }
  unreadSupport: { available: boolean; count: number }
  assessmentReview: {
    available: boolean
    count: number
    assessmentId: Id<'intakeAssessments'> | null
  }
  draftReview: {
    available: boolean
    count: number
    deliverableId: Id<'deliverables'> | null
  }
}

type IntakeQueueProjection = {
  items: QueueItem[]
  truncated: boolean
  temporaryIntakeSupportAvailable: boolean
}

const listAdminIntakeQueueRef = makeFunctionReference<
  'query',
  { limit?: number },
  IntakeQueueProjection
>('support:listAdminIntakeQueue')

function companyRoomHref(item: QueueItem): string | null {
  if (!item.companyId) return null
  if (item.draftReview.deliverableId) {
    return `/admin/companies/${encodeURIComponent(item.companyId)}/documents?deliverable=${encodeURIComponent(item.draftReview.deliverableId)}#deliverables-heading`
  }
  return `/admin/companies/${encodeURIComponent(item.companyId)}/documents#company-preparation`
}

export type AdminIntakeQueueProps = {
  selectedIntakeId?: string
}

export function AdminIntakeQueue({ selectedIntakeId }: AdminIntakeQueueProps) {
  const t = useTranslations('adminIntakeQueue')
  const queue = useQuery(listAdminIntakeQueueRef, { limit: 25 })
  const countSignal = (key: SignalKey, count: number) =>
    t(`signals.${key}.${count === 1 ? 'one' : 'many'}`, { count })

  // Sin tarjeta y con filas `py-2`: la cola es una lista, no diez tarjetas
  // apiladas, y scrollea por dentro ([F] 2026-09-11, tarjeta O1-05).
  return (
    <section id="intake-queue" className="border-border-hairline border-t pt-4">
      <div className="flex items-center gap-3">
        <span className="bg-primary/10 text-primary flex size-8 items-center justify-center rounded-md">
          <ClipboardCheck className="size-4" aria-hidden />
        </span>
        <div>
          <h2 className="font-sans text-lg font-semibold tracking-normal">{t('title')}</h2>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
      </div>

      {!queue ? (
        <p className="text-muted-foreground mt-2 text-sm">{t('loading')}</p>
      ) : queue.items.length === 0 ? (
        <p className="text-muted-foreground mt-2 text-sm">{t('empty')}</p>
      ) : (
        <ul className="divide-border-hairline mt-2 max-h-64 divide-y overflow-y-auto">
          {queue.items.map((item) => {
            const roomHref = companyRoomHref(item)
            const supportHref = item.supportThreadId
              ? `/admin/support?thread=${encodeURIComponent(item.supportThreadId)}`
              : item.companyId
                ? `/admin/support?company=${encodeURIComponent(item.companyId)}`
                : null
            const intakeHref = item.intakeSessionId
              ? `/admin/support?intake=${encodeURIComponent(item.intakeSessionId)}#admin-intake-assessment`
              : null
            const selected = item.intakeSessionId === selectedIntakeId

            return (
              <li
                id={item.intakeSessionId ? `intake-${item.intakeSessionId}` : undefined}
                key={item.scopeKey}
                data-testid="admin-intake-queue-item"
                aria-current={selected ? 'true' : undefined}
                className={
                  selected
                    ? 'bg-primary/5 flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between'
                    : 'flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between'
                }
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="min-w-0 text-base font-medium [overflow-wrap:anywhere]">
                      {item.roomLabel ?? t('temporaryRoom')}
                    </h3>
                    <Badge variant="outline">
                      {item.scopeKind === 'COMPANY' ? t('companyScope') : t('intakeScope')}
                    </Badge>
                  </div>
                  <ul className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 text-sm">
                    {item.readiness.available ? (
                      <li>
                        {t(
                          `readinessProgress.${item.readiness.missingCount === 1 ? 'one' : 'many'}`,
                          {
                            ready: item.readiness.completedCount,
                            total: item.readiness.totalCount,
                            missing: item.readiness.missingCount,
                          }
                        )}
                      </li>
                    ) : null}
                    {SIGNAL_KEYS.map((signal) =>
                      item[signal].count > 0 ? (
                        <li key={signal}>{countSignal(signal, item[signal].count)}</li>
                      ) : null
                    )}
                  </ul>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {supportHref ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={supportHref}>
                        {t('openSupport')}
                        <ExternalLink className="ml-2 size-3.5" aria-hidden />
                      </Link>
                    </Button>
                  ) : null}
                  {roomHref ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={roomHref}>
                        {t('openRoom')}
                        <ExternalLink className="ml-2 size-3.5" aria-hidden />
                      </Link>
                    </Button>
                  ) : null}
                  {intakeHref ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={intakeHref}>
                        {item.assessmentReview.count > 0
                          ? t('reviewAssessment')
                          : t('openQueueSignal')}
                      </Link>
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {queue?.truncated ? (
        <p className="text-muted-foreground mt-2 text-xs">{t('truncated')}</p>
      ) : null}
      {queue && !queue.temporaryIntakeSupportAvailable ? (
        <p className="text-muted-foreground mt-2 text-xs">{t('temporarySupportUnavailable')}</p>
      ) : null}
    </section>
  )
}
