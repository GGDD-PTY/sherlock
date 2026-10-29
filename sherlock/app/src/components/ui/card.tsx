import * as React from 'react'
import { Schema } from 'effect'

import { cn } from '@/lib/utils'

// Los `data-slot` son el contrato que el CSS de `CardHeader` lee
// (`has-data-[slot=card-action]`). Un typo en el string no pinta y no se
// queja. decodeSync revienta al importar el módulo si el catálogo y el
// literal se desalinean.
const CardSlotSchema = Schema.Literals([
  'card',
  'card-header',
  'card-title',
  'card-description',
  'card-content',
])
const CARD_SLOT = Schema.decodeSync(CardSlotSchema)('card')
const CARD_HEADER_SLOT = Schema.decodeSync(CardSlotSchema)('card-header')
const CARD_TITLE_SLOT = Schema.decodeSync(CardSlotSchema)('card-title')
const CARD_DESCRIPTION_SLOT = Schema.decodeSync(CardSlotSchema)('card-description')
const CARD_CONTENT_SLOT = Schema.decodeSync(CardSlotSchema)('card-content')

function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot={CARD_SLOT}
      className={cn(
        'bg-card text-card-foreground flex flex-col gap-6 rounded-md border py-6 shadow-sm',
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot={CARD_HEADER_SLOT}
      className={cn(
        '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6',
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot={CARD_TITLE_SLOT}
      className={cn('leading-none font-semibold', className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot={CARD_DESCRIPTION_SLOT}
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot={CARD_CONTENT_SLOT} className={cn('px-6', className)} {...props} />
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent }
