import { Schema } from 'effect'
import { locales } from '@/i18n/config'

// El segmento `[locale]` llega por la URL. Un solo catálogo —el del router—
// responde en el layout, las páginas públicas y el parseo de `returnTo`.
const SupportedLocaleSchema = Schema.Literals(locales)
export const isSupportedLocale = Schema.is(SupportedLocaleSchema)
