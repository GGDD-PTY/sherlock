import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { Schema } from 'effect'

import { cn } from '@/lib/utils'

// `variant` llega al className vía cva. Un string fuera del catálogo no pinta
// ninguna variante: se cuela silencioso. El guard cae a default.
const BadgeVariantSchema = Schema.Literals(['default', 'secondary', 'destructive', 'outline'])
type BadgeVariant = typeof BadgeVariantSchema.Type
const isBadgeVariant = Schema.is(BadgeVariantSchema)
const isAsChild = Schema.is(Schema.Boolean)

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
        outline: 'text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
      } satisfies Record<BadgeVariant, string>,
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const safeVariant = isBadgeVariant(variant) ? variant : 'default'
  const safeAsChild = isAsChild(asChild) ? asChild : false
  const Comp = safeAsChild ? Slot : 'span'

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant: safeVariant }), className)}
      {...props}
    />
  )
}

export { Badge }
