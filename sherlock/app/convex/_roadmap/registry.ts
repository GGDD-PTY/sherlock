// El registry vive bajo convex/ y no en la página porque Convex también lo
// necesita: es la lista cerrada contra la que se valida cada voto que llega sin
// sesión. Módulo puro a propósito, para que ambos lados importen lo mismo.
//
// El vocabulario de estados es UN `Schema.Literals`, no una unión escrita a
// mano: `VOTABLE_STATUSES` sale de `.pick(...)` sobre esa misma lista, así que
// un estado votable que no exista en el vocabulario no compila, y el tipo
// `RoadmapStatus` deja de tener una segunda copia que mantener.
//
// `RoadmapEntry` en cambio es una unión pelada: `ROADMAP_REGISTRY` es data
// literal de este mismo archivo (nunca entra sin decodificar desde afuera), así
// que un `Schema.Struct` sería un valor en el bundle que nadie llama.

import { Schema } from 'effect'

const RoadmapStatusSchema = Schema.Literals([
  'shipped',
  'inProgress',
  'planned',
  'gatheringInterest',
])

export type RoadmapStatus = typeof RoadmapStatusSchema.Type

// `added` es un mes ISO (`2026-08`), no texto libre: la tarjeta lo pinta y el
// orden de la lista lo usa como desempate legible.
export interface RoadmapEntry {
  key: string
  status: RoadmapStatus
  board: 'feature' | 'bug'
  added: string
}

export const ROADMAP_REGISTRY: readonly RoadmapEntry[] = [
  // deliverables sube a Construido ([F] 2026-09-11): el loop de Sample Foods
  // terminó con el modelo v1 revisado a mano y subido a la sala del cliente.
  { key: 'deliverables', status: 'shipped', board: 'feature', added: '2026-08' },
  { key: 'mcp', status: 'inProgress', board: 'feature', added: '2026-08' },
  // Construidos ([F] 2026-09-06, auditoría F08): el hilo con el equipo vive en
  // la sala del cliente (SupportThread) y el equipo contesta desde
  // /admin/support; el tablero ya vota y muestra totales en vivo. Las keys se
  // quedan por las filas de `roadmapVotes` que las nombran (ver `bilingual`).
  { key: 'support', status: 'shipped', board: 'feature', added: '2026-08' },
  { key: 'voting', status: 'shipped', board: 'feature', added: '2026-08' },
  { key: 'guestRooms', status: 'gatheringInterest', board: 'feature', added: '2026-08' },
  { key: 'marketplace', status: 'gatheringInterest', board: 'feature', added: '2026-08' },
  // vdr vuelve a Construido ([F] 2026-09-11): el pase de punta a punta que
  // pedía el [F] 2026-08-27 ya corrió — auditoría autenticada del 2026-09-10
  // sobre PDF, Excel, búsqueda y versiones de la sala.
  { key: 'vdr', status: 'shipped', board: 'feature', added: '2026-07' },
  { key: 'intake', status: 'shipped', board: 'feature', added: '2026-08' },
  // La key se queda aunque el inglés haya salido del plan ([F] 2026-09-03
  // 23:30, el sitio ships solo en español). Sacarla del registry deja huérfanas
  // las filas de `roadmapVotes` que ya la nombran: dejan de contar contra el
  // tope de tres votos del dispositivo y `vote` ya no las puede quitar. Estado
  // terminal, no votable: lo construido es el sitio en español.
  { key: 'bilingual', status: 'shipped', board: 'feature', added: '2026-09' },
  { key: 'theme', status: 'shipped', board: 'feature', added: '2026-07' },
]

/** Los dos estados que admiten voto, derivados del vocabulario, no repetidos. */
const VotableStatusSchema = RoadmapStatusSchema.pick(['planned', 'gatheringInterest'])

export const VOTABLE_STATUSES: readonly RoadmapStatus[] = VotableStatusSchema.literals

export function isVotableKey(key: string): boolean {
  const entry = ROADMAP_REGISTRY.find((candidate) => candidate.key === key)
  return entry !== undefined && VOTABLE_STATUSES.includes(entry.status)
}

export function isKnownKey(key: string): boolean {
  return ROADMAP_REGISTRY.some((entry) => entry.key === key)
}
