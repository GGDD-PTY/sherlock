'use client'

import * as React from 'react'
import * as LabelPrimitive from '@radix-ui/react-label'
import { Schema } from 'effect'

import { cn } from '@/lib/utils'

// `htmlFor` sale tipado como `string`, pero React lo acepta como atributo
// genérico: un número o un boolean llega al DOM como `"true"` / `"12"` y
// asocia el label al control equivocado. El guard omite el valor.
const isHtmlFor = Schema.is(Schema.String)

function Label({ className, htmlFor, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  const safeHtmlFor = htmlFor === undefined ? undefined : isHtmlFor(htmlFor) ? htmlFor : undefined

  return (
    <LabelPrimitive.Root
      data-slot="label"
      htmlFor={safeHtmlFor}
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}

export { Label }
