// ============================================================================
// IDENTIDAD DEV → CONVEX LOCAL
// ============================================================================
// La impersonación con la admin key del backend local se enciende solo con
// dev-auth activo, fuera de producción, con la key exportada por
// `scripts/convex-local.mjs` y con una URL de loopback. Cualquier otra
// combinación devuelve null y el cliente dev sigue sin identidad.
// ============================================================================

import { describe, expect, it } from 'vitest'

import {
  hasLocalConvexIdentity,
  isLoopbackConvexUrl,
  localConvexAdminKey,
  localConvexIdentity,
  useDevAuthFixtures,
} from '@/lib/dev-auth/local-convex-identity'
import { DEV_USERS } from '@/lib/dev-auth/types'

const LOCAL = {
  NODE_ENV: 'development',
  NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210',
  NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: 'anonymous-agent|local-admin-key',
}

describe('localConvexAdminKey', () => {
  it('devuelve la key con dev-auth, loopback y key presente', () => {
    expect(localConvexAdminKey(LOCAL, true)).toBe('anonymous-agent|local-admin-key')
  })

  it.each([
    ['dev-auth apagado', LOCAL, false],
    ['producción', { ...LOCAL, NODE_ENV: 'production' }, true],
    ['sin key', { ...LOCAL, NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: '' }, true],
    ['key ausente', { ...LOCAL, NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: undefined }, true],
    ['URL de la nube', { ...LOCAL, NEXT_PUBLIC_CONVEX_URL: 'https://x.convex.cloud' }, true],
    ['host de la red', { ...LOCAL, NEXT_PUBLIC_CONVEX_URL: 'http://192.168.1.10:3210' }, true],
    ['sin URL', { ...LOCAL, NEXT_PUBLIC_CONVEX_URL: undefined }, true],
  ])('null: %s', (_, env, devAuthEnabled) => {
    expect(localConvexAdminKey(env, devAuthEnabled)).toBeNull()
  })
})

describe('hasLocalConvexIdentity', () => {
  it('true con dev-auth, loopback y key', () => {
    expect(hasLocalConvexIdentity(LOCAL, true)).toBe(true)
  })

  it('false sin key', () => {
    expect(
      hasLocalConvexIdentity({ ...LOCAL, NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: undefined }, true)
    ).toBe(false)
  })
})

describe('useDevAuthFixtures', () => {
  it('false cuando hay identidad admin local', () => {
    expect(useDevAuthFixtures(LOCAL, true)).toBe(false)
  })

  it.each([
    ['sin key', { ...LOCAL, NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: undefined }, true],
    ['URL de la nube', { ...LOCAL, NEXT_PUBLIC_CONVEX_URL: 'https://x.convex.cloud' }, true],
  ])('true: %s', (_, env, devAuthEnabled) => {
    expect(useDevAuthFixtures(env, devAuthEnabled)).toBe(true)
  })

  it('false cuando dev-auth está apagado', () => {
    expect(useDevAuthFixtures(LOCAL, false)).toBe(false)
    expect(
      useDevAuthFixtures({ ...LOCAL, NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: undefined }, false)
    ).toBe(false)
  })
})

describe('isLoopbackConvexUrl', () => {
  it.each([
    ['http://127.0.0.1:3210', true],
    ['http://localhost:3210', true],
    ['https://127.0.0.1:3210', false],
    ['https://brainy-emu-822.convex.cloud', false],
    ['no-es-url', false],
    [undefined, false],
  ])('%s → %s', (value, expected) => {
    expect(isLoopbackConvexUrl(value)).toBe(expected)
  })
})

describe('localConvexIdentity', () => {
  it('el usuario COMPANY se impersona con el subject WorkOS que parchan los seeds', () => {
    const company = DEV_USERS.find((user) => user.role === 'COMPANY')!
    expect(localConvexIdentity(company)).toEqual({
      subject: 'dev_company_001_workos',
      issuer: 'https://api.workos.com/',
      email: 'company@dev.local',
      name: 'Sample Hydro, S. A.',
    })
  })

  it('el usuario ADMIN se impersona con el subject WorkOS y la sesión del seed local', () => {
    const admin = DEV_USERS.find((user) => user.role === 'ADMIN')!
    expect(localConvexIdentity(admin)).toMatchObject({
      subject: 'dev_admin_001_workos',
      issuer: 'https://api.workos.com/',
      sid: 'dev_admin_001_local_session',
      email: 'admin@dev.local',
    })
  })
})
