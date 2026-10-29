// ============================================================================
// REDUCTOR DE FASES DEL VISOR XLSX
// ============================================================================
// La frontera por la que entran los mensajes del sidecar al host. Todo lo que
// llega por el MessagePort pasa por aqui, asi que aqui es donde se prueba que
// una marca desconocida, repetida o fuera de orden no mueve nada.
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  reduceXlsxPhase,
  serializeXlsxTimeline,
  XLSX_PHASE_INITIAL,
  XLSX_PHASES,
  xlsxMarksExposed,
  xlsxPhaseMessageKey,
  type XlsxPhaseState,
} from '@/components/documents/viewers/xlsxPhases'

function drive(messages: unknown[], from: XlsxPhaseState = XLSX_PHASE_INITIAL): XlsxPhaseState {
  return messages.reduce<XlsxPhaseState>((state, message) => reduceXlsxPhase(state, message), from)
}

const phase = (name: string, at: number) => ({ type: 'phase', phase: name, at })

describe('xlsx phase reducer — orden', () => {
  it('avanza por las seis fases y termina en rendered', () => {
    const state = drive(XLSX_PHASES.map((name, index) => phase(name, index * 10)))

    expect(state.phase).toBe('rendered')
    expect(state.status).toBe('rendered')
    expect(state.timeline.map((mark) => mark.phase)).toEqual([...XLSX_PHASES])
  })

  it('ignora una fase anterior a la actual', () => {
    const opened = drive([phase('boot', 1), phase('parsing', 40)])
    const late = reduceXlsxPhase(opened, phase('wasm-ready', 41))

    expect(late).toBe(opened)
    expect(late.phase).toBe('parsing')
  })

  it('ignora un reloj que retrocede aunque la fase avance', () => {
    const state = drive([phase('boot', 100), phase('bytes-received', 20)])

    expect(state.phase).toBe('boot')
    expect(state.timeline).toHaveLength(1)
  })

  it('salta fases intermedias sin inventarlas', () => {
    const state = drive([phase('boot', 0), phase('first-sheet', 900)])

    expect(state.phase).toBe('first-sheet')
    expect(state.timeline.map((mark) => mark.phase)).toEqual(['boot', 'first-sheet'])
  })
})

describe('xlsx phase reducer — idempotencia', () => {
  it('devuelve el MISMO objeto cuando la marca se repite', () => {
    const state = drive([phase('boot', 5)])
    const again = reduceXlsxPhase(state, phase('boot', 5))
    const laterCopy = reduceXlsxPhase(state, phase('boot', 99))

    expect(again).toBe(state)
    expect(laterCopy).toBe(state)
    expect(state.timeline).toHaveLength(1)
  })

  it('no vuelve a pintar cuando el mensaje no dice nada', () => {
    const state = drive([phase('boot', 5)])

    for (const noise of [
      { type: 'ready' },
      { type: 'navigate', sheet: 'EEFF' },
      { type: 'phase', phase: 'teletransportacion', at: 10 },
      { type: 'phase', phase: 'parsing' },
      { type: 'phase', phase: 'parsing', at: 'pronto' },
      { type: 'phase', phase: 'parsing', at: Number.NaN },
      { type: 'phase', phase: 'parsing', at: Number.POSITIVE_INFINITY },
      { type: 'phase', phase: 'parsing', at: -1 },
      { phase: 'parsing', at: 10 },
      'parsing',
      42,
      null,
      undefined,
    ]) {
      expect(reduceXlsxPhase(state, noise)).toBe(state)
    }
  })
})

describe('xlsx phase reducer — error', () => {
  it('es terminal y conserva la fase donde murio', () => {
    const state = drive([phase('boot', 1), phase('parsing', 30), { type: 'error', at: 45 }])

    expect(state.status).toBe('error')
    expect(state.phase).toBe('parsing')
    expect(state.timeline.at(-1)).toEqual({ phase: 'error', at: 45 })
  })

  it('ignora fases posteriores al error y no lo duplica', () => {
    const failed = drive([phase('boot', 1), { type: 'error', at: 9 }])

    expect(reduceXlsxPhase(failed, phase('rendered', 30))).toBe(failed)
    expect(reduceXlsxPhase(failed, { type: 'error', at: 30 })).toBe(failed)
  })

  it('degrada en vez de borrar la hoja cuando llega despues de rendered', () => {
    const rendered = drive([phase('boot', 1), phase('rendered', 20)])
    const degraded = reduceXlsxPhase(rendered, { type: 'error' })

    expect(rendered.status).toBe('rendered')
    // El libro ya esta en pantalla: citar una celda que no existe o un fallo
    // tardio del runtime no puede quitarle al cliente la hoja que si abrio.
    expect(degraded.status).toBe('degraded')
    expect(degraded.phase).toBe('rendered')
    // Sin reloj propio hereda el de la ultima marca en vez de inventar un cero.
    expect(degraded.timeline.at(-1)).toEqual({ phase: 'error', at: 20 })
  })

  it('un segundo fallo no convierte la hoja degradada en error', () => {
    const degraded = reduceXlsxPhase(drive([phase('rendered', 20)]), { type: 'error' })

    // Sin el guardia, la rama de arriba leeria `status !== 'rendered'` y le
    // quitaria al cliente el libro que sigue en pantalla.
    expect(reduceXlsxPhase(degraded, { type: 'error', at: 44 })).toBe(degraded)
  })

  it('no deja que el reloj del error retroceda en el timeline', () => {
    const degraded = reduceXlsxPhase(drive([phase('rendered', 20)]), { type: 'error', at: 5 })

    // `data-xlsx-marks` sigue en pantalla con el visor degradado, y es una
    // medicion del reparto del tiempo: no puede ir hacia atras.
    expect(degraded.timeline.at(-1)).toEqual({ phase: 'error', at: 20 })
  })

  it('acepta un error sin reloj desde el estado inicial', () => {
    const failed = reduceXlsxPhase(XLSX_PHASE_INITIAL, { type: 'error' })

    expect(failed.status).toBe('error')
    expect(failed.phase).toBeNull()
    expect(failed.timeline).toEqual([{ phase: 'error', at: 0 }])
  })
})

describe('xlsx phase reducer — la cita se reintenta', () => {
  it('sale de degraded cuando el host emite una cita nueva', () => {
    const degraded = reduceXlsxPhase(drive([phase('rendered', 20)]), { type: 'error', at: 30 })
    const retried = reduceXlsxPhase(degraded, { type: 'navigation-retry' })

    expect(degraded.status).toBe('degraded')
    expect(retried.status).toBe('rendered')
    // La marca del fallo se conserva: el timeline es la medicion, no el aviso.
    expect(retried.timeline).toEqual(degraded.timeline)
  })

  it('no revive un libro que nunca abrio ni mueve uno sano', () => {
    const failed = drive([phase('boot', 1), { type: 'error', at: 9 }])
    const rendered = drive([phase('rendered', 12)])
    const opening = drive([phase('parsing', 5)])

    for (const state of [failed, rendered, opening]) {
      expect(reduceXlsxPhase(state, { type: 'navigation-retry' })).toBe(state)
    }
  })
})

describe('xlsx phase reducer — protocolo viejo', () => {
  it('acepta `opened` como alias de rendered', () => {
    const state = drive([phase('boot', 1), phase('parsing', 30), { type: 'opened' }])

    expect(state.status).toBe('rendered')
    expect(state.timeline.at(-1)).toEqual({ phase: 'rendered', at: 30 })
  })

  it('no retrocede si `opened` llega despues de la fase rendered', () => {
    const state = drive([phase('rendered', 12)])

    expect(reduceXlsxPhase(state, { type: 'opened' })).toBe(state)
  })
})

describe('xlsx phase copy y serializacion', () => {
  it('da una clave de copy para cada fase que se puede rotular', () => {
    expect(xlsxPhaseMessageKey(null)).toBe('loadingSheets')
    expect(xlsxPhaseMessageKey('rendered')).toBe('loadingSheets')

    const labelled = XLSX_PHASES.filter((name) => name !== 'rendered').map(xlsxPhaseMessageKey)
    expect(new Set(labelled).size).toBe(labelled.length)
    expect(labelled).toEqual([
      'phaseBoot',
      'phaseBytesReceived',
      'phaseWasmReady',
      'phaseParsing',
      'phaseFirstSheet',
    ])
  })

  it('serializa el timeline como `fase:ms` para el atributo del iframe', () => {
    const state = drive([phase('boot', 4.4), phase('bytes-received', 40.6)])

    expect(serializeXlsxTimeline(state.timeline)).toBe('boot:4 bytes-received:41')
    expect(serializeXlsxTimeline([])).toBe('')
  })
})

describe('exposicion de los ganchos de tiempo', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('solo se abre fuera de produccion y con la bandera de las specs', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_XLSX_PHASE_MARKS', 'true')
    expect(xlsxMarksExposed()).toBe(true)
  })

  it('queda cerrada en produccion aunque alguien exporte la bandera', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_XLSX_PHASE_MARKS', 'true')
    expect(xlsxMarksExposed()).toBe(false)
  })

  it('queda cerrada sin la bandera, y no acepta un valor aproximado', () => {
    vi.stubEnv('NODE_ENV', 'development')
    for (const value of [undefined, '', '1', 'TRUE', 'yes']) {
      vi.stubEnv('NEXT_PUBLIC_XLSX_PHASE_MARKS', value)
      expect(xlsxMarksExposed(), String(value)).toBe(false)
    }
  })
})
