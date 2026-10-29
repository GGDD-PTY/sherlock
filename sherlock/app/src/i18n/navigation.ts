// ============================================================================
// i18n NAVIGATION
// ============================================================================
// Proporciona Link, useRouter, usePathname y redirect que automáticamente
// manejan el prefijo de locale. Usar estos en lugar de los de next/navigation.
//
// IMPORTANTE: Todos los componentes que usan Link o useRouter deben importar
// desde este archivo para que el routing i18n funcione correctamente.
// ============================================================================

import { createNavigation } from 'next-intl/navigation'
import { locales, defaultLocale } from './routing'

// ===== CONFIGURACIÓN DE NAVEGACIÓN =====
// Crea versiones localizadas de Link, useRouter, usePathname, redirect
export const { Link, redirect, usePathname, useRouter } = createNavigation({
  locales,
  defaultLocale,
  // "always" = siempre mostrar el prefijo de locale en la URL (/es/)
  // "as-needed" = no mostrar el locale por defecto (/ en vez de /es/)
  localePrefix: 'always',
})
