'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useTranslations } from 'next-intl'
import { Schema } from 'effect'

import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { Button } from '@/components/ui/button'
import { prefetchXlsxSidecar } from '@/components/documents/viewers/xlsxSidecarPrefetch'
import { ConvexLoadFailure } from './vdr/ConvexLoadFailure'
import { useConvexLoadTimeout } from './vdr/useConvexLoadTimeout'
import { trackRoomJourney } from '@/lib/analytics/room-journey'
import { formatShortDate } from '@/lib/utils'

type Snapshot = FunctionReturnType<typeof api.financialSnapshots.getForCompany>
type ReadySnapshot = Extract<Snapshot, { status: 'READY' }>
type Metric = ReadySnapshot['metrics'][number]
export type FinancialSource = Metric['source']

const numberFormat = new Intl.NumberFormat('es-PA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

// El catálogo de indicadores. Es el mismo vocabulario que declara
// `metricNameValidator` en `convex/financialSnapshots.ts` con `v.literal`:
// ese archivo es la fuente de verdad y `Metric['metric']` ya sale de ahí. Este
// schema es una segunda descripción del mismo catálogo, y sirve para dos
// cosas que `Metric['metric']` solo no da: un orden canónico para las
// tarjetas (abajo, `groups` ya no depende del orden en que Convex devolvió el
// array) y una lista recorrible con `.literals`.
const MetricKeySchema = Schema.Literals([
  'REVENUE',
  'EBITDA',
  'NET_INCOME',
  'TOTAL_ASSETS',
  'TOTAL_DEBT',
  'CASH',
])

/**
 * El rótulo de cada indicador, escrito entero. La clave se armaba con una
 * plantilla —`t(`metrics.${metric.metric}`)`— y eso compilaba con cualquier
 * indicador: el vocabulario vive en `convex/financialSnapshots.ts` y sus seis
 * rótulos en `roomWorkspace.dashboard.metrics` de `es.json`, dos listas
 * escritas a mano que hoy coinciden y nada ata. Un séptimo indicador publicado
 * por el equipo salía en el tablero del cliente como el texto crudo
 * `metrics.GROSS_MARGIN`. El `satisfies` contra `Metric['metric']` —el tipo
 * real que manda Convex— sigue sin compilar hasta que alguien escriba cómo se
 * llama; `MetricKeySchema` es la lista aparte que hace falta para ordenar y
 * recorrer.
 */
const METRIC_LABEL_KEY = {
  REVENUE: 'metrics.REVENUE',
  EBITDA: 'metrics.EBITDA',
  NET_INCOME: 'metrics.NET_INCOME',
  TOTAL_ASSETS: 'metrics.TOTAL_ASSETS',
  TOTAL_DEBT: 'metrics.TOTAL_DEBT',
  CASH: 'metrics.CASH',
} satisfies Record<Metric['metric'], string>

// El orden en que se pintan las tarjetas. Antes salía del orden de inserción
// del `Map` de `groups`, que a su vez es el orden en que Convex devolvió el
// array de métricas — no garantizado por el backend. Dos cargas de la misma
// sala podían pintar EBITDA antes o después de CASH sin que nada hubiera
// cambiado. Ahora el orden es el del catálogo, siempre igual.
const METRIC_ORDER = MetricKeySchema.literals

function Trend({ points, label }: { points: Metric[]; label: string }) {
  if (points.length < 2) return null
  const values = points.map((point) => point.value)
  const min = Math.min(...values)
  const span = Math.max(...values) - min
  const coordinates = values
    .map(
      (value, index) =>
        `${8 + (index * 224) / (values.length - 1)},${span === 0 ? 32 : 56 - ((value - min) * 48) / span}`
    )
    .join(' ')
  return (
    <svg
      viewBox="0 0 240 64"
      role="img"
      aria-label={label}
      className="text-primary mt-4 h-16 w-full max-w-xs"
    >
      <polyline points={coordinates} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

export function CompanyFinancialDashboard(props: {
  companyId: Id<'companies'>
  isDemo: boolean
  onOpenSource: (source: FinancialSource) => void
  onAvailabilityChange?: (available: boolean) => void
}) {
  const [attempt, setAttempt] = useState(0)
  return (
    <CompanyFinancialDashboardLive
      key={`${props.companyId}:${attempt}`}
      {...props}
      onRetry={() => {
        setAttempt((current) => current + 1)
      }}
    />
  )
}

function CompanyFinancialDashboardLive({
  companyId,
  isDemo,
  onOpenSource,
  onRetry,
  onAvailabilityChange,
}: {
  companyId: Id<'companies'>
  isDemo: boolean
  onOpenSource: (source: FinancialSource) => void
  onRetry: () => void
  onAvailabilityChange?: (available: boolean) => void
}) {
  const t = useTranslations('roomWorkspace.dashboard')
  const vdr = useTranslations('vdr')
  const result = useQuery(api.financialSnapshots.getForCompany, isDemo ? 'skip' : { companyId })
  const snapshot = isDemo ? null : result
  const loadTimeout = useConvexLoadTimeout(snapshot === undefined, 12_000, companyId)
  const sectionRef = useRef<HTMLElement>(null)
  const reportedPublication = useRef<number | null>(null)
  const ready = snapshot?.status === 'READY' ? snapshot : null
  const groups = useMemo(() => {
    const series = new Map<string, Metric[]>()
    for (const metric of ready?.metrics ?? []) {
      const key = `${metric.metric}:${metric.currency}`
      const points = series.get(key)
      if (points) points.push(metric)
      else series.set(key, [metric])
    }
    return [...series.entries()].sort(
      ([, a], [, b]) => METRIC_ORDER.indexOf(a[0].metric) - METRIC_ORDER.indexOf(b[0].metric)
    )
  }, [ready])

  useEffect(() => {
    const section = sectionRef.current
    if (!section || !ready || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((entry) => entry.isIntersecting) &&
          reportedPublication.current !== ready.publishedAt
        ) {
          reportedPublication.current = ready.publishedAt
          void trackRoomJourney('dashboard_opened', {})
        }
      },
      { threshold: 0.1 }
    )
    observer.observe(section)
    return () => observer.disconnect()
  }, [ready])

  // Preparación es el otro camino por el que se abre un libro: una cifra citada
  // con hoja y rango empuja a la sala con `openSource` y ahí se monta el visor
  // XLSX, cuyo sidecar son 17 MB que solo se bajan la primera vez. La cache se
  // calienta mientras el cliente lee el tablero, no al pulsar la cita. El
  // helper es idempotente y fail-open, y en la sala demo no hay snapshot.
  const citesWorkbook = (ready?.metrics ?? []).some(
    (metric) => metric.source.locator.kind !== 'PAGE'
  )
  useEffect(() => {
    if (citesWorkbook) prefetchXlsxSidecar()
  }, [citesWorkbook])

  // Sin cifras publicadas la sección no existe: lo que el equipo tiene
  // pendiente no se le cuenta al cliente en su sala.
  const available = Boolean(ready) || loadTimeout.timedOut
  useEffect(() => {
    onAvailabilityChange?.(available)
  }, [available, onAvailabilityChange])
  if (snapshot !== undefined && !available) return null

  return (
    <section
      ref={sectionRef}
      id="company-dashboard"
      aria-labelledby="company-dashboard-heading"
      className="border-border scroll-mt-24 border-t pt-6"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="company-dashboard-heading">{t('title')}</h2>
        {ready ? (
          <p className="text-muted-foreground text-sm">
            {t('published', {
              date: formatShortDate(ready.publishedAt),
            })}
          </p>
        ) : null}
      </div>
      {loadTimeout.timedOut ? (
        <div className="mt-5">
          <ConvexLoadFailure
            message={vdr('loadFailed')}
            onRetry={onRetry}
            testId="financial-dashboard-load-failure"
          />
        </div>
      ) : snapshot === undefined ? (
        <p role="status" className="text-muted-foreground mt-5 text-sm">
          {t('loading')}
        </p>
      ) : ready ? (
        <div data-posthog-block className="mt-5">
          <p className="mt-2 max-w-prose text-sm">{ready.reviewNote}</p>
          <div className="border-border mt-6 grid gap-x-8 border-t sm:grid-cols-2 lg:grid-cols-3">
            {groups.map(([key, points]) => {
              const latest = points.at(-1)
              if (!latest) return null
              return (
                <div key={key} className="border-border border-b py-5">
                  <h3 className="font-sans text-sm font-medium">
                    {t(METRIC_LABEL_KEY[latest.metric])}
                  </h3>
                  <p className="mt-2 text-2xl tabular-nums">
                    {numberFormat.format(latest.value)}{' '}
                    <span className="text-muted-foreground text-sm">{latest.currency}</span>
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">{latest.period}</p>
                  <Trend
                    points={points}
                    label={t('trend', { metric: t(METRIC_LABEL_KEY[latest.metric]) })}
                  />
                </div>
              )
            })}
          </div>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="pb-3 text-left font-medium">{t('sourcesTitle')}</caption>
              <thead>
                <tr className="border-border border-b">
                  <th className="py-2 pr-4">{t('indicator')}</th>
                  <th className="py-2 pr-4">{t('period')}</th>
                  <th className="py-2 pr-4 text-right">{t('value')}</th>
                  <th className="py-2 pl-4">{t('source')}</th>
                </tr>
              </thead>
              <tbody>
                {ready.metrics.map((metric, index) => (
                  <tr
                    key={`${metric.metric}:${metric.period}:${index}`}
                    className="border-border border-b"
                  >
                    <td className="py-3 pr-4">{t(METRIC_LABEL_KEY[metric.metric])}</td>
                    <td className="py-3 pr-4">{metric.period}</td>
                    <td className="py-3 pr-4 text-right whitespace-nowrap tabular-nums">
                      {numberFormat.format(metric.value)} {metric.currency}
                    </td>
                    <td className="py-3 pl-4">
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-left whitespace-normal"
                        onClick={() => onOpenSource(metric.source)}
                      >
                        {metric.source.documentName} ·{' '}
                        {metric.source.locator.kind === 'PAGE'
                          ? t('page', { page: metric.source.locator.page })
                          : `${metric.source.locator.sheet}!${metric.source.locator.range}`}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  )
}
