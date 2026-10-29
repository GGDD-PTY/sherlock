// ============================================================================
// ENTREGA DE GRANTS DE DOCUMENTO SIN DEPENDER DE POPUPS
// ============================================================================
// Un grant de descarga se pide a Convex con `await` y recién después se
// entrega. Ese `await` saca la entrega del gesto del usuario: Safari (Mac e
// iOS) y Chrome móvil tratan un `window.open` posterior como popup y lo
// bloquean en silencio (`window.open` devuelve null). El grant es de un solo
// uso, así que además se quema sin que nadie vea un archivo. Hilo de soporte
// de SAMPLE_HYDRO 2026-08-27: «Why can't I download the pdfs? Why can't I open the
// pdfs from my cellphone?».
//
// Las URLs de grant son same-origin (`/api/documents/access/<grantId>`), así
// que una descarga no necesita pestaña nueva: un <a download> sintético la
// dispara en cualquier navegador sin permiso de popup. Ver fuera del visor
// sí intenta la pestaña nueva, pero si el navegador la bloquea navega en la
// misma pestaña en vez de callarse.
//
// El anchor es un recurso con vida propia dentro del DOM: se adquiere y se
// libera con `Effect.acquireRelease`, así que ni un click que lance lo deja
// pegado en el documento. Todo corre con `Effect.runSync` — la entrega tiene
// que ocurrir DENTRO del gesto del usuario, sin un solo tick de espera.
// ============================================================================

import { Effect } from 'effect'

const clickAnchor = Effect.fn('DeliverGrant.clickAnchor')(function* (
  url: string,
  fileName?: string
) {
  const anchor = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const element = document.createElement('a')
      element.href = url
      element.rel = 'noopener noreferrer'
      // `download` solo aplica same-origin; el nombre lo fija el servidor con
      // Content-Disposition y aquí solo se sugiere para el diálogo del navegador.
      element.download = fileName ?? ''
      element.style.display = 'none'
      document.body.appendChild(element)
      return element
    }),
    (element) => Effect.sync(() => element.remove())
  )
  yield* Effect.sync(() => anchor.click())
  return true
})

export function downloadFromGrant(url: string, fileName?: string): boolean {
  if (typeof document === 'undefined') return false
  return Effect.runSync(Effect.scoped(clickAnchor(url, fileName)))
}

const openTab = Effect.fn('DeliverGrant.openTab')(function* (url: string) {
  const openedWindow = yield* Effect.sync(() => window.open('', '_blank'))
  if (!openedWindow) {
    yield* Effect.sync(() => window.location.assign(url))
    return 'same-tab' as const
  }
  yield* Effect.sync(() => {
    openedWindow.opener = null
    openedWindow.location.assign(url)
  })
  return 'tab' as const
})

export function openFromGrant(url: string): 'tab' | 'same-tab' | 'none' {
  if (typeof window === 'undefined') return 'none'
  return Effect.runSync(openTab(url))
}
