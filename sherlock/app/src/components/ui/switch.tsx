'use client'

import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { Schema } from 'effect'

import { cn } from '@/lib/utils'

// `checked` decide si el switch es controlado. Un truthy que no es booleano
// (`'yes'`, 1) lo dejaría encendido por coerción de JS. El guard solo acepta
// un boolean real; cualquier otra cosa se trata como no controlado.
const isSwitchChecked = Schema.is(Schema.Boolean)

function Switch({
  className,
  checked,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  const safeChecked =
    checked === undefined ? undefined : isSwitchChecked(checked) ? checked : undefined

  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      checked={safeChecked}
      className={cn(
        'peer focus-visible:border-ring focus-visible:ring-ring/50 inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'bg-background pointer-events-none block size-4 rounded-full ring-0 transition-transform'
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
