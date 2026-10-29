import { Schema } from 'effect'

import { cn } from '@/lib/utils'

// `variant` indexa `variantStyles`. Un valor fuera del catálogo devolvía
// `undefined` y el placeholder perdía el radio sin quejarse. El guard cae a default.
const PremiumSkeletonVariantSchema = Schema.Literals(['default', 'rounded', 'circle', 'text'])
type PremiumSkeletonVariant = typeof PremiumSkeletonVariantSchema.Type
const isPremiumSkeletonVariant = Schema.is(PremiumSkeletonVariantSchema)

interface SkeletonProps {
  className?: string
  variant?: PremiumSkeletonVariant
}

function Skeleton({ className, variant = 'default' }: SkeletonProps) {
  const safeVariant = isPremiumSkeletonVariant(variant) ? variant : 'default'
  const variantStyles = {
    default: 'rounded-md',
    rounded: 'rounded-xl',
    circle: 'rounded-full',
    text: 'rounded h-4',
  } satisfies Record<PremiumSkeletonVariant, string>

  return (
    <div
      className={cn('bg-muted/40 relative overflow-hidden', variantStyles[safeVariant], className)}
    >
      <div className="animate-shimmer absolute inset-0" />
    </div>
  )
}

export function NavbarUserSkeleton({ label }: { readonly label: string }) {
  return (
    <div
      className="flex items-center gap-2"
      data-testid="navbar-skeleton"
      role="status"
      aria-label={label}
    >
      <div className="hidden items-center gap-1 md:flex">
        <Skeleton className="h-8 w-24" variant="rounded" />
        <Skeleton className="h-8 w-12" variant="rounded" />
        <Skeleton className="h-8 w-9" variant="rounded" />
        <Skeleton className="h-8 w-16" variant="rounded" />
      </div>
    </div>
  )
}
