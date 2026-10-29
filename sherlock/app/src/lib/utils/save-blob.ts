// ============================================================================
// GUARDAR UN BLOB COMO DESCARGA
// ============================================================================
// Un solo camino para entregarle bytes al navegador: un `<a download>` sobre
// un object URL, same-origin, sin popup.
//
// LA REVOCACIÓN ESPERA UN TURNO. Chrome, Firefox y Safari pueden no haber
// consumido el Blob todavía si el object URL se revoca en el mismo tick que el
// `click()`, y entonces la descarga muere en silencio: sin excepción y sin
// aviso. Con un zip de cientos de MB la ventana se ensancha. El
// `acquireRelease` garantiza que el URL se libera pase lo que pase —también si
// el `click()` explota—, y el `setTimeout(..., 0)` la corre en el turno
// siguiente.
//
// Vivía duplicado: el export JSON de privacidad lo hacía bien y el zip de la
// sala lo hacía en el mismo tick. Ahora hay un solo sitio donde está la regla.
// ============================================================================

import { Effect } from 'effect'

/** Entrega `blob` al navegador con el nombre `fileName`. */
export const saveBlob = Effect.fn('Browser.saveBlob')(function* (blob: Blob, fileName: string) {
  const objectUrl = yield* Effect.acquireRelease(
    Effect.sync(() => URL.createObjectURL(blob)),
    (url) =>
      Effect.sync(() => {
        setTimeout(() => URL.revokeObjectURL(url), 0)
      })
  )

  yield* Effect.sync(() => {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = fileName
    anchor.rel = 'noopener'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  })
}, Effect.scoped)
