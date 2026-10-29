import { describe, expect, it } from 'vitest'

import es from '@/messages/es.json'

// ============================================================================
// CANDADO: EL AVISO DE LA SALA DE INVITADOS SOLO PROMETE LO QUE EL SISTEMA HACE
// ============================================================================
// El visor de invitados baja los bytes del PDF al navegador (`useDocumentBytes`
// -> `fetch` -> `arrayBuffer`), así que DevTools, imprimir o guardar sacan el
// archivo. Prometer que la descarga es imposible es falso y el invitado ajusta
// su conducta a esa promesa. Lo que el código sí garantiza y este candado exige
// nombrar: la versión queda fijada en la invitación (`companyRoom.documents`),
// cada apertura escribe `GUEST_DOCUMENT_VIEW_AUTHORIZED` en `activityLogs`, y
// revocar la invitación mata las sesiones en la misma transacción.
// ============================================================================

const FALSE_DOWNLOAD_CLAIMS = [
  /no permite descargas?/i,
  /no puedes descargar/i,
  /sin descargas?/i,
  /does not allow downloads?/i,
  /cannot download/i,
  /downloads? (are|is) (not |dis)/i,
]

describe('company guest room read-only notice', () => {
  const notice = es.vdrGuest.room.readOnly

  it('does not promise that downloads are impossible', () => {
    for (const claim of FALSE_DOWNLOAD_CLAIMS) {
      expect(notice).not.toMatch(claim)
    }
  })

  it('fails if the room notice promises that you cannot download', () => {
    expect(notice).not.toMatch(/no se puede descargar/i)
  })

  it('names the guarantees the backend actually enforces', () => {
    expect(notice).toMatch(/registra/i)
    expect(notice).toMatch(/revoca/i)
  })
})
