'use client'

// ============================================================================
// UNA SERIE DIARIA DEL TABLERO
// ============================================================================
// El gráfico existe para leer una forma —subió, cayó, se quedó plano—, y con
// dos o tres días no hay forma que leer: treinta barras de las que veintisiete
// valen cero dibujan una tendencia que nadie midió. Por debajo de siete días
// con datos la serie se muestra como tabla, que es lo que de verdad se sabe.
// ============================================================================

import { Schema } from 'effect'
import { useTranslations } from 'next-intl'
import { Bar, BarChart, XAxis } from 'recharts'

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type DailyPoint = { readonly fecha: string; readonly valor: number }
export type DailySeries = {
  readonly dias: readonly DailyPoint[]
  readonly diasConDatos: number
  readonly truncado: boolean
}

/** Días con datos por debajo de los cuales el gráfico miente y la tabla no. */
const MIN_DAYS_WITH_DATA = 7

// 120 px y no 160: con la sección nueva `/es/admin` ya no cabía en 900 px a
// 1440x900, y el alto del gráfico es la primera palanca de la tarjeta O1-04.
const CHART_HEIGHT_CLASS = 'aspect-auto h-[120px] w-full'

// La serie llega del backend. Un `valor` NaN pinta una barra fantasma y una
// fecha vacía rompe el eje, así que los puntos se validan en la frontera.
const isDailyPoint = Schema.is(
  Schema.Struct({
    fecha: Schema.String.check(Schema.isMinLength(1)),
    valor: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  })
)

/** `2026-09-11` → `11/09`: el eje muestra el día, la tabla la fecha completa. */
function shortDay(fecha: string): string {
  return `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}`
}

export function DailySeriesPanel({
  label,
  color,
  serie,
}: {
  label: string
  color: string
  serie: DailySeries | undefined
}) {
  const t = useTranslations('admin.operations.overview.series')

  if (serie === undefined) {
    return (
      <div className="min-w-0 space-y-2">
        <p className="eyebrow">{label}</p>
        <Skeleton className="h-[120px] w-full" />
      </div>
    )
  }

  const dias = serie.dias.filter(isDailyPoint)
  const config = { valor: { label, color } } satisfies ChartConfig

  return (
    <div className="min-w-0 space-y-2">
      <p className="eyebrow">{label}</p>
      {serie.diasConDatos < MIN_DAYS_WITH_DATA ? (
        <div className="space-y-2">
          <Table aria-label={label}>
            <TableHeader>
              <TableRow>
                <TableHead className="py-1">{t('date')}</TableHead>
                <TableHead className="py-1 text-right">{t('value')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dias
                .filter((dia) => dia.valor > 0)
                .map((dia) => (
                  <TableRow key={dia.fecha}>
                    <TableCell className="py-1 tabular-nums">{dia.fecha}</TableCell>
                    <TableCell className="font-figure py-1 text-right tabular-nums">
                      {dia.valor}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
          <p className="text-muted-foreground text-xs">
            {t('empty', { count: serie.diasConDatos })}
          </p>
        </div>
      ) : (
        <ChartContainer aria-label={label} className={CHART_HEIGHT_CLASS} config={config}>
          <BarChart accessibilityLayer data={dias} margin={{ left: 0, right: 0, top: 4 }}>
            <XAxis
              axisLine={false}
              dataKey="fecha"
              interval="preserveStartEnd"
              minTickGap={24}
              tickFormatter={shortDay}
              tickLine={false}
              tickMargin={8}
            />
            <ChartTooltip content={<ChartTooltipContent hideIndicator />} cursor={false} />
            <Bar dataKey="valor" fill="var(--color-valor)" radius={2} />
          </BarChart>
        </ChartContainer>
      )}
    </div>
  )
}
