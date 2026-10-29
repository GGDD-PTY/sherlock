// ============================================================================
// Sherlock - COMPANY FUNCTIONS
// ============================================================================
// Funciones para manejar perfiles de empresas.
// ============================================================================

import { paginationOptsValidator, type PaginationOptions } from 'convex/server'
import { v, type ObjectType } from 'convex/values'
import { Effect } from 'effect'
import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { mutation, query } from './_generated/server'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { requireAdmin, type AuthResult } from './_helpers/auth'
import {
  buildUserInsertFromIdentity,
  findUserByAuthIdentity,
  getIdentityAuthProvider,
  isSyntheticIdentityEmail,
  loadProviderUserTombstone,
  requireAuthEffect,
} from './_helpers/auth.identity'
import { convexPromise, convexSync, runConvex } from './_helpers/effect'
import { logAdminAction } from './_helpers/auditLog'
import {
  alreadyExists,
  invalidState,
  isBootstrapRecoverableAuthError,
  type AppError,
  notAuthenticated,
  notFound,
  unauthorized,
  validationFailed,
} from './_helpers/errors'
import { FOCUS_BAND_MAX_USD, FOCUS_BAND_MIN_USD, isOutsideUsdFocusBand } from './_helpers/focusBand'
import {
  applyCompanyVisibility,
  type CompanyVisibilityAuthorization,
} from './_helpers/companyVisibility'
import {
  evaluateCompanyManagementAuthorization,
  isCurrentCompanyAuthorizationSession,
  requireCompanyManagementAuthorization,
  requireCompanyReadAuthorization,
  resolveCompanyWorkosOrgBindingForCreation,
  resolveCompanyWorkosOrgBindingForSelfProvisioning,
  resolveCurrentCompanyAuthorization,
} from './_helpers/companyAuthorization'
import { recordCompanyAuthorizationInventoryForCreation } from './companyAuthorizationRollout'
import { confirmCompanyName } from './companyChecklist'
import { normalizeContactPhone } from './_helpers/contactPhone'

async function resolveCompanyVisibilityAuthorization(
  ctx: Parameters<typeof resolveCurrentCompanyAuthorization>[0],
  auth: AuthResult,
  company: Doc<'companies'>
): Promise<CompanyVisibilityAuthorization | null> {
  if (auth.profile.role === 'ADMIN') {
    const decision = await evaluateCompanyManagementAuthorization(ctx, auth, company)
    return decision.authorized ? { companyId: company._id, decision } : null
  }

  if (auth.profile.role !== 'COMPANY') return null

  const authorization = await resolveCurrentCompanyAuthorization(ctx, auth)
  return authorization?.company._id === company._id ? authorization : null
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Resolve the current principal's issuer workspace without accepting a
 * client-supplied profile or company id. Legacy owners keep management access;
 * an active, unambiguous WorkOS COMPANY_MEMBER receives read-only access.
 */
const getMyVdrWorkspaceProgram = Effect.fn('Companies.getMyVdrWorkspace')(function* (
  ctx: QueryCtx
) {
  const auth = yield* requireAuthEffect(ctx)
  const authorization = yield* convexPromise(() => resolveCurrentCompanyAuthorization(ctx, auth))
  if (!authorization) return null

  return {
    access: authorization.access,
    company: authorization.company,
  }
})

export const getMyVdrWorkspace = query({
  args: {},
  handler: (ctx) => runConvex(getMyVdrWorkspaceProgram(ctx)),
})

/**
 * Resolve one issuer workspace for the admin team. La sala es una por empresa:
 * la identidad del workspace es la empresa misma.
 */
const getAdminVdrWorkspaceProgram = Effect.fn('Companies.getAdminVdrWorkspace')(function* (
  ctx: QueryCtx,
  args: { companyId: Id<'companies'> }
) {
  const { profile } = yield* requireAuthEffect(ctx)
  yield* convexSync(() => requireAdmin(profile))

  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) return null

  return {
    company: { _id: company._id, name: company.name },
  }
})

export const getAdminVdrWorkspace = query({
  args: { companyId: v.id('companies') },
  handler: (ctx, args) => runConvex(getAdminVdrWorkspaceProgram(ctx, args)),
})

/**
 * Obtener empresa por ID
 * SEGURIDAD: Información sensible solo visible para owner o admin
 */
const getCompanyProgram = Effect.fn('Companies.getCompany')(function* (
  ctx: QueryCtx,
  args: { companyId: Id<'companies'> }
) {
  // ===== AUTH: Verificar autenticación =====
  const auth = yield* requireAuthEffect(ctx)
  const { profile } = auth

  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) return null

  let companyAuthorization: CompanyVisibilityAuthorization | null = null

  // ===== VERIFICAR AUTORIZACIÓN =====
  // Si no es público y no es owner/admin, negar acceso
  if (!company.isPublic) {
    companyAuthorization = yield* convexPromise(() =>
      requireCompanyReadAuthorization(ctx, auth, company, 'No tienes permiso para ver esta empresa')
    )
  } else {
    companyAuthorization = yield* convexPromise(() =>
      resolveCompanyVisibilityAuthorization(ctx, auth, company)
    )
  }

  return (
    (yield* convexPromise(() =>
      applyCompanyVisibility(ctx, {
        company,
        profile,
        ownerCanReveal: true,
        auth,
        companyAuthorization,
      })
    )) ?? company
  )
})

export const getCompany = query({
  args: { companyId: v.id('companies') },
  handler: (ctx, args) => runConvex(getCompanyProgram(ctx, args)),
})

/**
 * Obtener empresa por owner (profile)
 * SEGURIDAD: Solo el owner o admin pueden acceder
 */
const getCompanyByOwnerProgram = Effect.fn('Companies.getCompanyByOwner')(function* (
  ctx: QueryCtx,
  args: { ownerId: Id<'profiles'> }
) {
  // ===== AUTH: Verificar autenticación =====
  const auth = yield* requireAuthEffect(ctx)
  const company = yield* convexPromise(() =>
    ctx.db
      .query('companies')
      .withIndex('by_ownerId', (q) => q.eq('ownerId', args.ownerId))
      .first()
  )
  if (!company) return null
  yield* convexPromise(() =>
    requireCompanyReadAuthorization(ctx, auth, company, 'No tienes permiso para ver esta empresa')
  )
  return company
})

export const getCompanyByOwner = query({
  args: { ownerId: v.id('profiles') },
  handler: (ctx, args) => runConvex(getCompanyByOwnerProgram(ctx, args)),
})

/**
 * Listar empresas para el equipo administrador.
 * SEGURIDAD: Solo admin. Incluye registros internos para que
 * las empresas en revisión no desaparezcan del control tower.
 */
const listAdminCompaniesProgram = Effect.fn('Companies.listAdminCompanies')(function* (
  ctx: QueryCtx
) {
  const auth = yield* requireAuthEffect(ctx)
  const { profile } = auth
  yield* convexSync(() => requireAdmin(profile))
  if (!isCurrentCompanyAuthorizationSession(auth)) {
    return yield* Effect.fail(unauthorized('No tienes permiso para listar empresas privadas'))
  }

  const companies = yield* convexPromise(() => ctx.db.query('companies').collect())

  return companies.sort((a, b) => b._creationTime - a._creationTime)
})

export const listAdminCompanies = query({
  args: {},
  handler: (ctx) => runConvex(listAdminCompaniesProgram(ctx)),
})

/**
 * Mismo criterio que `AdminOverview.ownerEmail`: perfil del dueño, luego el
 * email del usuario. Vive acá porque esa función no se exporta y este query
 * no puede importar el módulo del panel.
 */
const ownerEmailForCompany = Effect.fn('Companies.ownerEmail')(function* (
  ctx: QueryCtx,
  company: Doc<'companies'>
) {
  const owner = yield* convexPromise(() => ctx.db.get(company.ownerId))
  if (!owner) return null
  const user = yield* convexPromise(() => ctx.db.get(owner.userId))
  return user?.email ?? null
})

/**
 * La misma cola admin, página por página con el cursor de Convex.
 * La versión sin paginar se queda para los llamadores que necesitan el total.
 * SEGURIDAD: mismas dos guardas que `listAdminCompanies` — admin y sesión que
 * no está actuando como empresa.
 */
const listAdminCompaniesPaginatedProgram = Effect.fn('Companies.listAdminCompaniesPaginated')(
  function* (ctx: QueryCtx, args: { paginationOpts: PaginationOptions }) {
    const auth = yield* requireAuthEffect(ctx)
    const { profile } = auth
    yield* convexSync(() => requireAdmin(profile))
    if (!isCurrentCompanyAuthorizationSession(auth)) {
      return yield* Effect.fail(unauthorized('No tienes permiso para listar empresas privadas'))
    }

    // `.order('desc')` sobre el índice de creación: el mismo orden que devolvía
    // el `.collect()` ordenado a mano, pero sin traer la tabla entera.
    const result = yield* convexPromise(() =>
      ctx.db.query('companies').order('desc').paginate(args.paginationOpts)
    )
    const page: Array<(typeof result.page)[number] & { ownerEmail: string | null }> = []
    for (const company of result.page) {
      page.push({
        ...company,
        ownerEmail: yield* ownerEmailForCompany(ctx, company),
      })
    }
    return { ...result, page }
  }
)

export const listAdminCompaniesPaginated = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: (ctx, args) => runConvex(listAdminCompaniesPaginatedProgram(ctx, args)),
})

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Crear empresa (después de signup como COMPANY)
 */
const createCompanyProgram = Effect.fn('Companies.createCompany')(function* (
  ctx: MutationCtx,
  args: {
    ownerId: Id<'profiles'>
    name: string
    country: string
    legalName?: string
    tagline?: string
    website?: string
    industry?: string
    sector?: string
    description?: string
    stage?: string
    foundedYear?: number
    revenueRange?: string
    employees?: string
    onboardingStep?: number
    isPublic?: boolean
  }
) {
  // ===== AUTH: Verificar autenticación y ownership =====
  const auth = yield* requireAuthEffect(ctx)
  const { profile } = auth

  // ===== VALIDACIÓN DE CAMPOS REQUERIDOS =====
  // Verificar que name y country no estén vacíos
  if (!args.name || args.name.trim().length === 0) {
    return yield* Effect.fail(validationFailed('El nombre de la empresa es requerido', 'name'))
  }
  if (!args.country || args.country.trim().length === 0) {
    return yield* Effect.fail(validationFailed('El país es requerido', 'country'))
  }

  // Verificar que no tenga ya una empresa
  const existing = yield* convexPromise(() =>
    ctx.db
      .query('companies')
      .withIndex('by_ownerId', (q) => q.eq('ownerId', args.ownerId))
      .first()
  )

  if (existing) {
    return yield* Effect.fail(alreadyExists('Empresa'))
  }

  const workosOrgId = yield* convexPromise(() =>
    resolveCompanyWorkosOrgBindingForCreation(ctx, auth, args.ownerId)
  )

  // Construir objeto sin spread para evitar problemas de tipos con sector/industry
  const companyId = yield* convexPromise(() =>
    ctx.db.insert('companies', {
      ownerId: args.ownerId,
      name: args.name.trim(),
      country: args.country,
      legalName: args.legalName,
      tagline: args.tagline,
      website: args.website,
      description: args.description,
      stage: args.stage,
      foundedYear: args.foundedYear,
      revenueRange: args.revenueRange,
      employees: args.employees,
      // sector e industry se pueden agregar después via updateCompany
      // ya que requieren tipos específicos que vienen del formulario
      currency: 'USD',
      seekingType: 'BOTH',
      onboardingStep: args.onboardingStep ?? 1,
      isPublic: profile.role === 'ADMIN' ? (args.isPublic ?? false) : false,
      isFeatured: false,
    })
  )

  if (workosOrgId) {
    yield* convexPromise(() =>
      ctx.db.insert('companyOrganizationBindings', {
        companyId,
        ownerProfileId: args.ownerId,
        authProvider: 'workos',
        providerOrgId: workosOrgId,
        createdAt: Date.now(),
        createdByProfileId: profile._id,
        source: 'COMPANY_CREATE',
      })
    )
  }

  yield* convexPromise(() => recordCompanyAuthorizationInventoryForCreation(ctx, companyId))

  return companyId
})

export const createCompany = mutation({
  args: {
    ownerId: v.id('profiles'),
    name: v.string(),
    country: v.string(),
    // Campos opcionales
    legalName: v.optional(v.string()),
    tagline: v.optional(v.string()),
    website: v.optional(v.string()),
    industry: v.optional(v.string()),
    sector: v.optional(v.string()),
    description: v.optional(v.string()),
    // Stage: texto libre, igual que sector e industria ([F] 2026-09-17).
    stage: v.optional(v.string()),
    foundedYear: v.optional(v.number()),
    revenueRange: v.optional(v.string()),
    employees: v.optional(v.string()),
    onboardingStep: v.optional(v.number()),
    isPublic: v.optional(v.boolean()), // Para crear empresas no visibles
  },
  handler: (ctx, args) => runConvex(createCompanyProgram(ctx, args)),
})

export type EnsureCompanyWorkspaceResult = {
  created: boolean
  role: Doc<'profiles'>['role']
  company: Doc<'companies'> | null
}

/** Forma de un id de usuario del proveedor: `user_` + 26 caracteres de ULID. */
const PROVIDER_USER_ID = /^user_[0-9A-Za-z]{26}$/

/**
 * El nombre de arranque que sale de un correo, o `undefined` cuando ese correo
 * no dice nada de nadie: una dirección sintética, o un local-part con forma de
 * id del proveedor. Va acá y no en `normalizeCompanyName` a propósito — el
 * normalizador decide qué es un nombre VÁLIDO y no puede empezar a rechazarle
 * el suyo a un cliente; esto decide qué sirve como nombre de ARRANQUE.
 */
function startingNameFromEmail(email: string | null | undefined): string | undefined {
  if (typeof email !== 'string') return undefined
  if (isSyntheticIdentityEmail(email)) return undefined
  const localPart = email.split('@')[0]?.trim()
  if (!localPart || PROVIDER_USER_ID.test(localPart)) return undefined
  return localPart
}

/**
 * Aprovisionar el espacio de trabajo de una empresa en el primer login.
 *
 * Convex serializa las mutaciones, así que el read-before-write dentro del
 * handler ES la primitiva de idempotencia: no hace falta ningún lock extra.
 */
// El tipo de retorno va anotado porque el programa agenda por `internal.*`: sin
// la anotación, `_generated/api` necesitaría el tipo de este módulo para
// tiparse a sí mismo y `tsc` corta el ciclo devolviendo `any`.
const ensureCompanyWorkspaceProgram = Effect.fn('Companies.ensureCompanyWorkspace')(function* (
  ctx: MutationCtx
): Effect.fn.Return<EnsureCompanyWorkspaceResult, AppError> {
  const identity = yield* convexPromise(() => ctx.auth.getUserIdentity())
  if (!identity) {
    return yield* Effect.fail(notAuthenticated())
  }

  // Un usuario o perfil local ausente es la condición recuperable del primer
  // login (el cliente puede ganarle al webhook de WorkOS). Credenciales Clerk
  // retenidas y perfiles inactivos siguen fail-closed y nunca llegan a escribir.
  // El fallo recuperable se apaga en el canal de error; cualquier otro sube.
  const authenticated: AuthResult | null = yield* requireAuthEffect(ctx).pipe(
    Effect.catch((error) =>
      isBootstrapRecoverableAuthError(error)
        ? Effect.succeed(null as AuthResult | null)
        : Effect.fail(error)
    )
  )

  let user =
    authenticated?.user ?? (yield* convexPromise(() => findUserByAuthIdentity(ctx, identity)))
  if (getIdentityAuthProvider(identity) === 'workos') {
    const tombstone = yield* convexPromise(() => loadProviderUserTombstone(ctx, identity.subject))
    if (tombstone) {
      return yield* Effect.fail(unauthorized())
    }
  }
  if (!user) {
    // Espejo del guard del webhook (workos_user_email_collision, users.ts):
    // un email ya ligado a otro usuario local jamás se re-crea desde el
    // cliente — insertaría una segunda fila y fragmentaría esa cuenta.
    const identityEmail = typeof identity.email === 'string' ? identity.email : undefined
    if (identityEmail) {
      const emailOwner = yield* convexPromise(() =>
        ctx.db
          .query('users')
          .withIndex('by_email', (q) => q.eq('email', identityEmail))
          .first()
      )
      if (emailOwner) {
        return yield* Effect.fail(invalidState('El correo ya pertenece a otra cuenta'))
      }
    }
    const userId = yield* convexPromise(() =>
      ctx.db.insert('users', buildUserInsertFromIdentity(identity, 'COMPANY'))
    )
    user = yield* convexPromise(() => ctx.db.get(userId))
    if (!user) {
      return yield* Effect.fail(invalidState('No se pudo crear el usuario'))
    }
  }

  const existingUser = user
  let profile =
    authenticated?.profile ??
    // `.unique()` y no `.first()`: un usuario con perfiles duplicados es
    // corrupción, y `requireAuth` ya falla cerrado ahí. Elegir uno en silencio
    // aprovisionaría contra el perfil equivocado.
    (yield* convexPromise(() =>
      ctx.db
        .query('profiles')
        .withIndex('by_userId', (q) => q.eq('userId', existingUser._id))
        .unique()
    ))

  // La condición de página que antes abría el selector de rol (`!roleConfirmed`)
  // también la alcanza un ADMIN cuyo perfil creó el webhook y promovió
  // `makeAdmin`, que no fija `roleConfirmed`. Aprovisionar nunca puede degradar
  // a un ADMIN, así que acá el rol no se toca.
  if (profile && profile.role !== 'COMPANY') {
    return { created: false, role: profile.role, company: null }
  }

  if (!profile) {
    const profileId = yield* convexPromise(() =>
      ctx.db.insert('profiles', {
        userId: existingUser._id,
        role: 'COMPANY',
        roleConfirmed: true,
        language: 'es',
        timezone: 'America/Panama',
        emailNotifications: true,
        isVerified: false,
        isActive: true,
        unreadMessageCount: 0,
      })
    )
    profile = yield* convexPromise(() => ctx.db.get(profileId))
    if (!profile) {
      return yield* Effect.fail(invalidState('No se pudo crear el perfil'))
    }
  } else if (profile.roleConfirmed !== true) {
    const unconfirmed = profile
    yield* convexPromise(() => ctx.db.patch(unconfirmed._id, { roleConfirmed: true }))
  }

  const companyProfile = profile

  // `users.role` siempre debe seguir a `profiles.role`: si queda stale (o
  // `undefined`, como en los usuarios creados por el webhook `user.created`),
  // el sync de WorkOS re-deriva el rol desde ahí y degrada el perfil.
  if (existingUser.role !== 'COMPANY') {
    yield* convexPromise(() => ctx.db.patch(existingUser._id, { role: 'COMPANY' }))
  }

  const callerAuth: AuthResult = authenticated ?? {
    identity: {
      subject: identity.subject,
      authProvider: yield* convexSync(() => getIdentityAuthProvider(identity)),
      issuer: identity.issuer,
      sessionId: typeof identity.sid === 'string' ? identity.sid : undefined,
      email: identity.email,
      name: identity.name,
    },
    user: existingUser,
    profile: companyProfile,
  }

  const existingCompany = yield* convexPromise(() =>
    ctx.db
      .query('companies')
      .withIndex('by_ownerId', (q) => q.eq('ownerId', companyProfile._id))
      .first()
  )
  // Una empresa a mitad del wizard conserva su `onboardingStep`: se devuelve
  // intacta, nunca se parcha. La fila solo sale de acá si pasa la MISMA
  // evaluación de lectura que aplica `getCompanyByOwner`; devolverla en crudo
  // convertía esta mutación en un camino paralelo más laxo que la query.
  if (existingCompany) {
    const readable = yield* convexPromise(() =>
      evaluateCompanyManagementAuthorization(ctx, callerAuth, existingCompany)
    )
    return {
      created: false,
      role: 'COMPANY',
      company: readable.authorized ? existingCompany : null,
    }
  }

  const binding = yield* convexPromise(() =>
    resolveCompanyWorkosOrgBindingForSelfProvisioning(ctx, callerAuth)
  )
  if (!binding.allowed) {
    return { created: false, role: 'COMPANY', company: null }
  }

  // El correo solo nombra la sala cuando dice algo de alguien. Un token sin
  // claim de correo deja una dirección sintética (`user_01…@workos.user`), y
  // ese id no puede terminar de nombre de empresa ni en el asunto del correo
  // que le llega al equipo ([F] 2026-09-17: arregla los hallazgos del E2E).
  // `'Mi empresa'` era el default declarado y era inalcanzable; ahora es el que
  // el cliente ve hasta que escribe el nombre de verdad.
  const name =
    existingUser.name?.trim() ||
    identity.name?.trim() ||
    startingNameFromEmail(existingUser.email) ||
    'Mi empresa'

  // `country` nace vacío: no se conoce en el signup, el cliente lo completa en
  // my-company, y en el resto de las vistas renderiza en blanco sin romper nada.
  const companyId = yield* convexPromise(() =>
    ctx.db.insert('companies', {
      ownerId: companyProfile._id,
      name,
      country: '',
      currency: 'USD',
      seekingType: 'BOTH',
      isPublic: false,
      isFeatured: false,
      onboardingStep: 6,
      onboardingCompletedAt: Date.now(),
    })
  )

  if (binding.providerOrgId) {
    const providerOrgId = binding.providerOrgId
    yield* convexPromise(() =>
      ctx.db.insert('companyOrganizationBindings', {
        companyId,
        ownerProfileId: companyProfile._id,
        authProvider: 'workos',
        providerOrgId,
        createdAt: Date.now(),
        createdByProfileId: companyProfile._id,
        source: 'COMPANY_CREATE',
      })
    )
  }

  yield* convexPromise(() => recordCompanyAuthorizationInventoryForCreation(ctx, companyId))

  const company = yield* convexPromise(() => ctx.db.get(companyId))
  if (!company) {
    return yield* Effect.fail(
      invalidState('No se pudo aprovisionar el espacio de trabajo de la empresa')
    )
  }

  yield* convexPromise(() =>
    ctx.scheduler.runAfter(0, internal.notifications._recordCompanyWorkspaceCreated, {
      companyId,
    })
  )

  return { created: true, role: 'COMPANY', company }
})

export const ensureCompanyWorkspace = mutation({
  args: {},
  handler: (ctx): Promise<EnsureCompanyWorkspaceResult> =>
    runConvex(ensureCompanyWorkspaceProgram(ctx)),
})

// Rangos del formulario de la sala. El cliente los valida en línea; el server
// los vuelve a exigir porque el MCP y cualquier otro llamador entran por aquí.
function assertCompanyProfileArgs(args: {
  name?: string
  country?: string
  foundedYear?: number | null
  debtTermYears?: number | null
  debtIndicativeRate?: number | null
}): void {
  if (typeof args.name === 'string' && args.name.trim().length === 0) {
    throw validationFailed('Escribe el nombre de tu empresa', 'name')
  }
  if (typeof args.country === 'string' && args.country.trim().length === 0) {
    throw validationFailed('Elige el país', 'country')
  }
  const currentYear = new Date().getFullYear()
  if (
    args.foundedYear != null &&
    (!Number.isInteger(args.foundedYear) ||
      args.foundedYear < 1900 ||
      args.foundedYear > currentYear)
  ) {
    throw validationFailed(`Escribe un año entre 1900 y ${currentYear}`, 'foundedYear')
  }
  if (
    args.debtTermYears != null &&
    (!Number.isInteger(args.debtTermYears) || args.debtTermYears < 1 || args.debtTermYears > 30)
  ) {
    throw validationFailed('Escribe un plazo entre 1 y 30 años', 'debtTermYears')
  }
  if (
    args.debtIndicativeRate != null &&
    (!Number.isFinite(args.debtIndicativeRate) ||
      args.debtIndicativeRate < 0 ||
      args.debtIndicativeRate > 100)
  ) {
    throw validationFailed('Escribe una tasa entre 0 y 100', 'debtIndicativeRate')
  }
}

/**
 * Actualizar empresa
 * SEGURIDAD: Solo el owner o admin pueden actualizar
 */
const updateCompanyArgs = {
  companyId: v.id('companies'),
  // Campos actualizables
  managementTeam: v.optional(
    v.array(
      v.object({
        name: v.string(),
        title: v.string(),
        bio: v.optional(v.string()),
        linkedin: v.optional(v.string()),
      })
    )
  ),
  name: v.optional(v.string()),
  legalName: v.optional(v.string()),
  logoUrl: v.optional(v.string()),
  website: v.optional(v.string()),
  tagline: v.optional(v.string()),
  country: v.optional(v.string()),
  city: v.optional(v.string()),
  address: v.optional(v.string()),
  industry: v.optional(v.string()),
  sector: v.optional(v.string()),
  // Los cuatro numéricos del formulario de la sala aceptan `null` para
  // BORRAR el valor guardado; `undefined` sigue siendo "sin cambio".
  foundedYear: v.optional(v.union(v.number(), v.null())),
  employeesCount: v.optional(v.number()),
  employees: v.optional(v.string()),
  description: v.optional(v.string()),
  longDescription: v.optional(v.string()),
  // Financieros. Los estados financieros llegan como documentos a la sala;
  // el formulario no los pide ([F] 2026-09-07 09:00).
  revenuePrevious: v.optional(v.number()),
  totalAssets: v.optional(v.number()),
  totalLiabilities: v.optional(v.number()),
  totalEquity: v.optional(v.number()),
  currency: v.optional(v.string()),
  // Qué buscan
  seekingAmount: v.optional(v.union(v.number(), v.null())),
  // `BRIDGE` queda en el schema para filas viejas; el formulario ya no lo
  // ofrece y la mutation no lo acepta.
  seekingType: v.optional(v.union(v.literal('DEBT'), v.literal('EQUITY'), v.literal('BOTH'))),
  useOfFunds: v.optional(v.string()),
  // Términos buscados cuando hay deuda ([F] 2026-09-07 09:00).
  debtTermYears: v.optional(v.union(v.number(), v.null())),
  debtIndicativeRate: v.optional(v.union(v.number(), v.null())),
  // `isPublic` no viaja por aquí: es material aprobado para compartir y lo
  // enciende el equipo con `setCompanyVisibility`.
  // Onboarding Step 2 (texto libre)
  foundersDescription: v.optional(v.string()),
  teamSize: v.optional(v.string()),
  companyLinkedin: v.optional(v.string()),
  // Onboarding
  onboardingStep: v.optional(v.number()),
  onboardingCompletedAt: v.optional(v.number()),
  // Señal de intención, NO un campo de la empresa: declara que esta persona
  // está confirmando el nombre a propósito aunque no lo esté cambiando.
  confirmName: v.optional(v.boolean()),
}

const updateCompanyProgram = Effect.fn('Companies.updateCompany')(function* (
  ctx: MutationCtx,
  args: ObjectType<typeof updateCompanyArgs>
) {
  // ===== AUTH: Verificar autenticación y ownership =====
  const auth = yield* requireAuthEffect(ctx)
  const { profile } = auth

  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) {
    return yield* Effect.fail(notFound('Empresa', args.companyId))
  }

  // Solo el owner o admin pueden actualizar
  yield* convexPromise(() =>
    requireCompanyManagementAuthorization(
      ctx,
      auth,
      company,
      'No autorizado: Solo el dueño o admin pueden actualizar la empresa'
    )
  )

  const { companyId, confirmName, ...updates } = args

  yield* convexSync(() => assertCompanyProfileArgs(args))

  // Lo que el formulario deja vacío viaja como '' (texto) o null (número) y
  // se BORRA de la fila: `undefined` sigue siendo "sin cambio". Antes todo
  // vacío se filtraba como sin cambio y un sitio web borrado reaparecía al
  // recargar.
  const cleanUpdates = Object.fromEntries(
    Object.entries(updates)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value === '' || value === null ? undefined : value])
  )
  // `isPublic` es material aprobado para compartir y NO se cambia por aquí. El
  // validator no lo declara, pero el handler hace spread de lo que le llega:
  // un caller interno (`_handler`, una mutation vecina, un seed) publicaría la
  // empresa sin pasar por el equipo. Se descarta venga de quien venga, admin
  // incluido: la única vía es `setCompanyVisibility`, que audita el cambio.
  delete cleanUpdates.isPublic

  if (typeof cleanUpdates.debtIndicativeRate === 'number') {
    cleanUpdates.debtIndicativeRate = Math.round(cleanUpdates.debtIndicativeRate * 100) / 100
  }

  // ¿Cambiaron de verdad los términos de fundraising? Se compara contra la
  // fila ANTES del patch: el formulario de la sala (CompanyProfileForm)
  // reenvía seekingAmount/currency existentes en guardados que no los tocan,
  // y marcar cada guardado repetido llenaría el feed de eventos de revisión
  // falsos.
  const submittedAmount = args.seekingAmount === null ? undefined : args.seekingAmount
  const fundraisingChanged =
    (args.seekingAmount !== undefined && submittedAmount !== company.seekingAmount) ||
    (args.currency !== undefined && args.currency !== company.currency)

  // El nombre lo confirma una PERSONA, no un guardado. El formulario
  // reenvía el nombre en cada submit — editar solo el sitio web no puede
  // marcar el checklist. Se confirma si el nombre enviado difiere del
  // almacenado (comparación exacta sobre el texto recortado) o si el caller
  // manda `confirmName: true` para declararlo sin cambiarlo. Igual que
  // `fundraisingChanged`, se compara contra la fila ANTES del patch.
  const submittedName = typeof args.name === 'string' ? args.name.trim() : null
  const storedName = typeof company.name === 'string' ? company.name.trim() : ''
  const effectiveName = submittedName ?? storedName
  const nameChanged =
    submittedName !== null && submittedName.length > 0 && submittedName !== storedName
  const shouldConfirmName = (nameChanged || confirmName === true) && effectiveName.length > 0

  yield* convexPromise(() => ctx.db.patch(companyId, cleanUpdates))
  if (shouldConfirmName) {
    yield* convexPromise(() => confirmCompanyName(ctx, companyId, 'ROOM_RENAME'))
  }
  const updatedCompany = yield* convexPromise(() => ctx.db.get(companyId))

  // ===== BANDA DE ENFOQUE: MARCA DURABLE DE REVISIÓN MANUAL =====
  // Decisión firmada 2026-07-31: la banda USD 250K-5MM avisa, no bloquea.
  // El rastro para el equipo se persiste AQUÍ (misma transacción que el
  // guardado) y no en logs del servidor Next, que en producción descartan
  // `info` y dejarían el monto fuera de banda sin marca observable.
  const fundraisingResubmitted = args.seekingAmount !== undefined || args.currency !== undefined

  if (
    fundraisingResubmitted &&
    updatedCompany &&
    isOutsideUsdFocusBand(updatedCompany.seekingAmount, updatedCompany.currency)
  ) {
    // Sin cambio real no hay evento nuevo — salvo reparación: empresas que
    // ya estaban fuera de banda antes de esta política no tienen marca, y el
    // guard de "solo cambios reales" la dejaría irreparable. Un reenvío del
    // form con los mismos valores la escribe una única vez, deduplicada por
    // el índice by_action_entityId.
    let shouldMark = fundraisingChanged

    if (!shouldMark) {
      const existingBandMarker = yield* convexPromise(() =>
        ctx.db
          .query('activityLogs')
          .withIndex('by_action_entityId', (q) =>
            q.eq('action', 'COMPANY_FUNDRAISING_OUTSIDE_FOCUS_BAND').eq('entityId', `${companyId}`)
          )
          .first()
      )

      shouldMark = !existingBandMarker
    }

    if (shouldMark) {
      yield* convexPromise(() =>
        ctx.db.insert('activityLogs', {
          userId: profile._id,
          action: 'COMPANY_FUNDRAISING_OUTSIDE_FOCUS_BAND',
          entityType: 'COMPANY',
          entityId: `${companyId}`,
          metadata: {
            resourceType: 'COMPANY',
            resourceId: `${companyId}`,
            details: {
              seekingAmount: updatedCompany.seekingAmount,
              currency: updatedCompany.currency,
              focusBandMin: FOCUS_BAND_MIN_USD,
              focusBandMax: FOCUS_BAND_MAX_USD,
            },
          },
        })
      )
    }
  }

  return updatedCompany
})

export const updateCompany = mutation({
  args: updateCompanyArgs,
  handler: (ctx, args) => runConvex(updateCompanyProgram(ctx, args)),
})

const updateContactPhoneProgram = Effect.fn('Companies.updateContactPhone')(function* (
  ctx: MutationCtx,
  args: { companyId: Id<'companies'>; phone: string }
) {
  const auth = yield* requireAuthEffect(ctx)
  const denialMessage = 'Solo el dueño de la empresa puede guardar su teléfono de contacto'
  if (auth.profile.role !== 'COMPANY') return yield* Effect.fail(unauthorized(denialMessage))
  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company || auth.profile._id !== company.ownerId) {
    return yield* Effect.fail(unauthorized(denialMessage))
  }
  yield* convexPromise(() =>
    requireCompanyManagementAuthorization(ctx, auth, company, denialMessage)
  )
  const phone = normalizeContactPhone(args.phone)
  if (phone === null) {
    return yield* Effect.fail(validationFailed('Escribe un teléfono de 7 a 15 dígitos'))
  }
  if (auth.profile.phone !== phone) {
    yield* convexPromise(() => ctx.db.patch(company.ownerId, { phone }))
    yield* convexPromise(() =>
      ctx.db.insert('activityLogs', {
        userId: auth.profile._id,
        action: 'COMPANY_CONTACT_PHONE_UPDATED',
        entityType: 'COMPANY',
        entityId: String(company._id),
      })
    )
  }
  return { saved: true }
})

export const updateContactPhone = mutation({
  args: { companyId: v.id('companies'), phone: v.string() },
  handler: (ctx, args) => runConvex(updateContactPhoneProgram(ctx, args)),
})

/**
 * Actualizar management team
 * SEGURIDAD: Solo el owner o admin pueden actualizar
 */
const updateManagementTeamProgram = Effect.fn('Companies.updateManagementTeam')(function* (
  ctx: MutationCtx,
  args: {
    companyId: Id<'companies'>
    managementTeam: { name: string; title: string; bio?: string; linkedin?: string }[]
  }
) {
  // ===== AUTH: Verificar autenticación y ownership =====
  const auth = yield* requireAuthEffect(ctx)

  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) {
    return yield* Effect.fail(notFound('Empresa', args.companyId))
  }

  // Solo el owner o admin pueden actualizar
  yield* convexPromise(() =>
    requireCompanyManagementAuthorization(
      ctx,
      auth,
      company,
      'No autorizado: Solo el dueño o admin pueden actualizar el equipo'
    )
  )

  yield* convexPromise(() =>
    ctx.db.patch(args.companyId, {
      managementTeam: args.managementTeam,
    })
  )
})

export const updateManagementTeam = mutation({
  args: {
    companyId: v.id('companies'),
    managementTeam: v.array(
      v.object({
        name: v.string(),
        title: v.string(),
        bio: v.optional(v.string()),
        linkedin: v.optional(v.string()),
      })
    ),
  },
  handler: (ctx, args) => runConvex(updateManagementTeamProgram(ctx, args)),
})

/**
 * Cambiar el estado de material aprobado para compartir (admin-only).
 * El equipo lo activa tras revisión; el owner no puede hacerlo por su cuenta
 * (`updateCompany` descarta `isPublic` venga de quien venga). Esta es la acción
 * explícita y auditada del equipo, aunque el nombre persistido siga congelado.
 */
const setCompanyVisibilityProgram = Effect.fn('Companies.setCompanyVisibility')(function* (
  ctx: MutationCtx,
  args: { companyId: Id<'companies'>; isPublic: boolean }
) {
  const auth = yield* requireAuthEffect(ctx)
  const { identity, profile, user } = auth
  yield* convexSync(() => requireAdmin(profile))
  if (!isCurrentCompanyAuthorizationSession(auth)) {
    return yield* Effect.fail(
      unauthorized('No tienes permiso para cambiar la visibilidad de esta empresa')
    )
  }

  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) {
    return yield* Effect.fail(notFound('Empresa', args.companyId))
  }

  if (company.isPublic === args.isPublic) {
    return yield* convexPromise(() => ctx.db.get(args.companyId))
  }

  yield* convexPromise(() => ctx.db.patch(args.companyId, { isPublic: args.isPublic }))

  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: identity.email ?? user.email,
      action: 'COMPANY_VISIBILITY_CHANGE',
      targetType: 'COMPANY',
      targetId: `${args.companyId}`,
      previousValue: { isPublic: company.isPublic ?? false },
      newValue: { isPublic: args.isPublic },
      notes: args.isPublic
        ? 'Material de empresa aprobado para compartir tras revisión del equipo.'
        : 'Aprobación para compartir material de empresa retirada.',
    })
  )

  return yield* convexPromise(() => ctx.db.get(args.companyId))
})

export const setCompanyVisibility = mutation({
  args: {
    companyId: v.id('companies'),
    isPublic: v.boolean(),
  },
  handler: (ctx, args) => runConvex(setCompanyVisibilityProgram(ctx, args)),
})

/**
 * Completar paso de onboarding
 * SEGURIDAD: Solo el owner o admin pueden completar pasos de onboarding
 */
const completeOnboardingStepProgram = Effect.fn('Companies.completeOnboardingStep')(function* (
  ctx: MutationCtx,
  args: { companyId: Id<'companies'>; step: number }
) {
  // ===== AUTH: Verificar autenticación y ownership =====
  const auth = yield* requireAuthEffect(ctx)

  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) return yield* Effect.fail(notFound('Empresa', args.companyId))

  // Solo el owner o admin pueden actualizar el onboarding
  yield* convexPromise(() =>
    requireCompanyManagementAuthorization(
      ctx,
      auth,
      company,
      'No autorizado: Solo el dueño o admin pueden completar el onboarding'
    )
  )

  const updates: Record<string, unknown> = {
    onboardingStep: args.step + 1,
  }

  // Si es el último paso, marcar como completado
  if (args.step >= 4) {
    updates.onboardingCompletedAt = Date.now()
  }

  yield* convexPromise(() => ctx.db.patch(args.companyId, updates))
})

export const completeOnboardingStep = mutation({
  args: {
    companyId: v.id('companies'),
    step: v.number(),
  },
  handler: (ctx, args) => runConvex(completeOnboardingStepProgram(ctx, args)),
})
