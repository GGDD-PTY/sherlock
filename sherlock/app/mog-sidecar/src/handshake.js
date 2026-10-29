// ============================================================================
// FRONTERA DEL APRETON DE MANOS DEL SIDECAR
// ============================================================================
// El canal privado se lo entrega el host por `window.postMessage`, y esa puerta
// la ve cualquier documento con una referencia a esta ventana: un frame hermano
// puede mandar su propio `mog:init` con un puerto suyo y ganarle al host. El
// atacante no consigue los bytes del grant — el host solo los transfiere por su
// propio canal — pero se queda con el que el sidecar escucha, y entonces el
// visor espera un `opened` que nunca llega.
//
// Dos cerrojos, y ninguno es la forma del mensaje:
//   1. la ventana: solo el padre entrega el canal,
//   2. el origen: `allow-same-origin` en el sandbox (spike R0) hace que host y
//      sidecar compartan origen por diseno, asi que un origen distinto — u
//      opaco — no es el host.
// ============================================================================

/**
 * @param {MessageEvent} event Mensaje recibido por el sidecar.
 * @param {Window} view Ventana del sidecar (`window`).
 * @returns {boolean} `true` solo si el mensaje es el init del host con puerto.
 */
export function isHostInit(event, view) {
  if (event.source !== view.parent) return false
  if (event.origin !== view.location.origin) return false
  const data = event.data
  if (typeof data !== 'object' || data === null || data.type !== 'mog:init') return false
  return Boolean(event.ports && event.ports[0])
}
