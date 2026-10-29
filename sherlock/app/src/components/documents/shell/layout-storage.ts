// Persistencia local del layout del shell. Es una conveniencia por navegador:
// cada lectura y escritura falla en silencio (modo privado, storage bloqueado)
// y el shell debe renderizar igual sin ningún valor guardado.

import { Option, Schema } from 'effect'

// v2: el panel derecho salió de la sala ([F] 2026-09-07), así que un layout
// guardado con `sidebarOpen`/`sidebarWidth` ya no describe nada. La versión
// nueva de la llave hace que esos valores se ignoren en vez de migrarlos.
const ROOM_LAYOUT_STORAGE_KEY = 'sherlock.vdr.shell.layout.v2'

// 180 px es lo más angosto que el árbol sigue siendo legible: por debajo de
// 18rem de contenedor las filas apilan nombre y metadata (ver RoomFolderTree).
export const ROOM_TREE_MIN_WIDTH = 180
export const ROOM_TREE_MAX_WIDTH = 420
const ROOM_TREE_DEFAULT_WIDTH = 320

export type RoomLayout = {
  treeWidth: number
}

const ROOM_DEFAULT_LAYOUT: RoomLayout = {
  treeWidth: ROOM_TREE_DEFAULT_WIDTH,
}

function clamp(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function clampTreeWidth(value: number) {
  return clamp(value, ROOM_TREE_MIN_WIDTH, ROOM_TREE_MAX_WIDTH, ROOM_TREE_DEFAULT_WIDTH)
}

/**
 * Lo que puede haber en `localStorage`, decodificado en vez de casteado.
 *
 * Antes esto era `JSON.parse(raw) as Partial<RoomLayout>`: un casteo ciego
 * sobre un valor que escribe el navegador del visitante y que cualquiera puede
 * editar. Lo salvaba `clampTreeWidth`, no el tipo. Ahora lo que no tiene la
 * forma no llega al clamp: se cae al layout por defecto.
 */
const StoredRoomLayout = Schema.Struct({ treeWidth: Schema.Number })

const decodeStoredLayout = Schema.decodeUnknownOption(StoredRoomLayout)

function readRoomLayout(): RoomLayout {
  try {
    const raw = window.localStorage.getItem(ROOM_LAYOUT_STORAGE_KEY)
    if (!raw) return ROOM_DEFAULT_LAYOUT
    const stored = Option.getOrUndefined(decodeStoredLayout(JSON.parse(raw)))
    if (!stored) return ROOM_DEFAULT_LAYOUT
    return { treeWidth: clampTreeWidth(stored.treeWidth) }
  } catch {
    return ROOM_DEFAULT_LAYOUT
  }
}

function writeRoomLayout(layout: RoomLayout) {
  try {
    window.localStorage.setItem(ROOM_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // El layout es una conveniencia; nunca puede romper la sala.
  }
}

// Store externo mínimo para `useSyncExternalStore`: el servidor siempre
// renderiza el layout por defecto y el navegador adopta el guardado tras
// hidratar, sin efectos que disparen renders en cascada.
let cachedLayout: RoomLayout | null = null
const layoutListeners = new Set<() => void>()

export function subscribeRoomLayout(listener: () => void) {
  layoutListeners.add(listener)
  return () => {
    layoutListeners.delete(listener)
  }
}

export function getRoomLayoutSnapshot(): RoomLayout {
  if (!cachedLayout) cachedLayout = readRoomLayout()
  return cachedLayout
}

export function getRoomLayoutServerSnapshot(): RoomLayout {
  return ROOM_DEFAULT_LAYOUT
}

export function setRoomLayout(patch: Partial<RoomLayout>) {
  cachedLayout = { ...getRoomLayoutSnapshot(), ...patch }
  writeRoomLayout(cachedLayout)
  for (const listener of layoutListeners) listener()
}
