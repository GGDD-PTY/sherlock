// ============================================================================
// DELIVERABLES — modelo de dominio del pipeline intake → paquete transaccional
// ============================================================================
// Única fuente de los tipos de entregable, sus estados y las transiciones
// permitidas. El schema, las mutations, la UI y los tests consumen ESTE módulo;
// ninguno redeclara los literales ([F] 2026-08-18, diseño foundational del
// pipeline).
//
// Separación de capas — tres tablas, tres responsabilidades:
//   - custodia:   `documents` + `documentVersions` (bytes inmutables, VDR)
//   - transporte: `modelRun*` (PR #287 — cómo llega un artefacto de Mycroft)
//   - workflow:   `deliverables` (este dominio — el slot y su ciclo de vida)
//
// El productor es un DATO, no una arquitectura: el carril manual del equipo y
// el carril Mycroft llenan el mismo slot con la misma forma. Cuando el tubo
// MCP encienda, nada cambia para el cliente.

import { v } from 'convex/values'
import { Schema } from 'effect'

// Cada vocabulario se declara UNA vez, como `Schema.Literals`. La lista `const`
// que ya exportaba este módulo sale de ahí y el validador de Convex también: los
// literales dejan de estar escritos dos veces (una para el tipo, otra para el
// `v.union`), que es justo donde una suite de ocho entregables se desincroniza.
// La expresión del `v.union` va inline y no detrás de un helper genérico: dentro
// de un genérico `v.literal` pierde el literal y el validador degenera a
// `v.string()`, que aceptaría cualquier estado.

// ============================================================================
// KINDS — la suite del oficio ([F] 2026-08-18: 6 entregables; [F] 2026-09-01:
// QA e IRL entran como kinds — la máquina de estados no depende del kind)
// ============================================================================

const DeliverableKindSchema = Schema.Literals([
  'MODEL',
  'TEASER',
  'CIM',
  'MGMT_PRESENTATION',
  'DEBT_DECK',
  'EQUITY_DECK',
  'QA',
  'IRL',
])

export const DELIVERABLE_KINDS = DeliverableKindSchema.literals

export type DeliverableKind = typeof DeliverableKindSchema.Type

export const deliverableKindValidator = v.union(
  ...DeliverableKindSchema.literals.map((literal) => v.literal(literal))
)

// ============================================================================
// RENDITIONS — un kind puede existir en varios formatos; cada rendition es un
// `document` en custodia (los bytes viven en Convex Storage detrás del VDR,
// jamás en un hosting público; solo el teaser puede publicarse afuera y eso es
// una acción humana explícita, no un estado de este workflow).
// HTML primero ([F] 2026-08-18): el artefacto nativo es web; PPTX/PDF son
// exports posteriores del mismo contenido.
// ============================================================================

const DeliverableRenditionFormatSchema = Schema.Literals(['HTML', 'PPTX', 'PDF', 'XLSX'])

export const DELIVERABLE_RENDITION_FORMATS = DeliverableRenditionFormatSchema.literals

export type DeliverableRenditionFormat = typeof DeliverableRenditionFormatSchema.Type

export const deliverableRenditionFormatValidator = v.union(
  ...DeliverableRenditionFormatSchema.literals.map((literal) => v.literal(literal))
)

// ============================================================================
// RETIRO DEL CLIENTE — el dueño quita de su sala una entrega del equipo
// ============================================================================
// [F] 2026-09-17, textual: «cada cliente, dueño de sus documentos, no podemos
// prohibirle borrar sus documentos de su VDR (no es lo mismo que de nuestro
// database, sino de su VDR solamente)». Quitar de la sala archiva el documento
// — fila, bytes y auditoría se quedan — así que el slot NO cambia de estado: su
// máquina de estados es del equipo y `status` lo leen media docena de módulos.
// Lo que cambia es la rendition, que queda marcada con quién la retiró y
// cuándo. El sello es el RECIBO del gesto, no el estado del slot: si el slot se
// quedó sin entrega vigente se pregunta documento por documento
// (`hasUsableRenditionEffect` en `_deliverables/clientWithdrawal.ts`), porque
// una rendition también deja de ser usable sin que nadie la retire — vencida,
// despublicada o con el scan sucio.

// El nombre del slot para el equipo. El `Record` completo es la guarda: un kind
// nuevo no compila hasta que alguien escribe cómo se llama en el aviso. La
// tabla de la UI (`src/messages/es.json`) es la del cliente y no viaja al
// servidor; esta es la del carril interno, como el resto de la copy de
// `_notifications/`.
export const DELIVERABLE_KIND_TEAM_LABELS: Readonly<Record<DeliverableKind, string>> = {
  MODEL: 'Modelo financiero',
  TEASER: 'Teaser',
  CIM: 'CIM',
  MGMT_PRESENTATION: 'Presentación de management',
  DEBT_DECK: 'Deck de deuda',
  EQUITY_DECK: 'Deck de equity',
  QA: 'Q&A',
  IRL: 'Lista de requerimientos (IRL)',
} as const

// ============================================================================
// PRODUCERS — quién produjo el contenido vigente del slot
// ============================================================================

const DeliverableProducerSchema = Schema.Literals(['MYCROFT_RUN', 'TEAM'])

export const DELIVERABLE_PRODUCERS = DeliverableProducerSchema.literals

export const deliverableProducerValidator = v.union(
  ...DeliverableProducerSchema.literals.map((literal) => v.literal(literal))
)

// ============================================================================
// STATUS — máquina de estados del slot
// ============================================================================
// El slot es "el teaser de la empresa X": nunca se supersede a sí mismo — su
// historial de contenido vive en `documentVersions`. Una versión nueva después
// de DELIVERED reabre el ciclo (DELIVERED → IN_PROGRESS).
//
//   REQUESTED → IN_PROGRESS → DRAFT_READY → IN_REVIEW → APPROVED → DELIVERED
//                    ↕                          ↓                      ↓
//               NEEDS_INPUT              (IN_PROGRESS:            (IN_PROGRESS:
//               (faltan docs;             revisión pide            nueva versión
//               mismo vocabulario         cambios)                 reabre ciclo)
//               que modelRuns #287)

const DeliverableStatusSchema = Schema.Literals([
  'REQUESTED',
  'IN_PROGRESS',
  'NEEDS_INPUT',
  'DRAFT_READY',
  'IN_REVIEW',
  'APPROVED',
  'DELIVERED',
])

export const DELIVERABLE_STATUSES = DeliverableStatusSchema.literals

export type DeliverableStatus = typeof DeliverableStatusSchema.Type

export const deliverableStatusValidator = v.union(
  ...DeliverableStatusSchema.literals.map((literal) => v.literal(literal))
)

// Transiciones permitidas. La ausencia de un par aquí ES la regla: no existe
// atajo REQUESTED → APPROVED ni ningún camino que salte la revisión humana.
export const DELIVERABLE_TRANSITIONS: Readonly<
  Record<DeliverableStatus, readonly DeliverableStatus[]>
> = {
  REQUESTED: ['IN_PROGRESS'],
  IN_PROGRESS: ['NEEDS_INPUT', 'DRAFT_READY'],
  NEEDS_INPUT: ['IN_PROGRESS'],
  DRAFT_READY: ['IN_REVIEW'],
  IN_REVIEW: ['APPROVED', 'IN_PROGRESS'],
  APPROVED: ['DELIVERED', 'IN_REVIEW'],
  DELIVERED: ['IN_PROGRESS'],
} as const

export function canTransitionDeliverable(from: DeliverableStatus, to: DeliverableStatus): boolean {
  return DELIVERABLE_TRANSITIONS[from]?.includes(to) ?? false
}

// ============================================================================
// ENTREGA A MANO — el camino que recorre `bun run vdr:push --slot`
// ============================================================================
// El operador que publica el entregable en la sala ES la persona: ya lo produjo
// en Mycroft y ya lo vetó a mano. Su push colapsa producción, revisión,
// aprobación y entrega en un solo acto, y por eso el slot termina en DELIVERED.
//
// Lo que NO hace es inventar un atajo: devuelve los saltos INTERMEDIOS que la
// máquina ya declara y cada uno se valida contra `canTransitionDeliverable`. Si
// alguien recorta `DELIVERABLE_TRANSITIONS`, esto devuelve `null` y la mutation
// no escribe nada — nunca un status que la máquina no admite.
const HUMAN_DELIVERY_PATH: readonly DeliverableStatus[] = [
  'REQUESTED',
  'IN_PROGRESS',
  'DRAFT_READY',
  'IN_REVIEW',
  'APPROVED',
  'DELIVERED',
] as const

export function manualDeliverySteps(from: DeliverableStatus): DeliverableStatus[] | null {
  const position = HUMAN_DELIVERY_PATH.indexOf(from)
  // NEEDS_INPUT (fuera de la línea) y DELIVERED (final de la línea) reentran
  // por IN_PROGRESS, la única transición que la máquina les da a cada uno.
  const start =
    position >= 0 && from !== 'DELIVERED'
      ? position + 1
      : HUMAN_DELIVERY_PATH.indexOf('IN_PROGRESS')
  const steps = HUMAN_DELIVERY_PATH.slice(start)
  let current = from
  for (const next of steps) {
    if (!canTransitionDeliverable(current, next)) return null
    current = next
  }
  return current === 'DELIVERED' ? [...steps] : null
}
