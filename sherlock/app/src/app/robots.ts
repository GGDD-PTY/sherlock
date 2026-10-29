import type { MetadataRoute } from 'next'
import { Schema } from 'effect'

import { getPublicAppUrl } from '@/lib/site/brand'

const APP_URL = getPublicAppUrl()

// Los ocho globos estaban escritos a mano, uno por uno. Lo que de verdad hay
// son dos vocabularios —las superficies con sesión y las puertas de
// autenticación— y una forma de globo. Se nombran una vez y el glob se escribe
// una sola vez.
//
// DUPLICADO CONOCIDO: las mismas dos listas viven en `src/proxy.ts`
// (`PROTECTED_PAGE_SEGMENTS` y `PUBLIC_AUTH_SEGMENTS`), que es quien de verdad
// cierra la puerta; acá solo se le pide al crawler que no las rastree. Hoy
// coinciden y nada las ata: el orden es el mismo que allá a propósito, para que
// una diferencia se vea como diferencia de texto. Consolidarlas pide un módulo
// que las dos rutas puedan importar (`src/proxy.ts` no se puede importar desde
// una ruta de metadata: arrastra `next/server` y AuthKit), y ese módulo vive
// fuera de este lote.
const ProtectedSegmentSchema = Schema.Literals([
  'admin',
  'my-company',
  'notifications',
  'onboarding',
  'settings',
])
const AuthSegmentSchema = Schema.Literals(['sign-in', 'sign-up', 'dev-login'])

const localizedGlob = (segment: string) => `/*/${segment}`

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/api/',
        ...ProtectedSegmentSchema.literals.map(localizedGlob),
        ...AuthSegmentSchema.literals.map(localizedGlob),
      ],
    },
    sitemap: `${APP_URL}/sitemap.xml`,
  }
}
