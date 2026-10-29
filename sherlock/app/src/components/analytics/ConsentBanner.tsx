'use client'

import { Schema } from 'effect'

// El producto se fue a analítica sin cookies en `0e136e486`. El banner no
// pinta nada; el schema nombra ese estado para que un valor que no sea
// `retired` no se cuele como "hay banner" si alguien reabre este archivo.
const ConsentBannerModeSchema = Schema.Literals(['retired'])
const CONSENT_BANNER_MODE = Schema.decodeSync(ConsentBannerModeSchema)('retired')

export function ConsentBanner() {
  switch (CONSENT_BANNER_MODE) {
    case 'retired':
      return null
    default:
      return null
  }
}
