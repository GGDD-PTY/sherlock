// ============================================================================
// seed-identity — la identidad dev del dueño sembrado sale del email
// ============================================================================
// La regla la importan `_localSeed.ts` (al sembrar) y el dev-login (al entrar):
// si los dos lados derivan distinto, el login crea un usuario huérfano que no
// ve la sala. Estos tests pinean la regla exacta.
// ============================================================================

import { describe, expect, it } from 'vitest'

import {
  devSeedOwnerIds,
  devUserForRole,
  devUserFromEmail,
  devUserFromId,
  seedIdentitySlug,
} from '@/lib/dev-auth/seed-identity'
import { DEV_USERS } from '@/lib/dev-auth/types'

describe('seedIdentitySlug', () => {
  it('pasa el email a minúsculas y quita todo lo que no es alfanumérico', () => {
    expect(seedIdentitySlug('Samplefoods.Foods+Test@DEV.local')).toBe(
      'samplefoods-foods-test-dev-local'
    )
  })

  it('recorta los guiones de los bordes', () => {
    expect(seedIdentitySlug('__a__@dev.local')).toBe('a-dev-local')
  })
})

describe('devSeedOwnerIds', () => {
  it('fabrica clerkId y workosUserId con el mismo slug', () => {
    expect(devSeedOwnerIds('a@dev.local')).toEqual({
      clerkId: 'dev_a-dev-local',
      workosUserId: 'dev_a-dev-local_workos',
    })
  })

  it('dos correos distintos producen identidades distintas', () => {
    expect(devSeedOwnerIds('a@dev.local')).not.toEqual(devSeedOwnerIds('b@dev.local'))
  })
})

// ============================================================================
// EL DEV-LOGIN ABRE A CUALQUIER `*@dev.local` SEMBRADO ([F] D1, tarjeta O3-01)
// ============================================================================
// `seed:company` fabrica un dueño por empresa. Si el dev-login solo conociera
// las dos filas fijas, esa empresa no se podría probar como cliente: la sala
// que abriría sería la de `company@dev.local`, que es de otro.

describe('devUserFromEmail', () => {
  it('devuelve la fila escrita a mano para los dos correos fijos', () => {
    for (const fixed of DEV_USERS) {
      expect(devUserFromEmail(fixed.email)).toBe(fixed)
      expect(devUserFromEmail(fixed.email.toUpperCase())).toBe(fixed)
    }
  })

  it('reconstruye al dueño sembrado con la identidad que escribió el seed', () => {
    const user = devUserFromEmail('samplefoods@dev.local')

    expect(user).not.toBeNull()
    expect(user?.id).toBe(devSeedOwnerIds('samplefoods@dev.local').clerkId)
    expect(user?.role).toBe('COMPANY')
    expect(user?.convexIdentity.subject).toBe(devSeedOwnerIds('samplefoods@dev.local').workosUserId)
    expect(user?.convexIdentity.issuer).toBe(DEV_USERS[0]?.convexIdentity.issuer)
  })

  it('nombra al dueño con la parte local del correo, guiones a espacios', () => {
    expect(devUserFromEmail('samplefoods-foods@dev.local')?.name).toBe('Samplefoods Foods')
    expect(devUserFromEmail('  Samplefoods@DEV.local  ')?.name).toBe('Samplefoods')
  })

  it.each([
    ['otro dominio', 'fixture-bdc28e21@example.com'],
    ['dominio parecido', 'fixture-9f28efde@example.com'],
    ['subdominio colgado', 'fixture-e625012a@example.com'],
    ['sin parte local', '@dev.local'],
    ['vacío', ''],
  ])('rechaza %s', (_, email) => {
    expect(devUserFromEmail(email)).toBeNull()
  })
})

describe('devUserFromId', () => {
  it('devuelve la fila fija por su id', () => {
    for (const fixed of DEV_USERS) {
      expect(devUserFromId(fixed.id)).toBe(fixed)
    }
  })

  it('vuelve del id de la cookie al mismo dueño sembrado', () => {
    const signedIn = devUserFromEmail('samplefoods@dev.local')
    expect(signedIn).not.toBeNull()
    expect(devUserFromId(signedIn!.id)).toEqual(signedIn)
  })

  it('un correo con punto y uno con guion comparten slug, id e identidad', () => {
    const dotted = devUserFromEmail('samplefoods.foods@dev.local')
    const hyphen = devUserFromEmail('samplefoods-foods@dev.local')

    expect(dotted?.id).toBe(hyphen?.id)
    expect(devUserFromId(dotted!.id)?.convexIdentity).toEqual(dotted?.convexIdentity)
  })

  it.each([
    ['sin prefijo dev_', 'samplefoods-dev-local'],
    ['sin el dominio en el slug', 'dev_samplefoods'],
    ['slug de otro dominio', 'dev_samplefoods-gmail-com'],
    ['dominio sin parte local', 'dev_dev-local'],
    ['id de un subject WorkOS', 'dev_samplefoods-dev-local_workos'],
  ])('rechaza %s', (_, id) => {
    expect(devUserFromId(id)).toBeNull()
  })
})

describe('devUserForRole', () => {
  it('selects the company identity when a dev admin switches to COMPANY', () => {
    const admin = DEV_USERS.find((user) => user.role === 'ADMIN')!
    const company = DEV_USERS.find((user) => user.role === 'COMPANY')!
    expect(devUserForRole(admin, 'COMPANY')).toBe(company)
    expect(devUserForRole(admin, 'ADMIN')).toBe(admin)
    expect(devUserForRole(company, 'ADMIN')).toBe(company)
  })
})
