'use client'

import * as React from 'react'
import * as ProgressPrimitive from '@radix-ui/react-progress'
import { Schema } from 'effect'

import { cn } from '@/lib/utils'

// El indicador traduce el valor a un `translateX`, así que un valor fuera de
// [0, 100] no se queja: saca la barra de su carril y nadie se entera. La cota
// estaba escrita en un solo llamador (`Math.min(100, …)` en
// AdminDashboardClient) y los otros dos dependían de que su aritmética nunca se
// pasara. Acá el rango tiene nombre y lo hace cumplir la primitiva. Radix opina
// lo mismo: su Root llama `console.error` con cualquier valor fuera de [0, max].
const ProgressPercentSchema = Schema.Finite.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100))
)
const isProgressPercent = Schema.is(ProgressPercentSchema)

function toProgressPercent(value: number | null | undefined): number {
  if (isProgressPercent(value)) return value
  // `null`, `undefined` y `NaN` caen a cero, igual que hacía el `value || 0`
  // anterior; un número que se pasó se pega al extremo que rebasó.
  return typeof value === 'number' && value > 0 ? 100 : 0
}

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn('bg-secondary relative h-4 w-full overflow-hidden rounded-full', className)}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className="bg-primary h-full w-full flex-1 transition-all"
      style={{ transform: `translateX(-${100 - toProgressPercent(value)}%)` }}
    />
  </ProgressPrimitive.Root>
))
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
