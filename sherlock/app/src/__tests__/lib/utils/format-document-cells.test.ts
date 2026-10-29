// ============================================================================
// Celdas de la tabla del data room — fecha corta y tamaño de archivo
// ============================================================================
// `DocumentsList` es un componente cliente que igual se renderiza en servidor.
// Una fecha formateada con la zona horaria ambiente puede diferir entre
// servidor y navegador en el borde del día y romper la hidratación: por eso los
// formateadores fijan una zona. Desde [F] 2026-09-17 esa zona es la de Panamá y
// no UTC — sigue siendo fija, así que la hidratación sigue a salvo, y además el
// día que se lee es el día que el cliente vivió.
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'

import { formatDateTime, formatFileSize, formatShortDate, PANAMA_TIME_ZONE } from '@/lib/utils'

const TIMESTAMP = Date.UTC(2027, 0, 15, 2, 0, 0)

function panamaReference(locale: string) {
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: PANAMA_TIME_ZONE,
  }).format(new Date(TIMESTAMP))
}

describe('formatShortDate', () => {
  // [F] 2026-09-03 23:30: el sitio es solo en español. El parámetro `locale`
  // sobrevive porque los llamadores viven en rutas `[locale]`, pero ya no elige
  // formato: cualquier valor sale en es-PA.
  it('formatea en hora de Panamá, no en la zona horaria ambiente', () => {
    expect(formatShortDate(TIMESTAMP, 'es')).toBe(panamaReference('es-PA'))
    expect(formatShortDate(TIMESTAMP, 'en')).toBe(panamaReference('es-PA'))
  })

  it('devuelve el fallback para valores ausentes o inválidos', () => {
    expect(formatShortDate(null)).toBe('—')
    expect(formatShortDate(undefined)).toBe('—')
    expect(formatShortDate('')).toBe('—')
    expect(formatShortDate('not-a-date')).toBe('—')
  })

  it('acepta un fallback explícito', () => {
    expect(formatShortDate(null, 'es', 'N/D')).toBe('N/D')
  })
})

describe('formatDateTime', () => {
  // La pantalla de actividad del data room es superficie forense: dos accesos
  // del mismo día tienen que poder distinguirse. Con fecha sola son idénticos.
  function panamaDateTimeReference(locale: string) {
    return new Intl.DateTimeFormat(locale, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZone: PANAMA_TIME_ZONE,
    }).format(new Date(TIMESTAMP))
  }

  it('formatea en hora de Panamá e incluye hora, minuto y segundo', () => {
    expect(formatDateTime(TIMESTAMP, 'es')).toBe(panamaDateTimeReference('es-PA'))
    expect(formatDateTime(TIMESTAMP, 'en')).toBe(panamaDateTimeReference('es-PA'))
    expect(formatDateTime(TIMESTAMP, 'es')).toMatch(/\d{2}:\d{2}:\d{2}/)
  })

  it('distingue dos momentos del mismo día', () => {
    const earlier = Date.UTC(2027, 0, 15, 1, 0, 0)
    expect(formatDateTime(TIMESTAMP, 'es')).not.toBe(formatDateTime(earlier, 'es'))
  })

  it('devuelve el fallback para valores ausentes o inválidos', () => {
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime(undefined)).toBe('—')
    expect(formatDateTime('')).toBe('—')
    expect(formatDateTime('not-a-date')).toBe('—')
    expect(formatDateTime(Number.NaN)).toBe('—')
  })

  it('acepta un fallback explícito', () => {
    expect(formatDateTime(null, 'es', 'Fecha no disponible')).toBe('Fecha no disponible')
  })
})

// ============================================================================
// El defecto que esto habría atrapado
// ============================================================================
// Con `timeZone: 'UTC'`, un evento de las 20:30 del 16 de septiembre en Panamá
// se imprimía «17 sept 2026, 01:30:00»: el cliente leía el día siguiente. Los
// dos formateadores tienen que decir el 16.
// ============================================================================

const PANAMA_EVENING = Date.parse('2026-09-17T01:30:00.000Z')
const OTHER_ZONES = ['UTC', 'America/Panama', 'Asia/Tokyo'] as const

describe('la noche panameña no salta al día siguiente', () => {
  const originalTz = process.env.TZ

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  })

  it('imprime el 16 de septiembre, no el 17', () => {
    expect(formatDateTime(PANAMA_EVENING, 'es')).toBe('16 sept 2026, 20:30:00')
    expect(formatShortDate(PANAMA_EVENING, 'es')).toBe('16 sept 2026')
  })

  // La zona del proceso es lo que cambia entre el servidor de Vercel (UTC) y el
  // navegador de quien mira. Si la cadena dependiera de ella, servidor y cliente
  // imprimirían distinto y React rompería la hidratación.
  //
  // Los formateadores guardan su `Intl.DateTimeFormat` en un caché de módulo, así
  // que cada zona carga una instancia nueva de `utils`: con el caché ya lleno, un
  // formateador creado en otra zona respondería por todas y el test pasaría
  // aunque faltara `timeZone`.
  it('imprime la misma cadena sin importar la zona del proceso', async () => {
    const rendered = []
    for (const zone of OTHER_ZONES) {
      process.env.TZ = zone
      vi.resetModules()
      const fresh = await import('@/lib/utils')
      rendered.push({
        zone,
        dateTime: fresh.formatDateTime(PANAMA_EVENING, 'es'),
        shortDate: fresh.formatShortDate(PANAMA_EVENING, 'es'),
        ambient: new Date(PANAMA_EVENING).getHours(),
      })
    }

    expect(new Set(rendered.map((row) => row.dateTime)).size).toBe(1)
    expect(new Set(rendered.map((row) => row.shortDate)).size).toBe(1)
    expect(rendered[0]?.dateTime).toBe('16 sept 2026, 20:30:00')

    // Control: la zona del proceso sí cambió. Sin esto, el test pasaría también
    // si `process.env.TZ` no hiciera nada y no probaría nada.
    expect(new Set(rendered.map((row) => row.ambient)).size).toBeGreaterThan(1)
  })
})

describe('formatFileSize', () => {
  it('distingue un archivo de 0 bytes de un tamaño ausente', () => {
    expect(formatFileSize(0, '—')).toBe('0 B')
    expect(formatFileSize(null, '—')).toBe('—')
    expect(formatFileSize(undefined, '—')).toBe('—')
  })

  it('rechaza tamaños imposibles en vez de imprimirlos', () => {
    expect(formatFileSize(-5, '—')).toBe('—')
    expect(formatFileSize(Number.NaN, '—')).toBe('—')
  })

  it('sigue formateando KB y MB como antes', () => {
    expect(formatFileSize(2_400_000)).toBe('2.3 MB')
    expect(formatFileSize(2_048)).toBe('2.0 KB')
  })
})
