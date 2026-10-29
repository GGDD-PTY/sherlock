'use client'

// ============================================================================
// COMPONENTE: ViewAsSelector
// ============================================================================
// Permite a los administradores ver la experiencia de empresa para debugging y QA.
// El admin conserva su rol real; ViewAsBanner indica el modo activo.
//
// EL CATÁLOGO DE ROLES «VER COMO» SE ESCRIBE UNA VEZ. Confundir el rol pintado
// con el rol real es una escalada de privilegios, así que los dos catálogos se
// definen como schemas y el compilador verifica que uno sea subconjunto del
// otro: `ViewAsRoleSchema` no puede ofrecer un rol que `UserRoleSchema` no
// reconozca. Antes eran tres listas sueltas (acá, en el banner y en el store)
// que coincidían por costumbre.
// ============================================================================

import { Schema } from 'effect'

import { useViewAsStore } from '@/stores/useViewAsStore'
import { useCurrentUser, type UserRole } from '@/hooks/useCurrentUser'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import { Eye, EyeOff, Building2, ChevronDown } from 'lucide-react'

// ===== LOS ROLES QUE UN ADMIN PUEDE PINTAR =====
// `ADMIN` es el rol real del que se
// sale, así que la lista tiene un solo miembro hoy. Lo que importa es que sea
// UNA lista: el banner la lee de acá en vez de escribir la suya.
const ViewAsRoleSchema = Schema.Literals(['COMPANY'])
export type ViewAsRoleName = typeof ViewAsRoleSchema.Type

// El compilador verifica el subconjunto: si alguien agrega acá un rol que
// `UserRoleSchema` no reconoce, la restricción de abajo no compila.
// Antes era `export const VIEW_AS_ROLES: readonly UserRole[]`; knip lo veía
// como export muerto porque nadie lo lee, y borrarlo se llevó la
// comprobación con él. Como tipo hace el mismo trabajo, no viaja en el
// bundle y knip no lo cuenta.
type OnlyUserRoles<T extends UserRole> = T
type _ViewAsRoleIsUserRole = OnlyUserRoles<ViewAsRoleName>

/** Lo que la UI pinta hoy, ya decodificado: `none` = no hay modo «ver como». */
export const decodeViewAsRole = Schema.decodeUnknownOption(ViewAsRoleSchema)

interface ViewAsSelectorProps {
  variant?: 'buttons' | 'dropdown'
  compact?: boolean
}

export function ViewAsSelector({ variant = 'dropdown', compact = false }: ViewAsSelectorProps) {
  const { isAdmin, isViewingAs, effectiveRole } = useCurrentUser()
  const { viewAsRole, setViewAs, clearViewAs } = useViewAsStore()

  if (!isAdmin) {
    return null
  }

  const roleLabels = {
    COMPANY: 'Empresa',
    ADMIN: 'Admin',
  }
  const labels = {
    trigger: 'Ver como...',
    activeTrigger: 'Viendo como',
    menuLabel: 'Impersonar Rol',
    company: 'Ver como Empresa',
    active: 'Activo',
    backToAdmin: 'Volver a vista Admin',
  }
  const triggerLabel =
    isViewingAs && effectiveRole === 'COMPANY'
      ? `${labels.activeTrigger} ${roleLabels.COMPANY}`
      : labels.trigger

  if (variant === 'dropdown') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={isViewingAs ? 'default' : 'outline'}
            size={compact ? 'sm' : 'default'}
            className={isViewingAs ? 'bg-accent text-accent-foreground hover:bg-accent/90' : ''}
            aria-label={triggerLabel}
            title={triggerLabel}
          >
            {isViewingAs ? (
              <>
                <Eye className="mr-2 h-4 w-4" />
                {!compact && <>{triggerLabel}</>}
              </>
            ) : (
              <>
                <EyeOff className="mr-2 h-4 w-4" />
                {!compact && labels.trigger}
              </>
            )}
            <ChevronDown className="ml-2 h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>{labels.menuLabel}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setViewAs('COMPANY')}
            className={viewAsRole === 'COMPANY' ? 'bg-accent' : ''}
          >
            <Building2 className="mr-2 h-4 w-4" />
            {labels.company}
            {viewAsRole === 'COMPANY' && (
              <Badge variant="secondary" className="ml-auto">
                {labels.active}
              </Badge>
            )}
          </DropdownMenuItem>
          {isViewingAs && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={clearViewAs} className="text-muted-foreground">
                <EyeOff className="mr-2 h-4 w-4" />
                {labels.backToAdmin}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant={viewAsRole === 'COMPANY' ? 'default' : 'outline'}
        size={compact ? 'sm' : 'default'}
        onClick={() => (viewAsRole === 'COMPANY' ? clearViewAs() : setViewAs('COMPANY'))}
        className={
          viewAsRole === 'COMPANY' ? 'bg-accent text-accent-foreground hover:bg-accent/90' : ''
        }
        aria-label={labels.company}
        title={labels.company}
      >
        <Building2 className="mr-2 h-4 w-4" />
        {!compact && roleLabels.COMPANY}
      </Button>
      {isViewingAs && (
        <Button
          variant="ghost"
          size={compact ? 'sm' : 'default'}
          onClick={clearViewAs}
          aria-label={labels.backToAdmin}
          title={labels.backToAdmin}
        >
          <EyeOff className="mr-2 h-4 w-4" />
          {!compact && 'Volver'}
        </Button>
      )}
    </div>
  )
}
