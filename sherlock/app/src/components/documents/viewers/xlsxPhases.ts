// ============================================================================
// FASES DE APERTURA DEL VISOR XLSX — frontera host <- sidecar
// ============================================================================
// El sidecar Mog publica fases ordenadas por el MessagePort privado
// (`mog-sidecar/src/phases.js`). Este modulo es la UNICA puerta por la que el
// estado de apertura cambia: valida forma y orden, y devuelve el siguiente
// estado. Nada mas del visor mira `event.data`. Por esa misma puerta entra el
// unico evento que no viene del sidecar, `navigation-retry`, que el host emite
// cuando manda una cita nueva.
//
// Se modela como maquina de estados con una tabla de orden, no como una pila de
// condicionales: agregar una fase es una entrada en `XLSX_PHASES` y una clave
// de copy, y el resto (orden, idempotencia, timeline) sale gratis.
//
// Reglas de la frontera, todas cubiertas por `xlsx-phases.test.ts`:
//   - una fase desconocida se ignora (no rompe, no avanza),
//   - una fase repetida o anterior a la actual se ignora,
//   - un `at` que no es un numero finito no negativo se ignora,
//   - un `at` que retrocede respecto de la ultima marca se ignora,
//   - `error` antes de `rendered` es terminal, y despues de `rendered` degrada:
//     el libro ya esta en pantalla y una cita fallida no se lo quita al cliente,
//   - una cita nueva saca al visor de `degraded`: el aviso describe el ULTIMO
//     intento, no una condena del libro.
// ============================================================================

import { Option, Schema } from 'effect'

/**
 * Fases en orden. El indice ES el orden: no hay segunda lista que mantener.
 * La lista se declara como schema y de ahi salen las dos cosas que se usan: el
 * tipo (`XlsxPhase`) y el arreglo en orden (`XLSX_PHASES`). Asi la frontera
 * valida contra la MISMA lista con la que el visor ordena, y no contra una
 * copia escrita a mano al lado.
 */
const XlsxPhaseSchema = Schema.Literals([
  'boot',
  'bytes-received',
  'wasm-ready',
  'parsing',
  'first-sheet',
  'rendered',
])

export const XLSX_PHASES = XlsxPhaseSchema.literals

export type XlsxPhase = typeof XlsxPhaseSchema.Type

const PHASE_ORDER = new Map<string, number>(XLSX_PHASES.map((phase, index) => [phase, index]))

/** Una marca ya aceptada. `error` no es una fase ordenada: es el final infeliz. */
export type XlsxPhaseMark = { phase: XlsxPhase | 'error'; at: number }

export type XlsxPhaseState = {
  /** Ultima fase confirmada, o `null` mientras el sidecar no ha saludado. */
  phase: XlsxPhase | null
  /**
   * `error` es el libro que nunca abrio y el visor entero se reemplaza. Son dos
   * estados y no uno con bandera porque el visor hace cosas distintas con cada
   * uno: `degraded` es el libro abierto al que le fallo algo despues, y ahi la
   * hoja se queda donde esta con un aviso al lado.
   */
  status: 'opening' | 'rendered' | 'error' | 'degraded'
  timeline: XlsxPhaseMark[]
}

export const XLSX_PHASE_INITIAL: XlsxPhaseState = { phase: null, status: 'opening', timeline: [] }

/**
 * Copy por fase. `rendered` no aparece: cuando llega, el esqueleto se va y no
 * hay nada que rotular. `null` (todavia bajando los bytes) reusa el texto que
 * el visor ya tenia, para no estrenar un estado que no dice nada nuevo.
 */
const PHASE_MESSAGE_KEY: Record<Exclude<XlsxPhase, 'rendered'>, string> = {
  boot: 'phaseBoot',
  'bytes-received': 'phaseBytesReceived',
  'wasm-ready': 'phaseWasmReady',
  parsing: 'phaseParsing',
  'first-sheet': 'phaseFirstSheet',
}

/** Clave de `vdr.viewer` que rotula el esqueleto para la fase dada. */
export function xlsxPhaseMessageKey(phase: XlsxPhase | null): string {
  if (phase === null || phase === 'rendered') return 'loadingSheets'
  return PHASE_MESSAGE_KEY[phase]
}

type PhaseEvent =
  | { kind: 'phase'; phase: XlsxPhase; at: number }
  | { kind: 'error'; at: number | null }
  | { kind: 'retry' }

function finiteAt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * La forma de lo que el puerto puede traer. El `at` se declara `Unknown` a
 * proposito: el reloj no es parte de la FORMA del mensaje sino de su
 * contenido, y un `at` corrupto no descalifica un `error` (que sigue siendo un
 * error, solo sin reloj propio) aunque si descalifique una fase, que sin marca
 * no se puede ordenar. Esa diferencia la decide `finiteAt`, abajo; el schema
 * decide el vocabulario.
 *
 * Los campos de mas se ignoran, que es el default de `decodeUnknown`: el
 * sidecar puede publicar diagnostico junto a la fase sin que el host lo tire.
 */
const SidecarMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal('navigation-retry') }),
  Schema.Struct({ type: Schema.Literal('error'), at: Schema.optionalKey(Schema.Unknown) }),
  Schema.Struct({ type: Schema.Literal('opened'), at: Schema.optionalKey(Schema.Unknown) }),
  Schema.Struct({
    type: Schema.Literal('phase'),
    phase: XlsxPhaseSchema,
    at: Schema.optionalKey(Schema.Unknown),
  }),
])

const decodeSidecarMessage = Schema.decodeUnknownOption(SidecarMessage)

/**
 * Traduce un mensaje crudo del puerto a un evento tipado, o `null` si no lo es.
 *
 * `opened` se acepta como alias de `rendered`: es el mensaje que el sidecar ya
 * publicaba antes de las fases y sigue publicando, y el visor no puede quedarse
 * colgado contra un sidecar cacheado que solo sepa el protocolo viejo.
 */
function parsePhaseMessage(message: unknown): PhaseEvent | null {
  const decoded = Option.getOrUndefined(decodeSidecarMessage(message))
  if (!decoded) return null

  if (decoded.type === 'navigation-retry') return { kind: 'retry' }
  if (decoded.type === 'error') return { kind: 'error', at: finiteAt(decoded.at) }
  if (decoded.type === 'opened') {
    return { kind: 'phase', phase: 'rendered', at: finiteAt(decoded.at) ?? -1 }
  }

  const at = finiteAt(decoded.at)
  if (at === null) return null
  return { kind: 'phase', phase: decoded.phase, at }
}

/**
 * Reduce un mensaje del sidecar sobre el estado de fases. Puro y idempotente:
 * si el mensaje no cambia nada devuelve EL MISMO objeto, asi React no vuelve a
 * pintar por una marca repetida.
 */
export function reduceXlsxPhase(state: XlsxPhaseState, message: unknown): XlsxPhaseState {
  const event = parsePhaseMessage(message)
  if (!event) return state

  const lastAt = state.timeline.at(-1)?.at ?? 0

  // Solo hay de donde volver si el libro sigue en pantalla. Un `error` real
  // nunca se deshace, y un visor sano no tiene nada que limpiar.
  if (event.kind === 'retry') {
    return state.status === 'degraded' ? { ...state, status: 'rendered' } : state
  }

  if (event.kind === 'error') {
    if (state.status === 'error' || state.status === 'degraded') return state
    return {
      phase: state.phase,
      status: state.status === 'rendered' ? 'degraded' : 'error',
      // El reloj del error tampoco puede retroceder: `data-xlsx-marks` sigue
      // en pantalla mientras el visor esta degradado y es una medicion.
      timeline: [...state.timeline, { phase: 'error', at: Math.max(event.at ?? lastAt, lastAt) }],
    }
  }

  // Un error ya reportado no se deshace con una fase que llega tarde. No hace
  // falta nombrar `degraded` aqui: implica `phase === 'rendered'`, que es el
  // maximo del orden, asi que la comparacion de abajo ya descarta todo.
  if (state.status === 'error') return state

  const next = PHASE_ORDER.get(event.phase)
  const current = state.phase === null ? -1 : PHASE_ORDER.get(state.phase)
  if (next === undefined || current === undefined || next <= current) return state

  // `opened` viejo no trae reloj: hereda el de la ultima marca en vez de
  // inventar un cero que rompería la serie.
  const at = event.at < 0 ? lastAt : event.at
  if (at < lastAt) return state

  return {
    phase: event.phase,
    status: event.phase === 'rendered' ? 'rendered' : 'opening',
    timeline: [...state.timeline, { phase: event.phase, at }],
  }
}

/**
 * Los ganchos de tiempo (`data-xlsx-phase` / `data-xlsx-marks`) son para las
 * specs, no para el cliente: en produccion no se publica el reparto del tiempo
 * de apertura ni queda un lector de instrumentacion en el DOM. La bandera la
 * pone `playwright.config.ts`, y el `NODE_ENV` cierra la puerta aunque alguien
 * la exporte en un deploy.
 */
export function xlsxMarksExposed(): boolean {
  return (
    process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_XLSX_PHASE_MARKS === 'true'
  )
}

/**
 * Serializa el timeline para el atributo `data-xlsx-marks` del iframe. Es lo
 * que lee `e2e/xlsx-viewer-phases.spec.ts` para reportar el reparto del tiempo
 * por fase sin instrumentar el navegador.
 */
export function serializeXlsxTimeline(timeline: readonly XlsxPhaseMark[]): string {
  return timeline.map((mark) => `${mark.phase}:${Math.round(mark.at)}`).join(' ')
}
