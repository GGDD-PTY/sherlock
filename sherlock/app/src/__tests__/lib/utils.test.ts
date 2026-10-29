// ============================================================================
// TESTS: src/lib/utils.ts
// ============================================================================
// Tests unitarios para las funciones de utilidad principales.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cn,
  formatCurrency,
  formatFileSize,
  formatShortRelativeTime,
  getInitials,
} from '@/lib/utils'

// ============================================================================
// cn() - Tailwind class merge
// ============================================================================
describe('cn()', () => {
  it('combina clases simples', () => {
    expect(cn('foo', 'bar')).toBe('foo bar')
  })

  it('maneja arrays de clases', () => {
    expect(cn(['foo', 'bar'])).toBe('foo bar')
  })

  it('filtra valores falsy', () => {
    expect(cn('foo', null, undefined, false, 'bar')).toBe('foo bar')
  })

  it('maneja clases condicionales', () => {
    const isActive = true
    const isDisabled = false
    expect(cn('base', isActive && 'active', isDisabled && 'disabled')).toBe('base active')
  })

  it('resuelve conflictos de Tailwind', () => {
    // twMerge resuelve conflictos donde la última clase gana
    expect(cn('bg-red-500', 'bg-blue-500')).toBe('bg-blue-500')
    expect(cn('p-4', 'p-2')).toBe('p-2')
    expect(cn('text-sm', 'text-lg')).toBe('text-lg')
  })

  it('mantiene clases no conflictivas', () => {
    expect(cn('bg-red-500', 'text-white', 'p-4')).toBe('bg-red-500 text-white p-4')
  })

  it('maneja objetos de clases', () => {
    expect(cn({ foo: true, bar: false, baz: true })).toBe('foo baz')
  })

  it('retorna string vacío cuando no hay clases', () => {
    expect(cn()).toBe('')
    expect(cn(null, undefined, false)).toBe('')
  })
})

// ============================================================================
// formatCurrency() - Formato de moneda
// ============================================================================
describe('formatCurrency()', () => {
  it('formatea USD correctamente (en-US)', () => {
    const result = formatCurrency(5000000, 'USD', 'en-US')
    // Assert exactly $5,000,000
    expect(result).toBe('$5,000,000')
  })

  it('formatea MXN correctamente (es-MX)', () => {
    const result = formatCurrency(1000000, 'MXN', 'es-MX')
    // es-MX puede usar $ seguido del número o MXN seguido del número dependiendo del entorno
    expect(result).toMatch(/^(\$|MXN)[  ]?1,000,000$/)
  })

  it('formatea COP correctamente (es-CO)', () => {
    const result = formatCurrency(50000000, 'COP', 'es-CO')
    // es-CO puede usar $ o COP
    expect(result).toMatch(/^(\$|COP)[  ]?50\.000\.000$/)
  })

  it('usa USD como default y es-MX locale', () => {
    const result = formatCurrency(1000)
    // es-MX con USD puede retornar $ 1,000 o USD 1,000
    expect(result).toMatch(/^(\$|USD)[  ]?1,000$/)
  })

  it('maneja números negativos', () => {
    const result = formatCurrency(-5000, 'USD', 'en-US')
    expect(result).toBe('-$5,000')
  })

  it('maneja cero', () => {
    const result = formatCurrency(0, 'USD', 'en-US')
    expect(result).toBe('$0')
  })

  it('no muestra decimales y redondea correctamente', () => {
    const result = formatCurrency(1234.56, 'USD', 'en-US')
    // maximumFractionDigits: 0 significa sin decimales, redondea 1234.56 a 1235
    expect(result).toBe('$1,235')
    expect(result).not.toContain('.')
  })

  it('acepta locale personalizado para diferentes formatos de separadores', () => {
    // Alemania usa punto para miles y coma para decimales
    const result = formatCurrency(1000, 'EUR', 'de-DE')
    // "1.000 €" o similar
    expect(result).toMatch(/^1\.000[  ]?€$/)
  })
})

// ============================================================================
// formatFileSize() - Formato de tamaño de archivo
// ============================================================================
describe('formatFileSize()', () => {
  // Un archivo de 0 bytes y un tamaño ausente son señales distintas en la tabla
  // del data room: el guard `!bytes` las confundía y ahora se separan.
  it('returns the default fallback for missing byte values', () => {
    expect(formatFileSize(undefined)).toBe('N/A')
    expect(formatFileSize(null)).toBe('N/A')
    expect(formatFileSize(0)).toBe('0 B')
  })

  it('allows callers to customize the fallback label', () => {
    expect(formatFileSize(undefined, '—')).toBe('—')
    expect(formatFileSize(0, '—')).toBe('0 B')
  })

  it('formats byte, kilobyte, and megabyte values', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(2_621_440)).toBe('2.5 MB')
  })
})

// ============================================================================
// formatShortRelativeTime() - Formato relativo compacto
// ============================================================================
describe('formatShortRelativeTime()', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-11T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('acepta fechas como string, number y Date', () => {
    const thirtyMinutesAgo = new Date('2026-05-11T11:30:00.000Z')

    expect(formatShortRelativeTime(thirtyMinutesAgo.toISOString())).toBe('hace 30m')
    expect(formatShortRelativeTime(thirtyMinutesAgo.getTime())).toBe('hace 30m')
    expect(formatShortRelativeTime(thirtyMinutesAgo)).toBe('hace 30m')
  })

  it('usa minutos, horas y días para fechas recientes', () => {
    expect(formatShortRelativeTime('2026-05-11T11:59:30.000Z')).toBe('ahora')
    expect(formatShortRelativeTime('2026-05-11T07:00:00.000Z')).toBe('hace 5h')
    expect(formatShortRelativeTime('2026-05-08T12:00:00.000Z')).toBe('hace 3d')
  })

  it('usa fecha corta para valores de una semana o más', () => {
    expect(formatShortRelativeTime('2026-05-01T12:00:00.000Z')).toMatch(/may/i)
  })
})

// ============================================================================
// getInitials() - Iniciales para avatares
// ============================================================================
describe('getInitials()', () => {
  it('extrae hasta dos iniciales desde nombres completos', () => {
    expect(getInitials('Equipo Sherlock')).toBe('ES')
    expect(getInitials('Maintainer')).toBe('M')
  })

  it('ignora espacios repetidos y usa fallback para nombres vacios', () => {
    expect(getInitials('  Private   Capital  ')).toBe('PC')
    expect(getInitials('   ')).toBe('??')
    expect(getInitials('')).toBe('??')
  })
})
