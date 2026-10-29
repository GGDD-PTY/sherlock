import { clsx, type ClassValue } from 'clsx'
import { Schema } from 'effect'
import { twMerge } from 'tailwind-merge'

// ===== LAS DOS PREGUNTAS QUE ESTE MÓDULO REPITE =====
// «¿esto es un tamaño?» y «¿esto es una fecha?». Las dos se hacían con una
// conjunción distinta en cada función; escritas una vez, las tres superficies
// de fecha del data room no pueden divergir en qué consideran inválido.
const ByteCountSchema = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const isByteCount = Schema.is(ByteCountSchema)

// `Schema.Date` acepta una instancia de Date cuyo timestamp no sea NaN: es
// exactamente lo que preguntaba `Number.isNaN(date.getTime())`.
const isValidDate = Schema.is(Schema.Date)

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
// Funciones de utilidad compartidas en toda la aplicación
// ============================================================================

// ===== TAILWIND CLASS MERGE =====
// Combina clases de Tailwind de forma inteligente, resolviendo conflictos
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ============================================================================
// FORMATTING UTILITIES
// ============================================================================

// ===== FORMATTER CACHE =====
// Cache de Intl.NumberFormat para evitar recreación en cada llamada
// ES: Crear un formatter es ~10x más lento que reutilizar uno cacheado.
// EN: Creating a formatter is ~10x slower than reusing a cached one.
const currencyFormatterCache = new Map<string, Intl.NumberFormat>()

function getCurrencyFormatter(locale: string, currency: string): Intl.NumberFormat {
  const cacheKey = `${locale}:${currency}`
  let formatter = currencyFormatterCache.get(cacheKey)

  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })
    currencyFormatterCache.set(cacheKey, formatter)
  }

  return formatter
}

// ===== FORMAT CURRENCY (BASIC) =====
// Formatea un número como moneda
// Por defecto usa locale es-PA
// Acepta locale opcional para casos especiales
// Uso: formatCurrency(5000000, 'USD') → "USD 5,000,000.00"
export function formatCurrency(amount: number, currency: string = 'USD', locale?: string): string {
  const targetLocale = locale || 'es-PA'
  return getCurrencyFormatter(targetLocale, currency).format(amount)
}

// ===== FORMAT FILE SIZE =====
// Formatea tamaños opcionales para metadatos compactos de documentos.
export function formatFileSize(bytes: number | null | undefined, fallback: string = 'N/A'): string {
  // `!bytes` se tragaba el 0: un archivo vacío se veía igual que un tamaño
  // ausente, y ambos son señales distintas en la tabla del data room.
  if (!isByteCount(bytes)) return fallback
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ===== ZONA HORARIA DEL PRODUCTO =====
// Las fechas que el cliente lee van en hora de Panamá ([F] 2026-09-17). La zona
// es FIJA, no la del visitante: el componente se renderiza en servidor (Vercel,
// UTC) y en el navegador, y sólo una zona idéntica en ambos lados imprime la
// misma cadena y evita el mismatch de hidratación. Panamá no tiene horario de
// verano, así que el desfase es siempre UTC-5.
export const PANAMA_TIME_ZONE = 'America/Panama'

// ===== FORMAT SHORT DATE =====
// Fecha corta para tablas densas (data room), en hora de Panamá. Fijar UTC
// mandaba al día siguiente todo lo ocurrido después de las 19:00 locales.
const shortDateFormatterCache = new Map<string, Intl.DateTimeFormat>()

function getShortDateFormatter(_locale: string): Intl.DateTimeFormat {
  const resolvedLocale = 'es-PA'
  let formatter = shortDateFormatterCache.get(resolvedLocale)

  if (!formatter) {
    formatter = new Intl.DateTimeFormat(resolvedLocale, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: PANAMA_TIME_ZONE,
    })
    shortDateFormatterCache.set(resolvedLocale, formatter)
  }

  return formatter
}

export function formatShortDate(
  value: number | string | Date | null | undefined,
  locale: string = 'es',
  fallback: string = '—'
): string {
  if (value === null || value === undefined || value === '') return fallback

  const date = new Date(value)
  if (!isValidDate(date)) return fallback

  return getShortDateFormatter(locale).format(date)
}

// ===== FORMAT DATE TIME =====
// Fecha CON hora para superficies forenses (actividad del data room): dos
// accesos del mismo día tienen que poder distinguirse, y una tabla de evidencia
// que los pinta idénticos deja de servir como evidencia. Misma zona fija de
// Panamá que `formatShortDate`, por la misma razón de hidratación, y
// `hourCycle: 'h23'` para que una tabla financiera densa nunca mezcle
// "a. m./p. m.".
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>()

function getDateTimeFormatter(_locale: string): Intl.DateTimeFormat {
  const resolvedLocale = 'es-PA'
  let formatter = dateTimeFormatterCache.get(resolvedLocale)

  if (!formatter) {
    formatter = new Intl.DateTimeFormat(resolvedLocale, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZone: PANAMA_TIME_ZONE,
    })
    dateTimeFormatterCache.set(resolvedLocale, formatter)
  }

  return formatter
}

export function formatDateTime(
  value: number | string | Date | null | undefined,
  locale: string = 'es',
  fallback: string = '—'
): string {
  if (value === null || value === undefined || value === '') return fallback

  const date = new Date(value)
  if (!isValidDate(date)) return fallback

  return getDateTimeFormatter(locale).format(date)
}

// ===== FORMAT SHORT RELATIVE TIME =====
// Formatea fechas recientes para superficies compactas como notificaciones y mensajes.
export function formatShortRelativeTime(
  value: string | number | Date,
  _locale: string = 'es'
): string {
  const date = new Date(value)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'ahora'
  if (diffMins < 60) return `hace ${diffMins}m`
  if (diffHours < 24) return `hace ${diffHours}h`
  if (diffDays < 7) return `hace ${diffDays}d`
  // Mismo criterio que los formateadores de arriba: la fecha de respaldo va en
  // hora de Panamá, no en la del navegador.
  return new Intl.DateTimeFormat('es-PA', {
    month: 'short',
    day: 'numeric',
    timeZone: PANAMA_TIME_ZONE,
  }).format(date)
}

// ===== GET INITIALS =====
// Extrae las iniciales de un nombre (máximo 2 caracteres)
// Maneja nombres vacíos, whitespace, y caracteres undefined de forma segura
// Uso: getInitials("John Doe") → "JD"
// Uso: getInitials("  ") → "??"
// Uso: getInitials("") → "??"
export function getInitials(name: string): string {
  // Guard contra entrada vacía o solo whitespace
  if (!name || !name.trim()) {
    return '??'
  }

  // Dividir en palabras, filtrar vacías, tomar primera letra de cada palabra
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
  const initials = words
    .map((word) => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) // Máximo 2 caracteres
  // Nota: El filter((char) => char) era redundante porque words ya estaba filtrado

  return initials || '??' // Fallback si no hay caracteres válidos
}
