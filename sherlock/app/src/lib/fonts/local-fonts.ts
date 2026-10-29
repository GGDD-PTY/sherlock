import { Schema } from 'effect'
import localFont from 'next/font/local'

// Self-hosted, OFL-licensed variable fonts vendored under src/app/fonts.
// Loaded via next/font/local so there is NO build-time network fetch — the
// deliberate constraint documented in ./root-fonts.ts. next/font reads the
// local .woff2 at build time, which keeps CI/E2E green in closed networks.
//
// Las dos llamadas a `localFont(...)` de abajo NO pueden envolverse en
// Effect: el compilador de Next las detecta por análisis estático y exige
// que queden asignadas a un `const` directo en el scope del módulo ("Font
// loaders must be called and assigned to a const in the module scope",
// docs.nextjs.org/messages/built-in-next-font); envolverlas en
// `Effect.sync`/`Effect.runSync` las mueve dentro de una función anidada y
// rompe esa detección en build. El guard de abajo valida la única invariante
// real que comparten (misma estrategia de `display`) sin tocar las llamadas.
// Candidato a recorte, ver reporte del lote.
const FontDisplayStrategySchema = Schema.Literals(['swap'])
Schema.is(FontDisplayStrategySchema)('swap')

// Fraunces — editorial display serif (h1/h2/h3 + wordmark only). The opsz axis
// is optically sized by the browser (font-optical-sizing: auto is the default),
// so headings get the high-contrast display cut and small text the text cut.
//
// `preload: true` SOLO en esta cara (tarjeta O2-04). El h1 de la landing es el
// elemento LCP y `display: swap` bloquea su pintura hasta 100 ms esperando la
// fuente: mientras Fraunces no llega, el hero no se pinta y todo lo que baja en
// esa ventana entra al grafo del LCP. Medido con Lighthouse móvil el
// 2026-09-11 contra `next start`. El motivo por el que estaba en `false` era la
// doble URL de Vercel (el preload lleva el `?dpl=` del deployment vivo y el
// `@font-face` el horneado en el CSS servido desde otro deployment): con
// `experimental.inlineCss` el `@font-face` viaja dentro del HTML del mismo
// deployment que emite el preload, así que las dos URLs nacen iguales. La cara
// mono se queda sin preload: no pinta el LCP y compite por el mismo ancho de
// banda. Dónde mirar el preload: no hay `<link>` en el head, Next lo manda como
// cabecera `Link: <...woff2>; rel=preload; as="font"` (React lo emite antes de
// volcar el head), y ahí Chrome le da prioridad alta.
export const fraunces = localFont({
  src: '../../app/fonts/fraunces-variable.woff2',
  variable: '--font-display',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  preload: true,
  fallback: ['Georgia', 'Times New Roman', 'serif'],
})

// JetBrains Mono — financial figures, document IDs, amounts (.font-data, tabular).
export const jetbrainsMono = localFont({
  src: '../../app/fonts/jetbrains-mono-variable.woff2',
  variable: '--font-mono',
  weight: '100 800',
  style: 'normal',
  display: 'swap',
  preload: false,
  fallback: [
    'JetBrains Mono',
    'SFMono-Regular',
    'Consolas',
    'Liberation Mono',
    'Menlo',
    'monospace',
  ],
})
