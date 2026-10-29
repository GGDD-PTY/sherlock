// ============================================================================
// CONTRATO DE FASES SIDECAR <-> HOST
// ============================================================================
// El sidecar y el visor son dos bundles distintos: el sidecar compila con Vite
// a `public/mog/` y el host viaja en el bundle de Next. Nada los enlaza en
// tiempo de compilacion, asi que si los nombres de fase se separan el esqueleto
// vuelve a quedarse mudo sin que nada falle. Este archivo es ese enlace.
//
// Segundo invariante: las cuatro marcas `performance` heredadas
// (`open-received`, `runtime-ready`, `workbook-ready`, `app-ready`) NO se
// renombran. La spec manual de perf las lee por nombre exacto (PR #490).
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  createMogPhaseReporter,
  MOG_PHASE_MARKS,
  MOG_PHASES,
} from '../../../mog-sidecar/src/phases.js'
import { XLSX_PHASES } from '@/components/documents/viewers/xlsxPhases'

const SIDECAR_MAIN = readFileSync(join(process.cwd(), 'mog-sidecar/src/main.js'), 'utf8')

type PhaseMessage = { type: string; phase: string; at: number }

function reporter() {
  const posted: PhaseMessage[] = []
  const marked: string[] = []
  let clock = 0
  const phase = createMogPhaseReporter({
    post: (message: unknown) => {
      posted.push(message as PhaseMessage)
    },
    now: () => clock,
    mark: (name: string) => marked.push(name),
  })
  return { phase, posted, marked, tick: (ms: number) => (clock += ms) }
}

describe('protocolo de fases del sidecar', () => {
  it('los dos extremos nombran las mismas fases y en el mismo orden', () => {
    expect(MOG_PHASES).toEqual([...XLSX_PHASES])
    expect(Object.keys(MOG_PHASE_MARKS)).toEqual([...XLSX_PHASES])
  })

  it('conserva las cuatro marcas de performance que lee la spec de perf', () => {
    expect(Object.values(MOG_PHASE_MARKS).filter(Boolean)).toEqual([
      'open-received',
      'runtime-ready',
      'workbook-ready',
      'app-ready',
    ])
  })

  it('publica cada fase con un reloj no decreciente y solo marca las que llevan marca', () => {
    const { phase, posted, marked, tick } = reporter()

    tick(12)
    phase('boot')
    tick(28)
    phase('bytes-received')
    phase('parsing')

    expect(posted).toEqual([
      { type: 'phase', phase: 'boot', at: 12 },
      { type: 'phase', phase: 'bytes-received', at: 40 },
      { type: 'phase', phase: 'parsing', at: 40 },
    ])
    expect(marked).toEqual(['mog:open-received'])
  })

  it('no deja que un reloj cuantizado publique una marca hacia atras', () => {
    const posted: PhaseMessage[] = []
    const clock = vi
      .fn<() => number>()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(99.4)
      .mockReturnValueOnce(101.6)
    const phase = createMogPhaseReporter({
      post: (message: unknown) => {
        posted.push(message as PhaseMessage)
      },
      now: clock,
      mark: () => undefined,
    })

    phase('boot')
    phase('bytes-received')
    phase('wasm-ready')

    expect(posted.map((message) => message.at)).toEqual([100, 100, 102])
  })

  it('ignora una fase que no esta en la tabla', () => {
    const { phase, posted, marked } = reporter()

    expect(phase('recalculando-todo')).toBe(false)
    expect(phase('constructor')).toBe(false)
    expect(phase('boot')).toBe(true)
    expect(posted).toHaveLength(1)
    expect(marked).toEqual([])
  })
})

describe('main.js del sidecar', () => {
  it('emite las seis fases y ya no tiene un marcador propio', () => {
    for (const name of MOG_PHASES) {
      expect(SIDECAR_MAIN).toContain(`phase('${name}')`)
    }
    // El helper viejo `function mark(name)` desaparecio: la tabla es la unica
    // que decide que se marca.
    expect(SIDECAR_MAIN).not.toContain('function mark(')
    expect(SIDECAR_MAIN).toContain("import { createMogPhaseReporter } from './phases.js'")
  })

  it('sella el error con su propio reloj para que el timeline no mienta', () => {
    expect(SIDECAR_MAIN).toContain(
      "post({ type: 'error', message, at: Math.round(performance.now()) })"
    )
  })

  it('saluda con la fase boot solo despues de tener el puerto privado', () => {
    const handshake = SIDECAR_MAIN.slice(SIDECAR_MAIN.indexOf("post({ type: 'ready' })"))
    expect(handshake.indexOf("phase('boot')")).toBeGreaterThan(-1)
    expect(handshake.indexOf("phase('boot')")).toBeLessThan(120)
  })
})
