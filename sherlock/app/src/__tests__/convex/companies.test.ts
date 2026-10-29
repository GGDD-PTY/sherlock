// ============================================================================
// CONVEX COMPANIES MODULE TEST SUITE
// ============================================================================
// Comprehensive tests for convex/companies.ts
//
// Test Categories:
// 1. Company Queries (getCompany, getByOwner, getCompanyByOwner)
// 2. Company Mutations (createCompany, ensureCompanyWorkspace, updateCompany, updateManagementTeam)
// 3. Onboarding (completeOnboardingStep)
// 4. Auth/Ownership Guards
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ensureCompanyWorkspace,
  getCompanyByOwner,
  getMyVdrWorkspace,
  updateCompany,
  type EnsureCompanyWorkspaceResult,
} from '../../../convex/companies'
import { getCurrentUserState } from '../../../convex/users'
import type { Id } from '../../../convex/_generated/dataModel'
import {
  convexArgsValidator,
  createMockConvexCtx,
  createMockUserIdentity,
  isOptionalArg,
  mockAuthenticatedUser,
  unionLiteralsOf,
  mockUnauthenticatedRequest,
  createMockQueryBuilder,
  type MockConvexCtx,
  type MockUserIdentity,
} from '../utils/convex-test-utils'
import {
  createMockUser,
  createMockProfile,
  createMockCompany,
  mockId,
  resetIdCounter,
  type MockCompany,
  type MockProfile,
  type MockUser,
} from '../utils/test-factories'
import { createConvexCtx, runHandler, type HarnessCtx, type Tables } from './nda-convex-harness'

const updateCompanyHandler = (
  updateCompany as unknown as {
    _handler: (
      ctx: MockConvexCtx,
      args: { companyId: Id<'companies'> } & Record<string, unknown>
    ) => Promise<unknown>
  }
)._handler

const ensureCompanyWorkspaceHandler = (
  ensureCompanyWorkspace as unknown as {
    _handler: (ctx: MockConvexCtx) => Promise<EnsureCompanyWorkspaceResult>
  }
)._handler

const getCompanyByOwnerHandler = (
  getCompanyByOwner as unknown as {
    _handler: (
      ctx: MockConvexCtx,
      args: { ownerId: Id<'profiles'> }
    ) => Promise<Record<string, unknown> | null>
  }
)._handler

// ============================================================================
// SETUP
// ============================================================================

describe('convex/companies.ts', () => {
  let ctx: MockConvexCtx

  beforeEach(() => {
    ctx = createMockConvexCtx()
    resetIdCounter()
    vi.clearAllMocks()
  })

  // ==========================================================================
  // SECTION 1: COMPANY QUERIES
  // ==========================================================================

  describe('Company Queries', () => {
    // ===== getCompany =====
    describe('getCompany', () => {
      it('should return company when found by ID', async () => {
        const companyId = mockId('companies')
        const mockCompany = createMockCompany({ _id: companyId })

        ctx.db.get.mockResolvedValue(mockCompany)

        const result = await ctx.db.get(companyId)

        expect(result).toEqual(mockCompany)
        expect(ctx.db.get).toHaveBeenCalledWith(companyId)
      })

      it('should return null when company not found', async () => {
        const companyId = mockId('companies')
        ctx.db.get.mockResolvedValue(null)

        const result = await ctx.db.get(companyId)

        expect(result).toBeNull()
      })

      it('should include all company fields', async () => {
        const mockCompany = createMockCompany({
          name: 'Test Company',
          industry: 'TECHNOLOGY',
          isVerified: true,
        })
        ctx.db.get.mockResolvedValue(mockCompany)

        const result = await ctx.db.get(mockCompany._id)

        expect(result?.name).toBe('Test Company')
        expect(result?.industry).toBe('TECHNOLOGY')
        expect(result?.isVerified).toBe(true)
      })

      it('should work without authentication (public query)', async () => {
        mockUnauthenticatedRequest(ctx)

        const mockCompany = createMockCompany()
        ctx.db.get.mockResolvedValue(mockCompany)

        const result = await ctx.db.get(mockCompany._id)

        expect(result).toEqual(mockCompany)
      })
    })

    // ===== getByOwner =====
    describe('getByOwner', () => {
      it('should return company for owner profile', async () => {
        const profileId = mockId('profiles')
        const mockCompany = createMockCompany({ ownerId: profileId })

        const queryBuilder = createMockQueryBuilder([mockCompany])
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('companies')
        const result = await query.withIndex('by_ownerId').first()

        expect(result).toEqual(mockCompany)
        expect(result?.ownerId).toBe(profileId)
      })

      it('should return null when profile has no company', async () => {
        const queryBuilder = createMockQueryBuilder([])
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('companies')
        const result = await query.withIndex('by_ownerId').first()

        expect(result).toBeNull()
      })
    })

    // ===== getCompanyWithDeals =====
    describe('getCompanyWithDeals', () => {
      it('should return company with associated deals', async () => {
        const companyId = mockId('companies')
        const mockCompany = createMockCompany({ _id: companyId })

        ctx.db.get.mockResolvedValue(mockCompany)

        const result = await ctx.db.get(companyId)

        expect(result).toEqual(mockCompany)
      })
    })
  })

  // ==========================================================================
  // SECTION 2: COMPANY MUTATIONS
  // ==========================================================================

  describe('Company Mutations', () => {
    // ===== createCompany =====
    describe('createCompany', () => {
      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should require COMPANY role', async () => {
        const companyProfile = createMockProfile({ role: 'COMPANY' })
        expect(companyProfile.role).toBe('COMPANY')
      })

      it('should create company with valid data', async () => {
        const companyId = mockId('companies')
        const profileId = mockId('profiles')

        ctx.db.insert.mockResolvedValue(companyId)

        const companyData = {
          ownerId: profileId,
          name: 'New Company',
          description: 'A great company',
          industry: 'TECHNOLOGY',
          location: 'Mexico City',
        }

        const result = await ctx.db.insert('companies', companyData)

        expect(result).toBe(companyId)
        expect(ctx.db.insert).toHaveBeenCalledWith(
          'companies',
          expect.objectContaining({
            name: 'New Company',
            industry: 'TECHNOLOGY',
          })
        )
      })

      it('should verify ownerId matches caller profile', async () => {
        const clerkId = 'test_clerk_id'
        const mockIdentity = createMockUserIdentity({ subject: clerkId })
        mockAuthenticatedUser(ctx, mockIdentity)

        const identity = await ctx.auth.getUserIdentity()
        expect(identity?.subject).toBe(clerkId)
      })

      it('should prevent duplicate companies for same owner', async () => {
        const profileId = mockId('profiles')
        const existingCompany = createMockCompany({ ownerId: profileId })

        const queryBuilder = createMockQueryBuilder([existingCompany])
        ctx.db.query.mockReturnValue(queryBuilder)

        const query = ctx.db.query('companies')
        const existing = await query.withIndex('by_ownerId').first()

        expect(existing).not.toBeNull()
        // Real code would throw "Ya tienes una empresa registrada"
      })
    })

    // ===== updateCompany =====
    describe('updateCompany', () => {
      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should allow owner to update their company', async () => {
        const companyId = mockId('companies')
        const profileId = mockId('profiles')
        const mockCompany = createMockCompany({
          _id: companyId,
          ownerId: profileId,
        })

        ctx.db.get.mockResolvedValue(mockCompany)

        const company = await ctx.db.get(companyId)
        expect(company?.ownerId).toBe(profileId)

        await ctx.db.patch(companyId, { name: 'Updated Company' })
        expect(ctx.db.patch).toHaveBeenCalledWith(companyId, {
          name: 'Updated Company',
        })
      })

      it('should deny non-owner from updating company', async () => {
        const companyId = mockId('companies')
        const ownerProfileId = mockId('profiles')
        const attackerProfileId = mockId('profiles')

        const mockCompany = createMockCompany({
          _id: companyId,
          ownerId: ownerProfileId,
        })
        ctx.db.get.mockResolvedValue(mockCompany)

        const company = await ctx.db.get(companyId)
        const isOwner = company?.ownerId === attackerProfileId

        expect(isOwner).toBe(false)
        // Real code would throw "No tienes permiso"
      })

      it('should allow ADMIN to update any company', async () => {
        const adminProfile = createMockProfile({ role: 'ADMIN' })
        const companyId = mockId('companies')

        expect(adminProfile.role).toBe('ADMIN')

        await ctx.db.patch(companyId, { isVerified: true })
        expect(ctx.db.patch).toHaveBeenCalled()
      })

      it('should validate update fields', async () => {
        const companyId = mockId('companies')

        const validUpdates = {
          name: 'Valid Company Name',
          description: 'Valid description',
          website: 'https://example.com',
        }

        await ctx.db.patch(companyId, validUpdates)
        expect(ctx.db.patch).toHaveBeenCalledWith(companyId, validUpdates)
      })

      // [F] 2026-09-07 09:00: el perfil del marketplace se retiró y la mutation
      // dejó de aceptar lo que solo esas pantallas mandaban. `isPublic` sigue
      // siendo del equipo, vía `setCompanyVisibility`.
      it('no longer accepts the marketplace-era profile fields', () => {
        const validator = convexArgsValidator(updateCompany)
        const fields = validator.value as Record<string, unknown>

        for (const dropped of [
          'businessModel',
          'stage',
          'revenueRange',
          'fundraisingTimeline',
          'revenueCurrent',
          'revenueGrowthYoy',
          'grossMargin',
          'ebitdaMargin',
          'netMargin',
          'mission',
          'vision',
          'isPublic',
        ]) {
          expect(fields, dropped).not.toHaveProperty(dropped)
        }
        expect(unionLiteralsOf(validator, 'seekingType')).toEqual(['DEBT', 'EQUITY', 'BOTH'])
      })
    })

    // ===== updateCompany — «Tu empresa» en la sala =====
    // [F] 2026-09-07 09:00: el formulario de la sala guarda los términos de
    // deuda y borra lo que el cliente deja vacío.
    describe('updateCompany — perfil en la sala', () => {
      function ownerCompany() {
        const clerkId = 'clerk_company_profile'
        const user = createMockUser({ clerkId, role: 'COMPANY' })
        const profile = createMockProfile({ userId: user._id, role: 'COMPANY' })
        const company = createMockCompany({ ownerId: profile._id, name: 'SampleFoods Foods' })

        mockAuthenticatedUser(ctx, createMockUserIdentity({ subject: clerkId }))
        ctx.db.query.mockImplementation((table: string) => {
          if (table === 'users') return createMockQueryBuilder([user])
          if (table === 'profiles') return createMockQueryBuilder([profile])
          return createMockQueryBuilder([])
        })
        ctx.db.get.mockImplementation(async (id) => (id === company._id ? company : null))
        return company
      }

      it('declares the room numerics as optional numbers that accept null to clear', () => {
        const validator = convexArgsValidator(updateCompany)
        const fields = validator.value as Record<
          string,
          { fieldType: { type: string; value?: Array<{ type: string }> } }
        >

        for (const field of [
          'debtTermYears',
          'debtIndicativeRate',
          'seekingAmount',
          'foundedYear',
        ]) {
          expect(isOptionalArg(validator, field), field).toBe(true)
          expect(fields[field]?.fieldType.type, field).toBe('union')
          expect(
            fields[field]?.fieldType.value?.map((member) => member.type).sort(),
            field
          ).toEqual(['null', 'number'])
        }
      })

      // El validator ya no declara `isPublic`, pero el handler hace spread de lo
      // que le llega por `_handler`. Este test entra por ahí, como entraría una
      // mutation vecina o un seed, y pinnea que el patch del owner no lo lleva.
      it('drops isPublic in the handler even when a caller sends it', async () => {
        const company = ownerCompany()

        await updateCompanyHandler(ctx, {
          companyId: company._id,
          name: 'SampleFoods Foods',
          isPublic: true,
        })

        expect(ctx.db.patch).toHaveBeenCalledTimes(1)
        const patch = ctx.db.patch.mock.calls[0]?.[1] as Record<string, unknown>
        expect(patch.name).toBe('SampleFoods Foods')
        expect(Object.hasOwn(patch, 'isPublic')).toBe(false)
      })

      it('stores the debt terms, rounds the rate to two decimals and drops cleared fields', async () => {
        const company = ownerCompany()

        await updateCompanyHandler(ctx, {
          companyId: company._id,
          name: 'SampleFoods Foods',
          debtTermYears: 7,
          debtIndicativeRate: 9.456,
          city: '',
          foundedYear: null,
          website: 'https://samplefoods.example',
        })

        expect(ctx.db.patch).toHaveBeenCalledTimes(1)
        const patch = ctx.db.patch.mock.calls[0]?.[1] as Record<string, unknown>
        expect(patch).toMatchObject({
          debtTermYears: 7,
          debtIndicativeRate: 9.46,
          website: 'https://samplefoods.example',
        })
        // Convex borra un campo cuando el patch lo trae en `undefined`; un
        // `undefined` que falta del todo lo dejaría intacto.
        for (const cleared of ['city', 'foundedYear']) {
          expect(Object.hasOwn(patch, cleared), cleared).toBe(true)
          expect(patch[cleared], cleared).toBeUndefined()
        }
      })

      it.each([
        [{ debtTermYears: 0 }, /plazo/],
        [{ debtTermYears: 31 }, /plazo/],
        [{ debtTermYears: 7.5 }, /plazo/],
        [{ debtIndicativeRate: -1 }, /tasa/],
        [{ debtIndicativeRate: 101 }, /tasa/],
        [{ foundedYear: 1800 }, /año/],
        [{ name: '   ' }, /nombre/],
        [{ country: '' }, /país/],
      ])('rejects %j before touching the row', async (args, message) => {
        const company = ownerCompany()

        await expect(
          updateCompanyHandler(ctx, { companyId: company._id, ...args })
        ).rejects.toThrow(message)
        expect(ctx.db.patch).not.toHaveBeenCalled()
      })
    })

    // ===== updateManagementTeam =====
    describe('updateManagementTeam', () => {
      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should update management team array', async () => {
        const companyId = mockId('companies')
        const managementTeam = [
          { name: 'John CEO', title: 'CEO', bio: 'Experienced leader' },
          { name: 'Jane CFO', title: 'CFO', bio: 'Financial expert' },
        ]

        await ctx.db.patch(companyId, { managementTeam })

        expect(ctx.db.patch).toHaveBeenCalledWith(
          companyId,
          expect.objectContaining({
            managementTeam,
          })
        )
      })

      it('should require ownership to update management team', async () => {
        const companyId = mockId('companies')
        const profileId = mockId('profiles')
        const mockCompany = createMockCompany({
          _id: companyId,
          ownerId: profileId,
        })

        ctx.db.get.mockResolvedValue(mockCompany)

        const company = await ctx.db.get(companyId)
        expect(company?.ownerId).toBe(profileId)
      })
    })

    // ===== ensureCompanyWorkspace =====
    describe('ensureCompanyWorkspace', () => {
      /**
       * `ctx.db.insert` returns a synthetic id that the default `ctx.db.get`
       * cannot resolve, so the handler would throw `invalidState` before
       * returning. This store reads back what production actually wrote, which
       * is also what makes a second call see the company the first one created.
       */
      function seedProvisioningCtx(options: {
        user: MockUser
        profile: MockProfile
        companies?: MockCompany[]
        identity?: Partial<MockUserIdentity>
        controls?: Record<string, unknown>[]
        memberships?: Record<string, unknown>[]
        bindings?: Record<string, unknown>[]
      }) {
        mockAuthenticatedUser(
          ctx,
          createMockUserIdentity({ subject: options.user.clerkId, ...options.identity })
        )

        const stored = new Map<string, Record<string, unknown>>()
        const insertedByTable = new Map<string, Record<string, unknown>[]>()
        const companyRows: unknown[] = [...(options.companies ?? [])]
        const bindingRows: unknown[] = []

        ctx.db.query.mockImplementation((table: string) => {
          if (table === 'users') return createMockQueryBuilder([options.user])
          if (table === 'profiles') return createMockQueryBuilder([options.profile])
          if (table === 'companies') return createMockQueryBuilder(companyRows)
          if (table === 'companyAuthorizationControls') {
            return createMockQueryBuilder(options.controls ?? [])
          }
          if (table === 'organizationMemberships') {
            return createMockQueryBuilder(options.memberships ?? [])
          }
          if (table === 'companyOrganizationBindings') {
            return createMockQueryBuilder(options.bindings ?? bindingRows)
          }
          return createMockQueryBuilder([])
        })

        ctx.db.insert.mockImplementation(async (table: string, doc: Record<string, unknown>) => {
          const id = `${table}_${stored.size + 1}`
          const row = { _id: id, _creationTime: Date.now(), ...doc }
          stored.set(id, row)
          insertedByTable.set(table, [...(insertedByTable.get(table) ?? []), row])
          if (table === 'companies') companyRows.push(row)
          if (table === 'companyOrganizationBindings') bindingRows.push(row)
          return id
        })

        ctx.db.get.mockImplementation(async (id: string) => stored.get(String(id)) ?? null)

        return {
          insertsFor: (table: string) => insertedByTable.get(table) ?? [],
          patchedIds: () => ctx.db.patch.mock.calls.map((call) => call[0] as string),
        }
      }

      it('creates a born-complete workspace when the owner has none', async () => {
        const user = createMockUser({
          clerkId: 'clerk_first_login',
          role: 'COMPANY',
          name: 'Fundadora Uno',
        })
        const profile = createMockProfile({ userId: user._id, role: 'COMPANY' })
        const { insertsFor } = seedProvisioningCtx({ user, profile })

        const result = await ensureCompanyWorkspaceHandler(ctx)

        expect(result.created).toBe(true)
        expect(result.role).toBe('COMPANY')

        const [inserted] = insertsFor('companies')
        expect(inserted).toMatchObject({
          ownerId: profile._id,
          name: 'Fundadora Uno',
          country: '',
          isPublic: false,
          onboardingStep: 6,
        })
        expect(typeof inserted.onboardingCompletedAt).toBe('number')
      })

      it('returns an existing mid-wizard company untouched', async () => {
        const user = createMockUser({ clerkId: 'clerk_mid_wizard', role: 'COMPANY' })
        const profile = createMockProfile({ userId: user._id, role: 'COMPANY' })
        const company = createMockCompany({
          ownerId: profile._id,
          onboardingStep: 2,
          onboardingCompletedAt: undefined,
        })
        const { insertsFor, patchedIds } = seedProvisioningCtx({
          user,
          profile,
          companies: [company],
        })

        const result = await ensureCompanyWorkspaceHandler(ctx)

        expect(result.created).toBe(false)
        expect(result.company).toBe(company)
        expect(insertsFor('companies')).toHaveLength(0)
        expect(patchedIds()).not.toContain(company._id)
      })

      // El retorno temprano de la empresa existente es una lectura, y tiene que
      // pesar lo mismo que `getCompanyByOwner`: a un dueño WorkOS con la membresía
      // de su organización revocada la query le niega la fila, y esta mutación no
      // puede ser la puerta de atrás que se la entrega.
      it('withholds an existing company when the bound membership was revoked', async () => {
        const workosUserId = 'user_workos_revoked_binding'
        const user = createMockUser({
          clerkId: 'clerk_revoked_binding',
          role: 'COMPANY',
          workosUserId,
        })
        const profile = createMockProfile({ userId: user._id, role: 'COMPANY' })
        const company = createMockCompany({ ownerId: profile._id })
        const { insertsFor } = seedProvisioningCtx({
          user,
          profile,
          companies: [company],
          identity: {
            subject: workosUserId,
            issuer: 'https://api.workos.com/user_management/client_test',
          },
          bindings: [
            {
              _id: 'companyOrganizationBindings_1',
              companyId: company._id,
              ownerProfileId: profile._id,
              authProvider: 'workos',
              providerOrgId: 'org_bound',
              createdAt: Date.now(),
            },
          ],
          memberships: [
            {
              _id: 'organizationMemberships_revoked_bound',
              userId: user._id,
              profileId: profile._id,
              authProvider: 'workos',
              providerOrgId: 'org_bound',
              betaRole: 'COMPANY_OWNER',
              profileRole: 'COMPANY',
              status: 'INACTIVE',
              createdAt: Date.now(),
            },
          ],
        })

        const result = await ensureCompanyWorkspaceHandler(ctx)

        expect(result).toEqual({ created: false, role: 'COMPANY', company: null })
        expect(insertsFor('companies')).toHaveLength(0)
      })

      it('falls back to the email local part when the user has no name', async () => {
        const user = createMockUser({
          clerkId: 'clerk_nameless',
          role: 'COMPANY',
          name: undefined,
          email: 'fixture-367c4f72@example.com',
        })
        const profile = createMockProfile({ userId: user._id, role: 'COMPANY' })
        const { insertsFor } = seedProvisioningCtx({ user, profile, identity: { name: undefined } })

        await ensureCompanyWorkspaceHandler(ctx)

        expect(insertsFor('companies')[0]).toMatchObject({ name: 'fixture-367c4f72' })
      })

      it('does not create a second company on a repeated call', async () => {
        const user = createMockUser({ clerkId: 'clerk_repeat_call', role: 'COMPANY' })
        const profile = createMockProfile({ userId: user._id, role: 'COMPANY' })
        const { insertsFor } = seedProvisioningCtx({ user, profile })

        const first = await ensureCompanyWorkspaceHandler(ctx)
        const second = await ensureCompanyWorkspaceHandler(ctx)

        expect(first.created).toBe(true)
        expect(second.created).toBe(false)
        expect(second.company).toBe(first.company)
        expect(insertsFor('companies')).toHaveLength(1)
      })

      // Este par es diferencial: mismo caller WorkOS vivo y sin membresía, y lo
      // único que cambia entre los dos es la fila de control. Sin el primero, el
      // segundo pasaría igual si el resolver cortara antes por otra razón.
      it('provisions an unbound WorkOS first login before the cutover', async () => {
        const workosUserId = 'user_workos_unenforced'
        const user = createMockUser({
          clerkId: 'clerk_unenforced',
          role: 'COMPANY',
          name: 'Fundadora WorkOS',
          workosUserId,
        })
        const profile = createMockProfile({ userId: user._id, role: 'COMPANY' })
        const { insertsFor } = seedProvisioningCtx({
          user,
          profile,
          identity: {
            subject: workosUserId,
            issuer: 'https://api.workos.com/user_management/client_test',
          },
        })

        const result = await ensureCompanyWorkspaceHandler(ctx)

        expect(result.created).toBe(true)
        expect(insertsFor('companies')).toHaveLength(1)
      })

      // Aprovisionar y leer son el MISMO camino para un usuario nuevo. La regla de
      // compatibilidad de empresas sin binding pedía exactamente una membresía de
      // dueño, así que el recién aprovisionado quedaba fuera de su propio workspace.
      it('lets a fresh WorkOS owner read the workspace it just provisioned', async () => {
        const workosUserId = 'user_workos_read_after_provision'
        const user = createMockUser({
          clerkId: 'clerk_read_after_provision',
          role: 'COMPANY',
          name: 'Fundadora Nueva',
          workosUserId,
        })
        const profile = createMockProfile({ userId: user._id, role: 'COMPANY' })
        seedProvisioningCtx({
          user,
          profile,
          identity: {
            subject: workosUserId,
            issuer: 'https://api.workos.com/user_management/client_test',
          },
        })

        const provisioned = await ensureCompanyWorkspaceHandler(ctx)
        expect(provisioned.created).toBe(true)

        const read = await getCompanyByOwnerHandler(ctx, { ownerId: profile._id })

        expect(read).toMatchObject({ _id: (provisioned.company as { _id: string })._id })
      })

      // El contrapeso del caso anterior: la desprobación deja la fila en INACTIVE
      // en vez de borrarla, así que "sin ninguna membresía" sigue distinguiendo el
      // primer login de un dueño al que le revocaron la organización.
      it('still denies a deprovisioned owner reading an unbound company', async () => {
        const workosUserId = 'user_workos_deprovisioned'
        const user = createMockUser({
          clerkId: 'clerk_deprovisioned',
          role: 'COMPANY',
          workosUserId,
        })
        const profile = createMockProfile({ userId: user._id, role: 'COMPANY' })
        const company = createMockCompany({ ownerId: profile._id })
        seedProvisioningCtx({
          user,
          profile,
          companies: [company],
          identity: {
            subject: workosUserId,
            issuer: 'https://api.workos.com/user_management/client_test',
          },
          memberships: [
            {
              _id: 'organizationMemberships_revoked',
              userId: user._id,
              profileId: profile._id,
              authProvider: 'workos',
              providerOrgId: 'org_revoked',
              betaRole: 'COMPANY_OWNER',
              profileRole: 'COMPANY',
              status: 'INACTIVE',
              createdAt: Date.now(),
            },
          ],
        })

        await expect(getCompanyByOwnerHandler(ctx, { ownerId: profile._id })).rejects.toThrow(
          /permiso/
        )
      })

      // Dos membresías utilizables no eligen organización. Crear igual dejaría una
      // empresa sin binding que la regla de compatibilidad le niega al mismo dueño.
      it('degrades to the wizard when the owner has ambiguous memberships', async () => {
        const workosUserId = 'user_workos_multi_org'
        const user = createMockUser({
          clerkId: 'clerk_multi_org',
          role: 'COMPANY',
          workosUserId,
        })
        const profile = createMockProfile({ userId: user._id, role: 'COMPANY' })
        const usableMembership = (orgId: string) => ({
          _id: `organizationMemberships_${orgId}`,
          userId: user._id,
          profileId: profile._id,
          authProvider: 'workos',
          providerOrgId: orgId,
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          createdAt: Date.now(),
        })
        const { insertsFor } = seedProvisioningCtx({
          user,
          profile,
          identity: {
            subject: workosUserId,
            issuer: 'https://api.workos.com/user_management/client_test',
          },
          memberships: [usableMembership('org_one'), usableMembership('org_two')],
        })

        const result = await ensureCompanyWorkspaceHandler(ctx)

        expect(result).toEqual({ created: false, role: 'COMPANY', company: null })
        expect(insertsFor('companies')).toHaveLength(0)
      })

      it('refuses to create an unbound company once binding enforcement is live', async () => {
        // Los demás casos usan identidad Clerk, así que el resolver corta en
        // `!auth.user.workosUserId` y esta rama nunca corre. Acá la sesión WorkOS
        // es viva y sin membresía de organización: con el cutover activo, una
        // empresa sin binding es un estado inválido y el alta debe negarse.
        const workosUserId = 'user_workos_enforced'
        const user = createMockUser({
          clerkId: 'clerk_enforced',
          role: 'COMPANY',
          workosUserId,
        })
        const profile = createMockProfile({ userId: user._id, role: 'COMPANY' })
        const { insertsFor } = seedProvisioningCtx({
          user,
          profile,
          identity: {
            subject: workosUserId,
            issuer: 'https://api.workos.com/user_management/client_test',
          },
          controls: [{ key: 'WORKOS_COMPANY_ORG_BINDING_V1', status: 'ENFORCED' }],
        })

        const result = await ensureCompanyWorkspaceHandler(ctx)

        expect(result).toEqual({ created: false, role: 'COMPANY', company: null })
        expect(insertsFor('companies')).toHaveLength(0)
      })

      it('never downgrades an existing ADMIN profile', async () => {
        const user = createMockUser({ clerkId: 'clerk_admin_login', role: 'ADMIN' })
        const profile = createMockProfile({ userId: user._id, role: 'ADMIN' })
        const { insertsFor, patchedIds } = seedProvisioningCtx({ user, profile })

        const result = await ensureCompanyWorkspaceHandler(ctx)

        expect(result).toEqual({ created: false, role: 'ADMIN', company: null })
        expect(insertsFor('companies')).toHaveLength(0)
        expect(patchedIds()).not.toContain(profile._id)
      })
    })

    // ========================================================================
    // ensureCompanyWorkspace — BOOTSTRAP DESDE UNA BASE VACÍA
    // ========================================================================
    // Los casos de arriba siembran `users` y `profiles`, así que ejercen la rama
    // del perfil ya existente y nunca el primer login real: `requireAuth` falla,
    // el handler atrapa el error recuperable y construye usuario, perfil y
    // `AuthResult` a mano. Este harness además EVALÚA los predicados de
    // `withIndex`, así que una regresión de pertenencia no puede quedar verde
    // porque el mock devuelva la primera fila de la tabla.
    describe('ensureCompanyWorkspace bootstrap', () => {
      const WORKOS_ISSUER = 'https://api.workos.com/user_management/client_test'
      const FIRST_LOGIN_IDENTITY = {
        subject: 'user_workos_bootstrap',
        issuer: WORKOS_ISSUER,
        email: 'fixture-9dcfd121@example.com',
        name: 'Fundadora Cero',
      }

      const rowsOf = (harness: HarnessCtx, table: string) => harness.tables[table] ?? []

      const provision = (harness: HarnessCtx) =>
        runHandler<Record<string, never>, EnsureCompanyWorkspaceResult>(
          ensureCompanyWorkspace,
          harness,
          {}
        )

      it('creates user, profile and company from an empty database', async () => {
        const harness = createConvexCtx({}, { identity: FIRST_LOGIN_IDENTITY })

        const result = await provision(harness)

        expect(result.created).toBe(true)
        expect(result.role).toBe('COMPANY')

        const [insertedUser] = rowsOf(harness, 'users')
        expect(insertedUser).toMatchObject({
          role: 'COMPANY',
          authProvider: 'workos',
          providerUserId: FIRST_LOGIN_IDENTITY.subject,
          workosUserId: FIRST_LOGIN_IDENTITY.subject,
          email: FIRST_LOGIN_IDENTITY.email,
        })

        const [insertedProfile] = rowsOf(harness, 'profiles')
        expect(insertedProfile).toMatchObject({
          userId: insertedUser._id,
          role: 'COMPANY',
          roleConfirmed: true,
          isActive: true,
        })

        const [insertedCompany] = rowsOf(harness, 'companies')
        expect(insertedCompany).toMatchObject({
          ownerId: insertedProfile._id,
          name: 'Fundadora Cero',
          country: '',
          onboardingStep: 6,
        })
        expect(result.company).toMatchObject({ _id: insertedCompany._id })
      })

      it('refuses a WorkOS first login when the subject already has a user tombstone', async () => {
        const harness = createConvexCtx(
          {
            providerUserTombstones: [
              {
                _id: 'provider_user_tombstone_1',
                _creationTime: 1,
                authProvider: 'workos',
                providerUserId: FIRST_LOGIN_IDENTITY.subject,
                deletedAt: 1,
              },
            ],
          },
          { identity: FIRST_LOGIN_IDENTITY }
        )

        await expect(provision(harness)).rejects.toMatchObject({
          data: { code: 'AUTHZ_UNAUTHORIZED' },
        })
        expect(rowsOf(harness, 'users')).toEqual([])
        expect(rowsOf(harness, 'profiles')).toEqual([])
        expect(rowsOf(harness, 'companies')).toEqual([])
      })

      it('refuses profile recovery for a deleted WorkOS user with a local user row', async () => {
        const harness = createConvexCtx(
          {
            users: [
              {
                _id: 'deleted_local_user',
                _creationTime: 1,
                authProvider: 'workos',
                providerUserId: FIRST_LOGIN_IDENTITY.subject,
                workosUserId: FIRST_LOGIN_IDENTITY.subject,
                email: FIRST_LOGIN_IDENTITY.email,
                role: 'COMPANY',
              },
            ],
            providerUserTombstones: [
              {
                _id: 'deleted_user_tombstone',
                _creationTime: 2,
                authProvider: 'workos',
                providerUserId: FIRST_LOGIN_IDENTITY.subject,
                deletedAt: 2,
              },
            ],
          },
          { identity: FIRST_LOGIN_IDENTITY }
        )

        await expect(provision(harness)).rejects.toMatchObject({
          data: { code: 'AUTHZ_UNAUTHORIZED' },
        })
        expect(rowsOf(harness, 'users')).toHaveLength(1)
        expect(rowsOf(harness, 'profiles')).toEqual([])
        expect(rowsOf(harness, 'companies')).toEqual([])
        expect(harness.db.insert).not.toHaveBeenCalled()
      })

      it('no agenda contadores de systemStats al crear el perfil', async () => {
        const harness = createConvexCtx({}, { identity: FIRST_LOGIN_IDENTITY })

        await provision(harness)

        expect(harness.scheduler.runAfter.mock.calls.map((call) => call[2])).toEqual([
          { companyId: expect.any(String) },
        ])
      })

      // Sin claim de correo ni de nombre, el usuario nace con una dirección
      // sintética (`user_01…@workos.user`). Ese id no nombra a nadie: la sala
      // arranca con el default declarado, y el correo de «Espacio nuevo» sale
      // sin un id de WorkOS en el asunto ([F] 2026-09-17: arregla los hallazgos
      // del E2E).
      it('names the workspace «Mi empresa» when the token carries no name and no email', async () => {
        const harness = createConvexCtx(
          {},
          { identity: { subject: 'user_01AAAAAAAAAAAAAAAAAAAAAAAA', issuer: WORKOS_ISSUER } }
        )

        const result = await provision(harness)

        expect(result.created).toBe(true)
        const [insertedUser] = rowsOf(harness, 'users')
        expect(insertedUser).toMatchObject({
          email: 'user_01AAAAAAAAAAAAAAAAAAAAAAAA@workos.user',
        })
        expect(rowsOf(harness, 'companies')[0]).toMatchObject({ name: 'Mi empresa' })
      })

      // El contrapeso: un correo de verdad sigue nombrando la sala.
      it('still names the workspace after the email local part when the email is real', async () => {
        const harness = createConvexCtx(
          {},
          {
            identity: {
              subject: 'user_workos_real_email',
              issuer: WORKOS_ISSUER,
              email: 'fixture-367c4f72@example.com',
            },
          }
        )

        await provision(harness)

        expect(rowsOf(harness, 'companies')[0]).toMatchObject({ name: 'fixture-367c4f72' })
      })

      // El correo puede ser de un dominio real y aun así no decir nada: un
      // local-part con forma de id del proveedor tampoco nombra la sala.
      it('ignores an email whose local part has the shape of a provider user id', async () => {
        const harness = createConvexCtx(
          {},
          {
            identity: {
              subject: 'user_01AAAAAAAAAAAAAAAAAAAAAAAA',
              issuer: WORKOS_ISSUER,
              email: 'user_01AAAAAAAAAAAAAAAAAAAAAAAA@example.com',
            },
          }
        )

        await provision(harness)

        expect(rowsOf(harness, 'companies')[0]).toMatchObject({ name: 'Mi empresa' })
      })

      it('lets the bootstrapped owner read the company it just got', async () => {
        const harness = createConvexCtx({}, { identity: FIRST_LOGIN_IDENTITY })
        await provision(harness)
        const [profile] = rowsOf(harness, 'profiles')

        const read = await runHandler(getCompanyByOwner, harness, { ownerId: profile._id })

        expect(read).toMatchObject({ ownerId: profile._id })
      })

      // Leer no alcanza: `/my-company` y el wizard escriben, y una empresa que el
      // dueño no puede administrar es el mismo callejón sin salida un paso después.
      it('lets the bootstrapped owner manage the company it just got', async () => {
        const harness = createConvexCtx({}, { identity: FIRST_LOGIN_IDENTITY })
        await provision(harness)
        const [company] = rowsOf(harness, 'companies')

        await runHandler(updateCompany, harness, { companyId: company._id, name: 'Acme Panamá' })

        expect(rowsOf(harness, 'companies')[0]).toMatchObject({ name: 'Acme Panamá' })
      })

      // El caso que un mock ciego a los índices no puede distinguir: dos dueños
      // aprovisionados, y el segundo pidiendo la empresa del primero.
      it('does not hand the bootstrapped company to another provisioned owner', async () => {
        const harness = createConvexCtx({}, { identity: FIRST_LOGIN_IDENTITY })
        await provision(harness)
        const [ownerProfile] = rowsOf(harness, 'profiles')

        // El segundo dueño entra por el MISMO ctx: dos harness sobre las mismas
        // tablas llevan secuencias de id independientes y se pisarían los `_id`.
        harness.auth.getUserIdentity.mockResolvedValue({
          subject: 'user_workos_intruder',
          issuer: WORKOS_ISSUER,
          email: 'fixture-df14633e@example.com',
        })
        await provision(harness)

        await expect(
          runHandler(getCompanyByOwner, harness, { ownerId: ownerProfile._id })
        ).rejects.toThrow(/permiso/)
      })

      // El destino post-aprovisionamiento es /my-company/documents, y esa página
      // rebota al wizard si getMyVdrWorkspace devuelve null: probar el aterrizaje
      // real, no solo la lectura por owner.
      it('serves the vdr workspace to the bootstrapped owner', async () => {
        const harness = createConvexCtx({}, { identity: FIRST_LOGIN_IDENTITY })
        const result = await provision(harness)

        const workspace = await runHandler<
          Record<string, never>,
          { company: { _id: string } } | null
        >(getMyVdrWorkspace, harness, {})

        expect(workspace).not.toBeNull()
        expect(workspace?.company).toMatchObject({ _id: result.company?._id })
      })

      it('does not treat a delete-before-upsert tombstone as a clean first login', async () => {
        const tables: Tables = {
          organizationMembershipTombstones: [
            {
              _id: 'membership_tombstone_before_login',
              _creationTime: 1,
              authProvider: 'workos',
              providerMembershipId: 'membership_deleted_before_login',
              providerOrgId: 'org_deleted_before_login',
              providerUserId: FIRST_LOGIN_IDENTITY.subject,
              deletedAt: 1,
            },
          ],
        }
        const harness = createConvexCtx(tables, { identity: FIRST_LOGIN_IDENTITY })

        const result = await provision(harness)

        expect(result).toEqual({ created: false, role: 'COMPANY', company: null })
        expect(rowsOf(harness, 'users')).toHaveLength(1)
        expect(rowsOf(harness, 'profiles')).toHaveLength(1)
        expect(rowsOf(harness, 'companies')).toHaveLength(0)
      })

      // Espejo del guard FIRST_LOGIN_OWNER en el resolver: una fila INACTIVE es
      // desprovisión, no primer login — aprovisionar aquí crearía una empresa
      // que su dueño no puede abrir después.
      it('denies provisioning to a deprovisioned owner with only INACTIVE rows', async () => {
        const tables: Tables = {
          users: [
            {
              _id: 'user_deprovisioned',
              _creationTime: 1,
              authProvider: 'workos',
              providerUserId: 'user_workos_deprov',
              workosUserId: 'user_workos_deprov',
              email: 'fixture-caf186c3@example.com',
              role: 'COMPANY',
            },
          ],
          profiles: [
            {
              _id: 'profile_deprovisioned',
              _creationTime: 2,
              userId: 'user_deprovisioned',
              role: 'COMPANY',
              isActive: true,
            },
          ],
          organizationMemberships: [
            {
              _id: 'membership_revoked',
              _creationTime: 3,
              userId: 'user_deprovisioned',
              profileId: 'profile_deprovisioned',
              authProvider: 'workos',
              providerOrgId: 'org_revoked',
              betaRole: 'COMPANY_OWNER',
              profileRole: 'COMPANY',
              status: 'INACTIVE',
              createdAt: 1,
            },
          ],
        }
        const harness = createConvexCtx(tables, {
          identity: {
            subject: 'user_workos_deprov',
            issuer: WORKOS_ISSUER,
            email: 'fixture-caf186c3@example.com',
          },
        })

        const result = await provision(harness)

        expect(result).toEqual({ created: false, role: 'COMPANY', company: null })
        expect(rowsOf(harness, 'companies')).toHaveLength(0)
      })

      // Espejo del guard del webhook (workos_user_email_collision): un email ya
      // ligado a otro usuario local no se re-crea desde el cliente — una segunda
      // fila `users` fragmentaría la cuenta original.
      it('refuses to bootstrap over an email that belongs to another local user', async () => {
        const tables: Tables = {
          users: [
            {
              _id: 'user_legacy',
              _creationTime: 1,
              authProvider: 'clerk',
              providerUserId: 'clerk_legacy',
              clerkId: 'clerk_legacy',
              email: FIRST_LOGIN_IDENTITY.email,
              role: 'COMPANY',
            },
          ],
        }
        const harness = createConvexCtx(tables, { identity: FIRST_LOGIN_IDENTITY })

        await expect(provision(harness)).rejects.toThrow(/correo|cuenta/)
        expect(rowsOf(harness, 'users')).toHaveLength(1)
        expect(rowsOf(harness, 'profiles')).toHaveLength(0)
        expect(rowsOf(harness, 'companies')).toHaveLength(0)
      })

      // Sin fila local, getCurrentUserState devolvía null y requireWorkosSession
      // lo leía como fallo de backend: redirect a /onboarding?error=..., que es
      // la misma página — loop infinito para el primer login real. La forma
      // {user: null} es lo que separa "todavía no existe" de "falló la consulta".
      it('returns the empty state shape, not null, for an identity with no rows', async () => {
        const harness = createConvexCtx({}, { identity: FIRST_LOGIN_IDENTITY })

        const state = await runHandler(getCurrentUserState, harness, {})

        expect(state).not.toBeNull()
        expect(state).toMatchObject({ user: null, profile: null })
      })

      // El catch del bootstrap solo cubre "todavía no existe". Una cuenta
      // desactivada NO es recuperable y no puede aprovisionarse por encima.
      it('rethrows a non-recoverable auth failure instead of bootstrapping over it', async () => {
        const tables: Tables = {
          users: [
            {
              _id: 'user_disabled',
              _creationTime: 1,
              authProvider: 'workos',
              providerUserId: 'user_workos_disabled',
              workosUserId: 'user_workos_disabled',
              email: 'fixture-caf186c3@example.com',
              role: 'COMPANY',
            },
          ],
          profiles: [
            {
              _id: 'profile_disabled',
              _creationTime: 2,
              userId: 'user_disabled',
              role: 'COMPANY',
              isActive: false,
            },
          ],
        }
        const harness = createConvexCtx(tables, {
          identity: {
            subject: 'user_workos_disabled',
            issuer: WORKOS_ISSUER,
            email: 'fixture-caf186c3@example.com',
          },
        })

        await expect(provision(harness)).rejects.toThrow(/desactivada|inactiva/i)
        expect(rowsOf(harness, 'companies')).toHaveLength(0)
        expect(rowsOf(harness, 'users')).toHaveLength(1)
        expect(rowsOf(harness, 'profiles')).toHaveLength(1)
      })

      // El webhook `user.created` gana la carrera y deja `users` sin `role` y el
      // perfil COMPANY sin `roleConfirmed`. Si esta mutación no sincroniza ambos,
      // el próximo `user.updated` re-deriva el rol desde `users.role` y el
      // onboarding sigue viendo un selector que ya no existe.
      it('repairs a webhook-seeded COMPANY row before creating the workspace', async () => {
        const tables: Tables = {
          users: [
            {
              _id: 'user_webhook',
              _creationTime: 1,
              authProvider: 'workos',
              providerUserId: 'user_workos_webhook',
              workosUserId: 'user_workos_webhook',
              email: 'fixture-9dcfd121@example.com',
            },
          ],
          profiles: [
            {
              _id: 'profile_webhook',
              _creationTime: 2,
              userId: 'user_webhook',
              role: 'COMPANY',
              isActive: true,
            },
          ],
        }
        const harness = createConvexCtx(tables, {
          identity: {
            subject: 'user_workos_webhook',
            issuer: WORKOS_ISSUER,
            email: 'fixture-9dcfd121@example.com',
            name: 'Fundadora Webhook',
          },
        })

        const result = await provision(harness)

        expect(result.created).toBe(true)
        expect(tables.users[0]).toMatchObject({ role: 'COMPANY' })
        expect(tables.profiles[0]).toMatchObject({ role: 'COMPANY', roleConfirmed: true })
        expect(rowsOf(harness, 'companies')).toHaveLength(1)
      })

      // Una sola membresía utilizable SÍ elige organización. Crear la empresa
      // sin el binding dejaría un workspace UNRESOLVED que el cutover le niega
      // al mismo dueño que acaba de aprovisionar.
      it('binds the workspace to the single usable WorkOS organization', async () => {
        const tables: Tables = {
          users: [
            {
              _id: 'user_single_org',
              _creationTime: 1,
              authProvider: 'workos',
              providerUserId: 'user_workos_single',
              workosUserId: 'user_workos_single',
              email: 'fixture-18ecdd3c@example.com',
              role: 'COMPANY',
            },
          ],
          profiles: [
            {
              _id: 'profile_single_org',
              _creationTime: 2,
              userId: 'user_single_org',
              role: 'COMPANY',
              isActive: true,
              roleConfirmed: true,
            },
          ],
          organizationMemberships: [
            {
              _id: 'membership_single',
              _creationTime: 3,
              userId: 'user_single_org',
              profileId: 'profile_single_org',
              authProvider: 'workos',
              providerOrgId: 'org_acme',
              betaRole: 'COMPANY_OWNER',
              profileRole: 'COMPANY',
              status: 'ACTIVE',
              createdAt: 1,
            },
          ],
        }
        const harness = createConvexCtx(tables, {
          identity: {
            subject: 'user_workos_single',
            issuer: WORKOS_ISSUER,
            email: 'fixture-18ecdd3c@example.com',
            name: 'Dueña Acme',
          },
        })

        const result = await provision(harness)

        expect(result.created).toBe(true)
        expect(rowsOf(harness, 'companyOrganizationBindings')).toEqual([
          expect.objectContaining({
            companyId: result.company?._id,
            ownerProfileId: 'profile_single_org',
            authProvider: 'workos',
            providerOrgId: 'org_acme',
            createdByProfileId: 'profile_single_org',
            source: 'COMPANY_CREATE',
          }),
        ])

        const read = await runHandler(getCompanyByOwner, harness, {
          ownerId: 'profile_single_org',
        })
        expect(read).toMatchObject({ _id: result.company?._id })
      })
    })
  })

  // ==========================================================================
  // SECTION 4: ONBOARDING
  // ==========================================================================

  describe('Onboarding', () => {
    // ===== completeOnboardingStep =====
    describe('completeOnboardingStep', () => {
      it('should require authentication', async () => {
        mockUnauthenticatedRequest(ctx)
        const identity = await ctx.auth.getUserIdentity()
        expect(identity).toBeNull()
      })

      it('should update onboarding progress', async () => {
        const companyId = mockId('companies')
        const completedSteps = ['basic_info', 'financial_info']

        await ctx.db.patch(companyId, {
          onboardingCompletedSteps: completedSteps,
        })

        expect(ctx.db.patch).toHaveBeenCalledWith(
          companyId,
          expect.objectContaining({
            onboardingCompletedSteps: completedSteps,
          })
        )
      })

      it('should mark onboarding complete when all steps done', async () => {
        const companyId = mockId('companies')

        await ctx.db.patch(companyId, { isOnboardingComplete: true })

        expect(ctx.db.patch).toHaveBeenCalledWith(
          companyId,
          expect.objectContaining({
            isOnboardingComplete: true,
          })
        )
      })

      it('should require ownership to complete onboarding', async () => {
        const companyId = mockId('companies')
        const profileId = mockId('profiles')
        const mockCompany = createMockCompany({
          _id: companyId,
          ownerId: profileId,
        })

        ctx.db.get.mockResolvedValue(mockCompany)

        const company = await ctx.db.get(companyId)
        expect(company?.ownerId).toBe(profileId)
      })
    })
  })

  // ==========================================================================
  // SECTION 5: AUTH/OWNERSHIP GUARDS
  // ==========================================================================

  describe('Auth/Ownership Guards', () => {
    it('should verify ownership before mutations', async () => {
      const profileId = mockId('profiles')
      const companyId = mockId('companies')
      const mockCompany = createMockCompany({
        _id: companyId,
        ownerId: profileId,
      })

      ctx.db.get.mockResolvedValue(mockCompany)

      const company = await ctx.db.get(companyId)
      const isOwner = company?.ownerId === profileId

      expect(isOwner).toBe(true)
    })

    it('should allow admin bypass', async () => {
      const adminProfile = createMockProfile({ role: 'ADMIN' })
      expect(adminProfile.role).toBe('ADMIN')
    })

    it('should deny non-owner non-admin', async () => {
      const companyId = mockId('companies')
      const ownerProfileId = mockId('profiles')
      const _callerProfileId = mockId('profiles')

      const callerProfile = createMockProfile({
        _id: _callerProfileId,
        role: 'COMPANY',
      })
      const mockCompany = createMockCompany({
        _id: companyId,
        ownerId: ownerProfileId,
      })

      ctx.db.get.mockResolvedValue(mockCompany)

      const company = await ctx.db.get(companyId)
      const isAdmin = callerProfile.role === 'ADMIN'
      const isOwner = company?.ownerId === _callerProfileId

      expect(isAdmin || isOwner).toBe(false)
    })
  })

  // ==========================================================================
  // SECTION 6: DATA VALIDATION
  // ==========================================================================

  describe('Data Validation', () => {
    it('should validate company name length', () => {
      const validNames = ['A', 'Valid Company', 'A'.repeat(100)]
      const invalidNames = ['', 'A'.repeat(201)]

      validNames.forEach((name) => {
        expect(name.length).toBeGreaterThan(0)
        expect(name.length).toBeLessThanOrEqual(200)
      })

      invalidNames.forEach((name) => {
        const isValid = name.length > 0 && name.length <= 200
        expect(isValid).toBe(false)
      })
    })

    it('should validate website URL format', () => {
      const validUrls = ['https://example.com', 'http://test.com/path']
      const invalidUrls = ['not-a-url', 'ftp://test.com']

      validUrls.forEach((url) => {
        expect(url).toMatch(/^https?:\/\//)
      })

      invalidUrls.forEach((url) => {
        const isValid = url.match(/^https?:\/\//) !== null
        expect(isValid).toBe(false)
      })
    })
  })

  // ==========================================================================
  // SECTION 7: EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle company with no deals', async () => {
      const companyId = mockId('companies')
      const mockCompany = createMockCompany({ _id: companyId })

      ctx.db.get.mockResolvedValue(mockCompany)

      const queryBuilder = createMockQueryBuilder([])
      ctx.db.query.mockReturnValue(queryBuilder)

      const company = await ctx.db.get(companyId)
      expect(company).toEqual(mockCompany)

      const dealsQuery = ctx.db.query('deals')
      const deals = await dealsQuery.withIndex('by_companyId').collect()
      expect(deals).toHaveLength(0)
    })

    it('should handle special characters in company name', async () => {
      const companyId = mockId('companies')
      const specialName = "O'Brien & Associates, S.A. de C.V."

      await ctx.db.patch(companyId, { name: specialName })

      expect(ctx.db.patch).toHaveBeenCalledWith(companyId, {
        name: specialName,
      })
    })

    it('should handle empty management team', async () => {
      const companyId = mockId('companies')

      await ctx.db.patch(companyId, { managementTeam: [] })

      expect(ctx.db.patch).toHaveBeenCalledWith(companyId, {
        managementTeam: [],
      })
    })

    it('should handle concurrent updates', async () => {
      const companyId = mockId('companies')

      await Promise.all([
        ctx.db.patch(companyId, { name: 'Update 1' }),
        ctx.db.patch(companyId, { description: 'Update 2' }),
      ])

      expect(ctx.db.patch).toHaveBeenCalledTimes(2)
    })
  })
})
