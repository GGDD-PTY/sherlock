import { describe, expect, it } from 'vitest'

import { getCurrentProfileId } from '../../../convex/users'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const OWNER_IDENTITY = {
  issuer: 'https://api.workos.com/',
  subject: 'workos_owner',
  email: 'fixture-befbb74d@example.com',
}

function tables(): Tables {
  return {
    users: [
      {
        _id: 'user_owner',
        authProvider: 'workos',
        providerUserId: 'workos_owner',
        workosUserId: 'workos_owner',
        email: 'fixture-befbb74d@example.com',
        name: 'Owner',
        role: 'COMPANY',
      },
    ],
    profiles: [
      {
        _id: 'profile_owner',
        userId: 'user_owner',
        role: 'COMPANY',
        isActive: true,
        fullName: 'Sample Owner',
      },
    ],
  }
}

// La ruta de descarga firma la prueba de entrega con este id y
// `consumeDownloadGrant` lo verifica contra el mismo perfil.
describe('users.getCurrentProfileId', () => {
  it('returns the authenticated profile id', async () => {
    const ctx = createConvexCtx(tables(), { identity: OWNER_IDENTITY })

    const result = await runHandler(getCurrentProfileId, ctx, {})

    expect(result).toEqual({ profileId: 'profile_owner' })
  })
})
