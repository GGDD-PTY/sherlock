import { Effect } from 'effect'
import type { MutationCtx } from '../_generated/server'
import type { AuthContext, AuthResult } from './auth.types'
import { isMutationCtx } from './auth.types'
import { convexPromise, runConvex } from './effect'
import { AppError, ErrorCode, unauthorized, validationFailed } from './errors'

const DEV_USER_EMAIL = 'admin@dev.local'

// Los dos roles que el bypass de desarrollo puede sembrar, escritos una vez.
// Las empresas y documentos solo se crean al ejecutar un seed de forma explícita.
// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
type DevRole = 'ADMIN' | 'COMPANY'

const DEV_USER_DEFINITIONS: ReadonlyArray<{
  email: string
  name: string
  clerkId: string
  role: DevRole
}> = [
  {
    email: 'admin@dev.local',
    name: 'Dev Admin User',
    clerkId: 'dev_admin_001',
    role: 'ADMIN',
  },
  {
    email: 'company@dev.local',
    name: 'Sample Hydro, S. A.',
    clerkId: 'dev_company_001',
    role: 'COMPANY',
  },
]

export function isDevAuthBypassedViaEnv(): boolean {
  if (process.env.BYPASS_AUTH !== 'true') {
    return false
  }
  // Fail-closed: el bypass exige que el deployment se declare explícitamente
  // de desarrollo (`npx convex env set CONVEX_ENV dev`). Un BYPASS_AUTH=true
  // perdido en el Convex de producción queda inerte en vez de abrir el
  // auto-login de admin a cualquiera.
  return process.env.CONVEX_ENV === 'dev'
}

export function isDevAuthBypassed(): boolean {
  return isDevAuthBypassedViaEnv()
}

const tryGetDevUserEffect = Effect.fn('DevAuth.tryGetUser')(function* (ctx: AuthContext) {
  if (!isDevAuthBypassed()) {
    return null
  }

  for (const devDef of DEV_USER_DEFINITIONS) {
    const user = yield* convexPromise(() =>
      ctx.db
        .query('users')
        .withIndex('by_email', (q) => q.eq('email', devDef.email))
        .first()
    )

    if (user) {
      const profile = yield* convexPromise(() =>
        ctx.db
          .query('profiles')
          .withIndex('by_userId', (q) => q.eq('userId', user._id))
          .first()
      )

      if (profile) {
        yield* Effect.log(`[DEV AUTH] Using existing dev user: ${devDef.email}`)
        return {
          identity: {
            subject: user.clerkId || `dev_${user._id}`,
            authProvider: 'clerk',
            email: user.email,
            name: user.name,
          },
          user,
          profile,
        } satisfies AuthResult
      }
    }
  }

  if (!isMutationCtx(ctx)) {
    return null
  }

  const mutationCtx = ctx
  yield* Effect.log(`[DEV AUTH] Creating all dev users...`)

  let firstResult: AuthResult | null = null

  for (const devDef of DEV_USER_DEFINITIONS) {
    const existingUser = yield* convexPromise(() =>
      mutationCtx.db
        .query('users')
        .withIndex('by_email', (q) => q.eq('email', devDef.email))
        .first()
    )

    if (existingUser) continue

    yield* Effect.log(`[DEV AUTH] Creating dev user: ${devDef.email}`)

    const userId = yield* convexPromise(() =>
      mutationCtx.db.insert('users', {
        email: devDef.email,
        name: devDef.name,
        clerkId: devDef.clerkId,
        role: devDef.role,
        emailVerified: true,
      })
    )
    const user = yield* convexPromise(() => mutationCtx.db.get(userId))

    if (!user) {
      yield* Effect.logError(`[DEV AUTH] Failed to create dev user: ${devDef.email}`)
      continue
    }

    const profileId = yield* convexPromise(() =>
      mutationCtx.db.insert('profiles', {
        userId: user._id,
        role: devDef.role,
        fullName: devDef.name,
        language: 'es',
        isVerified: true,
        isActive: true,
        kycStatus: 'VERIFIED',
        roleConfirmed: true,
      })
    )
    const profile = yield* convexPromise(() => mutationCtx.db.get(profileId))

    if (!profile) {
      yield* Effect.logError(`[DEV AUTH] Failed to create dev profile: ${devDef.email}`)
      continue
    }

    if (!firstResult) {
      firstResult = {
        identity: {
          subject: user.clerkId || `dev_${user._id}`,
          authProvider: 'clerk',
          email: user.email,
          name: user.name,
        },
        user,
        profile,
      }
    }
  }

  return firstResult
})

export function tryGetDevUser(ctx: AuthContext): Promise<AuthResult | null> {
  return runConvex(tryGetDevUserEffect(ctx))
}

const ensureDevUserAndProfile = Effect.fn('DevAuth.ensureUserAndProfile')(function* (
  ctx: MutationCtx,
  email: string
) {
  let user = yield* convexPromise(() =>
    ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', email))
      .unique()
  )

  if (!user) {
    const devUserDef = DEV_USER_DEFINITIONS.find((def) => def.email === email)
    if (!devUserDef) {
      return yield* Effect.fail(
        validationFailed(`No dev user definition found for email: ${email}`, 'email')
      )
    }

    const userId = yield* convexPromise(() =>
      ctx.db.insert('users', {
        email,
        name: devUserDef.name,
        clerkId: devUserDef.clerkId,
        role: devUserDef.role,
        emailVerified: true,
      })
    )
    user = yield* convexPromise(() => ctx.db.get(userId))
  }

  const devUser = user
  if (!devUser) {
    return yield* Effect.fail(
      new AppError(
        ErrorCode.INTERNAL_ERROR,
        `[DEV MODE] Failed to create or find dev user with email: ${email}`
      )
    )
  }

  let profile = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', devUser._id))
      .unique()
  )

  if (!profile) {
    const profileId = yield* convexPromise(() =>
      ctx.db.insert('profiles', {
        userId: devUser._id,
        role: 'ADMIN',
        fullName: 'Dev Admin User',
        language: 'es',
        isVerified: true,
        isActive: true,
        kycStatus: 'VERIFIED',
        roleConfirmed: true,
      })
    )
    profile = yield* convexPromise(() => ctx.db.get(profileId))
  }

  const devProfile = profile
  if (!devProfile) {
    return yield* Effect.fail(
      new AppError(
        ErrorCode.INTERNAL_ERROR,
        `[DEV MODE] Failed to create or find dev profile for user: ${devUser._id}`
      )
    )
  }

  return { user: devUser, profile: devProfile }
})

const getDevAuthResultEffect = Effect.fn('DevAuth.getResult')(function* (ctx: AuthContext) {
  if (!isDevAuthBypassed()) {
    return yield* Effect.fail(unauthorized('Dev auth no está habilitado en este entorno'))
  }

  if (isMutationCtx(ctx)) {
    const mutationCtx = ctx
    const { user, profile } = yield* ensureDevUserAndProfile(mutationCtx, DEV_USER_EMAIL)
    return {
      identity: {
        subject: user.clerkId || 'dev_admin_001',
        authProvider: 'clerk',
        email: user.email,
        name: user.name,
      },
      user,
      profile,
    } satisfies AuthResult
  }

  const user = yield* convexPromise(() =>
    ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', DEV_USER_EMAIL))
      .unique()
  )

  if (!user) {
    return yield* Effect.fail(
      new AppError(
        ErrorCode.NOT_FOUND,
        '[DEV MODE] Usuario de desarrollo no encontrado. ' +
          'Ejecuta una mutation primero para crearlo automáticamente.'
      )
    )
  }

  const profile = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .unique()
  )

  if (!profile) {
    return yield* Effect.fail(
      new AppError(
        ErrorCode.PROFILE_NOT_FOUND,
        '[DEV MODE] Perfil de desarrollo no encontrado. ' +
          'Ejecuta una mutation primero para crearlo automáticamente.'
      )
    )
  }

  return {
    identity: {
      subject: user.clerkId || 'dev_admin_001',
      authProvider: 'clerk',
      email: user.email,
      name: user.name,
    },
    user,
    profile,
  } satisfies AuthResult
})

export function getDevAuthResult(ctx: AuthContext): Promise<AuthResult> {
  return runConvex(getDevAuthResultEffect(ctx))
}
