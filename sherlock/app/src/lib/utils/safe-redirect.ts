// ============================================================================
// SAFE REDIRECT UTILITY
// ============================================================================
// Utilidad para prevenir vulnerabilidades de open-redirect.
// Valida que los redirects sean solo a rutas internas o dominios permitidos.
//
// LA REGLA SE ESCRIBE COMO SCHEMA, NO COMO CADENA DE `if`s. Cada condición de
// abajo es un `Schema.check` con nombre, porque acá una condición de más o de
// menos no rompe una pantalla: manda al cliente a otro dominio.
// ============================================================================

import { Schema } from 'effect'

import { getPublicAppHost } from '@/lib/site/brand'

// ===== DOMINIOS PERMITIDOS =====
// Lista de dominios a los que permitimos redirigir (incluye el dominio de la app)
const configuredHosts = (process.env.NEXT_PUBLIC_ALLOWED_REDIRECT_HOSTS || '')
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean)

const ALLOWED_DOMAINS = Array.from(
  new Set(['localhost', getPublicAppHost(), `www.${getPublicAppHost()}`, ...configuredHosts])
)

// ===== LAS CUATRO REGLAS =====

// El parser de URL de WHATWG BORRA tab (U+0009), LF (U+000A) y CR (U+000D) de
// cualquier posición del string antes de resolverlo. Un destino que los
// contenga no es el que este módulo lee: una ruta con un tab adentro le parece
// interna a un `startsWith('/')` y el navegador la resuelve a `https://evil.com/`.
// Se exige un string no vacío y sin controles C0 ni DEL.
const PrintableCandidateSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^\u0000-\u001F\u007F]+$/))
)

// Ruta interna: empieza con exactamente UNA barra. Una segunda barra la vuelve
// protocol-relative (`//evil.com`) y un backslash pegado termina en lo mismo,
// porque el parser normaliza `\` a `/` en los esquemas especiales.
const InternalPathSchema = Schema.String.pipe(Schema.check(Schema.isPattern(/^\/(?![/\\])/)))

// Escalada de directorio: saca al destino de la ruta que el llamador fijó.
const ParentTraversalSchema = Schema.String.pipe(Schema.check(Schema.isPattern(/\/\.\./)))

// Solo http y https. `javascript:`, `data:` y `file:` no son destinos.
const RedirectProtocolSchema = Schema.Literals(['http:', 'https:'])

const isPrintableCandidate = Schema.is(PrintableCandidateSchema)
const isInternalPath = Schema.is(InternalPathSchema)
const hasParentTraversal = Schema.is(ParentTraversalSchema)
const isRedirectProtocol = Schema.is(RedirectProtocolSchema)

function isAllowedHost(hostname: string): boolean {
  return ALLOWED_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
}

/**
 * Verifica si una URL es segura para redirigir.
 *
 * Una URL es segura si:
 * 1. Es una ruta relativa (empieza con /)
 * 2. Es un dominio en la lista de permitidos
 *
 * @param url - La URL a validar
 * @returns true si es segura, false si no
 */
export function isSafeRedirectUrl(url: string): boolean {
  // Verificar que no sea null/undefined/empty
  if (!url || typeof url !== 'string') {
    return false
  }

  // Limpiar espacios. Un string de solo espacios queda vacío y lo rechaza
  // `PrintableCandidateSchema`, que exige al menos un carácter.
  const cleanUrl = url.trim()
  if (!isPrintableCandidate(cleanUrl)) {
    return false
  }

  // Intentar decodificar para detectar ataques de ofuscación
  let decodedUrl = cleanUrl
  try {
    decodedUrl = decodeURIComponent(cleanUrl)
  } catch {
    // Si falla el decoding, seguimos con la original
  }

  // Un destino que esconde un control detrás de `%0A` se juzga por lo que dice
  // decodificado, igual que la escalada de directorio.
  if (!isPrintableCandidate(decodedUrl)) {
    return false
  }

  // Normalizar backslashes a slashes para la validación
  const normalizedUrl = cleanUrl.replace(/\\/g, '/')
  const normalizedDecodedUrl = decodedUrl.replace(/\\/g, '/')

  // Rutas relativas que empiezan con / son seguras, en las tres lecturas:
  // cruda, con los backslashes normalizados y decodificada.
  if (
    isInternalPath(cleanUrl) &&
    isInternalPath(normalizedUrl) &&
    isInternalPath(normalizedDecodedUrl) &&
    !hasParentTraversal(normalizedDecodedUrl)
  ) {
    return true
  }

  // Verificar URLs absolutas
  try {
    // new URL(url) lanzará error para URLs sin protocolo si no empiezan con /
    const parsed = new URL(cleanUrl)

    // El protocolo debe ser exactamente http: o https: (insensible a mayúsculas por new URL)
    if (!isRedirectProtocol(parsed.protocol)) {
      return false
    }

    // Si tiene credentials (user:pass@host), rechazar por seguridad (credential smuggling)
    if (parsed.username || parsed.password) {
      return false
    }

    // Verificar que el host esté en la lista de permitidos.
    // parsed.hostname ya viene en minúsculas
    return isAllowedHost(parsed.hostname)
  } catch {
    // Si no se puede parsear como URL, no es segura
    return false
  }
}

/**
 * Redirige de forma segura a una URL.
 * Si la URL no es segura, redirige al home por defecto.
 *
 * @param url - La URL destino
 * @param fallback - URL de fallback si la original no es segura (default: '/')
 */
export function safeRedirect(url: string, fallback: string = '/'): void {
  if (isSafeRedirectUrl(url)) {
    window.location.href = url
  } else {
    console.warn('[safeRedirect] Blocked unsafe redirect:', url)
    window.location.href = fallback
  }
}
