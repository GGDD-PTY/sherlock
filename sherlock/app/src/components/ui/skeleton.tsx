import * as React from 'react'
import { Schema } from 'effect'

import { cn } from '@/lib/utils'

// `className` llega tipado como `string | undefined`, pero en runtime un
// consumidor JS puede pasar un número o un objeto. `cn` lo traga y el
// placeholder pinta clases basura. El guard deja pasar solo un string.
const isSkeletonClassName = Schema.is(Schema.String)

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  const safeClassName =
    className === undefined ? undefined : isSkeletonClassName(className) ? className : undefined

  return (
    <div
      data-slot="skeleton"
      className={cn(
        'bg-foreground/10 animate-pulse rounded-md motion-reduce:animate-none',
        safeClassName
      )}
      {...props}
    />
  )
}

export { Skeleton }
