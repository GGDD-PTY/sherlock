// ============================================================================
// LA FRONTERA DE EFFECT EN CONVEX — SUITE DE LA IMPLEMENTACIÓN REAL
// ============================================================================
// Dos mitades, y la segunda es la que importa:
//
//   1. `runConvex`, `convexPromise` y `convexSync` en aislamiento: el reparto
//      entre el canal de error (lo que el cliente ve) y los defectos (lo que
//      nunca debe llegar al cliente).
//   2. `deliverables.request`, una mutation de verdad, invocada por su
//      `_handler` contra un ctx mockeado. Su cadena de autorización pasa por
//      `requireAuthEffect` y `requireAuthenticatedCompanyEffect`, así que este
//      bloque prueba el invariante «requireAuth + ownership check» tal como
//      corre en producción, no una reimplementación local.
//
// LO QUE ESTA SUITE NO PRUEBA: corre en Node bajo vitest, no en el aislado de
// Convex. No dice nada sobre si Effect arma un timer prohibido, ni sobre el
// tamaño del bundle que Convex empuja, ni sobre el tope de 1 s de código
// propio. Eso solo lo contesta un deployment.
// ============================================================================

import { ConvexError } from 'convex/values'
import { Effect } from 'effect'
import { describe, expect, it, beforeEach, vi } from 'vitest'

import type { Doc, Id } from '../../../convex/_generated/dataModel'
import { request as requestDeliverable } from '../../../convex/deliverables'
import { convexPromise, convexSync, runConvex } from '../../../convex/_helpers/effect'
import { AppError, ErrorCode, notFound, unauthorized } from '../../../convex/_helpers/errors'
import {
  convexHandler,
  createMockConvexCtx,
  createMockQueryBuilder,
  createMockUserIdentity,
  type MockConvexCtx,
} from '../utils/convex-test-utils'

// ============================================================================
// 1. EL RUNNER DE FRONTERA
// ============================================================================

describe('convex/_helpers/effect.ts — runConvex', () => {
  it('devuelve el valor del canal de éxito', async () => {
    await expect(runConvex(Effect.succeed(42))).resolves.toBe(42)
  })

  it('lanza el AppError del canal de error tal cual, para que Convex lo serialice', async () => {
    const failure = notFound('Deal', 'deal_123')

    const thrown = await runConvex(Effect.fail(failure)).catch((error: unknown) => error)

    expect(thrown).toBe(failure)
    expect(thrown).toBeInstanceOf(ConvexError)
    expect((thrown as AppError).data.code).toBe(ErrorCode.NOT_FOUND)
  })

  it('sube un defecto Error intacto, sin convertirlo en error de negocio', async () => {
    const defect = new TypeError('undefined no es una función')

    const thrown = await runConvex(Effect.die(defect)).catch((error: unknown) => error)

    expect(thrown).toBe(defect)
    expect(thrown).not.toBeInstanceOf(ConvexError)
  })

  it('convierte un defecto sin stack en INTERNAL_ERROR genérico y lo registra del lado servidor', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const thrown = await runConvex(Effect.die('detalle interno filtrable')).catch(
      (error: unknown) => error
    )

    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).data.code).toBe(ErrorCode.INTERNAL_ERROR)
    expect((thrown as AppError).data.message).not.toContain('detalle interno filtrable')
    expect(logged).toHaveBeenCalled()

    logged.mockRestore()
  })
})

// ============================================================================
// 2. EL PUENTE DESDE PROMISE Y DESDE LOS GUARDAS SÍNCRONOS
// ============================================================================

describe('convex/_helpers/effect.ts — convexPromise / convexSync', () => {
  it('pone un AppError rechazado en el canal de error, recuperable por su tag', async () => {
    const recovered = await runConvex(
      convexPromise(() => Promise.reject(unauthorized('sin permiso'))).pipe(
        Effect.catchTag('AppError', (error) => Effect.succeed(error.data.code))
      )
    )

    expect(recovered).toBe(ErrorCode.AUTHZ_UNAUTHORIZED)
  })

  it('deja cualquier otro rechazo como defecto, fuera del alcance de todo catch del canal de error', async () => {
    const defect = new RangeError('índice fuera de rango')

    // `Effect.catch` recupera TODO el canal de error. Que el programa siga
    // muriendo es la prueba de que el rechazo no entró a ese canal: un bug
    // nuestro no se puede confundir con una respuesta al cliente.
    const thrown = await runConvex(
      convexPromise(() => Promise.reject(defect)).pipe(
        Effect.catch(() => Effect.succeed('recuperado'))
      )
    ).catch((error: unknown) => error)

    expect(thrown).toBe(defect)
  })

  it('pone el lanzamiento de un guarda síncrono en el canal de error', async () => {
    const thrown = await runConvex(
      convexSync(() => {
        throw unauthorized('el guarda dijo que no')
      })
    ).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).data.code).toBe(ErrorCode.AUTHZ_UNAUTHORIZED)
  })
})

// ============================================================================
// 3. EL INVARIANTE, A TRAVÉS DE UNA MUTATION DE VERDAD
// ============================================================================

const OWNER_PROFILE_ID = 'profile_owner' as Id<'profiles'>
const OWN_COMPANY_ID = 'company_own' as Id<'companies'>
const OTHER_COMPANY_ID = 'company_other' as Id<'companies'>

function makeUser(): Doc<'users'> {
  return {
    _id: 'user_owner' as Id<'users'>,
    _creationTime: 1,
    email: 'fixture-eddb4fde@example.com',
    role: 'COMPANY',
    authProvider: 'clerk',
    providerUserId: 'clerk_owner',
    clerkId: 'clerk_owner',
  } as unknown as Doc<'users'>
}

function makeProfile(overrides: Partial<Doc<'profiles'>> = {}): Doc<'profiles'> {
  return {
    _id: OWNER_PROFILE_ID,
    _creationTime: 1,
    userId: 'user_owner' as Id<'users'>,
    role: 'COMPANY',
    kycStatus: 'VERIFIED',
    isActive: true,
    ...overrides,
  } as unknown as Doc<'profiles'>
}

function makeCompany(): Doc<'companies'> {
  return {
    _id: OWN_COMPANY_ID,
    _creationTime: 1,
    ownerId: OWNER_PROFILE_ID,
    name: 'Sample Hydro, S. A.',
  } as unknown as Doc<'companies'>
}

type Rows = Partial<Record<string, unknown[]>>

/**
 * Enruta `ctx.db.query(tabla)` por nombre de tabla. La cadena real de
 * `requireAuth` lee `users` y luego `profiles`; `requireAuthenticatedCompany`
 * agrega `companies`; la mutation agrega `rateLimits` y `deliverables`.
 */
function wireTables(ctx: MockConvexCtx, rows: Rows): void {
  ctx.db.query.mockImplementation((table: string) => createMockQueryBuilder(rows[table] ?? []))
}

const callRequest = convexHandler<
  { kind: 'TEASER'; companyId?: Id<'companies'> },
  { deliverableId: string; status: string; created: boolean }
>(requestDeliverable)

describe('convex/deliverables.ts — request, sobre la cadena de auth en Effect', () => {
  let ctx: MockConvexCtx

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = createMockConvexCtx()
    ctx.auth.getUserIdentity.mockResolvedValue(
      createMockUserIdentity({ subject: 'clerk_owner', email: 'fixture-eddb4fde@example.com' })
    )
    wireTables(ctx, {
      users: [makeUser()],
      profiles: [makeProfile()],
      companies: [makeCompany()],
      rateLimits: [],
      deliverables: [],
    })
  })

  it('rechaza sin sesión con AUTH_NOT_AUTHENTICATED', async () => {
    ctx.auth.getUserIdentity.mockResolvedValue(null)

    const thrown = await callRequest(ctx, { kind: 'TEASER' }).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).data.code).toBe(ErrorCode.AUTH_NOT_AUTHENTICATED)
    expect(ctx.db.insert).not.toHaveBeenCalled()
  })

  it('rechaza un perfil desactivado antes de tocar la empresa', async () => {
    wireTables(ctx, {
      users: [makeUser()],
      profiles: [makeProfile({ isActive: false })],
      companies: [makeCompany()],
      rateLimits: [],
      deliverables: [],
    })

    const thrown = await callRequest(ctx, { kind: 'TEASER' }).catch((error: unknown) => error)

    expect((thrown as AppError).data.code).toBe(ErrorCode.AUTHZ_UNAUTHORIZED)
    expect((thrown as AppError).data.message).toContain('desactivada')
    expect(ctx.db.insert).not.toHaveBeenCalled()
  })

  it('rechaza pedir un entregable para una empresa ajena', async () => {
    const thrown = await callRequest(ctx, {
      kind: 'TEASER',
      companyId: OTHER_COMPANY_ID,
    }).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).data.code).toBe(ErrorCode.AUTHZ_UNAUTHORIZED)
    expect(ctx.db.insert).not.toHaveBeenCalledWith('deliverables', expect.anything())
  })

  it('crea el slot para la empresa del dueño', async () => {
    const result = await callRequest(ctx, { kind: 'TEASER', companyId: OWN_COMPANY_ID })

    expect(result.status).toBe('REQUESTED')
    expect(result.created).toBe(true)
    expect(ctx.db.insert).toHaveBeenCalledWith(
      'deliverables',
      expect.objectContaining({
        companyId: OWN_COMPANY_ID,
        kind: 'TEASER',
        status: 'REQUESTED',
        requestedByProfileId: OWNER_PROFILE_ID,
      })
    )
  })

  it('rechaza cuando el perfil no tiene empresa, sin escribir nada', async () => {
    wireTables(ctx, {
      users: [makeUser()],
      profiles: [makeProfile()],
      companies: [],
      rateLimits: [],
      deliverables: [],
    })

    const thrown = await callRequest(ctx, { kind: 'TEASER' }).catch((error: unknown) => error)

    expect((thrown as AppError).data.code).toBe(ErrorCode.BUSINESS_MISSING_PROFILE)
    expect(ctx.db.insert).not.toHaveBeenCalled()
  })
})
