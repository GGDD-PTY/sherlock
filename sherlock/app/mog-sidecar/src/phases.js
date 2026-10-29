// ============================================================================
// PROTOCOLO DE FASES DEL SIDECAR -> HOST
// ============================================================================
// Abrir el libro de SAMPLE_HYDRO cuesta ~27,5 s (PR #490: `openWorkbook` 23,7 s, primer
// render 27,5 s). Sin marcas, el esqueleto del visor pasa esos 27 s mudo y el
// cliente cree que se colgo. Estas son las fases que el sidecar publica por el
// puerto privado, EN ORDEN, para que el host pueda decir en que va.
//
// Regla de compatibilidad: cada fase conserva la marca `performance` que ya
// existia. La spec manual de perf (`e2e/xlsx-sidecar-perf.spec.ts`, PR #490)
// lee esos cuatro nombres exactos, asi que no se renombran ni se agregan
// marcas nuevas: `boot` y `parsing` nacen sin marca y siguen sin ella.
//
// Una tabla decide que se marca y que se publica. Agregar una fase es una fila
// mas, no un `if` mas: el orden vive en el arreglo y en ningun otro lado.
// ============================================================================

/** Fases en orden de emision. El host descarta cualquier cosa fuera de esta lista. */
export const MOG_PHASES = [
  'boot',
  'bytes-received',
  'wasm-ready',
  'parsing',
  'first-sheet',
  'rendered',
]

/** Fase -> marca `performance` heredada, o `null` cuando la fase no tiene una. */
export const MOG_PHASE_MARKS = {
  boot: null,
  'bytes-received': 'open-received',
  'wasm-ready': 'runtime-ready',
  parsing: null,
  'first-sheet': 'workbook-ready',
  rendered: 'app-ready',
}

/**
 * Emisor de fases del sidecar.
 *
 * @param {object} deps
 * @param {(message: unknown) => void} deps.post Publica por el puerto privado.
 * @param {() => number} deps.now Reloj monotono del sidecar (`performance.now`).
 * @param {(name: string) => void} deps.mark Marca `performance` heredada.
 * @returns {(name: string) => boolean} `false` si la fase no existe.
 */
export function createMogPhaseReporter({ post, now, mark }) {
  let previous = -1

  return function phase(name) {
    // La pertenencia se resuelve contra el ARREGLO, no contra la tabla: leer
    // `MOG_PHASE_MARKS['constructor']` devolveria algo por la cadena de
    // prototipos y publicaria una fase que no existe.
    if (!MOG_PHASES.includes(name)) return false
    const legacy = MOG_PHASE_MARKS[name]
    if (legacy) mark(`mog:${legacy}`)

    // El host descarta marcas que retroceden. `performance.now()` puede venir
    // cuantizado y devolver el mismo valor dos veces seguidas, asi que aqui se
    // fuerza una serie no decreciente en vez de dejar que el host la tire.
    const at = Math.max(Math.round(now()), previous)
    previous = at
    post({ type: 'phase', phase: name, at })
    return true
  }
}
