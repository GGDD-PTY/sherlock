import { Effect } from 'effect'

import { fraunces, jetbrainsMono } from './local-fonts'

// Display (Fraunces) + mono (JetBrains Mono) are self-hosted and loaded via
// next/font/local — NO build-time network fetch (unlike next/font/google),
// so CI/E2E stay green in closed-network environments. Sans stays on the
// system stack defined in globals.css (:root --font-sans).
// Set NEXT_DISABLE_REMOTE_FONTS=1 to force the Georgia/system fallback.
//
// Configuración estática evaluada en build, sin frontera de runtime: el
// envoltorio de abajo es el último recurso del brief de llenado (paso 6), no
// cambia el valor ni su tipo. Candidato a recorte, ver reporte del lote.
export const rootFontVariables = Effect.runSync(
  Effect.sync(() => `${fraunces.variable} ${jetbrainsMono.variable}`)
)
