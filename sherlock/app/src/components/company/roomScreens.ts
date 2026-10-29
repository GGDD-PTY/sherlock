import { Schema } from 'effect'

// ===== PANTALLAS DE LA SALA =====
// La sala del cliente es un conjunto de pantallas, una por intención, y no una
// portada con secciones apiladas ([F] 2026-09-11 17:15, docs/design-system-vdr.md).
// Cada pantalla es una ruta hija de /my-company. Este catálogo es la única
// fuente: la barra de secciones, los enlaces cruzados («Subir», «Escríbenos»)
// y las páginas lo leen de aquí, así que una pantalla que no existe es un
// error del compilador y no un enlace muerto.
const RoomScreenSchema = Schema.Literals(['documents', 'company', 'preparation', 'team', 'guests'])

export type RoomScreen = typeof RoomScreenSchema.Type

export const ROOM_SCREENS: readonly RoomScreen[] = RoomScreenSchema.literals

/** Ruta relativa al locale. `Link` de `@/i18n/navigation` antepone `/es`. */
export const ROOM_SCREEN_PATH: Record<RoomScreen, `/my-company/${string}`> = {
  documents: '/my-company/documents',
  company: '/my-company/company',
  preparation: '/my-company/preparation',
  team: '/my-company/team',
  guests: '/my-company/guests',
}

/** Clave dentro de `roomWorkspace.nav` en `src/messages/es.json`. */
export const ROOM_SCREEN_LABEL_KEY: Record<RoomScreen, string> = {
  documents: 'documents',
  company: 'company',
  preparation: 'preparation',
  team: 'team',
  guests: 'guests',
}

const isRoomScreen = Schema.is(RoomScreenSchema)

/** Decodifica un pathname (`/es/my-company/company`) contra el catálogo. */
export function roomScreenFromPathname(pathname: string): RoomScreen | null {
  const match = /\/my-company\/([^/?#]+)/.exec(pathname)
  const candidate = match?.[1]
  return candidate !== undefined && isRoomScreen(candidate) ? candidate : null
}

/**
 * Qué pantallas ve quien entra. La barra enseña solo las que aplican: un
 * miembro de solo lectura no edita el perfil, el equipo no habla consigo mismo
 * desde /admin, y los invitados solo existen cuando la empresa tiene NDA.
 */
export function roomScreensFor(access: {
  accessMode: 'MANAGE' | 'READ_ONLY'
  adminOperator: boolean
  guestsAvailable: boolean
}): RoomScreen[] {
  const manages = access.accessMode === 'MANAGE'
  const visible: Record<RoomScreen, boolean> = {
    documents: true,
    company: manages && !access.adminOperator,
    preparation: manages,
    team: manages && !access.adminOperator,
    guests: manages && access.guestsAvailable,
  }
  return ROOM_SCREENS.filter((screen) => visible[screen])
}
