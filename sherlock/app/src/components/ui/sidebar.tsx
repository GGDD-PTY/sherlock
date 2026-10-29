'use client'

// Bloque `sidebar-07` de shadcn/ui (MIT), pegado entero y recoloreado con los
// tokens `--sidebar-*` de `globals.css`. Tres adaptaciones al repo, cada una
// con su razón:
//   1. `SidebarInset` pinta un `div`, no un `main`: el único `main` de la
//      página lo pone `app/[locale]/layout.tsx` y anidar landmarks rompe la
//      navegación por regiones.
//   2. Los rótulos del Sheet móvil y de los disparadores entran por props. El
//      bloque los trae en inglés y el sitio ships solo en español, así que el
//      texto vive en `es.json` y lo pasa quien monta la barra.
//   3. Los valores de catálogo (`side`, `variant`, `collapsible`) se decodifican
//      con Schema: salen al DOM como `data-*` y el CSS del bloque depende de
//      ellos, así que un valor fuera del catálogo no pinta nada y se cuela
//      silencioso.
// Lo que no se usa no se pega: el bloque trae además `SidebarInput`,
// `SidebarSeparator`, badges, acciones y submenús; `dead-code` los listaría.

import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { Effect, Schema } from 'effect'
import { PanelLeftIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { runClientSync } from '@/lib/effect/client-runtime'
import { cn } from '@/lib/utils'

// Si cambia, cambia también en `app/[locale]/(app)/admin/layout.tsx`, que lee
// esta cookie en el servidor. No se importa de acá: los exports de un módulo
// `'use client'` llegan al servidor como referencias de cliente, no como el
// valor, así que `cookies().get(SIDEBAR_COOKIE_NAME)` devolvía undefined.
const SIDEBAR_COOKIE_NAME = 'sidebar_state'
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
const SIDEBAR_WIDTH = '16rem'
const SIDEBAR_WIDTH_MOBILE = '18rem'
const SIDEBAR_WIDTH_ICON = '3rem'
const SIDEBAR_KEYBOARD_SHORTCUT = 'b'

const SidebarSideSchema = Schema.Literals(['left', 'right'])
type SidebarSide = typeof SidebarSideSchema.Type
const isSidebarSide = Schema.is(SidebarSideSchema)

const SidebarVariantSchema = Schema.Literals(['sidebar', 'floating', 'inset'])
type SidebarVariant = typeof SidebarVariantSchema.Type
const isSidebarVariant = Schema.is(SidebarVariantSchema)

const SidebarCollapsibleSchema = Schema.Literals(['offcanvas', 'icon', 'none'])
type SidebarCollapsible = typeof SidebarCollapsibleSchema.Type
const isSidebarCollapsible = Schema.is(SidebarCollapsibleSchema)

const isSidebarOpen = Schema.is(Schema.Boolean)

// El estado abierto/cerrado sobrevive a la recarga en una cookie. Es un efecto
// de borde sobre `document`, así que corre por el runtime de cliente.
const persistSidebarState = Effect.fn('Sidebar.persistState')(function* (open: boolean) {
  yield* Effect.sync(() => {
    document.cookie = `${SIDEBAR_COOKIE_NAME}=${open.toString()}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE.toString()}`
  })
})

interface SidebarContextValue {
  state: 'expanded' | 'collapsed'
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null)

function useSidebar(): SidebarContextValue {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error('useSidebar se usa dentro de un SidebarProvider.')
  }

  return context
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const open = openProp ?? uncontrolledOpen

  // El Sheet móvil solo se monta en la rama móvil, pero `openMobile` sobrevive
  // al cambio de viewport: abrirlo, pasar a escritorio y volver lo dejaba
  // abierto otra vez, con su overlay encima, sin que el usuario tocara nada.
  // Se ajusta en el render, no en un efecto: React vuelve a renderizar antes de
  // pintar y nadie llega a ver el estado viejo.
  const [wasMobile, setWasMobile] = React.useState(isMobile)
  if (wasMobile !== isMobile) {
    setWasMobile(isMobile)
    if (openMobile) setOpenMobile(false)
  }

  const setOpen = React.useCallback(
    (value: boolean | ((current: boolean) => boolean)) => {
      const next = typeof value === 'function' ? value(open) : value
      if (!isSidebarOpen(next)) return

      if (setOpenProp) setOpenProp(next)
      else setUncontrolledOpen(next)

      runClientSync(persistSidebarState(next))
    },
    [setOpenProp, open]
  )

  const toggleSidebar = React.useCallback(() => {
    if (isMobile) setOpenMobile((current) => !current)
    else setOpen((current) => !current)
  }, [isMobile, setOpen])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        toggleSidebar()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleSidebar])

  const state = open ? 'expanded' : 'collapsed'

  const contextValue = React.useMemo<SidebarContextValue>(
    () => ({ state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar }),
    [state, open, setOpen, isMobile, openMobile, toggleSidebar]
  )

  return (
    <SidebarContext.Provider value={contextValue}>
      <TooltipProvider delayDuration={0}>
        <div
          data-slot="sidebar-wrapper"
          style={
            {
              '--sidebar-width': SIDEBAR_WIDTH,
              '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn('group/sidebar-wrapper flex min-h-svh w-full', className)}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  )
}

function Sidebar({
  side = 'left',
  variant = 'sidebar',
  collapsible = 'offcanvas',
  mobileTitle,
  mobileDescription,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  side?: SidebarSide
  variant?: SidebarVariant
  collapsible?: SidebarCollapsible
  /** Título del Sheet móvil: Radix lo exige para nombrar el diálogo. */
  mobileTitle: string
  mobileDescription: string
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar()
  const safeSide = isSidebarSide(side) ? side : 'left'
  const safeVariant = isSidebarVariant(variant) ? variant : 'sidebar'
  const safeCollapsible = isSidebarCollapsible(collapsible) ? collapsible : 'offcanvas'

  if (safeCollapsible === 'none') {
    return (
      <div
        data-slot="sidebar"
        className={cn(
          'bg-sidebar text-sidebar-foreground flex h-full w-(--sidebar-width) flex-col',
          className
        )}
        {...props}
      >
        {children}
      </div>
    )
  }

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
        <SheetContent
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          className="bg-sidebar text-sidebar-foreground w-(--sidebar-width) gap-0 p-0"
          style={{ '--sidebar-width': SIDEBAR_WIDTH_MOBILE } as React.CSSProperties}
          side={safeSide}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{mobileTitle}</SheetTitle>
            <SheetDescription>{mobileDescription}</SheetDescription>
          </SheetHeader>
          {/* `pt-10` despeja el botón de cerrar que `SheetContent` pinta en la
              esquina; sin él tapa la primera fila del menú. */}
          <div className="flex h-full w-full flex-col pt-10">{children}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <div
      className="group peer text-sidebar-foreground hidden md:block"
      data-state={state}
      data-collapsible={state === 'collapsed' ? safeCollapsible : ''}
      data-variant={safeVariant}
      data-side={safeSide}
      data-slot="sidebar"
    >
      {/* La columna que reserva el ancho en el flujo: la barra en sí es fija. */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          'relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear motion-reduce:transition-none',
          'group-data-[collapsible=offcanvas]:w-0',
          'group-data-[side=right]:rotate-180',
          safeVariant === 'floating' || safeVariant === 'inset'
            ? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]'
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)'
        )}
      />
      <div
        data-slot="sidebar-container"
        className={cn(
          'fixed inset-y-0 z-10 hidden w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear motion-reduce:transition-none md:flex',
          safeSide === 'left'
            ? 'left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]'
            : 'right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]',
          safeVariant === 'floating' || safeVariant === 'inset'
            ? 'p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]'
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l',
          className
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="bg-sidebar group-data-[variant=floating]:border-sidebar-border flex h-full w-full flex-col group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:shadow-sm"
        >
          {children}
        </div>
      </div>
    </div>
  )
}

function SidebarTrigger({
  label,
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  const { toggleSidebar } = useSidebar()

  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      className={cn('size-8', className)}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <PanelLeftIcon aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </Button>
  )
}

function SidebarRail({
  label,
  className,
  ...props
}: React.ComponentProps<'button'> & { label: string }) {
  const { toggleSidebar } = useSidebar()

  return (
    <button
      type="button"
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label={label}
      tabIndex={-1}
      onClick={toggleSidebar}
      title={label}
      className={cn(
        'hover:after:bg-sidebar-border absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] motion-reduce:transition-none sm:flex',
        'in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize',
        '[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
        'hover:group-data-[collapsible=offcanvas]:bg-sidebar group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full',
        '[[data-side=left][data-collapsible=offcanvas]_&]:-right-2',
        '[[data-side=right][data-collapsible=offcanvas]_&]:-left-2',
        className
      )}
      {...props}
    />
  )
}

/** Un `div`, no un `main`: el landmark de la página vive en el layout del locale. */
function SidebarInset({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-inset"
      className={cn('bg-background relative flex w-full min-w-0 flex-1 flex-col', className)}
      {...props}
    />
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn('flex flex-col gap-2 p-2', className)}
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-2 overflow-auto overscroll-contain group-data-[collapsible=icon]:overflow-hidden',
        className
      )}
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn('relative flex w-full min-w-0 flex-col p-2', className)}
      {...props}
    />
  )
}

function SidebarGroupLabel({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'div'

  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        'text-sidebar-foreground/70 ring-sidebar-ring flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium outline-hidden transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 motion-reduce:transition-none [&>svg]:size-4 [&>svg]:shrink-0',
        'group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0',
        className
      )}
      {...props}
    />
  )
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn('flex w-full min-w-0 flex-col gap-1', className)}
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn('group/menu-item relative', className)}
      {...props}
    />
  )
}

const sidebarMenuButtonVariants = cva(
  'peer/menu-button hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring active:bg-sidebar-accent active:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm transition-[width,height,padding] outline-hidden focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 motion-reduce:transition-none group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! data-[active=true]:font-medium [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        outline:
          'bg-background hover:bg-sidebar-accent hover:text-sidebar-accent-foreground shadow-[0_0_0_1px_var(--sidebar-border)] hover:shadow-[0_0_0_1px_var(--sidebar-accent)]',
      },
      size: {
        default: 'h-8 text-sm',
        sm: 'h-7 text-xs',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
)

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = 'default',
  size = 'default',
  tooltip,
  className,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean
  isActive?: boolean
  /** Se pinta solo con la barra en iconos: ahí el rótulo queda recortado. */
  tooltip?: string
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? Slot : 'button'
  const { isMobile, state } = useSidebar()

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  )

  if (!tooltip) return button

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={state !== 'collapsed' || isMobile}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
}
