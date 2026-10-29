// ============================================================================
// CONFIGURACIÓN DE INTERNACIONALIZACIÓN (i18n)
// ============================================================================
// Define el único idioma soportado y el idioma por defecto
// Usado por next-intl y el middleware de routing
// ============================================================================

export const locales = ['es'] as const
export const defaultLocale = 'es' as const

export type Locale = (typeof locales)[number]
