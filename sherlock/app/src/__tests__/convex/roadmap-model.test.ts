import { describe, expect, it } from 'vitest'

import {
  REQUEST_BODY_MAX_LENGTH,
  VOTED_FEATURES_CAP,
  isValidDeviceToken,
  normalizeRequestBody,
  normalizedDedupeKey,
} from '../../../convex/_roadmap/model'

describe('normalizeRequestBody', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeRequestBody('   quiero exportar el roadmap   ')).toBe(
      'quiero exportar el roadmap'
    )
  })

  it('collapses internal whitespace and newlines into single spaces', () => {
    expect(normalizeRequestBody('quiero\n\nexportar   el\troadmap')).toBe(
      'quiero exportar el roadmap'
    )
  })

  it('strips control characters instead of welding the words around them together', () => {
    expect(normalizeRequestBody('quiero\u0000exportar\u0007el roadmap')).toBe(
      'quiero exportar el roadmap'
    )
  })

  it('truncates an oversized body at the cap without throwing', () => {
    const oversized = 'a'.repeat(REQUEST_BODY_MAX_LENGTH + 120)

    expect(() => normalizeRequestBody(oversized)).not.toThrow()
    expect(normalizeRequestBody(oversized)).toHaveLength(REQUEST_BODY_MAX_LENGTH)
  })

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeRequestBody('   \n\t  ')).toBe('')
  })
})

describe('normalizedDedupeKey', () => {
  it('strips diacritics so accented and unaccented spellings share one key', () => {
    expect(normalizedDedupeKey('Votación')).toBe('votacion')
    expect(normalizedDedupeKey('Votación')).toBe(normalizedDedupeKey('votacion'))
  })

  it('drops punctuation rather than splitting on it', () => {
    expect(normalizedDedupeKey('Exportar el roadmap, por favor!')).toBe(
      normalizedDedupeKey('exportar el roadmap por favor')
    )
    expect(normalizedDedupeKey('auto-guardado')).toBe('autoguardado')
  })

  it('is order-insensitive across the same token set', () => {
    expect(normalizedDedupeKey('publico roadmap exportar')).toBe(
      normalizedDedupeKey('exportar roadmap publico')
    )
    expect(normalizedDedupeKey('exportar roadmap publico')).toBe('exportar publico roadmap')
  })

  it('dedupes repeated tokens', () => {
    expect(normalizedDedupeKey('voto voto voto')).toBe('voto')
  })

  // La regresión que motivó los stopwords. Con los tokens crudos, estas dos
  // peticiones compartían `quiero/app/de` — tres de seis — y el tablero le
  // decía al visitante que su petición ya existía cuando pedía lo contrario.
  it('keeps two requests about opposite platforms apart', () => {
    expect(normalizedDedupeKey('Quiero un app de iphone')).not.toBe(
      normalizedDedupeKey('Quiero un app de android')
    )
    expect(normalizedDedupeKey('Quiero un app de iphone')).toBe('app iphone')
  })

  it('collapses the same ask phrased two ways into one key', () => {
    expect(normalizedDedupeKey('Quiero un app de iphone')).toBe(
      normalizedDedupeKey('Necesito por favor una app para el iphone')
    )
  })

  it('does not let politeness alone decide that two asks match', () => {
    expect(normalizedDedupeKey('Necesito exportar a excel')).not.toBe(
      normalizedDedupeKey('Necesito exportar a pdf')
    )
  })

  it('matches across languages when the content words agree', () => {
    expect(normalizedDedupeKey('I want a dark mode please')).toBe(
      normalizedDedupeKey('Please add dark mode')
    )
  })

  // Sin este resguardo toda petición hecha sólo de palabras función colapsaría
  // a la cadena vacía, y la primera de ellas volvería duplicadas a todas las
  // demás.
  it('falls back to the raw tokens when a request carries no content word', () => {
    expect(normalizedDedupeKey('por favor')).toBe('favor por')
    expect(normalizedDedupeKey('por favor')).not.toBe(normalizedDedupeKey('please'))
  })

  it('returns an empty key only for an empty body', () => {
    expect(normalizedDedupeKey('')).toBe('')
  })
})

describe('VOTED_FEATURES_CAP', () => {
  // El tope cuenta funciones distintas, no votos sobre la misma tarjeta: con lo
  // segundo un visitante podía votar el tablero entero y no priorizaba nada.
  it('budgets three features per device', () => {
    expect(VOTED_FEATURES_CAP).toBe(3)
  })
})

describe('isValidDeviceToken', () => {
  it('accepts a UUID-shaped token', () => {
    expect(isValidDeviceToken('3f1c9a20-7b4d-4e11-9f52-2a6c8d0b7e35')).toBe(true)
  })

  it('accepts tokens at both length bounds', () => {
    expect(isValidDeviceToken('a'.repeat(16))).toBe(true)
    expect(isValidDeviceToken('a'.repeat(64))).toBe(true)
  })

  it('rejects tokens outside the length bounds', () => {
    expect(isValidDeviceToken('a'.repeat(15))).toBe(false)
    expect(isValidDeviceToken('a'.repeat(65))).toBe(false)
  })

  it('rejects tokens carrying characters outside the alphanumeric-hyphen alphabet', () => {
    expect(isValidDeviceToken('device_token_1234567')).toBe(false)
    expect(isValidDeviceToken('device token 1234567')).toBe(false)
    expect(isValidDeviceToken('device.token.1234567')).toBe(false)
  })
})
