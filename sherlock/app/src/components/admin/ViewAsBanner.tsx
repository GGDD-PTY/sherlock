'use client'

// La etiqueta salía de `roleLabels[effectiveRole as keyof typeof roleLabels]`.
// `roleLabels` sólo tiene COMPANY, así que con ADMIN la búsqueda
// daba `undefined` y el banner —el único aviso de que el admin NO está viendo
// su propia vista— interpolaba un valor vacío. El rol se decodifica contra
// `ViewAsRoleSchema` (la misma lista que ofrece el selector) y, si no encaja,
// el banner no se pinta: mejor no mostrarlo que mostrarlo mintiendo.

import { Option } from 'effect'
import { useTranslations } from 'next-intl'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { useViewAsStore } from '@/stores/useViewAsStore'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth'
import { Button } from '@/components/ui/button'
import { decodeViewAsRole, type ViewAsRoleName } from '@/components/admin/ViewAsSelector'
import { Eye, X, Building2 } from 'lucide-react'

interface ViewAsBannerProps {
  position?: 'top' | 'bottom'
}

export function ViewAsBanner({ position = 'top' }: ViewAsBannerProps) {
  // DevAuthProvider no monta los hooks de auth: el banner no aplica.
  if (DEV_AUTH_ENABLED) {
    return null
  }

  return <ViewAsBannerInner position={position} />
}

function ViewAsBannerInner({ position = 'top' }: ViewAsBannerProps) {
  const t = useTranslations('admin.viewAs')
  const { isAdmin, isViewingAs, effectiveRole } = useCurrentUser()
  const clearViewAs = useViewAsStore((state) => state.clearViewAs)

  const paintedRole = decodeViewAsRole(effectiveRole)
  if (!isAdmin || !isViewingAs || Option.isNone(paintedRole)) {
    return null
  }

  const roleLabels: Record<ViewAsRoleName, string> = {
    COMPANY: t('roles.company'),
  }

  const RoleIcon = Building2
  const positionClasses = position === 'top' ? 'top-0' : 'bottom-0'

  return (
    <div
      className={`bg-warning text-warning-foreground fixed ${positionClasses} right-0 left-0 z-50 border-b px-4 py-2`}
      role="alert"
      aria-live="polite"
    >
      <div className="container mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-warning-foreground/10 flex items-center gap-2 rounded-sm px-3 py-1">
            <Eye className="h-4 w-4" />
            <span className="text-sm font-medium">{t('mode')}</span>
          </div>

          <div className="flex items-center gap-2">
            <RoleIcon className="h-5 w-5" />
            <span className="font-semibold">
              {t('viewingAs', { role: roleLabels[paintedRole.value] })}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <span className="text-sm opacity-90">{t('adminAuthority')}</span>

          <Button
            variant="secondary"
            size="sm"
            onClick={clearViewAs}
            className="bg-warning-foreground/10 text-warning-foreground hover:bg-warning-foreground/20 border-0"
          >
            <X className="mr-2 h-4 w-4" />
            {t('exit')}
          </Button>
        </div>
      </div>
    </div>
  )
}
