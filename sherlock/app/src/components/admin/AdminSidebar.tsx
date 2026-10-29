'use client'

// La barra del panel sobre el bloque `sidebar-07` de shadcn (`ui/sidebar.tsx`).
// Una sola lista para escritorio y móvil: en escritorio es la columna fija que
// se contrae a iconos, y debajo de `md` el propio primitivo la pinta dentro de
// un Sheet. Los destinos y los tres títulos de grupo salen de
// `ADMIN_SIDEBAR_SECTIONS`, que los deriva del catálogo del panel
// (`product/admin-routes.ts`); acá no se escribe ninguna ruta a mano.
//
// `top-[69px]` y el alto de `calc(100dvh-7.5rem)` son la misma cuenta que usa
// el resto de la app: el navbar sticky mide 68px más su borde, y 7.5rem es
// navbar más pie. Sin eso la barra fija se mete debajo del navbar (se come los
// clics de su primera fila) y tapa la primera columna del pie.

import { useCallback } from 'react'
import { Effect } from 'effect'
import { useTranslations } from 'next-intl'

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { Link, usePathname } from '@/i18n/navigation'
import { runClientSync } from '@/lib/effect/client-runtime'
import { ADMIN_SIDEBAR_SECTIONS } from '@/lib/navigation/registry'
import { ViewAsSelector } from './ViewAsSelector'

interface AdminNavItemProps {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  exact?: boolean
  pathname: string
}

// En móvil la barra vive dentro de un Sheet: sin esto queda abierta encima de
// la pantalla a la que el usuario acaba de navegar.
const closeMobileSidebar = Effect.fn('AdminSidebar.closeMobile')(function* (
  isMobile: boolean,
  close: () => void
) {
  if (!isMobile) return
  yield* Effect.sync(() => close())
})

function AdminNavItem({ href, label, icon: Icon, exact, pathname }: AdminNavItemProps) {
  const { isMobile, setOpenMobile } = useSidebar()
  const isActive = exact ? pathname === href : pathname.startsWith(href)

  const onNavigate = useCallback(() => {
    runClientSync(
      closeMobileSidebar(isMobile, () => {
        setOpenMobile(false)
      })
    )
  }, [isMobile, setOpenMobile])

  return (
    <SidebarMenuItem>
      {/* El riel ocre de 2px marca el paso actual, que es el único papel del
          ocre en una pantalla. El relleno suave lo pone el bloque. */}
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={label}
        className="data-[active=true]:border-highlight border-l-2 border-transparent data-[active=true]:rounded-l-none"
      >
        {/* Next prefetchea cada Link visible. En /admin el proxy corre
            getCurrentUserState por cada URL, así que la barra no prefetchea. */}
        <Link
          href={href}
          prefetch={false}
          onClick={onNavigate}
          aria-current={isActive ? 'page' : undefined}
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export function AdminSidebar() {
  const t = useTranslations('admin.sidebar')
  const ariaT = useTranslations('admin.aria')
  const pathname = usePathname()
  const { state, isMobile, openMobile } = useSidebar()

  // En móvil el disparador abre y cierra el Sheet (`openMobile`), no la columna
  // de escritorio (`state`). Leer solo `state` anunciaba «Expandir menú» dentro
  // de un Sheet ya abierto, que es lo contrario de lo que hace el botón.
  const isOpen = isMobile ? openMobile : state === 'expanded'
  const toggleLabel = isOpen ? t('collapse') : t('expand')

  return (
    <Sidebar
      collapsible="icon"
      mobileTitle={t('panelTitle')}
      mobileDescription={ariaT('sidebar')}
      className="bg-sidebar top-[69px] h-[calc(100dvh-7.5rem)]"
    >
      <SidebarHeader className="flex-row items-center gap-1">
        <SidebarTrigger label={toggleLabel} />
        <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <ViewAsSelector />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* El landmark es el `nav`, no el contenedor: el primitivo pinta divs. */}
        <nav aria-label={ariaT('navigation')} className="flex flex-col gap-2">
          {ADMIN_SIDEBAR_SECTIONS.map((section) => (
            <SidebarGroup key={section.title}>
              {/* `asChild` para que el título del grupo siga siendo un h3: el
                  lector de pantalla salta entre secciones por encabezado. */}
              <SidebarGroupLabel asChild>
                <h3 className="eyebrow">{section.title}</h3>
              </SidebarGroupLabel>
              <SidebarMenu>
                {section.items.map((item) => (
                  <AdminNavItem key={item.href} {...item} pathname={pathname} />
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>

      <SidebarRail label={toggleLabel} />
    </Sidebar>
  )
}
