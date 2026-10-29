'use client'

// ============================================================================
// DEV TOOLBAR COMPONENT
// ============================================================================
// Floating toolbar for ADMIN users that provides:
// - Quick role switching (ADMIN/COMPANY)
// - User impersonation
// - Quick links to admin pages
// - Seeding tools (in development)
//
// Features:
// - Collapsible (Ctrl+Shift+D to toggle)
// - Draggable
// - Persists position in localStorage
// - Only visible for ADMIN users
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Option, Schema } from 'effect'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Shield,
  Building2,
  KeyRound,
  ChevronDown,
  ChevronUp,
  X,
  Eye,
  Settings,
  LayoutDashboard,
  GripVertical,
  Keyboard,
} from 'lucide-react'
import { UserImpersonator } from './UserImpersonator'

// ============================================================================
// CONSTANTS
// ============================================================================

const POSITION_STORAGE_KEY = 'sherlock_dev_toolbar_position'
const COLLAPSED_STORAGE_KEY = 'sherlock_dev_toolbar_collapsed'

// ===== LA COSTURA CON EFFECT =====
// La posición guardada es entrada que no controlamos: `JSON.parse` devolvía
// `any` y ese `any` se usaba como coordenada. Un valor viejo o corrupto
// —`null`, un objeto con strings, un arreglo— pintaba la barra en `NaN` y la
// dejaba fuera de la pantalla, sin forma de recuperarla salvo borrando el
// storage a mano. Ahora se decodifica: lo que no sea un par de números finitos
// vuelve a la esquina.
const ToolbarPositionSchema = Schema.Struct({ x: Schema.Finite, y: Schema.Finite })
type ToolbarPosition = typeof ToolbarPositionSchema.Type
const decodeStoredPosition = Schema.decodeUnknownOption(
  Schema.fromJsonString(ToolbarPositionSchema)
)

const DEFAULT_POSITION: ToolbarPosition = { x: 16, y: 16 }

// Quick links to admin pages
// Ordered by specificity: longer/more specific routes first for proper prefix matching
// D2 ([F] 2026-09-11) retiró `/admin/users` y `/admin/activity`: lo que hacían
// vive en Accesos y en la pestaña de auditoría de Seguridad.
const ADMIN_LINKS = [
  { href: '/admin/companies', label: 'Companies', icon: Building2 },
  { href: '/admin/security', label: 'Security', icon: Shield },
  { href: '/admin/workos', label: 'Access', icon: KeyRound },
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
]

// ============================================================================
// COMPONENT
// ============================================================================

export function DevToolbar() {
  // ===== PRODUCTION: Never render =====
  // Defensa en profundidad (AdminChrome ya no la monta en prod): la toolbar de
  // dev con impersonación no existe en producción, ni siquiera para ADMIN.
  if (process.env.NODE_ENV === 'production') {
    return null
  }

  // ===== DEV AUTH MODE: Skip rendering =====
  // When DevAuthProvider is active (BYPASS_AUTH=true),
  // auth hooks aren't available. The dev login page provides similar functionality.
  if (DEV_AUTH_ENABLED) {
    return null
  }

  return <DevToolbarInner />
}

// Internal component that uses auth hooks
function DevToolbarInner() {
  const router = useRouter()
  const pathname = usePathname()
  const { isAdmin, isViewingAs, viewAsRole, effectiveRole, setViewAs, clearViewAs, isLoading } =
    useCurrentUser()

  // ===== LOAD INITIAL STATE FROM LOCALSTORAGE =====
  const loadInitialCollapsed = () => {
    try {
      const saved = localStorage.getItem(COLLAPSED_STORAGE_KEY)
      return saved ? saved === 'true' : true
    } catch {
      return true
    }
  }

  const loadInitialPosition = (): ToolbarPosition => {
    try {
      return Option.getOrElse(
        decodeStoredPosition(localStorage.getItem(POSITION_STORAGE_KEY)),
        () => DEFAULT_POSITION
      )
    } catch {
      return DEFAULT_POSITION
    }
  }

  // ===== STATE =====
  // Lazy initialization: arrow function evita ejecutar localStorage en cada render
  // Vercel Agent Skills Rule: rerender-derived-state.md
  const [isCollapsed, setIsCollapsed] = useState(() => loadInitialCollapsed())
  const [position, setPosition] = useState(() => loadInitialPosition())
  const [isDragging, setIsDragging] = useState(false)
  const [isVisible, setIsVisible] = useState(true)
  const dragRef = useRef<{
    startX: number
    startY: number
    startPosX: number
    startPosY: number
  } | null>(null)
  const positionRef = useRef(position)

  // ===== SAVE POSITION =====
  useEffect(() => {
    if (typeof window === 'undefined' || isDragging) return
    // Leer estaba protegido y escribir no. En un contexto donde `localStorage`
    // está bloqueado, `setItem` lanza y tumbaba el árbol entero por recordar
    // dónde quedó una barra de desarrollo.
    try {
      localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position))
    } catch {
      // Sin storage la barra sigue funcionando; solo no recuerda su posición.
    }
  }, [position, isDragging])

  // ===== SAVE COLLAPSED STATE =====
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, String(isCollapsed))
    } catch {
      // Sin storage la barra sigue funcionando; solo no recuerda su estado.
    }
  }, [isCollapsed])

  // ===== KEYBOARD SHORTCUT (Ctrl+Shift+D) =====
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault()
        setIsVisible((v) => !v)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // ===== SYNC POSITION REF =====
  useEffect(() => {
    positionRef.current = position
  }, [position])

  // ===== DRAG HANDLERS =====
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPosX: positionRef.current.x,
      startPosY: positionRef.current.y,
    }
  }, [])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const deltaX = e.clientX - dragRef.current.startX
      const deltaY = e.clientY - dragRef.current.startY
      setPosition({
        x: Math.max(0, Math.min(window.innerWidth - 200, dragRef.current.startPosX + deltaX)),
        y: Math.max(0, Math.min(window.innerHeight - 100, dragRef.current.startPosY + deltaY)),
      })
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      dragRef.current = null
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  // ===== ROLE HANDLERS =====
  const handleRoleChange = (role: 'COMPANY' | null) => {
    if (role === null) {
      clearViewAs()
    } else {
      setViewAs(role)
    }
    // Refresh the page to apply changes
    router.refresh()
  }

  // ===== RENDER =====
  // Only show for ADMIN users
  if (isLoading || !isAdmin || !isVisible) {
    return null
  }

  const roleColors = {
    ADMIN: 'bg-primary text-primary-foreground',
    COMPANY: 'bg-accent text-accent-foreground',
  }

  const roleIcons = {
    ADMIN: Shield,
    COMPANY: Building2,
  }

  const displayedRole = effectiveRole === 'COMPANY' ? 'COMPANY' : 'ADMIN'
  const RoleIcon = roleIcons[displayedRole]

  return (
    <div
      className="fixed z-9999 select-none"
      style={{
        left: position.x,
        top: position.y,
        cursor: isDragging ? 'grabbing' : 'default',
      }}
    >
      <Collapsible open={!isCollapsed} onOpenChange={(open) => setIsCollapsed(!open)}>
        <div className="bg-card min-w-[200px] overflow-hidden rounded-lg border shadow-lg">
          {/* ===== HEADER ===== */}
          <div className="bg-muted/50 flex items-center gap-2 border-b px-3 py-2">
            {/* Drag handle */}
            <div
              className="hover:bg-muted cursor-grab rounded p-1 active:cursor-grabbing"
              onMouseDown={handleMouseDown}
              role="separator"
              aria-label="Drag to reposition toolbar"
            >
              <GripVertical className="text-muted-foreground h-4 w-4" />
            </div>

            {/* Current role badge */}
            <Badge className={roleColors[displayedRole]}>
              <RoleIcon className="mr-1 h-3 w-3" />
              {displayedRole}
            </Badge>

            {/* View As indicator */}
            {isViewingAs && (
              <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning">
                <Eye className="mr-1 h-3 w-3" />
                View As
              </Badge>
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Collapse toggle */}
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                aria-label={isCollapsed ? 'Expand dev toolbar' : 'Collapse dev toolbar'}
              >
                {isCollapsed ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronUp className="h-4 w-4" />
                )}
              </Button>
            </CollapsibleTrigger>

            {/* Hide button */}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => setIsVisible(false)}
              title="Hide (Ctrl+Shift+D to show)"
              aria-label="Hide dev toolbar"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* ===== CONTENT ===== */}
          <CollapsibleContent>
            <div className="space-y-3 p-3">
              {/* ===== ROLE SWITCHER ===== */}
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  View As Role
                </p>
                <div className="flex gap-1">
                  <Button
                    variant={!isViewingAs ? 'default' : 'outline'}
                    size="sm"
                    className="flex-1"
                    onClick={() => handleRoleChange(null)}
                  >
                    <Shield className="mr-1 h-3 w-3" />
                    Admin
                  </Button>
                  <Button
                    variant={viewAsRole === 'COMPANY' ? 'default' : 'outline'}
                    size="sm"
                    className="flex-1"
                    onClick={() => handleRoleChange('COMPANY')}
                  >
                    <Building2 className="mr-1 h-3 w-3" />
                    Company
                  </Button>
                </div>
              </div>

              {/* ===== USER IMPERSONATION ===== */}
              <UserImpersonator />

              {/* ===== QUICK LINKS ===== */}
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  Admin Pages
                </p>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="w-full justify-between">
                      <span className="flex items-center gap-2">
                        <Settings className="h-3 w-3" />
                        Quick Links
                      </span>
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-48">
                    <DropdownMenuLabel>Admin Pages</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {ADMIN_LINKS.map((link) => {
                      const Icon = link.icon
                      const isActive = pathname?.startsWith(link.href)
                      return (
                        <DropdownMenuItem
                          key={link.href}
                          onClick={() => router.push(link.href)}
                          className={isActive ? 'bg-accent' : ''}
                        >
                          <Icon className="mr-2 h-4 w-4" />
                          {link.label}
                        </DropdownMenuItem>
                      )
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* ===== KEYBOARD SHORTCUT HINT ===== */}
              <div className="border-t pt-2">
                <p className="text-muted-foreground flex items-center gap-1 text-xs">
                  <Keyboard className="h-3 w-3" />
                  <kbd className="bg-muted rounded px-1 text-[10px]">Ctrl</kbd>+
                  <kbd className="bg-muted rounded px-1 text-[10px]">Shift</kbd>+
                  <kbd className="bg-muted rounded px-1 text-[10px]">D</kbd>
                  to toggle
                </p>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  )
}
