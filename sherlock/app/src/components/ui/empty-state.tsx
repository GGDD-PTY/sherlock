'use client'

import { Schema } from 'effect'
import { Bell, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Link } from '@/i18n/navigation'
import { cn } from '@/lib/utils'

// `variant` indexa padding e icono. Un valor fuera del catálogo devolvía
// `undefined` y el bloque perdía aire sin quejarse. El guard cae a default.
const EmptyStateVariantSchema = Schema.Literals(['default', 'compact', 'centered'])
type EmptyStateVariant = typeof EmptyStateVariantSchema.Type
const isEmptyStateVariant = Schema.is(EmptyStateVariantSchema)

type EmptyStateAction = {
  label: string
  href?: string
  onClick?: () => void
}

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  variant?: EmptyStateVariant
  action?: EmptyStateAction
  secondaryAction?: EmptyStateAction
  className?: string
}

function ActionButton({ action, variant }: { action: EmptyStateAction; variant?: 'outline' }) {
  if (action.href) {
    return (
      <Button variant={variant} asChild>
        <Link href={action.href}>{action.label}</Link>
      </Button>
    )
  }
  return (
    <Button variant={variant} onClick={action.onClick}>
      {action.label}
    </Button>
  )
}

const VARIANT_STYLES = {
  default: 'py-12 px-4',
  compact: 'py-8 px-4',
  centered: 'py-16 px-4 min-h-[400px] flex items-center justify-center',
} satisfies Record<EmptyStateVariant, string>

const ICON_SIZES = {
  default: 'h-12 w-12',
  compact: 'h-10 w-10',
  centered: 'h-16 w-16',
} satisfies Record<EmptyStateVariant, string>

export function EmptyState({
  icon: Icon,
  title,
  description,
  variant = 'default',
  action,
  secondaryAction,
  className,
}: EmptyStateProps) {
  const safeVariant = isEmptyStateVariant(variant) ? variant : 'default'

  return (
    <div
      className={cn(
        'flex flex-col items-center text-center',
        VARIANT_STYLES[safeVariant],
        className
      )}
    >
      <div className="bg-muted mb-4 flex items-center justify-center rounded-full p-4">
        <Icon className={cn('text-muted-foreground', ICON_SIZES[safeVariant])} />
      </div>

      <h3 className="text-foreground text-lg font-semibold">{title}</h3>

      {description && <p className="text-muted-foreground mt-2 max-w-md text-sm">{description}</p>}

      {(action || secondaryAction) && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {action ? <ActionButton action={action} /> : null}
          {secondaryAction ? <ActionButton action={secondaryAction} variant="outline" /> : null}
        </div>
      )}
    </div>
  )
}

export function EmptyNotifications() {
  const t = useTranslations('emptyState.notifications')

  return (
    <EmptyState icon={Bell} title={t('title')} description={t('description')} variant="compact" />
  )
}
