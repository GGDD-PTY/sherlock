// ============================================================================
// Sherlock - ADMIN FUNCTIONS
// ============================================================================
// Funciones administrativas para operaciones de mantenimiento de datos.
// IMPORTANTE: Funciones internas son solo para uso desde el dashboard de Convex.
// Funciones públicas (query/mutation) requieren autenticación ADMIN.
// ============================================================================

import { v, type Infer } from 'convex/values'
import { Effect } from 'effect'

import type { Id } from './_generated/dataModel'
import { mutation, type MutationCtx } from './_generated/server'
import { internalMutation } from './_generated/server'
import { requireAuthAdmin } from './_helpers/auth'
import { logAdminAction } from './_helpers/auditLog'
import { mapExistingDocs } from './_helpers/batch'
import { convexPromise, runConvex } from './_helpers/effect'
import { alreadyExists, notFound, validationFailed } from './_helpers/errors'
import { COMPANY_NAME_MAX_LENGTH, normalizeCompanyName } from './_helpers/companyName'

// ============================================================================
// PUBLIC MUTATIONS - Requieren autenticación ADMIN
// ============================================================================

const listUsersForImpersonationProgram = Effect.fn('Admin.listUsersForImpersonation')(function* (
  ctx: MutationCtx,
  args: { search?: string; limit?: number }
) {
  // Verificar que el usuario es ADMIN
  const { user, profile } = yield* convexPromise(() => requireAuthAdmin(ctx))

  const limit = args.limit ?? 50

  // Sanitizar input de búsqueda: cap a 100 caracteres
  const sanitizedSearch = args.search?.slice(0, 100)

  // Obtener todos los perfiles con un límite seguro para búsqueda
  // Aplicaremos el límite del usuario después del filtrado
  const profiles = yield* convexPromise(() => ctx.db.query('profiles').take(1000)) // Límite seguro alto

  // Enriquecer perfiles con email del usuario
  // Batch fetch all users in one request for better performance
  const userIds = profiles.map((p) => p.userId)
  const users = yield* Effect.forEach(userIds, (id) => convexPromise(() => ctx.db.get(id)), {
    concurrency: 'unbounded',
  })
  const userMap = mapExistingDocs(users)

  const profilesWithEmail = profiles.map((p) => ({
    ...p,
    email: userMap.get(p.userId)?.email,
  }))

  // Filtrar por búsqueda si se proporciona
  let filteredProfiles = profilesWithEmail
  if (sanitizedSearch) {
    const searchLower = sanitizedSearch.toLowerCase()
    filteredProfiles = profilesWithEmail.filter((p) => {
      const fullName = p.fullName?.toLowerCase() ?? ''
      const email = p.email?.toLowerCase() ?? ''
      return fullName.includes(searchLower) || email.includes(searchLower)
    })
  }

  // Aplicar límite después del filtrado
  filteredProfiles = filteredProfiles.slice(0, limit)

  // Mapear a formato seguro para impersonación
  const results = filteredProfiles.map((p) => ({
    id: p._id,
    fullName: p.fullName ?? 'Sin nombre',
    email: p.email ?? 'Sin email',
    role: p.role ?? 'COMPANY',
    avatarUrl: p.avatarUrl,
    isVerified: p.isVerified ?? false,
  }))

  // Registrar en audit log
  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: user.email,
      action: 'IMPERSONATION_LIST_SEARCH',
      targetType: 'SYSTEM',
      notes: sanitizedSearch
        ? `Búsqueda de impersonación: "${sanitizedSearch}" — ${results.length} resultados`
        : `Listado de impersonación sin filtro — ${results.length} resultados`,
    })
  )

  return results
})

/**
 * Listar usuarios para impersonación
 * Solo disponible para ADMIN
 * Retorna lista simplificada de usuarios (sin datos sensibles)
 * Registra la búsqueda en el audit log
 *
 * NOTE: Declared as mutation (not query) because it writes to the audit log.
 * This is intentional — the audit trail for impersonation searches is required.
 */
export const listUsersForImpersonation = mutation({
  args: {
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: (ctx, args) => runConvex(listUsersForImpersonationProgram(ctx, args)),
})

const getUserForImpersonationProgram = Effect.fn('Admin.getUserForImpersonation')(function* (
  ctx: MutationCtx,
  args: { userId: Id<'profiles'> }
) {
  // Verificar que el usuario es ADMIN
  const { user: adminUser, profile: adminProfile } = yield* convexPromise(() =>
    requireAuthAdmin(ctx)
  )

  const targetProfile = yield* convexPromise(() => ctx.db.get(args.userId))
  if (!targetProfile) {
    return null
  }

  // Obtener email del usuario objetivo
  const targetUser = yield* convexPromise(() => ctx.db.get(targetProfile.userId))

  // Si es COMPANY, obtener su empresa
  const companyProfile =
    targetProfile.role === 'COMPANY'
      ? yield* convexPromise(() =>
          ctx.db
            .query('companies')
            .withIndex('by_ownerId', (q) => q.eq('ownerId', targetProfile._id))
            .first()
        )
      : null

  // Registrar en audit log
  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: adminProfile._id,
      adminEmail: adminUser.email,
      action: 'IMPERSONATION_USER_ACCESS',
      targetType: 'PROFILE',
      targetId: targetProfile._id,
      notes: `Acceso de impersonación al usuario "${targetProfile.fullName ?? 'Sin nombre'}" (${targetUser?.email ?? 'Sin email'})`,
    })
  )

  return {
    id: targetProfile._id,
    fullName: targetProfile.fullName ?? 'Sin nombre',
    email: targetUser?.email ?? 'Sin email',
    role: targetProfile.role ?? 'COMPANY',
    avatarUrl: targetProfile.avatarUrl,
    isVerified: targetProfile.isVerified ?? false,
    // Datos adicionales según rol
    companyName: companyProfile?.name,
  }
})

/**
 * Obtener un usuario específico para impersonación
 * Solo disponible para ADMIN
 * Registra el acceso en el audit log
 */
export const getUserForImpersonation = mutation({
  args: {
    userId: v.id('profiles'),
  },
  handler: (ctx, args) => runConvex(getUserForImpersonationProgram(ctx, args)),
})

// ============================================================================
// MUTATIONS - Para crear y modificar datos
// ============================================================================

// Los validadores se declaran una vez: `internalMutation` los consume como
// `args` y el programa deriva su tipo del mismo objeto con `Infer`.
const createMockCompanyArgs = v.object({
  // Requeridos
  ownerId: v.id('profiles'),
  name: v.string(),
  country: v.string(),
  // Opcionales - información básica
  legalName: v.optional(v.string()),
  tagline: v.optional(v.string()),
  website: v.optional(v.string()),
  description: v.optional(v.string()),
  longDescription: v.optional(v.string()),
  // Opcionales - clasificación: texto libre, igual que el schema
  sector: v.optional(v.string()),
  industry: v.optional(v.string()),
  businessModel: v.optional(v.string()),
  stage: v.optional(v.string()),
  // Opcionales - detalles
  foundedYear: v.optional(v.number()),
  employees: v.optional(v.string()),
  revenueRange: v.optional(v.string()),
  city: v.optional(v.string()),
  // Visibilidad
  isPublic: v.optional(v.boolean()),
  isFeatured: v.optional(v.boolean()),
})

const createMockCompanyProgram = Effect.fn('Admin.createMockCompany')(function* (
  ctx: MutationCtx,
  args: Infer<typeof createMockCompanyArgs>
) {
  // Verificar que el owner existe
  const owner = yield* convexPromise(() => ctx.db.get(args.ownerId))
  if (!owner) {
    return yield* Effect.fail(notFound('Owner profile', args.ownerId))
  }

  // Crear la empresa
  // Nota: Esta función permite crear múltiples empresas para el mismo owner
  // (a diferencia de createCompany normal que valida unicidad)
  const companyId = yield* convexPromise(() =>
    ctx.db.insert('companies', {
      ownerId: args.ownerId,
      name: args.name,
      country: args.country,
      legalName: args.legalName,
      tagline: args.tagline,
      website: args.website,
      description: args.description,
      longDescription: args.longDescription,
      sector: args.sector,
      industry: args.industry,
      businessModel: args.businessModel,
      stage: args.stage,
      foundedYear: args.foundedYear,
      employees: args.employees,
      revenueRange: args.revenueRange,
      city: args.city,
      currency: 'USD',
      isPublic: args.isPublic ?? true,
      isFeatured: args.isFeatured ?? false,
      onboardingStep: 6, // Completado
    })
  )

  return {
    companyId,
    message: `Empresa "${args.name}" creada exitosamente`,
  }
})

/**
 * Crear una empresa mock (sin owner real)
 * Útil para testing y demos
 *
 * NOTA: Requiere un ownerId válido. Para empresas mock, usar el ID del admin.
 *
 * Sector, industria, stage y business model: texto libre.
 */
export const createMockCompany = internalMutation({
  args: createMockCompanyArgs.fields,
  handler: (ctx, args) => runConvex(createMockCompanyProgram(ctx, args)),
})

// ============================================================================
// INTERNAL MUTATIONS DE OPERACIÓN - Reparación manual de filas
// ============================================================================
// Sin entrada en `adminAuditLogs`: `logAdminAction` exige un actor autenticado
// (`adminProfileId`, `adminEmail`) que un `bunx convex run` no tiene. Igual que
// `createMockCompany`; el registro es la invocación del operador.

const setCompanyNameProgram = Effect.fn('Admin.setCompanyName')(function* (
  ctx: MutationCtx,
  args: { companyId: Id<'companies'>; name: string }
) {
  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) {
    return yield* Effect.fail(notFound('Empresa', args.companyId))
  }

  const name = normalizeCompanyName(args.name)
  if (!name) {
    return yield* Effect.fail(
      validationFailed(
        `El nombre de la empresa no es válido: revisa que no esté vacío ni pase de ${COMPANY_NAME_MAX_LENGTH} caracteres.`,
        'name'
      )
    )
  }

  // El nombre viejo se captura antes del patch: es el recibo para revertir.
  const previousName = company.name
  yield* convexPromise(() => ctx.db.patch(args.companyId, { name }))
  return { companyId: args.companyId, previousName, name }
})

/**
 * Corrige el nombre de una empresa que quedó con el nombre auto-derivado del
 * login (`companies.ensureCompanyWorkspace`) en vez del que declaró el cliente.
 */
export const setCompanyName = internalMutation({
  args: {
    companyId: v.id('companies'),
    name: v.string(),
  },
  handler: (ctx, args) => runConvex(setCompanyNameProgram(ctx, args)),
})

const repairUserEmailProgram = Effect.fn('Admin.repairUserEmail')(function* (
  ctx: MutationCtx,
  args: { userId: Id<'users'>; email: string; retireCollidingUserId?: Id<'users'> }
) {
  const user = yield* convexPromise(() => ctx.db.get(args.userId))
  if (!user) {
    return yield* Effect.fail(notFound('Usuario', args.userId))
  }

  // Sin bajar a minúsculas: `users.by_email` es un índice de string exacto y
  // el resto del código lo consulta con el email tal cual llega del proveedor.
  const email = args.email.trim()
  if (!email.includes('@') || /\s/.test(email)) {
    return yield* Effect.fail(
      validationFailed('El email no es válido: revisa que traiga un "@" y ningún espacio.', 'email')
    )
  }

  const sharingEmail = yield* convexPromise(() =>
    ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', email))
      .collect()
  )

  let retired: Id<'users'> | null = null
  for (const candidate of sharingEmail) {
    if (candidate._id === args.userId) continue
    if (candidate._id !== args.retireCollidingUserId) {
      return yield* Effect.fail(alreadyExists('Usuario', email))
    }
    yield* convexPromise(() =>
      ctx.db.patch(candidate._id, { email: `legacy+${candidate._id}@retired.local` })
    )
    retired = candidate._id
  }

  yield* convexPromise(() => ctx.db.patch(args.userId, { email }))
  return { userId: args.userId, email, retired }
})

/**
 * Corrige el email de un usuario. Cuando el email correcto lo retiene una fila
 * vieja (un alta duplicada), el operador la designa explícitamente en
 * `retireCollidingUserId` y esa fila se jubila antes de liberar el email; sin
 * esa designación la colisión es un error, no algo que se resuelva solo.
 */
export const repairUserEmail = internalMutation({
  args: {
    userId: v.id('users'),
    email: v.string(),
    retireCollidingUserId: v.optional(v.id('users')),
  },
  handler: (ctx, args) => runConvex(repairUserEmailProgram(ctx, args)),
})

const setUserRoleProgram = Effect.fn('Admin.setUserRole')(function* (
  ctx: MutationCtx,
  args: { userId: Id<'users'>; role: 'ADMIN' | 'COMPANY' }
) {
  const user = yield* convexPromise(() => ctx.db.get(args.userId))
  if (!user) {
    return yield* Effect.fail(notFound('Usuario', args.userId))
  }
  const profile = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', args.userId))
      .first()
  )
  if (!profile) {
    return yield* Effect.fail(notFound('Perfil', args.userId))
  }
  const previousRole = profile.role
  // `isActive` se NORMALIZA, no se enciende. Es opcional, su default de
  // producto es "activo", y el índice `by_role_isActive` no lo sabe: un ADMIN
  // sin la bandera queda fuera del rango que lee el aviso al equipo y no
  // recibe ni campanita ni correo, así que `undefined` se escribe como
  // `true`. Un `false` explícito es OTRA cosa: la desactivación pegajosa de
  // `deactivateOwnAccount` o del webhook `user.deleted`, que ni un webhook
  // posterior del IdP revierte. Cambiar de rol no es reactivar una cuenta.
  const isActivePatch = profile.isActive === undefined ? { isActive: true } : {}
  yield* convexPromise(() => ctx.db.patch(profile._id, { role: args.role, ...isActivePatch }))
  yield* convexPromise(() => ctx.db.patch(user._id, { role: args.role }))
  return { userId: user._id, email: user.email, previousRole, role: args.role }
})

/**
 * Fija el rol de un usuario desde la CLI del operador. Es el camino cuando
 * ningún perfil de prod es ADMIN todavía (2026-09-01: cero) y `makeAdmin`,
 * que exige un admin llamante, no puede arrancar. Toca perfil y usuario, como
 * `makeAdmin`, para que `useCurrentUser` lo vea en la sesión siguiente.
 */
export const setUserRole = internalMutation({
  args: {
    userId: v.id('users'),
    role: v.union(v.literal('ADMIN'), v.literal('COMPANY')),
  },
  handler: (ctx, args) => runConvex(setUserRoleProgram(ctx, args)),
})
