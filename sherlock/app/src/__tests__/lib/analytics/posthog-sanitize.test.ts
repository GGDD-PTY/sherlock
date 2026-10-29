// ============================================================================
// SANITIZADOR DE POSTHOG — LO QUE SALE DEL NAVEGADOR DEL CLIENTE
// ============================================================================
// Este módulo es el único filtro entre lo que el SDK recoge de la página y lo
// que viaja a PostHog. Hasta ahora no tenía una sola prueba: 500 líneas de
// redacción cuya única evidencia era leerlas.
//
// Los casos de abajo no prueban la implementación, prueban la promesa del
// encabezado del módulo: sin query string, sin ids de negocio, sin texto de la
// interfaz, sin cuerpos ni headers, sin perfil personal. Y prueban la otra
// mitad, la que se rompe callada: un evento que NO está en la lista no se manda.
// ============================================================================

import type { CaptureResult, CapturedNetworkRequest } from 'posthog-js'
import { describe, expect, it } from 'vitest'

import {
  sanitizeAnalyticsEvent,
  sanitizeAnalyticsPathname,
  sanitizeReplayNetworkRequest,
} from '@/lib/analytics/posthog-sanitize'

const ORIGIN = window.location.origin

function capture(event: string, properties: Record<string, unknown> = {}): CaptureResult {
  return {
    event,
    properties: {
      $current_url: `${ORIGIN}/es/vdr`,
      ...properties,
    },
    timestamp: new Date('2026-09-08T12:00:00.000Z'),
  } as unknown as CaptureResult
}

/** El evento sanitizado, o el fallo del caso si el sanitizador lo descartó. */
function sanitized(event: CaptureResult): CaptureResult {
  const result = sanitizeAnalyticsEvent(event)
  expect(result, `el sanitizador descartó ${event.event}`).not.toBeNull()
  return result as CaptureResult
}

describe('sanitizeAnalyticsPathname', () => {
  it('tacha el segmento que sigue a un padre dinámico', () => {
    expect(sanitizeAnalyticsPathname('/es/rooms/sampleenergy/documents')).toBe('/es/rooms/:id/documents')
    expect(sanitizeAnalyticsPathname('/companies/acme')).toBe('/companies/:id')
  })

  it('tacha lo que parece identificador aunque su padre sea estático', () => {
    expect(sanitizeAnalyticsPathname('/es/vdr/jd7f2k9a1b3c4d5e6f7g8h9j0k')).toBe('/es/vdr/:id')
    expect(sanitizeAnalyticsPathname('/es/vdr/1234567')).toBe('/es/vdr/:id')
    expect(sanitizeAnalyticsPathname('/es/vdr/ana@example.com')).toBe('/es/vdr/:id')
  })

  it('deja intacta una ruta que no nombra a nadie', () => {
    expect(sanitizeAnalyticsPathname('/es/vdr/documentos')).toBe('/es/vdr/documentos')
  })
})

describe('sanitizeAnalyticsEvent — qué eventos pasan', () => {
  it('descarta un evento que no está en ninguna lista', () => {
    expect(sanitizeAnalyticsEvent(capture('$identify'))).toBeNull()
    expect(sanitizeAnalyticsEvent(capture('$groupidentify'))).toBeNull()
    expect(sanitizeAnalyticsEvent(capture('evento_inventado'))).toBeNull()
  })

  it('descarta un evento nulo o sin URL utilizable', () => {
    expect(sanitizeAnalyticsEvent(null)).toBeNull()
    expect(
      sanitizeAnalyticsEvent(capture('$pageview', { $current_url: 'javascript:void(0)' }))
    ).toBeNull()
  })

  it('deja pasar los tres automáticos y los manuales del contrato', () => {
    expect(sanitizeAnalyticsEvent(capture('$pageview'))).not.toBeNull()
    expect(sanitizeAnalyticsEvent(capture('$pageleave'))).not.toBeNull()
    expect(sanitizeAnalyticsEvent(capture('$web_vitals'))).not.toBeNull()
    expect(sanitizeAnalyticsEvent(capture('intake_started'))).not.toBeNull()
  })
})

describe('sanitizeAnalyticsEvent — qué sale de la propiedad', () => {
  it('borra la query string y tacha los ids de la URL', () => {
    const event = sanitized(
      capture('$pageview', {
        $current_url: `${ORIGIN}/es/rooms/sampleenergy/documents?token=secreto&email=ana@example.com`,
      })
    )

    expect(event.properties.$current_url).toBe(`${ORIGIN}/es/rooms/:id/documents`)
    expect(event.properties.$pathname).toBe('/es/rooms/:id/documents')
    expect(JSON.stringify(event.properties)).not.toContain('secreto')
    expect(JSON.stringify(event.properties)).not.toContain('ana@example.com')
  })

  it('no deja pasar una propiedad que no esté en la lista del evento', () => {
    const event = sanitized(
      capture('$pageview', {
        userEmail: 'ana@example.com',
        $ip: '190.34.12.7',
        companyId: 'company_01ABCDEF',
      })
    )

    expect(event.properties.userEmail).toBeUndefined()
    expect(event.properties.$ip).toBeUndefined()
    expect(event.properties.companyId).toBeUndefined()
  })

  it('apaga el perfil personal y borra $set, $set_once y $unset', () => {
    const raw = capture('$pageview')
    Object.assign(raw, {
      $set: { email: 'ana@example.com' },
      $set_once: { firstSeen: 'hoy' },
      $unset: ['algo'],
    })

    const event = sanitized(raw)

    expect(event.properties.$process_person_profile).toBe(false)
    expect(event.$set).toBeUndefined()
    expect(event.$set_once).toBeUndefined()
    expect(event.$unset).toBeUndefined()
  })

  it('un referrer externo sale como origen, sin ruta', () => {
    const event = sanitized(
      capture('$pageview', { $referrer: 'https://buscador.example.com/q?email=ana@example.com' })
    )

    expect(event.properties.$referrer).toBe('https://buscador.example.com')
    expect(event.properties.$referring_domain).toBe('buscador.example.com')
  })

  it('descarta el evento entero si el referrer presente no se puede leer', () => {
    expect(
      sanitizeAnalyticsEvent(capture('$pageview', { $referrer: 'chrome://historial' }))
    ).toBeNull()
  })

  it('un evento manual conserva solo las propiedades de su contrato', () => {
    const event = sanitized(
      capture('files_selected', {
        locale: 'es',
        mode: 'TEMPORARY',
        fileCount: 3,
        fileNames: ['EEFF 2025 SAMPLE_ENERGY.pdf'],
      })
    )

    expect(event.properties.locale).toBe('es')
    expect(event.properties.mode).toBe('TEMPORARY')
    expect(event.properties.fileCount).toBe(3)
    expect(event.properties.fileNames).toBeUndefined()
  })
})

describe('sanitizeAnalyticsEvent — $exception', () => {
  it('tacha el mensaje y deja el esqueleto del stack sin query string', () => {
    const event = sanitized(
      capture('$exception', {
        digest: 'a3f9c1d2',
        locale: 'es',
        route: `${ORIGIN}/es/rooms/sampleenergy/documents`,
        $exception_message: 'fallo al leer ana@example.com',
        $exception_list: [
          {
            type: 'TypeError',
            value: 'fallo al leer ana@example.com',
            stacktrace: {
              type: 'raw',
              frames: [
                {
                  filename: `${ORIGIN}/_next/static/chunk.js?token=secreto`,
                  function: 'readDocument',
                  lineno: 12,
                  colno: 4,
                  in_app: true,
                  vars: { email: 'ana@example.com' },
                },
              ],
            },
          },
        ],
      })
    )

    expect(event.properties.$exception_message).toBe('[redacted]')
    expect(event.properties.digest).toBe('a3f9c1d2')
    expect(event.properties.route).toBe('/es/rooms/:id/documents')

    const serialized = JSON.stringify(event.properties.$exception_list)
    expect(serialized).toContain('TypeError')
    expect(serialized).toContain('readDocument')
    expect(serialized).toContain('[redacted]')
    expect(serialized).not.toContain('secreto')
    expect(serialized).not.toContain('ana@example.com')
    expect(serialized).not.toContain('vars')
  })

  it('un tipo de excepción con texto libre se colapsa en Error', () => {
    const event = sanitized(
      capture('$exception', {
        $exception_list: [{ type: 'fallo leyendo ana@example.com', value: 'x' }],
      })
    )

    expect(JSON.stringify(event.properties.$exception_list)).toContain('"type":"Error"')
    expect(JSON.stringify(event.properties.$exception_list)).not.toContain('ana@example.com')
  })
})

describe('sanitizeAnalyticsEvent — interacción y heatmap', () => {
  it('la cadena de elementos queda en etiqueta y posición, sin texto ni atributos', () => {
    const event = sanitized(
      capture('$autocapture', {
        $event_type: 'click',
        $elements_chain:
          'button:nth-child="2"nth-of-type="1"text="Descargar EEFF de SAMPLE_ENERGY"attr__href="/es/vdr/sampleenergy";div:nth-child="1"',
      })
    )

    expect(event.properties.$event_type).toBe('click')
    expect(event.properties.$elements_chain).toBe(
      'button:nth-child="2"nth-of-type="1";div:nth-child="1"'
    )
    expect(String(event.properties.$elements_chain)).not.toContain('SAMPLE_ENERGY')
    expect(String(event.properties.$elements_chain)).not.toContain('attr__href')
  })

  it('el heatmap sanea sus URLs y descarta los puntos que no lo son', () => {
    const event = sanitized(
      capture('$$heatmap', {
        $heatmap_data: {
          [`${ORIGIN}/es/rooms/sampleenergy?token=secreto`]: [
            { x: 10, y: 20, type: 'click', target_fixed: true, selector: '#descargar-eeff' },
            { x: -1, y: 20, type: 'click' },
            { x: 10, y: 20, type: 'teclado' },
            'no soy un punto',
          ],
        },
      })
    )

    expect(event.properties.$heatmap_data).toEqual({
      [`${ORIGIN}/es/rooms/:id`]: [{ x: 10, y: 20, type: 'click', target_fixed: true }],
    })
  })

  it('descarta el evento de heatmap cuando no queda un punto válido', () => {
    expect(
      sanitizeAnalyticsEvent(
        capture('$$heatmap', { $heatmap_data: { [`${ORIGIN}/es`]: [{ x: 'diez', y: 20 }] } })
      )
    ).toBeNull()
    expect(sanitizeAnalyticsEvent(capture('$$heatmap', { $heatmap_data: [] }))).toBeNull()
  })

  it('el snapshot sin bytes ni datos no se manda', () => {
    expect(sanitizeAnalyticsEvent(capture('$snapshot', { $snapshot_bytes: 12 }))).toBeNull()
    expect(
      sanitizeAnalyticsEvent(capture('$snapshot', { $snapshot_bytes: 12, $snapshot_data: [] }))
    ).not.toBeNull()
  })
})

describe('sanitizeReplayNetworkRequest', () => {
  it('deja el nombre sin query y borra headers y cuerpos', () => {
    const request = {
      name: `${ORIGIN}/api/vdr/documents/doc_01ABCDEF9GHJKMNP?token=secreto`,
      requestHeaders: { authorization: 'Bearer secreto' },
      responseHeaders: { 'set-cookie': 'session=secreto' },
      requestBody: '{"email":"ana@example.com"}',
      responseBody: '{"documento":"EEFF"}',
    } as unknown as CapturedNetworkRequest

    const sanitizedRequest = sanitizeReplayNetworkRequest(request)

    expect(sanitizedRequest?.name).toBe(`${ORIGIN}/api/vdr/documents/:id`)
    expect(sanitizedRequest?.requestHeaders).toBeUndefined()
    expect(sanitizedRequest?.responseHeaders).toBeUndefined()
    expect(sanitizedRequest?.requestBody).toBeUndefined()
    expect(sanitizedRequest?.responseBody).toBeUndefined()
    expect(JSON.stringify(sanitizedRequest)).not.toContain('secreto')
  })

  it('descarta la petición cuyo nombre no es una URL http', () => {
    expect(
      sanitizeReplayNetworkRequest({
        name: 'data:text/plain;base64,c2VjcmV0bw==',
      } as CapturedNetworkRequest)
    ).toBeNull()
  })
})
