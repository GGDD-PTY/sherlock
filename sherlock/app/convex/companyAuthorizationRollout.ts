import { v } from 'convex/values'
import { Effect, Schema } from 'effect'

import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { requireAuthAdmin } from './_helpers/auth'
import { logAdminAction } from './_helpers/auditLog'
import {
  COMPANY_ORG_BINDING_CONTROL_KEY,
  USER_MEMBERSHIP_CAP,
  isCurrentCompanyAuthorizationSession,
  isCompanyOrganizationBindingEnforced,
  loadCompanyOwnerMembershipEvidence,
} from './_helpers/companyAuthorization'
import { convexPromise, runConvex } from './_helpers/effect'
import type { AppError } from './_helpers/errors'
import { invalidState, notFound, unauthorized, validationFailed } from './_helpers/errors'

const DEFAULT_BATCH_SIZE = 50
const MAX_BATCH_SIZE = 100
const CUTOVER_COMPANY_CAP = 100
const RESOLUTION_REASON_MIN = 10
const RESOLUTION_REASON_MAX = 500

type RolloutCtx = QueryCtx | MutationCtx

// El vocabulario del rollout, definido UNA vez. `schema.ts` conserva su
// `v.union(v.literal(...))` porque es lo que lee el codegen de Convex; de este
// lado manda esta lista: el tipo del módulo se deriva de ella y el resumen se
// cuenta recorriéndola, así que agregar un estado sexto no puede dejar una
// columna del resumen en cero sin que el compilador lo diga.
const BindingStatusSchema = Schema.Literals([
  'LEGACY',
  'BOUND',
  'UNRESOLVED',
  'AMBIGUOUS',
  'INVALID_BINDING',
])
type BindingStatus = (typeof BindingStatusSchema)['Type']

// Las tres fases del cutover, en el mismo orden en que avanza el rollout.
// Sin `Schema.Literals`: nada llega aquí con esta forma desde fuera, así que un
// schema sería un valor en el bundle que nadie llama.
type RolloutPhase = 'UNENFORCED' | 'PREPARING' | 'ENFORCED'

type BindingInspection = {
  companyId: Id<'companies'>
  workosOwned: boolean
  status: BindingStatus
  candidateProviderOrgIds: string[]
  duplicateCandidateProviderOrgIds: string[]
  usableMembershipCount: number
  membershipCapExceeded: boolean
  bindingCount: number
}

const inspectCompanyBinding = Effect.fn('Rollout.inspectBinding')(function* (
  ctx: RolloutCtx,
  company: Doc<'companies'>
): Effect.fn.Return<BindingInspection, AppError> {
  const bindings = yield* convexPromise(() =>
    ctx.db
      .query('companyOrganizationBindings')
      .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
      .take(3)
  )
  const ownerProfile = yield* convexPromise(() => ctx.db.get(company.ownerId))
  const ownerUser = yield* convexPromise(() =>
    ownerProfile ? ctx.db.get(ownerProfile.userId) : Promise.resolve(null)
  )
  if (!ownerProfile || !ownerUser) {
    return {
      companyId: company._id,
      workosOwned: true,
      status: 'INVALID_BINDING',
      candidateProviderOrgIds: [],
      duplicateCandidateProviderOrgIds: [],
      usableMembershipCount: 0,
      membershipCapExceeded: false,
      bindingCount: bindings.length,
    }
  }
  if (ownerProfile.role !== 'COMPANY' || ownerProfile.isActive === false) {
    return {
      companyId: company._id,
      workosOwned: Boolean(ownerUser.workosUserId || bindings.length > 0),
      status: 'INVALID_BINDING',
      candidateProviderOrgIds: [],
      duplicateCandidateProviderOrgIds: [],
      usableMembershipCount: 0,
      membershipCapExceeded: false,
      bindingCount: bindings.length,
    }
  }
  if (!ownerUser.workosUserId) {
    return {
      companyId: company._id,
      workosOwned: bindings.length > 0,
      status: bindings.length === 0 ? ('LEGACY' as const) : ('INVALID_BINDING' as const),
      candidateProviderOrgIds: [],
      duplicateCandidateProviderOrgIds: [],
      usableMembershipCount: 0,
      membershipCapExceeded: false,
      bindingCount: bindings.length,
    }
  }

  const evidence = yield* loadCompanyOwnerMembershipEvidence(ctx, ownerUser, ownerProfile._id)
  if (evidence.memberships.length > USER_MEMBERSHIP_CAP) {
    return {
      companyId: company._id,
      workosOwned: true,
      status: 'AMBIGUOUS',
      candidateProviderOrgIds: [],
      duplicateCandidateProviderOrgIds: [],
      usableMembershipCount: evidence.memberships.length,
      membershipCapExceeded: true,
      bindingCount: bindings.length,
    }
  }

  const usableMemberships = evidence.usableMemberships
  const candidateProviderOrgIds = [
    ...new Set(usableMemberships.map((membership) => membership.providerOrgId)),
  ].sort()
  const duplicateCandidateProviderOrgIds = candidateProviderOrgIds.filter(
    (providerOrgId) =>
      usableMemberships.filter((membership) => membership.providerOrgId === providerOrgId).length >
      1
  )
  if (bindings.length === 1) {
    const binding = bindings[0]
    const exactUsableMemberships = usableMemberships.filter(
      (membership) => membership.providerOrgId === binding.providerOrgId
    )
    const valid =
      binding.companyId === company._id &&
      binding.ownerProfileId === company.ownerId &&
      binding.authProvider === 'workos' &&
      binding.providerOrgId.trim().length > 0 &&
      exactUsableMemberships.length === 1 &&
      (binding.source !== 'BACKFILL' || evidence.unambiguousProviderOrgId === binding.providerOrgId)
    if (valid) {
      return {
        companyId: company._id,
        workosOwned: true,
        status: 'BOUND',
        candidateProviderOrgIds,
        duplicateCandidateProviderOrgIds,
        usableMembershipCount: usableMemberships.length,
        membershipCapExceeded: false,
        bindingCount: 1,
      }
    }
  }

  const status: BindingStatus =
    bindings.length > 1 ||
    (bindings.length === 0 &&
      (usableMemberships.length > 1 ||
        (usableMemberships.length === 1 && !evidence.unambiguousProviderOrgId)))
      ? 'AMBIGUOUS'
      : bindings.length === 1
        ? 'INVALID_BINDING'
        : 'UNRESOLVED'
  return {
    companyId: company._id,
    workosOwned: true,
    status,
    candidateProviderOrgIds,
    duplicateCandidateProviderOrgIds,
    usableMembershipCount: usableMemberships.length,
    membershipCapExceeded: false,
    bindingCount: bindings.length,
  }
})

function summarize(
  inspections: Array<{
    workosOwned: boolean
    status: BindingStatus
  }>
) {
  // Un solo recorrido, y la lista de estados sale del `Schema.Literals` de
  // arriba en vez de repetirse cinco veces en cinco `filter`.
  const tally = Object.fromEntries(
    BindingStatusSchema.literals.map((status) => [status, 0])
  ) as Record<BindingStatus, number>
  for (const row of inspections) tally[row.status] = (tally[row.status] ?? 0) + 1
  return {
    totalCompanies: inspections.length,
    workosOwned: inspections.filter((row) => row.workosOwned).length,
    bound: tally.BOUND,
    unresolved: tally.UNRESOLVED,
    ambiguous: tally.AMBIGUOUS,
    invalid: tally.INVALID_BINDING,
    legacy: tally.LEGACY,
  }
}

const loadControl = Effect.fn('Rollout.loadControl')(function* (ctx: RolloutCtx) {
  const controls = yield* convexPromise(() =>
    ctx.db
      .query('companyAuthorizationControls')
      .withIndex('by_key', (q) => q.eq('key', COMPANY_ORG_BINDING_CONTROL_KEY))
      .take(2)
  )
  if (controls.length > 1) {
    return yield* Effect.fail(
      invalidState(
        'El control de autorización está duplicado y requiere reconciliación.',
        'COMPANY_AUTHORIZATION_CONTROL_AMBIGUOUS'
      )
    )
  }
  return controls[0] ?? null
})

const upsertInventoryRow = Effect.fn('Rollout.upsertInventoryRow')(function* (
  ctx: MutationCtx,
  epoch: string,
  company: Doc<'companies'>,
  inspection: BindingInspection
) {
  const rows = yield* convexPromise(() =>
    ctx.db
      .query('companyAuthorizationInventoryRows')
      .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
      .take(2)
  )
  if (rows.length > 1) {
    yield* Effect.fail(
      invalidState(
        'La evidencia de inventario de la empresa está duplicada.',
        'COMPANY_AUTHORIZATION_INVENTORY_DUPLICATED'
      )
    )
  }
  const value = {
    companyId: company._id,
    ownerProfileId: company.ownerId,
    epoch,
    workosOwned: inspection.workosOwned,
    status: inspection.status,
    candidateCount: inspection.usableMembershipCount,
    bindingCount: inspection.bindingCount,
    observedAt: Date.now(),
  }
  const target = rows[0]
  if (target) yield* convexPromise(() => ctx.db.patch(target._id, value))
  else yield* convexPromise(() => ctx.db.insert('companyAuthorizationInventoryRows', value))
})

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const recordInventoryForCreation = Effect.fn('Rollout.recordInventoryForCreation')(function* (
  ctx: MutationCtx,
  companyId: Id<'companies'>
) {
  const control = yield* loadControl(ctx)
  if (control?.status !== 'PREPARING' || !control.inventoryEpoch) return
  const company = yield* convexPromise(() => ctx.db.get(companyId))
  if (!company) return
  const inspection = yield* inspectCompanyBinding(ctx, company)
  yield* upsertInventoryRow(ctx, control.inventoryEpoch, company, inspection)
})

// El borde Promise que conservan `companies.ts` y `users.ts`.
export function recordCompanyAuthorizationInventoryForCreation(
  ctx: MutationCtx,
  companyId: Id<'companies'>
): Promise<void> {
  return runConvex(recordInventoryForCreation(ctx, companyId))
}

// La fase que rige hoy. Es lo único que el panel necesita saber para elegir
// entre «inventariando» y «cutover activo», y sale de una sola decisión.
const resolveRolloutPhase = Effect.fn('Rollout.resolvePhase')(function* (
  ctx: RolloutCtx,
  control: Doc<'companyAuthorizationControls'> | null
) {
  const enforced = yield* convexPromise(() => isCompanyOrganizationBindingEnforced(ctx))
  const phase: RolloutPhase = enforced
    ? 'ENFORCED'
    : control?.status === 'PREPARING'
      ? 'PREPARING'
      : 'UNENFORCED'
  return phase
})

const getBindingInventory = Effect.fn('Rollout.getInventory')(function* (
  ctx: QueryCtx,
  args: { cursor?: string; numItems?: number }
) {
  const auth = yield* convexPromise(() => requireAuthAdmin(ctx))
  if (!isCurrentCompanyAuthorizationSession(auth)) {
    return yield* Effect.fail(
      unauthorized('No tienes permiso para administrar el rollout de autorización')
    )
  }
  const control = yield* loadControl(ctx)
  const numItems = Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(args.numItems ?? 50)))
  const companyPage = yield* convexPromise(() =>
    ctx.db.query('companies').paginate({ cursor: args.cursor ?? null, numItems })
  )
  const rows: Array<{
    companyId: Id<'companies'>
    companyName: string
    workosOwned: boolean
    status: BindingStatus
    candidateCount: number
    membershipCapExceeded: boolean
    bindingCount: number
    inventoryRecorded: boolean
    inventoryRecordCount: number
    inventoryStatus?: BindingStatus
    inventoryObservedAt?: number
    inventoryDrift: boolean
    createdAfterInventoryStart: boolean
  }> = []
  for (const company of companyPage.page) {
    const inspection = yield* inspectCompanyBinding(ctx, company)
    const inventoryRows = yield* convexPromise(() =>
      ctx.db
        .query('companyAuthorizationInventoryRows')
        .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
        .take(2)
    )
    const epochRows = control?.inventoryEpoch
      ? inventoryRows.filter((row) => row.epoch === control.inventoryEpoch)
      : []
    const inventoryRow = epochRows.length === 1 ? epochRows[0] : undefined
    const inventoryRecorded = Boolean(inventoryRow)
    const inventoryDrift = Boolean(
      control?.inventoryEpoch &&
      (!inventoryRow ||
        inventoryRow.ownerProfileId !== company.ownerId ||
        inventoryRow.workosOwned !== inspection.workosOwned ||
        inventoryRow.status !== inspection.status ||
        inventoryRow.candidateCount !== inspection.usableMembershipCount ||
        inventoryRow.bindingCount !== inspection.bindingCount)
    )
    rows.push({
      companyId: inspection.companyId,
      companyName: company.name,
      workosOwned: inspection.workosOwned,
      status: inspection.status,
      candidateCount: inspection.usableMembershipCount,
      membershipCapExceeded: inspection.membershipCapExceeded,
      bindingCount: inspection.bindingCount,
      inventoryRecorded,
      inventoryRecordCount: epochRows.length,
      inventoryStatus: inventoryRow?.status,
      inventoryObservedAt: inventoryRow?.observedAt,
      inventoryDrift,
      createdAfterInventoryStart: Boolean(
        control?.inventoryStartedAt && company._creationTime > control.inventoryStartedAt
      ),
    })
  }
  return {
    enforcementStatus: yield* resolveRolloutPhase(ctx, control),
    inventoryComplete: Boolean(control?.inventoryCompletedAt),
    inventoryNextCursor: control?.inventoryNextCursor,
    isDone: companyPage.isDone,
    continueCursor: companyPage.continueCursor,
    pageHasDrift: rows.some((row) => row.inventoryDrift),
    pageHasCreationDrift: rows.some((row) => row.createdAfterInventoryStart),
    summary: summarize(rows),
    rows,
  }
})

export const getCompanyOrganizationBindingInventory = query({
  args: {
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: (ctx, args) => runConvex(getBindingInventory(ctx, args)),
})

const getBindingCandidates = Effect.fn('Rollout.getCandidates')(function* (
  ctx: QueryCtx,
  args: { companyId: Id<'companies'> }
) {
  const auth = yield* convexPromise(() => requireAuthAdmin(ctx))
  if (!isCurrentCompanyAuthorizationSession(auth)) {
    return yield* Effect.fail(
      unauthorized('No tienes permiso para administrar el rollout de autorización')
    )
  }
  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) return yield* Effect.fail(notFound('Empresa', args.companyId))
  const inspection = yield* inspectCompanyBinding(ctx, company)
  return {
    companyId: company._id,
    status: inspection.status,
    membershipCapExceeded: inspection.membershipCapExceeded,
    // Provider locators are returned only from this admin-authorized query;
    // the public company row and normal VDR projections never include them.
    candidateProviderOrgIds: inspection.candidateProviderOrgIds,
  }
})

export const getCompanyOrganizationBindingCandidates = query({
  args: { companyId: v.id('companies') },
  handler: (ctx, args) => runConvex(getBindingCandidates(ctx, args)),
})

const backfillBindings = Effect.fn('Rollout.backfillBindings')(function* (
  ctx: MutationCtx,
  args: { cursor?: string; numItems?: number }
) {
  const auth = yield* convexPromise(() => requireAuthAdmin(ctx))
  if (!isCurrentCompanyAuthorizationSession(auth)) {
    return yield* Effect.fail(
      unauthorized('No tienes permiso para administrar el rollout de autorización')
    )
  }
  const { user, profile } = auth
  let control = yield* loadControl(ctx)
  if (control?.status === 'ENFORCED') {
    return yield* Effect.fail(
      invalidState(
        'El cutover ya está activo; usa resolución explícita para reparar bindings.',
        'COMPANY_AUTHORIZATION_ALREADY_ENFORCED'
      )
    )
  }
  const startsNewInventory = !control?.inventoryEpoch
  if (startsNewInventory) {
    if (args.cursor !== undefined) {
      return yield* Effect.fail(
        invalidState(
          'El inventario debe comenzar desde el cursor inicial administrado por el servidor.',
          'COMPANY_AUTHORIZATION_CURSOR_INVALID'
        )
      )
    }
  } else {
    if (control?.inventoryCompletedAt) {
      if (args.cursor !== undefined) {
        return yield* Effect.fail(
          invalidState(
            'El inventario ya fue completado y no acepta cursores adicionales.',
            'COMPANY_AUTHORIZATION_CURSOR_INVALID'
          )
        )
      }
      const completedEpoch = control.inventoryEpoch!
      const inventoryRows = yield* convexPromise(() =>
        ctx.db
          .query('companyAuthorizationInventoryRows')
          .withIndex('by_epoch', (q) => q.eq('epoch', completedEpoch))
          .take(CUTOVER_COMPANY_CAP + 1)
      )
      if (inventoryRows.length > CUTOVER_COMPANY_CAP) {
        return yield* Effect.fail(
          invalidState(
            `El inventario excede el límite de ${CUTOVER_COMPANY_CAP} empresas.`,
            'COMPANY_AUTHORIZATION_CUTOVER_LIMIT_EXCEEDED'
          )
        )
      }
      return {
        inserted: 0,
        unchanged: inventoryRows.filter((row) => row.status === 'BOUND' || row.status === 'LEGACY')
          .length,
        unresolved: inventoryRows.filter(
          (row) => row.status === 'UNRESOLVED' || row.status === 'INVALID_BINDING'
        ).length,
        ambiguous: inventoryRows.filter((row) => row.status === 'AMBIGUOUS').length,
        isDone: true,
        continueCursor: '',
      }
    }
    if (!control?.inventoryNextCursor || args.cursor !== control.inventoryNextCursor) {
      return yield* Effect.fail(
        invalidState(
          'El cursor no coincide con el progreso durable del inventario.',
          'COMPANY_AUTHORIZATION_CURSOR_INVALID'
        )
      )
    }
  }
  const now = Date.now()
  const epoch = control?.inventoryEpoch ?? `${now}:${profile._id}`
  if (control) {
    const existingControl = control
    yield* convexPromise(() =>
      ctx.db.patch(existingControl._id, {
        status: 'PREPARING',
        inventoryEpoch: epoch,
        inventoryStartedAt: existingControl.inventoryStartedAt ?? now,
        inventoryNextCursor: startsNewInventory ? undefined : existingControl.inventoryNextCursor,
        inventoryCompletedAt: undefined,
        updatedAt: now,
      })
    )
  } else {
    const controlId = yield* convexPromise(() =>
      ctx.db.insert('companyAuthorizationControls', {
        key: COMPANY_ORG_BINDING_CONTROL_KEY,
        status: 'PREPARING',
        inventoryEpoch: epoch,
        inventoryStartedAt: now,
        updatedAt: now,
      })
    )
    const insertedControl = yield* convexPromise(() => ctx.db.get(controlId))
    if (!insertedControl) {
      return yield* Effect.fail(
        invalidState(
          'No se pudo persistir el control de inventario.',
          'COMPANY_AUTHORIZATION_CONTROL_WRITE_FAILED'
        )
      )
    }
    control = insertedControl
  }

  const numItems = Math.max(
    1,
    Math.min(MAX_BATCH_SIZE, Math.floor(args.numItems ?? DEFAULT_BATCH_SIZE))
  )
  const pageCursor = startsNewInventory ? null : control!.inventoryNextCursor!
  const page = yield* convexPromise(() =>
    ctx.db.query('companies').paginate({ cursor: pageCursor, numItems })
  )
  let unchanged = 0
  let unresolved = 0
  let ambiguous = 0

  // El inventario no convierte una única membresía observada en autoridad
  // sobre una empresa histórica. Cada vínculo requiere resolución explícita.
  for (const company of page.page) {
    const inspection = yield* inspectCompanyBinding(ctx, company)
    if (!inspection.workosOwned || inspection.status === 'BOUND') unchanged += 1
    else if (inspection.status === 'AMBIGUOUS') ambiguous += 1
    else unresolved += 1
    yield* upsertInventoryRow(ctx, epoch, company, inspection)
  }

  if (control) {
    const trackedControl = control
    const completedAt = page.isDone ? Date.now() : undefined
    yield* convexPromise(() =>
      ctx.db.patch(trackedControl._id, {
        inventoryNextCursor: page.isDone ? undefined : page.continueCursor,
        inventoryCompletedAt: completedAt,
        updatedAt: Date.now(),
      })
    )
  }

  const result = {
    inserted: 0,
    unchanged,
    unresolved,
    ambiguous,
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  }
  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: user.email,
      action: 'SYSTEM_CONFIG_CHANGE',
      targetType: 'SYSTEM',
      targetId: COMPANY_ORG_BINDING_CONTROL_KEY,
      newValue: result,
      notes: 'Inventario de vínculos empresa-organización; sin asignación automática.',
    })
  )
  return result
})

export const backfillCompanyOrganizationBindings = mutation({
  args: {
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: (ctx, args) => runConvex(backfillBindings(ctx, args)),
})

const resolveBinding = Effect.fn('Rollout.resolveBinding')(function* (
  ctx: MutationCtx,
  args: { companyId: Id<'companies'>; providerOrgId: string; reason: string }
) {
  const auth = yield* convexPromise(() => requireAuthAdmin(ctx))
  if (!isCurrentCompanyAuthorizationSession(auth)) {
    return yield* Effect.fail(
      unauthorized('No tienes permiso para administrar el rollout de autorización')
    )
  }
  const { user, profile } = auth
  const providerOrgId = args.providerOrgId.trim()
  const reason = args.reason.trim()
  if (providerOrgId.length < 3 || providerOrgId.length > 200) {
    return yield* Effect.fail(
      validationFailed('La organización WorkOS no es válida.', 'providerOrgId')
    )
  }
  if (reason.length < RESOLUTION_REASON_MIN || reason.length > RESOLUTION_REASON_MAX) {
    return yield* Effect.fail(
      validationFailed(
        `La razón debe tener entre ${RESOLUTION_REASON_MIN} y ${RESOLUTION_REASON_MAX} caracteres.`,
        'reason'
      )
    )
  }

  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) return yield* Effect.fail(notFound('Empresa', args.companyId))
  const ownerProfile = yield* convexPromise(() => ctx.db.get(company.ownerId))
  const ownerUser = yield* convexPromise(() =>
    ownerProfile ? ctx.db.get(ownerProfile.userId) : Promise.resolve(null)
  )
  if (!ownerProfile || !ownerUser?.workosUserId) {
    return yield* Effect.fail(
      validationFailed('La empresa no tiene un owner vinculado a WorkOS.', 'providerOrgId')
    )
  }
  const inspection = yield* inspectCompanyBinding(ctx, company)
  if (
    !inspection.workosOwned ||
    inspection.membershipCapExceeded ||
    !inspection.candidateProviderOrgIds.includes(providerOrgId) ||
    inspection.duplicateCandidateProviderOrgIds.includes(providerOrgId)
  ) {
    return yield* Effect.fail(
      validationFailed(
        'La organización seleccionada no tiene evidencia owner para esta empresa.',
        'providerOrgId'
      )
    )
  }

  const bindings = yield* convexPromise(() =>
    ctx.db
      .query('companyOrganizationBindings')
      .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
      .take(11)
  )
  if (bindings.length > 10) {
    return yield* Effect.fail(
      invalidState(
        'Hay demasiados vínculos duplicados para resolverlos en esta operación.',
        'COMPANY_AUTHORIZATION_BINDING_LIMIT_EXCEEDED'
      )
    )
  }
  const now = Date.now()
  const previousProviderOrgDigests = yield* convexPromise(() =>
    Promise.all(
      [...new Set(bindings.map((binding) => binding.providerOrgId))]
        .sort()
        .map(async (value) => await sha256Hex(value))
    )
  )
  const selectedProviderOrgDigest = yield* convexPromise(() => sha256Hex(providerOrgId))
  const primaryBinding = bindings[0]
  if (primaryBinding) {
    yield* convexPromise(() =>
      ctx.db.patch(primaryBinding._id, {
        ownerProfileId: company.ownerId,
        authProvider: 'workos',
        providerOrgId,
        source: 'ADMIN_RESOLUTION',
        updatedAt: now,
        updatedByProfileId: profile._id,
        resolutionReason: reason,
      })
    )
    for (const duplicate of bindings.slice(1)) {
      yield* convexPromise(() => ctx.db.delete(duplicate._id))
    }
  } else {
    yield* convexPromise(() =>
      ctx.db.insert('companyOrganizationBindings', {
        companyId: company._id,
        ownerProfileId: company.ownerId,
        authProvider: 'workos',
        providerOrgId,
        createdAt: now,
        createdByProfileId: profile._id,
        source: 'ADMIN_RESOLUTION',
        updatedAt: now,
        updatedByProfileId: profile._id,
        resolutionReason: reason,
      })
    )
  }
  const reinspection = yield* inspectCompanyBinding(ctx, company)

  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: user.email,
      action: 'SYSTEM_CONFIG_CHANGE',
      targetType: 'COMPANY',
      targetId: `${company._id}`,
      previousValue: {
        bindingCount: bindings.length,
        providerOrgDigests: previousProviderOrgDigests,
      },
      newValue: {
        bindingStatus: reinspection.status,
        providerOrgDigest: selectedProviderOrgDigest,
        duplicateBindingsRemoved: Math.max(0, bindings.length - 1),
      },
      notes: reason,
    })
  )
  const control = yield* loadControl(ctx)
  if (control?.status === 'PREPARING' && control.inventoryEpoch) {
    yield* upsertInventoryRow(ctx, control.inventoryEpoch, company, reinspection)
  }
  return { companyId: company._id, status: reinspection.status }
})

export const resolveCompanyOrganizationBinding = mutation({
  args: {
    companyId: v.id('companies'),
    providerOrgId: v.string(),
    reason: v.string(),
  },
  handler: (ctx, args) => runConvex(resolveBinding(ctx, args)),
})

const activateCutover = Effect.fn('Rollout.activateCutover')(function* (ctx: MutationCtx) {
  const auth = yield* convexPromise(() => requireAuthAdmin(ctx))
  if (!isCurrentCompanyAuthorizationSession(auth)) {
    return yield* Effect.fail(
      unauthorized('No tienes permiso para administrar el rollout de autorización')
    )
  }
  const { user, profile } = auth
  const control = yield* loadControl(ctx)
  if (
    !control ||
    control.status !== 'PREPARING' ||
    !control.inventoryEpoch ||
    !control.inventoryCompletedAt
  ) {
    return yield* Effect.fail(
      invalidState(
        'El cutover requiere completar primero el inventario paginado.',
        'COMPANY_AUTHORIZATION_INVENTORY_INCOMPLETE'
      )
    )
  }

  const epoch = control.inventoryEpoch
  const companies = yield* convexPromise(() =>
    ctx.db.query('companies').take(CUTOVER_COMPANY_CAP + 1)
  )
  if (companies.length > CUTOVER_COMPANY_CAP) {
    return yield* Effect.fail(
      invalidState(
        `El cutover admite hasta ${CUTOVER_COMPANY_CAP} empresas por activación.`,
        'COMPANY_AUTHORIZATION_CUTOVER_LIMIT_EXCEEDED'
      )
    )
  }
  const inventoryRows = yield* convexPromise(() =>
    ctx.db
      .query('companyAuthorizationInventoryRows')
      .withIndex('by_epoch', (q) => q.eq('epoch', epoch))
      .take(CUTOVER_COMPANY_CAP + 1)
  )
  if (inventoryRows.length > CUTOVER_COMPANY_CAP) {
    return yield* Effect.fail(
      invalidState(
        `El inventario excede el límite de ${CUTOVER_COMPANY_CAP} empresas por activación.`,
        'COMPANY_AUTHORIZATION_CUTOVER_LIMIT_EXCEEDED'
      )
    )
  }
  const inventoryByCompany = new Map<string, (typeof inventoryRows)[number]>()
  for (const row of inventoryRows) {
    const companyId = `${row.companyId}`
    if (inventoryByCompany.has(companyId)) {
      return yield* Effect.fail(
        invalidState(
          'El inventario tiene filas duplicadas para una empresa.',
          'COMPANY_AUTHORIZATION_INVENTORY_INVALID'
        )
      )
    }
    inventoryByCompany.set(companyId, row)
  }
  if (
    inventoryRows.length !== companies.length ||
    companies.some((company) => !inventoryByCompany.has(`${company._id}`))
  ) {
    return yield* Effect.fail(
      invalidState(
        'El inventario ya no coincide con las empresas actuales. Reinícialo antes del cutover.',
        'COMPANY_AUTHORIZATION_INVENTORY_INVALID'
      )
    )
  }

  const freshInspections: BindingInspection[] = []
  for (const company of companies) {
    const inventoryRow = inventoryByCompany.get(`${company._id}`)!
    if (inventoryRow.ownerProfileId !== company.ownerId) {
      return yield* Effect.fail(
        invalidState(
          'El dueño de una empresa cambió después del inventario. Reinícialo antes del cutover.',
          'COMPANY_AUTHORIZATION_INVENTORY_INVALID'
        )
      )
    }
    const inspection = yield* inspectCompanyBinding(ctx, company)
    if (inspection.workosOwned && inspection.status !== 'BOUND') {
      return yield* Effect.fail(
        invalidState(
          'El cutover requiere una membresía owner activa y exacta para cada empresa WorkOS.',
          'COMPANY_AUTHORIZATION_CUTOVER_BLOCKED'
        )
      )
    }
    freshInspections.push(inspection)
    yield* upsertInventoryRow(ctx, epoch, company, inspection)
  }
  const boundRows = freshInspections.filter(
    (inspection) => inspection.workosOwned && inspection.status === 'BOUND'
  )
  const now = Date.now()
  const enforced: RolloutPhase = 'ENFORCED'
  yield* convexPromise(() =>
    ctx.db.patch(control._id, {
      status: enforced,
      updatedAt: now,
      activatedAt: control.activatedAt ?? now,
      activatedByProfileId: control.activatedByProfileId ?? profile._id,
    })
  )

  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: user.email,
      action: 'SYSTEM_CONFIG_CHANGE',
      targetType: 'SYSTEM',
      targetId: COMPANY_ORG_BINDING_CONTROL_KEY,
      previousValue: { status: control.status, inventoryCompletedAt: control.inventoryCompletedAt },
      newValue: { status: enforced, workosOwned: boundRows.length, bound: boundRows.length },
      notes: 'Cutover de autorización WorkOS activado después de inventario completo.',
    })
  )
  return { status: 'ENFORCED' as const, workosOwned: boundRows.length }
})

export const activateCompanyOrganizationBindingCutover = mutation({
  args: {},
  handler: (ctx) => runConvex(activateCutover(ctx)),
})

const pauseCutover = Effect.fn('Rollout.pauseCutover')(function* (
  ctx: MutationCtx,
  args: { reason: string }
) {
  const auth = yield* convexPromise(() => requireAuthAdmin(ctx))
  if (!isCurrentCompanyAuthorizationSession(auth)) {
    return yield* Effect.fail(
      unauthorized('No tienes permiso para administrar el rollout de autorización')
    )
  }
  const { user, profile } = auth
  const reason = args.reason.trim()
  if (reason.length < RESOLUTION_REASON_MIN || reason.length > RESOLUTION_REASON_MAX) {
    return yield* Effect.fail(
      validationFailed(
        `La razón debe tener entre ${RESOLUTION_REASON_MIN} y ${RESOLUTION_REASON_MAX} caracteres.`,
        'reason'
      )
    )
  }

  const control = yield* loadControl(ctx)
  if (!control) {
    return yield* Effect.fail(
      invalidState(
        'No existe un cutover que pausar o reiniciar.',
        'COMPANY_AUTHORIZATION_CONTROL_MISSING'
      )
    )
  }
  const now = Date.now()
  yield* convexPromise(() =>
    ctx.db.patch(control._id, {
      status: 'UNENFORCED',
      inventoryEpoch: undefined,
      inventoryStartedAt: undefined,
      inventoryNextCursor: undefined,
      inventoryCompletedAt: undefined,
      activatedAt: undefined,
      activatedByProfileId: undefined,
      updatedAt: now,
    })
  )
  const result = {
    status: 'UNENFORCED' as const,
    inventoryReset: true,
    bindingsPreserved: true,
  }
  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: user.email,
      action: 'SYSTEM_CONFIG_CHANGE',
      targetType: 'SYSTEM',
      targetId: COMPANY_ORG_BINDING_CONTROL_KEY,
      previousValue: {
        status: control.status,
        inventoryStartedAt: control.inventoryStartedAt,
        inventoryCompletedAt: control.inventoryCompletedAt,
        activatedAt: control.activatedAt,
      },
      newValue: result,
      notes: reason,
    })
  )
  return result
})

export const pauseCompanyOrganizationBindingCutover = mutation({
  args: { reason: v.string() },
  handler: (ctx, args) => runConvex(pauseCutover(ctx, args)),
})
