// ============================================================================
// APRETON DE MANOS DEL SIDECAR — QUIEN PUEDE ENTREGARLE EL PUERTO
// ============================================================================
// El sidecar recibe su canal privado por `window.postMessage`. Cualquier
// documento con una referencia a esa ventana puede intentarlo: un frame hermano
// puede hacer `parent.frames[i].postMessage({type:'mog:init'}, '*', [puerto])`
// y ganarle al host. El sidecar no se queda con los bytes del grant en ese
// escenario, pero se queda con el canal, y el visor espera para siempre por un
// `opened` que nunca llega.
//
// Por eso el `mog:init` solo se acepta del padre y del mismo origen: el spike
// R0 dejo `allow-same-origin` en el sandbox, asi que el host y el sidecar
// comparten origen por diseno y un origen distinto (u opaco) no es el host.
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { isHostInit } from '../../../mog-sidecar/src/handshake.js'

const SIDECAR_MAIN = readFileSync(join(process.cwd(), 'mog-sidecar/src/main.js'), 'utf8')

const HOST = { location: { origin: 'https://sherlock.test' } } as unknown as Window
const view = { parent: HOST, location: HOST.location } as unknown as Window

function init(overrides: Record<string, unknown> = {}) {
  return {
    source: HOST,
    origin: 'https://sherlock.test',
    data: { type: 'mog:init' },
    ports: [{} as MessagePort],
    ...overrides,
  } as unknown as MessageEvent
}

describe('mog:init del sidecar', () => {
  it('acepta el init del padre, mismo origen y con puerto', () => {
    expect(isHostInit(init(), view)).toBe(true)
  })

  it('rechaza un init de otra ventana aunque el origen coincida', () => {
    const sibling = { location: HOST.location } as unknown as Window
    expect(isHostInit(init({ source: sibling }), view)).toBe(false)
  })

  it('rechaza un origen distinto u opaco', () => {
    for (const origin of ['https://evil.example', 'null', '']) {
      expect(isHostInit(init({ origin }), view), origin).toBe(false)
    }
  })

  it('rechaza un mensaje que no es el init o que llega sin puerto', () => {
    expect(isHostInit(init({ data: { type: 'mog:hello' } }), view)).toBe(false)
    expect(isHostInit(init({ data: null }), view)).toBe(false)
    expect(isHostInit(init({ data: 'mog:init' }), view)).toBe(false)
    expect(isHostInit(init({ ports: [] }), view)).toBe(false)
    expect(isHostInit(init({ ports: undefined }), view)).toBe(false)
  })

  it('funciona con el sidecar abierto como pagina de primer nivel', () => {
    // Asi lo mide la spec manual de perf de PR #490: sin iframe, `parent` es la
    // propia ventana y el saludo va de la pagina a si misma.
    const top = { location: HOST.location } as unknown as Window
    const selfView = { parent: top, location: HOST.location } as unknown as Window
    expect(isHostInit(init({ source: top }), selfView)).toBe(true)
  })
})

describe('main.js del sidecar — frontera del apreton', () => {
  it('valida el init con el guardia en vez de aceptar el primer puerto', () => {
    expect(SIDECAR_MAIN).toContain("import { isHostInit } from './handshake.js'")
    expect(SIDECAR_MAIN).toContain('if (!isHostInit(event, window)) return')
    // El puerto ya ligado sella el canal: un init posterior no lo reemplaza.
    const listener = SIDECAR_MAIN.slice(SIDECAR_MAIN.indexOf("addEventListener('message'"))
    expect(listener.indexOf('if (port) return')).toBeLessThan(
      listener.indexOf('if (!isHostInit(event, window)) return')
    )
  })

  it('saluda al padre con origen explicito, nunca con comodin', () => {
    expect(SIDECAR_MAIN).toContain(
      "window.parent?.postMessage({ type: 'mog:hello' }, window.location.origin)"
    )
    expect(SIDECAR_MAIN).not.toContain("postMessage({ type: 'mog:hello' }, '*')")
  })
})
