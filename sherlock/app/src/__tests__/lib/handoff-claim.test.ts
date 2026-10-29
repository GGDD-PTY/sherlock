import { describe, expect, it } from 'vitest'

import {
  HANDOFF_QUERY_PARAM,
  HANDOFF_RENAME_CLOCK_SKEW_MS,
  appendHandoffNonce,
  companyBornFromHandoff,
  createHandoffNonce,
  handoffBelongsToVisit,
  readHandoffNonce,
  stripHandoffNonce,
} from '@/lib/mycroft/handoff-claim'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('handoff claim', () => {
  it('mints a random v4 nonce that its own reader accepts', () => {
    const first = createHandoffNonce()
    const second = createHandoffNonce()
    expect(first).toMatch(UUID)
    expect(second).toMatch(UUID)
    expect(first).not.toBe(second)
    expect(readHandoffNonce(first)).toBe(first)
  })

  it('reads only a well-formed nonce from the URL', () => {
    expect(readHandoffNonce(null)).toBeNull()
    expect(readHandoffNonce(undefined)).toBeNull()
    expect(readHandoffNonce('')).toBeNull()
    expect(readHandoffNonce('abc')).toBeNull()
    expect(readHandoffNonce('../etc')).toBeNull()
    expect(readHandoffNonce('7C9E6679-7425-40DE-944B-E07FC1F90AE7')).toBe(
      '7c9e6679-7425-40de-944b-e07fc1f90ae7'
    )
  })

  // El nonce va dentro del returnTo, no al lado: es la sala la que lo lee, no
  // el sign-up, y tiene que cruzar el hosted de WorkOS y /dev-login intacto.
  it('adds the nonce to the returnTo the sign-up will hand back to the room', () => {
    const nonce = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
    const secureHref = `/es/sign-up?returnTo=${encodeURIComponent('/es/my-company/documents')}`

    const href = appendHandoffNonce(secureHref, nonce)

    const url = new URL(href, 'https://sherlock.capital')
    expect(url.pathname).toBe('/es/sign-up')
    const returnTo = new URL(url.searchParams.get('returnTo') ?? '', 'https://sherlock.capital')
    expect(returnTo.pathname).toBe('/es/my-company/documents')
    expect(returnTo.searchParams.get(HANDOFF_QUERY_PARAM)).toBe(nonce)
    expect(href).not.toContain('token')
  })

  it('leaves a continuation without returnTo untouched', () => {
    expect(appendHandoffNonce('/es/sign-up', 'x')).toBe('/es/sign-up')
  })

  it('strips only the nonce from a query and keeps the rest of the room state', () => {
    expect(stripHandoffNonce('?room=company&handoff=abc&view=documents')).toBe(
      'room=company&view=documents'
    )
    expect(stripHandoffNonce('?handoff=abc')).toBe('')
    expect(stripHandoffNonce('')).toBe('')
  })

  // El sobre es de quien lo parqueó: la pestaña que llegó con ese nonce. Otro
  // usuario en el mismo navegador, o el dueño entrando directo, no lo hereda.
  it('hands the envelope only to the visit that carries its nonce', () => {
    const nonce = createHandoffNonce()
    expect(handoffBelongsToVisit({ urlNonce: nonce, envelopeNonce: nonce })).toBe(true)
    expect(handoffBelongsToVisit({ urlNonce: null, envelopeNonce: nonce })).toBe(false)
    expect(handoffBelongsToVisit({ urlNonce: nonce, envelopeNonce: null })).toBe(false)
    expect(handoffBelongsToVisit({ urlNonce: nonce, envelopeNonce: createHandoffNonce() })).toBe(
      false
    )
    expect(handoffBelongsToVisit({ urlNonce: null, envelopeNonce: null })).toBe(false)
  })

  // El nombre solo bautiza un alta nueva. La comparación de relojes tolera un
  // navegador adelantado: la creación es reloj del servidor y el parqueo del
  // cliente.
  it('renames only a company born from this handoff, tolerating a fast browser clock', () => {
    const stashedAt = 1_780_000_000_000
    expect(companyBornFromHandoff({ companyCreatedAt: stashedAt + 90_000, stashedAt })).toBe(true)
    expect(companyBornFromHandoff({ companyCreatedAt: stashedAt - 3 * 60_000, stashedAt })).toBe(
      true
    )
    expect(
      companyBornFromHandoff({
        companyCreatedAt: stashedAt - HANDOFF_RENAME_CLOCK_SKEW_MS,
        stashedAt,
      })
    ).toBe(true)
    expect(
      companyBornFromHandoff({
        companyCreatedAt: stashedAt - HANDOFF_RENAME_CLOCK_SKEW_MS - 1,
        stashedAt,
      })
    ).toBe(false)
    expect(companyBornFromHandoff({ companyCreatedAt: null, stashedAt })).toBe(false)
    expect(companyBornFromHandoff({ companyCreatedAt: stashedAt, stashedAt: null })).toBe(false)
    expect(companyBornFromHandoff({ companyCreatedAt: Number.NaN, stashedAt })).toBe(false)
  })
})
