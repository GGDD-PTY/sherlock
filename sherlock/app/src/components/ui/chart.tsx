'use client'

// ============================================================================
// CHART — el bloque `chart` de shadcn/ui (MIT) recortado a lo que este repo usa
// ============================================================================
// Del bloque original quedan tres piezas: el contenedor, la hoja de estilo que
// convierte cada serie del `config` en una variable `--color-<serie>`, y el
// tooltip. La leyenda no entró porque ninguna gráfica la pide todavía.
//
// Lo demás cambió por lo que exige este repo: sin `any` (el `payload` crudo de
// recharts lo es), sin aserciones a ciegas, sin `key` por índice —cada entrada
// del tooltip se identifica por el `graphicalItemId` de su serie— y sin las
// ramas de `formatter`, `icon` y `nameKey` que nadie llama. El color nunca se
// escribe aquí: sale del `config`, que solo acepta variables de `globals.css`.
// ============================================================================

import * as React from 'react'
import { Schema } from 'effect'
import * as RechartsPrimitive from 'recharts'
import type { TooltipContentProps, TooltipPayloadEntry, TooltipValueType } from 'recharts'

import { cn } from '@/lib/utils'

type Theme = 'light' | 'dark'

/** Selector por tema: el modo oscuro cuelga de `.dark`, el claro de la raíz. */
const THEME_SELECTORS: ReadonlyArray<readonly [Theme, string]> = [
  ['light', ''],
  ['dark', '.dark'],
]

const INITIAL_DIMENSION = { width: 320, height: 200 } as const

export type ChartConfig = Record<
  string,
  { label?: React.ReactNode } & (
    { color?: string; theme?: never } | { color?: never; theme: Record<Theme, string> }
  )
>

type ChartContextProps = { config: ChartConfig }

const ChartContext = React.createContext<ChartContextProps | null>(null)

function useChart() {
  const context = React.useContext(ChartContext)

  if (!context) {
    throw new Error('useChart must be used within a <ChartContainer />')
  }

  return context
}

function ChartContainer({
  id,
  className,
  children,
  config,
  initialDimension = INITIAL_DIMENSION,
  ...props
}: React.ComponentProps<'div'> & {
  config: ChartConfig
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children']
  initialDimension?: { width: number; height: number }
}) {
  const uniqueId = React.useId()
  const chartId = `chart-${id ?? uniqueId.replaceAll(':', '')}`
  const context = React.useMemo(() => ({ config }), [config])

  return (
    <ChartContext.Provider value={context}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border flex aspect-video justify-center text-xs [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden",
          className
        )}
        {...props}
      >
        <ChartStyle config={config} id={chartId} />
        <RechartsPrimitive.ResponsiveContainer initialDimension={initialDimension}>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

// El `style` se inyecta como texto porque las variables llevan el id del
// gráfico en el selector. Lo que entra es el `config` que escribe el propio
// componente llamador —una variable de `globals.css`—, nunca dato de usuario.
function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colored = Object.entries(config).filter((entry) => entry[1].theme ?? entry[1].color)

  if (colored.length === 0) {
    return null
  }

  const css = THEME_SELECTORS.map(([theme, prefix]) => {
    const variables = colored
      .map(([key, item]) => {
        const color = item.theme?.[theme] ?? item.color
        return color === undefined ? null : `  --color-${key}: ${color};`
      })
      .filter((line) => line !== null)
      .join('\n')
    return `${prefix} [data-chart=${id}] {\n${variables}\n}`
  }).join('\n')

  return <style dangerouslySetInnerHTML={{ __html: css }} />
}

const ChartTooltip = RechartsPrimitive.Tooltip

type ChartTooltipContentProps = Partial<TooltipContentProps<TooltipValueType, string>> & {
  className?: string
  labelClassName?: string
  hideLabel?: boolean
  hideIndicator?: boolean
  indicator?: 'line' | 'dot' | 'dashed'
}

// recharts entrega el valor crudo del dato. Un hueco en la serie llega como
// NaN y `toLocaleString()` lo pintaría tal cual dentro del tooltip.
const isFiniteNumber = Schema.is(Schema.Finite)

function formatTooltipValue(value: TooltipValueType): React.ReactNode {
  if (typeof value !== 'number') return value
  return isFiniteNumber(value) ? value.toLocaleString() : '—'
}

/** La serie con la que el `config` nombra a una entrada del tooltip. */
function seriesKey(item: TooltipPayloadEntry): string {
  return String(item.name ?? item.dataKey ?? 'value')
}

function ChartTooltipContent({
  active,
  payload,
  label,
  className,
  labelClassName,
  hideLabel = false,
  hideIndicator = false,
  indicator = 'dot',
}: ChartTooltipContentProps) {
  const { config } = useChart()
  const entries = payload ?? []

  if (!active || entries.length === 0) {
    return null
  }

  const nestLabel = entries.length === 1 && indicator !== 'dot'
  const labelConfig = typeof label === 'string' ? config[label]?.label : undefined
  const tooltipLabel =
    hideLabel || label === undefined ? null : (
      <div className={cn('font-medium', labelClassName)}>{labelConfig ?? label}</div>
    )

  return (
    <div
      className={cn(
        'border-border/50 bg-background grid min-w-[8rem] items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl',
        className
      )}
    >
      {nestLabel ? null : tooltipLabel}
      <div className="grid gap-1.5">
        {entries
          .filter((item) => item.type !== 'none')
          .map((item) => {
            const itemConfig = config[seriesKey(item)]
            const indicatorColor = item.fill ?? item.color

            return (
              <div
                className={cn(
                  '[&>svg]:text-muted-foreground flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5',
                  indicator === 'dot' && 'items-center'
                )}
                key={item.graphicalItemId}
              >
                {hideIndicator ? null : (
                  <div
                    className={cn(
                      'shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)',
                      {
                        'h-2.5 w-2.5': indicator === 'dot',
                        'w-1': indicator === 'line',
                        'w-0 border-[1.5px] border-dashed bg-transparent': indicator === 'dashed',
                        'my-0.5': nestLabel && indicator === 'dashed',
                      }
                    )}
                    style={
                      {
                        '--color-bg': indicatorColor,
                        '--color-border': indicatorColor,
                      } as React.CSSProperties
                    }
                  />
                )}
                <div
                  className={cn(
                    'flex flex-1 justify-between leading-none',
                    nestLabel ? 'items-end' : 'items-center'
                  )}
                >
                  <div className="grid gap-1.5">
                    {nestLabel ? tooltipLabel : null}
                    <span className="text-muted-foreground">{itemConfig?.label ?? item.name}</span>
                  </div>
                  {item.value === undefined || item.value === null ? null : (
                    <span className="text-foreground font-mono font-medium tabular-nums">
                      {formatTooltipValue(item.value)}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
      </div>
    </div>
  )
}

export { ChartContainer, ChartTooltip, ChartTooltipContent }
