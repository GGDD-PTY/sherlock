// ============================================================================
// DEV AUTH — el perfil se LEE, no se inventa
// ============================================================================
// `getDevProfile` existe porque `useCurrentUserDev` sintetizaba un `_id` con
// `'demo_company_profile' as Id<'profiles'>`. El cast satisface a TypeScript y
// no convierte la cadena en un id de Convex: `/settings/privacy` caía al error
// boundary en cada entrada por `/dev-login`.
//
// Esta query es la superficie sin sesión que resuelve el perfil real. Si el
// guard fail-closed se afloja, o si el allowlist de correos se ensancha, o si
// el retorno deja de ser una whitelist, un BYPASS_AUTH olvidado en producción
// deja de ser inerte.
// ============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { getDevProfile } from '../../../convex/devAuth'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const originalEnv = { ...process.env }

function setEnv(key: string, value: string) {
  ;(process.env as Record<string, string | undefined>)[key] = value
}

function deleteEnv(key: string) {
  delete (process.env as Record<string, string | undefined>)[key]
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) deleteEnv(key)
  }
  Object.assign(process.env, originalEnv)
}

function enableBypass() {
  setEnv('BYPASS_AUTH', 'true')
  setEnv('CONVEX_ENV', 'dev')
}

function seed(email = 'company@dev.local'): Tables {
  return {
    users: [
      {
        _id: 'user_company',
        email,
        name: 'Agroindustrias Espavé',
        authProvider: 'workos',
        providerUserId: 'dev_company_001',
        clerkId: 'dev_company_001',
      },
    ],
    profiles: [
      {
        _id: 'profile_company_real',
        userId: 'user_company',
        role: 'COMPANY',
        isVerified: true,
        isActive: true,
        fullName: 'María Dueña',
        kycStatus: 'VERIFIED',
        kycRejectionReason: 'no debe filtrarse',
        email: 'no-debe-filtrarse@dev.local',
      },
    ],
  }
}

const run = (ctx: ReturnType<typeof createConvexCtx>, email: string) =>
  runHandler<
    { email: string },
    {
      _id: string
      role: string
      isVerified: boolean
      fullName: string | null
      kycStatus: string | null
    } | null
  >(getDevProfile, ctx, { email })

describe('devAuth.getDevProfile — fail-closed y whitelist', () => {
  afterEach(() => {
    restoreEnv()
  })

  it('devuelve null cuando BYPASS_AUTH no está, aunque el correo esté en la lista', async () => {
    deleteEnv('BYPASS_AUTH')
    deleteEnv('CONVEX_ENV')
    const ctx = createConvexCtx(seed())

    await expect(run(ctx, 'company@dev.local')).resolves.toBeNull()
  })

  it('devuelve null cuando BYPASS_AUTH=true pero CONVEX_ENV no es dev (flag perdido en prod)', async () => {
    setEnv('BYPASS_AUTH', 'true')
    deleteEnv('CONVEX_ENV')
    const ctx = createConvexCtx(seed())

    await expect(run(ctx, 'company@dev.local')).resolves.toBeNull()

    setEnv('CONVEX_ENV', 'prod')
    await expect(run(ctx, 'admin@dev.local')).resolves.toBeNull()
  })

  it('devuelve null para un correo fuera del dominio @dev.local aunque el bypass esté activo', async () => {
    enableBypass()
    const ctx = createConvexCtx(seed('example@example.com'))

    await expect(run(ctx, 'example@example.com')).resolves.toBeNull()
    await expect(run(ctx, 'COMPANY@dev.local')).resolves.toBeNull()
    await expect(run(ctx, 'company@dev.local ')).resolves.toBeNull()
    await expect(run(ctx, '@dev.local')).resolves.toBeNull()
  })

  it('resuelve el perfil de un dueño *@dev.local sembrado, no solo company@dev.local', async () => {
    enableBypass()
    const ctx = createConvexCtx(seed('journeys-s-a@dev.local'))

    const profile = await run(ctx, 'journeys-s-a@dev.local')

    expect(profile).toEqual({
      _id: 'profile_company_real',
      role: 'COMPANY',
      isVerified: true,
      fullName: 'María Dueña',
      phone: null,
      kycStatus: 'VERIFIED',
    })
  })

  it('devuelve null si el usuario allowlisted no existe todavía en la base', async () => {
    enableBypass()
    const ctx = createConvexCtx({ users: [], profiles: [] })

    await expect(run(ctx, 'company@dev.local')).resolves.toBeNull()
  })

  it('devuelve null si el usuario existe pero no tiene perfil', async () => {
    enableBypass()
    const rows = seed()
    rows.profiles = []
    const ctx = createConvexCtx(rows)

    await expect(run(ctx, 'company@dev.local')).resolves.toBeNull()
  })

  it('resuelve el perfil real y solo entrega la whitelist, nunca el documento crudo', async () => {
    enableBypass()
    const ctx = createConvexCtx(seed())

    const profile = await run(ctx, 'company@dev.local')

    expect(profile).toEqual({
      _id: 'profile_company_real',
      role: 'COMPANY',
      isVerified: true,
      fullName: 'María Dueña',
      phone: null,
      kycStatus: 'VERIFIED',
    })
    expect(profile).not.toHaveProperty('kycRejectionReason')
    expect(profile).not.toHaveProperty('email')
    expect(profile).not.toHaveProperty('userId')
    expect(profile).not.toHaveProperty('clerkId')
  })

  it('cae al nombre del user cuando el perfil no trae fullName', async () => {
    enableBypass()
    const rows = seed()
    delete rows.profiles[0].fullName
    const ctx = createConvexCtx(rows)

    const profile = await run(ctx, 'company@dev.local')

    expect(profile?.fullName).toBe('Agroindustrias Espavé')
  })
})

describe('useCurrentUserDev — lee getDevProfile, nunca el literal (O5-04-6)', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/hooks/useCurrentUser.ts'), 'utf8')

  it('pide el perfil real a Convex y no fabrica DEMO_COMPANY_PROFILE_ID ni en view-as', () => {
    expect(source).toContain('api.devAuth.getDevProfile')
    expect(source).toContain('_id: realProfile._id')
    expect(source).toContain('realProfile === undefined')
    expect(source).not.toContain('DEMO_COMPANY_PROFILE_ID')
    expect(source).not.toContain('if (realProfile && !isViewingAs)')
  })
})
