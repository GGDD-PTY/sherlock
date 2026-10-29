import { describe, expect, it } from 'vitest'

import { documentsHandoffNonce, withHandoffNonce } from '@/lib/mycroft/handoff-navigation'

const NONCE = '938c27d4-b16f-4087-b191-4fcb7c348959'
const OTHER_NONCE = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

describe('handoff navigation', () => {
  // El alta solo carga la llave del sobre hacia el destino que ya eligió el
  // servidor: con nonce válido se cuelga, con cualquier otra cosa el destino
  // sale limpio.
  it('hangs a valid nonce on the destination and leaves it clean otherwise', () => {
    expect(withHandoffNonce('/my-company/documents', NONCE)).toBe(
      `/my-company/documents?handoff=${NONCE}`
    )
    expect(withHandoffNonce('/onboarding?error=needs-profile', NONCE)).toBe(
      `/onboarding?error=needs-profile&handoff=${NONCE}`
    )
    expect(withHandoffNonce('/onboarding/provision', ` ${NONCE.toUpperCase()} `)).toBe(
      `/onboarding/provision?handoff=${NONCE}`
    )
    expect(withHandoffNonce('/onboarding')).toBe('/onboarding')
    expect(withHandoffNonce('/onboarding', null)).toBe('/onboarding')
    expect(withHandoffNonce('/onboarding', '')).toBe('/onboarding')
    expect(withHandoffNonce('/onboarding', 'invalid')).toBe('/onboarding')
  })

  it('reads the nonce only from a documents path that carries exactly one', () => {
    expect(documentsHandoffNonce(`/my-company/documents?handoff=${NONCE}`)).toBe(NONCE)
    expect(documentsHandoffNonce(`/my-company/documents?room=company&handoff=${NONCE}`)).toBe(NONCE)
    expect(documentsHandoffNonce(`/my-company/documents?handoff=%20${NONCE.toUpperCase()}`)).toBe(
      NONCE
    )
  })

  it.each([
    ['no path', undefined],
    ['empty path', ''],
    ['documents without query', '/my-company/documents'],
    ['documents without handoff', '/my-company/documents?room=company'],
    ['malformed nonce', '/my-company/documents?handoff=invalid'],
    ['empty nonce', '/my-company/documents?handoff='],
    ['two nonces', `/my-company/documents?handoff=${NONCE}&handoff=${OTHER_NONCE}`],
    ['same nonce twice', `/my-company/documents?handoff=${NONCE}&handoff=${NONCE}`],
    ['another screen', `/admin?handoff=${NONCE}`],
    ['trailing slash', `/my-company/documents/?handoff=${NONCE}`],
    ['nonce with fragment', `/my-company/documents?handoff=${NONCE}#top`],
    ['nonce after a second question mark', `/my-company/documents?room=company?handoff=${NONCE}`],
  ])('reads no nonce from %s', (_label, path) => {
    expect(documentsHandoffNonce(path)).toBeNull()
  })

  // `split('?')` corta en el segundo signo: lo que sigue no es parte de la query.
  it('ignores whatever follows a second question mark', () => {
    expect(documentsHandoffNonce(`/my-company/documents?handoff=${NONCE}?room=company`)).toBe(NONCE)
  })
})
