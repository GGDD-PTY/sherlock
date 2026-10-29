// ============================================================================
// ACTIVIDAD DEL DATA ROOM — agregación pura
// ============================================================================
// La query solo lee filas; el conteo vive acá. Sin ctx, determinista, testeable
// sin Convex. El conteo es la parte que puede estar mal en silencio.
// ============================================================================

import { Schema } from 'effect'

import type { Doc, Id } from '../_generated/dataModel'

// El catálogo se declara UNA vez, como `Schema.Literals`, y dos cosas distintas
// leen de él: la tabla de contadores de abajo (vía `satisfies`, atada al mismo
// tipo) y `emptyCounters()` (vía `.literals`, recorriendo el catálogo en vez de
// deletrear sus cinco miembros a mano). normalizeAccessAction la produce a mano
// desde strings sueltos (ver abajo) — no hay bytes externos que decodificar con
// este schema, pero SÍ hay un vocabulario que antes vivía repetido en dos
// sitios y ahora vive en uno.
const RoomActivityKindSchema = Schema.Literals(['VIEW', 'DOWNLOAD', 'LINK', 'BLOCKED', 'OTHER'])
export type RoomActivityKind = typeof RoomActivityKindSchema.Type

type RoomCounterpartyKind = 'TEAM' | 'UNKNOWN'

interface RoomActivityCounters {
  views: number
  downloads: number
  links: number
  blocked: number
  other: number
}

// Cada clase de actividad tiene UN contador, y la tabla lo dice. La escalera de
// `if/else if` que había antes terminaba en un `else` que mandaba todo lo no
// reconocido a `other`: agregar una clase nueva no rompía nada y su conteo se
// perdía ahí adentro. Con el `Record` exhaustivo —atado al catálogo por
// `satisfies`—, olvidarla no compila.
const ROOM_ACTIVITY_COUNTER = {
  VIEW: 'views',
  DOWNLOAD: 'downloads',
  LINK: 'links',
  BLOCKED: 'blocked',
  OTHER: 'other',
} as const satisfies Record<RoomActivityKind, keyof RoomActivityCounters>

export interface ResolvedCounterparty {
  kind: RoomCounterpartyKind
  displayName: string | null
  identityRevealed: boolean
}

// ES: Una sola descarga deja DOS filas: `getDownloadUrl` escribe
// DOWNLOAD_GRANT_ISSUED y `consumeDownloadGrant` escribe DOWNLOAD. Contar las
// dos duplicaría cada descarga en la pantalla del emisor, así que la emisión del
// enlace es su propia categoría y NO suma al contador de descargas. Lo mismo
// aplica a VIEW_GRANT_ISSUED contra VIEW. Un enlace sin consumo tampoco es una
// entrega: nadie llegó a abrir el archivo.
// EN: a grant issuance is a link, never a delivery — folding it in double-counts.
export function normalizeAccessAction(log: {
  action?: string
  decision?: 'ALLOW' | 'DENY' | 'REQUIRE_STEP_UP' | 'REQUIRE_REVIEW'
}): RoomActivityKind {
  if (log.decision && log.decision !== 'ALLOW') return 'BLOCKED'

  const action = (log.action ?? '').toUpperCase()
  if (action.endsWith('_DENIED') || action.endsWith('_BLOCKED')) return 'BLOCKED'
  if (action.endsWith('_GRANT_ISSUED')) return 'LINK'
  if (action === 'DOWNLOAD') return 'DOWNLOAD'
  if (action === 'VIEW' || action === 'PREVIEW') return 'VIEW'

  return 'OTHER'
}

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

function fnv1a(input: string, basis: number): number {
  let hash = basis >>> 0
  for (let i = 0; i < input.length; i += 1) {
    hash = Math.imul(hash ^ input.charCodeAt(i), FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

// ES: La clave que agrupa las filas del emisor NO puede ser el `Id<'profiles'>`.
// Un id de Convex es estable entre salas y pantallas: si la identidad de
// ese perfil se revela una sola vez en cualquier otra superficie, el emisor
// puede volver atrás y ponerle nombre a toda la actividad que guardó como
// anónima. Acá sale un derivado con sal de sala — estable DENTRO de la sala (por
// eso "volvió tres veces" sigue agrupando) y sin relación con la clave que el
// mismo perfil recibe en otra sala. El id real se queda del lado servidor.
// EN: room-scoped opaque key; the raw profile id never crosses the boundary.
function roomCounterpartyKey(roomScope: string, profileId: string): string {
  const material = `${roomScope}:${profileId}`
  const high = fnv1a(material, FNV_OFFSET_BASIS)
  const low = fnv1a(material, high)
  return `cp_${high.toString(36).padStart(7, '0')}${low.toString(36).padStart(7, '0')}`
}

// Código corto que se pinta en pantalla: se deriva de la clave opaca, nunca del
// id del perfil. Deja ver "volvió tres veces" sin revelar identidad que las
// compuertas todavía no otorgaron.
export function counterpartyCode(counterpartyKey: string): string {
  return counterpartyKey.slice(-4).toUpperCase()
}

// Derivado del catálogo, no deletreado: agregar un RoomActivityKind que no
// aparezca acá antes se perdía en silencio (el contador de esa fila arrancaba
// en `undefined`, y `addKind` lo dejaba en NaN). Con `.literals`, el nuevo
// contador nace en cero solo con actualizar `ROOM_ACTIVITY_COUNTER`.
function emptyCounters(): RoomActivityCounters {
  return RoomActivityKindSchema.literals.reduce<RoomActivityCounters>((counters, kind) => {
    counters[ROOM_ACTIVITY_COUNTER[kind]] = 0
    return counters
  }, {} as RoomActivityCounters)
}

function addKind(counters: RoomActivityCounters, kind: RoomActivityKind): void {
  counters[ROOM_ACTIVITY_COUNTER[kind]] += 1
}

interface RoomActivityEvent {
  id: Id<'documentAccessLogs'>
  at: number
  kind: RoomActivityKind
  documentId: Id<'documents'>
  /** Clave opaca con alcance de sala — nunca el `Id<'profiles'>`. */
  counterpartyKey: string
  accessLevel: Doc<'documents'>['accessLevel'] | null
}

interface RoomDocumentRow {
  documentId: Id<'documents'>
  name: string | null
  folder: string | null
  accessLevel: Doc<'documents'>['accessLevel'] | null
  counters: RoomActivityCounters
  counterpartyCount: number
  lastAccessAt: number
}

interface RoomCounterpartyRow {
  /** Clave opaca con alcance de sala — nunca el `Id<'profiles'>`. */
  key: string
  code: string
  kind: RoomCounterpartyKind
  displayName: string | null
  identityRevealed: boolean
  counters: RoomActivityCounters
  documentCount: number
  lastAccessAt: number
}

export interface RoomActivity {
  windowDays: number
  scanCap: number
  scannedCount: number
  truncated: boolean
  totals: RoomActivityCounters
  documentCount: number
  counterpartyCount: number
  byDocument: RoomDocumentRow[]
  byCounterparty: RoomCounterpartyRow[]
  events: RoomActivityEvent[]
}

export function buildRoomActivity(input: {
  logs: Array<Doc<'documentAccessLogs'>>
  documents: Map<Id<'documents'>, Doc<'documents'>>
  counterparties: Map<Id<'profiles'>, ResolvedCounterparty>
  /** Sala a la que pertenece esta proyección: sal de la clave de contraparte. */
  roomScope: string
  windowDays: number
  scanCap: number
  scannedCount: number
}): RoomActivity {
  const totals = emptyCounters()
  const events: RoomActivityEvent[] = []
  const documentRows = new Map<Id<'documents'>, RoomDocumentRow & { seen: Set<string> }>()
  const counterpartyRows = new Map<Id<'profiles'>, RoomCounterpartyRow & { seen: Set<string> }>()

  for (const log of input.logs) {
    const kind = normalizeAccessAction(log)
    const at = log.accessedAt ?? log._creationTime
    addKind(totals, kind)

    const document = input.documents.get(log.documentId)
    const documentRow = documentRows.get(log.documentId) ?? {
      documentId: log.documentId,
      name: document?.name ?? null,
      folder: document?.folder ?? null,
      accessLevel: document?.accessLevel ?? null,
      counters: emptyCounters(),
      counterpartyCount: 0,
      lastAccessAt: at,
      seen: new Set<string>(),
    }
    addKind(documentRow.counters, kind)
    documentRow.seen.add(log.accessedById)
    documentRow.counterpartyCount = documentRow.seen.size
    documentRow.lastAccessAt = Math.max(documentRow.lastAccessAt, at)
    documentRows.set(log.documentId, documentRow)

    const resolved = input.counterparties.get(log.accessedById)
    const revealed = resolved?.identityRevealed ?? false
    const key = roomCounterpartyKey(input.roomScope, log.accessedById)
    const counterpartyRow = counterpartyRows.get(log.accessedById) ?? {
      key,
      code: counterpartyCode(key),
      kind: resolved?.kind ?? 'UNKNOWN',
      displayName: revealed ? (resolved?.displayName ?? null) : null,
      identityRevealed: revealed,
      counters: emptyCounters(),
      documentCount: 0,
      lastAccessAt: at,
      seen: new Set<string>(),
    }
    addKind(counterpartyRow.counters, kind)
    counterpartyRow.seen.add(log.documentId)
    counterpartyRow.documentCount = counterpartyRow.seen.size
    counterpartyRow.lastAccessAt = Math.max(counterpartyRow.lastAccessAt, at)
    counterpartyRows.set(log.accessedById, counterpartyRow)

    events.push({
      id: log._id,
      at,
      kind,
      documentId: log.documentId,
      counterpartyKey: key,
      accessLevel: log.accessLevel ?? null,
    })
  }

  const byRecency = <T extends { lastAccessAt: number; counters: RoomActivityCounters }>(
    a: T,
    b: T
  ) => b.lastAccessAt - a.lastAccessAt || b.counters.downloads - a.counters.downloads

  return {
    windowDays: input.windowDays,
    scanCap: input.scanCap,
    scannedCount: input.scannedCount,
    truncated: input.scannedCount >= input.scanCap,
    totals,
    documentCount: documentRows.size,
    counterpartyCount: counterpartyRows.size,
    byDocument: [...documentRows.values()].map(({ seen: _seen, ...row }) => row).sort(byRecency),
    byCounterparty: [...counterpartyRows.values()]
      .map(({ seen: _seen, ...row }) => row)
      .sort(byRecency),
    events,
  }
}
