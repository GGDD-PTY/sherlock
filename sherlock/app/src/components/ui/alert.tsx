import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { Schema } from 'effect'
import { cn } from '@/lib/utils'

// `variant` llega al className vía cva. Un string fuera del catálogo no pinta
// destructivo ni default: se cuela silencioso. El guard cae a default.
const AlertVariantSchema = Schema.Literals(['default', 'destructive'])
type AlertVariant = typeof AlertVariantSchema.Type
const isAlertVariant = Schema.is(AlertVariantSchema)
const isAsChild = Schema.is(Schema.Boolean)

const alertVariants = cva(
  'relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground',
  {
    variants: {
      variant: {
        default: 'bg-background text-foreground',
        destructive:
          'border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive',
      } satisfies Record<AlertVariant, string>,
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant = 'default', ...props }, ref) => {
  const safeVariant = isAlertVariant(variant) ? variant : 'default'

  return (
    <div
      ref={ref}
      role="alert"
      className={cn(alertVariants({ variant: safeVariant }), className)}
      {...props}
    />
  )
})
Alert.displayName = 'Alert'

type AlertTitleProps = React.HTMLAttributes<HTMLHeadingElement> & {
  readonly asChild?: boolean
}

const AlertTitle = React.forwardRef<HTMLHeadingElement, AlertTitleProps>(
  ({ asChild = false, className, ...props }, ref) => {
    const safeAsChild = isAsChild(asChild) ? asChild : false
    const Comp = safeAsChild ? Slot : 'h5'

    return (
      <Comp
        ref={ref}
        className={cn('mb-1 leading-none font-medium tracking-tight', className)}
        {...props}
      />
    )
  }
)
AlertTitle.displayName = 'AlertTitle'

const AlertDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-sm [&_p]:leading-relaxed', className)} {...props} />
  )
)
AlertDescription.displayName = 'AlertDescription'

export { Alert, AlertTitle, AlertDescription }
