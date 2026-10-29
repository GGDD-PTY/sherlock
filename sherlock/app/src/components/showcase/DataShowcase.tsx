import { useLocale, useTranslations } from 'next-intl'
import { Schema } from 'effect'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatMoney } from '@/lib/i18n/formatters'
import { SYNTHETIC_SHOWCASE_FIXTURES } from './showcase-fixtures'
import { Example, ShowcaseSection } from './ShowcaseSection'

// El color de cada serie sale de la fila, no de su posición en el arreglo.
// `chartRows` es un fixture local (`as const` en showcase-fixtures.ts), así
// que su tipo ya es exhaustivo; el schema y la guardia de abajo son la misma
// defensa que llevaría un dato real, aplicada a datos sintéticos — es
// ceremonia y va en la lista de recorte.
const ChartToneSchema = Schema.Literals(['primary', 'accent'])
type ChartTone = typeof ChartToneSchema.Type
const isChartTone = Schema.is(ChartToneSchema)

const CHART_TONE_CLASSES = {
  primary: 'bg-primary',
  accent: 'bg-accent',
} satisfies Record<ChartTone, string>

const ChartShareSchema = Schema.Finite.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100))
)
const isChartShare = Schema.is(ChartShareSchema)

export function DataShowcase() {
  const t = useTranslations('designSystem')
  const locale = useLocale()
  const formatAmount = (amount: number, compact = false) =>
    formatMoney(amount, {
      compact,
      currency: SYNTHETIC_SHOWCASE_FIXTURES.mandate.currency,
      locale,
    })

  return (
    <ShowcaseSection title={t('families.data')} description={t('descriptions.data')}>
      <div className="grid gap-4 lg:grid-cols-2">
        <Example label={t('examples.kpi')}>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t('data.target')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-figure text-3xl tabular-nums">
                {formatAmount(SYNTHETIC_SHOWCASE_FIXTURES.mandate.amount)}
              </p>
              <p className="text-muted-foreground font-figure mt-1 text-sm tabular-nums">
                {formatAmount(SYNTHETIC_SHOWCASE_FIXTURES.mandate.amount, true)}
              </p>
              <p className="text-muted-foreground mt-2 text-xs">{t('data.asOf')}</p>
            </CardContent>
          </Card>
        </Example>
        <Example label={t('examples.chart')}>
          <figure>
            <figcaption className="mb-4 text-sm font-semibold">{t('data.mixTitle')}</figcaption>
            <div className="flex h-5 overflow-hidden rounded-sm" aria-hidden="true">
              {SYNTHETIC_SHOWCASE_FIXTURES.chartRows.map((row) => (
                <div
                  key={row.id}
                  className={
                    CHART_TONE_CLASSES[
                      isChartTone(row.tone) ? row.tone : ChartToneSchema.literals[0]
                    ]
                  }
                  style={{ width: `${isChartShare(row.value) ? row.value : 0}%` }}
                />
              ))}
            </div>
            <p className="text-muted-foreground mt-3 text-xs">{t('data.takeaway')}</p>
          </figure>
        </Example>
        <Example label={t('examples.table')} className="lg:col-span-2">
          <div
            className="overflow-x-auto [&_[data-slot=table-container]]:overflow-x-visible"
            role="region"
            aria-label={t('data.tableRegion')}
            tabIndex={0}
          >
            <Table>
              <TableCaption>{t('data.caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('data.instrument')}</TableHead>
                  <TableHead scope="col">{t('data.status')}</TableHead>
                  <TableHead scope="col" className="text-right">
                    {t('data.amount')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {SYNTHETIC_SHOWCASE_FIXTURES.tableRows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{t(`data.${row.labelKey}`)}</TableCell>
                    <TableCell>{t(`data.${row.statusKey}`)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatAmount(row.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Example>
      </div>
    </ShowcaseSection>
  )
}
