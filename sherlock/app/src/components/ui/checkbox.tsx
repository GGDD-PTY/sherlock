'use client'

import * as React from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Schema } from 'effect'
import { CheckIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

// Radix solo acepta `true | false | 'indeterminate'`. Un truthy que no es
// de ese catálogo (`'yes'`, 1) abre el checked a medias y el indicador no
// coincide con el estado. El guard omite el valor (mismo default no controlado
// que el primitive).
const CheckboxCheckedSchema = Schema.Literals([true, false, 'indeterminate'])
type CheckboxChecked = typeof CheckboxCheckedSchema.Type
const isCheckboxChecked = Schema.is(CheckboxCheckedSchema)

function toCheckedState(value: unknown): CheckboxChecked | undefined {
  if (value === undefined) return undefined
  return isCheckboxChecked(value) ? value : undefined
}

function Checkbox({
  className,
  checked,
  defaultChecked,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  const safeChecked = toCheckedState(checked)
  const safeDefaultChecked = toCheckedState(defaultChecked)

  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      checked={safeChecked}
      defaultChecked={safeDefaultChecked}
      className={cn(
        'peer border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
