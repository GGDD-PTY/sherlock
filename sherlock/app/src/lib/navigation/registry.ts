import type { LucideIcon } from 'lucide-react'
import { Schema } from 'effect'
import { CircleHelp, FolderLock, LayoutDashboard, Settings, UserCircle } from 'lucide-react'
import { homePathForRole } from '@/lib/navigation/home'
import { ADMIN_ROUTES, ADMIN_SIDEBAR_SECTION_TITLES } from '@/lib/product/admin-routes'
import type { AdminSidebarSectionTitle } from '@/lib/product/admin-routes'
import { PublicRouteSchema } from '@/lib/product/public-routes'
import type { AppShell } from '@/lib/product/types'

// La ruta pública que este catálogo enlaza sale decodificada del catálogo de
// rutas, no escrita a mano.
const HELP_PATH = Schema.decodeSync(PublicRouteSchema)('/ayuda')

// Los dos roles que la navegación sabe nombrar. `ROLE_AUDIENCE_FLAG` (más
// abajo) es la tabla que este catálogo tiene que cubrir por completo: el
// schema existe para recorrerla y decirlo si algún día deja de cubrirla.
const NavbarRoleSchema = Schema.Literals(['COMPANY', 'ADMIN'])
type NavbarRole = typeof NavbarRoleSchema.Type

// `getVisibleNavbarSecondaryItems` recibe `placement` como argumento de
// función: TypeScript lo tipa en cada call site, pero es una frontera pública
// del módulo — cualquier caller con un `as` o un valor armado dinámicamente
// puede pasar otra cosa. `isNavbarPlacement` (más abajo) es el guardia.
const NavbarPlacementSchema = Schema.Literals(['mobile', 'desktop', 'user-menu'])
type NavbarPlacement = typeof NavbarPlacementSchema.Type
const isNavbarPlacement = Schema.is(NavbarPlacementSchema)

export interface PrimaryNavItem {
  /** Fallback English label. Rendered label comes from `nameKey` via i18n. */
  name: string
  /** i18n key under the `common.navbar` namespace (es/en parity). */
  nameKey: string
  href: string
  icon: LucideIcon
  description: string
  descriptionKey: string
  shells: AppShell[]
}

export interface NavbarSecondaryItem {
  href: string
  labelKey: string
  icon: LucideIcon
  placements: NavbarPlacement[]
  shells: AppShell[]
  roles?: NavbarRole[]
  highlight?: boolean
  /** La sala propia del rol: el destino al que el logo y el navbar vuelven. */
  room?: true
  /** En el menú compacto los ítems de cuenta van agrupados bajo «Cuenta». */
  group?: 'account'
}

interface AdminSidebarItem {
  href: string
  label: string
  icon: LucideIcon
  exact?: boolean
}

export interface AdminSidebarSection {
  title: AdminSidebarSectionTitle
  items: readonly AdminSidebarItem[]
}

export const PRIMARY_NAV_ITEMS: PrimaryNavItem[] = [
  // `/data-room` era una página que solo redirigía a la sala del cliente
  // ([F] 2026-09-07 09:00), así que este item apunta a la capa de subida de la
  // landing, que es donde una sala empieza de verdad. El rótulo dice eso desde
  // el 2026-09-11: rotulado «Data Room» prometía una sala y abría un formulario
  // de carga. Este item solo lo ven los visitantes sin sesión (`Navbar.tsx`
  // vacía la lista al autenticarse); con sesión, «Data Room» es el enlace a la
  // sala propia en `NAVBAR_SECONDARY_ITEMS`.
  {
    name: 'Start your Data Room',
    nameKey: 'startDataRoom',
    href: '/#intake',
    icon: FolderLock,
    description: 'Upload your documents and the team opens your room',
    descriptionKey: 'startDataRoom',
    shells: ['PUBLIC', 'COMPANY', 'ADMIN'],
  },
]

export const NAVBAR_SECONDARY_ITEMS: NavbarSecondaryItem[] = [
  // La sala propia de cada rol se nombra por su destino: «Data Room» para la
  // empresa y «Panel» para el equipo ([F] 2026-09-07 09:00). «Cuenta» pasó a
  // ser el menú que agrupa configuración, tema y cerrar sesión, así que ya no
  // puede ser también el enlace a la sala. `/dashboard` sigue fuera: solo
  // redirigía a estas mismas dos rutas ([F] 2026-09-01).
  {
    href: '/my-company/documents',
    labelKey: 'dataRoom',
    icon: FolderLock,
    placements: ['mobile', 'desktop', 'user-menu'],
    shells: ['COMPANY'],
    roles: ['COMPANY'],
    room: true,
  },
  {
    href: '/admin',
    labelKey: 'teamPanel',
    icon: LayoutDashboard,
    placements: ['mobile', 'desktop', 'user-menu'],
    shells: ['ADMIN'],
    roles: ['ADMIN'],
    room: true,
  },
  {
    href: '/settings',
    labelKey: 'settings',
    icon: Settings,
    placements: ['mobile', 'user-menu'],
    shells: ['COMPANY', 'ADMIN'],
    group: 'account',
  },
  // «Ayuda» es la misma puerta desde la landing y desde la sala: escribirle al
  // equipo, votar lo que sigue y leer cómo funciona la sala viven en /ayuda
  // ([F] 2026-09-01). Sin `roles`, para que el equipo la vea igual que el
  // cliente y nadie tenga que salirse de la sala para pedir algo.
  {
    href: HELP_PATH,
    labelKey: 'support',
    icon: CircleHelp,
    placements: ['mobile', 'desktop'],
    shells: ['COMPANY', 'ADMIN'],
  },
]

// La barra del panel no declara destinos: los deriva del catálogo de
// `product/admin-routes.ts`, que es donde una ruta del panel entra o sale
// ([F] 2026-09-17). Cada sección toma sus filas en el orden del catálogo, y el
// orden de las secciones es el de `ADMIN_SIDEBAR_SECTION_TITLES`.
export const ADMIN_SIDEBAR_SECTIONS: readonly AdminSidebarSection[] =
  ADMIN_SIDEBAR_SECTION_TITLES.map((title) => ({
    title,
    items: ADMIN_ROUTES.filter((route) => route.nav.section === title).map((route) => ({
      href: route.paths[0],
      label: route.nav.label,
      icon: route.nav.icon,
      exact: route.nav.exact,
    })),
  }))

// Recorre el resultado al importar el módulo: un título sin rutas significa que
// el catálogo se quedó sin la última ruta de esa sección, y la barra pintaría un
// encabezado vacío. Mejor reventar acá que dejar un grupo fantasma en pantalla.
for (const section of ADMIN_SIDEBAR_SECTIONS) {
  if (section.items.length === 0) {
    throw new Error(`registry: la sección "${section.title}" del panel quedó sin destinos`)
  }
}

type NavbarAudience = { isCompany: boolean; isAdmin: boolean }

// Tabla, no ternario: `role === 'COMPANY' ? isCompany : isAdmin` mandaba al
// flag de admin cualquier rol que no fuera COMPANY, así que un tercer rol en
// `roles` habría heredado la visibilidad del equipo sin que nadie lo notara.
const ROLE_AUDIENCE_FLAG = {
  COMPANY: 'isCompany',
  ADMIN: 'isAdmin',
} satisfies Record<NavbarRole, keyof NavbarAudience>

// Recorre el catálogo de roles: si `NavbarRoleSchema` gana un tercer rol sin
// que `ROLE_AUDIENCE_FLAG` gane su fila, esto revienta acá en vez de dejar
// `matchesRole` indexando con `undefined` y escondiendo el ítem en silencio.
for (const role of NavbarRoleSchema.literals) {
  if (!(role in ROLE_AUDIENCE_FLAG)) {
    throw new Error(`registry: falta el flag de audiencia para el rol de navbar "${role}"`)
  }
}

function matchesRole(item: NavbarSecondaryItem, options: NavbarAudience): boolean {
  if (!item.roles?.length) {
    return true
  }

  return item.roles.some((role) => options[ROLE_AUDIENCE_FLAG[role]])
}

export function getVisibleNavbarSecondaryItems(options: {
  isCompany: boolean
  isAdmin: boolean
  placement: NavbarPlacement
}) {
  // `placement` cruza la frontera pública de esta función: si un caller le
  // pasa algo fuera del catálogo (un `as`, un valor armado a mano), cae a
  // 'desktop' en vez de que `.includes` compare contra un valor que ningún
  // `NavbarSecondaryItem.placements` va a tener nunca.
  const placement = isNavbarPlacement(options.placement) ? options.placement : 'desktop'

  return NAVBAR_SECONDARY_ITEMS.filter(
    (item) => item.placements.includes(placement) && matchesRole(item, options)
  )
}

export type AccountRoom = Pick<NavbarSecondaryItem, 'href' | 'labelKey' | 'icon'>

export function getAccountRoom(options: { isCompany: boolean; isAdmin: boolean }): AccountRoom {
  const room = NAVBAR_SECONDARY_ITEMS.find((item) => item.room && matchesRole(item, options))
  if (room) return { href: room.href, labelKey: room.labelKey, icon: room.icon }

  // El navbar ofrece la sala apenas resuelve la sesión, antes del perfil de
  // Convex. Sin rol todavía no hay sala que nombrar y la casa pública es el
  // único destino que existe: `/dashboard` se borró ([F] 2026-09-07 09:00).
  return { href: homePathForRole(null), labelKey: 'account', icon: UserCircle }
}
