import { describe, expect, it } from 'vitest'

import {
  evaluateCompanyManagementAuthorization,
  type CompanyManagementAuthorizationDecision,
} from '../../../convex/_helpers/companyAuthorization'
import {
  activateCompanyOrganizationBindingCutover,
  backfillCompanyOrganizationBindings,
  getCompanyOrganizationBindingInventory,
  pauseCompanyOrganizationBindingCutover,
  resolveCompanyOrganizationBinding,
} from '../../../convex/companyAuthorizationRollout'
import { createConvexCtx, runHandler, type Row, type Tables } from './nda-convex-harness'

const ADMIN_IDENTITY = {
  subject: 'workos_admin',
  issuer: 'https://api.workos.com/',
  email: 'admin@example.com',
}

function adminRows(): Pick<Tables, 'users' | 'profiles'> {
  return {
    users: [
      {
        _id: 'user_admin',
        _creationTime: 1,
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'admin@example.com',
        role: 'ADMIN',
      },
    ],
    profiles: [
      {
        _id: 'profile_admin',
        _creationTime: 2,
        userId: 'user_admin',
        role: 'ADMIN',
        isActive: true,
      },
    ],
  }
}

function ownerMembership(overrides: Partial<Row>): Row {
  return {
    _id: 'membership_owner',
    _creationTime: 100,
    userId: 'user_owner',
    profileId: 'profile_owner',
    authProvider: 'workos',
    providerOrgId: 'org_unique',
    workosOrgId: 'org_unique',
    betaRole: 'COMPANY_OWNER',
    profileRole: 'COMPANY',
    status: 'ACTIVE',
    createdAt: 100,
    ...overrides,
  }
}

function rolloutTables(): Tables {
  const admin = adminRows()
  return {
    users: [
      ...admin.users,
      {
        _id: 'user_owner_unique',
        _creationTime: 10,
        authProvider: 'workos',
        providerUserId: 'workos_owner_unique',
        workosUserId: 'workos_owner_unique',
        email: 'unique@example.com',
        role: 'COMPANY',
      },
      {
        _id: 'user_owner_unresolved',
        _creationTime: 11,
        authProvider: 'workos',
        providerUserId: 'workos_owner_unresolved',
        workosUserId: 'workos_owner_unresolved',
        email: 'unresolved@example.com',
        role: 'COMPANY',
      },
      {
        _id: 'user_owner_ambiguous',
        _creationTime: 12,
        authProvider: 'workos',
        providerUserId: 'workos_owner_ambiguous',
        workosUserId: 'workos_owner_ambiguous',
        email: 'ambiguous@example.com',
        role: 'COMPANY',
      },
    ],
    profiles: [
      ...admin.profiles,
      {
        _id: 'profile_owner_unique',
        _creationTime: 20,
        userId: 'user_owner_unique',
        role: 'COMPANY',
        isActive: true,
      },
      {
        _id: 'profile_owner_unresolved',
        _creationTime: 21,
        userId: 'user_owner_unresolved',
        role: 'COMPANY',
        isActive: true,
      },
      {
        _id: 'profile_owner_ambiguous',
        _creationTime: 22,
        userId: 'user_owner_ambiguous',
        role: 'COMPANY',
        isActive: true,
      },
    ],
    companies: [
      {
        _id: 'company_unique',
        _creationTime: 30,
        ownerId: 'profile_owner_unique',
        name: 'Issuer Unique',
      },
      {
        _id: 'company_unresolved',
        _creationTime: 31,
        ownerId: 'profile_owner_unresolved',
        name: 'Issuer Unresolved',
      },
      {
        _id: 'company_ambiguous',
        _creationTime: 32,
        ownerId: 'profile_owner_ambiguous',
        name: 'Issuer Ambiguous',
      },
    ],
    organizationMemberships: [
      ownerMembership({
        _id: 'membership_unique',
        userId: 'user_owner_unique',
        profileId: 'profile_owner_unique',
      }),
      ownerMembership({
        _id: 'membership_ambiguous_a',
        _creationTime: 101,
        userId: 'user_owner_ambiguous',
        profileId: 'profile_owner_ambiguous',
        providerOrgId: 'org_ambiguous_a',
        workosOrgId: 'org_ambiguous_a',
      }),
      ownerMembership({
        _id: 'membership_ambiguous_b',
        _creationTime: 102,
        userId: 'user_owner_ambiguous',
        profileId: 'profile_owner_ambiguous',
        providerOrgId: 'org_ambiguous_b',
        workosOrgId: 'org_ambiguous_b',
      }),
    ],
    companyOrganizationBindings: [],
    companyAuthorizationControls: [],
    adminAuditLogs: [],
  }
}

function cutoverTables(): Tables {
  const tables = rolloutTables()
  tables.users = tables.users.filter((row) =>
    ['user_admin', 'user_owner_unique'].includes(String(row._id))
  )
  tables.profiles = tables.profiles.filter((row) =>
    ['profile_admin', 'profile_owner_unique'].includes(String(row._id))
  )
  tables.companies = tables.companies.filter((row) => row._id === 'company_unique')
  tables.organizationMemberships = tables.organizationMemberships.filter(
    (row) => row._id === 'membership_unique'
  )
  return tables
}

function authorizationFixture(options: {
  storedProvider?: 'clerk' | 'workos'
  enforced?: boolean
  dualLinked?: boolean
  profileRole?: 'COMPANY' | 'ADMIN'
}) {
  const user: Row = {
    _id: 'user_owner',
    _creationTime: 1,
    authProvider: options.storedProvider ?? 'workos',
    providerUserId: options.storedProvider === 'clerk' ? 'clerk_owner' : 'workos_owner',
    clerkId: options.storedProvider === 'clerk' ? 'clerk_owner' : undefined,
    ...(options.storedProvider !== 'clerk' || options.dualLinked !== false
      ? { workosUserId: 'workos_owner' }
      : {}),
    email: 'owner@example.com',
    role: options.profileRole ?? 'COMPANY',
  }
  const profile: Row = {
    _id: 'profile_owner',
    _creationTime: 2,
    userId: 'user_owner',
    role: options.profileRole ?? 'COMPANY',
    isActive: true,
  }
  const company: Row = {
    _id: 'company_owner',
    _creationTime: 3,
    ownerId: 'profile_owner',
    name: 'Issuer Owner',
  }
  const tables: Tables = {
    users: [user],
    profiles: [profile],
    companies: [company],
    organizationMemberships: [
      ownerMembership({
        _id: 'membership_owner_fixture',
        userId: 'user_owner',
        profileId: 'profile_owner',
        providerOrgId: 'org_owner',
        workosOrgId: 'org_owner',
      }),
    ],
    companyOrganizationBindings: [],
    companyAuthorizationControls: options.enforced
      ? [
          {
            _id: 'control_enforced',
            _creationTime: 4,
            key: 'WORKOS_COMPANY_ORG_BINDING_V1',
            status: 'ENFORCED',
            updatedAt: 4,
            activatedAt: 4,
            activatedByProfileId: 'profile_admin',
          },
        ]
      : [],
    workosDirectoryUsers: [],
    workosDirectories: [],
  }
  return { tables, user, profile, company }
}

async function evaluateFixture(
  options: {
    storedProvider?: 'clerk' | 'workos'
    enforced?: boolean
    dualLinked?: boolean
    profileRole?: 'COMPANY' | 'ADMIN'
  },
  session: { subject: string; authProvider: 'clerk' | 'workos' }
): Promise<CompanyManagementAuthorizationDecision> {
  const { tables, user, profile, company } = authorizationFixture(options)
  const ctx = createConvexCtx(tables)
  return await evaluateCompanyManagementAuthorization(
    ctx as never,
    {
      identity: session,
      user,
      profile,
    } as never,
    company as never
  )
}

describe('company organization authorization cutover', () => {
  it('keeps a missing WorkOS binding compatible before cutover and labels it UNENFORCED', async () => {
    await expect(
      evaluateFixture({}, { subject: 'workos_owner', authProvider: 'workos' })
    ).resolves.toEqual({
      authorized: true,
      enforcement: 'UNENFORCED',
      reason: 'CUTOVER_COMPATIBILITY',
    })
  })

  it('fails closed for the same missing WorkOS binding after cutover', async () => {
    await expect(
      evaluateFixture({ enforced: true }, { subject: 'workos_owner', authProvider: 'workos' })
    ).resolves.toEqual({
      authorized: false,
      enforcement: 'ENFORCED',
      reason: 'BINDING_REQUIRED',
    })
  })

  it('does not let a dual-linked WorkOS session fall back to the stored Clerk legacy lane', async () => {
    await expect(
      evaluateFixture(
        { storedProvider: 'clerk', enforced: true, dualLinked: true },
        { subject: 'workos_owner', authProvider: 'workos' }
      )
    ).resolves.toEqual({
      authorized: false,
      enforcement: 'ENFORCED',
      reason: 'BINDING_REQUIRED',
    })
  })

  it('preserves the legacy owner contract for a genuine Clerk session', async () => {
    await expect(
      evaluateFixture(
        { storedProvider: 'clerk', enforced: true, dualLinked: false },
        { subject: 'clerk_owner', authProvider: 'clerk' }
      )
    ).resolves.toEqual({
      authorized: true,
      enforcement: 'LEGACY_SESSION',
      reason: 'LEGACY_SESSION',
    })
  })

  it('fails closed for a retained Clerk session once the user is dual-linked to WorkOS', async () => {
    await expect(
      evaluateFixture(
        { storedProvider: 'clerk', enforced: true, dualLinked: true },
        { subject: 'clerk_owner', authProvider: 'clerk' }
      )
    ).resolves.toEqual({
      authorized: false,
      enforcement: 'ENFORCED',
      reason: 'SESSION_PROVIDER_MISMATCH',
    })
  })

  it('does not let an ADMIN role bypass provider validation on a dual-linked Clerk session', async () => {
    await expect(
      evaluateFixture(
        {
          storedProvider: 'clerk',
          enforced: true,
          dualLinked: true,
          profileRole: 'ADMIN',
        },
        { subject: 'clerk_owner', authProvider: 'clerk' }
      )
    ).resolves.toEqual({
      authorized: false,
      enforcement: 'ENFORCED',
      reason: 'SESSION_PROVIDER_MISMATCH',
    })
  })

  it('keeps the ADMIN bypass after exact WorkOS provider validation', async () => {
    await expect(
      evaluateFixture(
        { enforced: true, profileRole: 'ADMIN' },
        { subject: 'workos_owner', authProvider: 'workos' }
      )
    ).resolves.toEqual({
      authorized: true,
      enforcement: 'ADMIN',
      reason: 'ADMIN',
    })
  })

  it('rejects rollout administration from a retained Clerk credential on a WorkOS admin', async () => {
    const tables = rolloutTables()
    const admin = tables.users.find((row) => row._id === 'user_admin')!
    admin.clerkId = 'clerk_admin'

    await expect(
      runHandler(
        getCompanyOrganizationBindingInventory,
        createConvexCtx(tables, {
          identity: {
            subject: 'clerk_admin',
            issuer: 'https://clerk.dev',
            email: 'admin@example.com',
          },
        }),
        {}
      )
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })
  })

  it('reports current eligibility and inventory drift without exposing provider locators', async () => {
    const tables = rolloutTables()
    const inventory = await runHandler<
      Record<string, never>,
      {
        enforcementStatus: string
        inventoryComplete: boolean
        pageHasDrift: boolean
        pageHasCreationDrift: boolean
        summary: Record<string, number>
        rows: Array<Record<string, unknown>>
      }
    >(
      getCompanyOrganizationBindingInventory,
      createConvexCtx(tables, { identity: ADMIN_IDENTITY }),
      {}
    )

    expect(inventory).toMatchObject({
      enforcementStatus: 'UNENFORCED',
      inventoryComplete: false,
      pageHasDrift: false,
      pageHasCreationDrift: false,
      summary: {
        totalCompanies: 3,
        workosOwned: 3,
        bound: 0,
        unresolved: 2,
        ambiguous: 1,
        invalid: 0,
        legacy: 0,
      },
      rows: [
        {
          companyId: 'company_unique',
          companyName: 'Issuer Unique',
          status: 'UNRESOLVED',
          candidateCount: 1,
          membershipCapExceeded: false,
          bindingCount: 0,
          inventoryRecorded: false,
          inventoryDrift: false,
        },
        {
          companyId: 'company_unresolved',
          companyName: 'Issuer Unresolved',
          status: 'UNRESOLVED',
          candidateCount: 0,
          bindingCount: 0,
        },
        {
          companyId: 'company_ambiguous',
          companyName: 'Issuer Ambiguous',
          status: 'AMBIGUOUS',
          candidateCount: 2,
          bindingCount: 0,
        },
      ],
    })
    expect(JSON.stringify(inventory)).not.toContain('org_unique')
    expect(JSON.stringify(inventory)).not.toContain('org_ambiguous')
  })

  it('inventories historical companies without assigning an organization automatically', async () => {
    const tables = rolloutTables()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await expect(runHandler(backfillCompanyOrganizationBindings, ctx, {})).resolves.toMatchObject({
      inserted: 0,
      unchanged: 0,
      unresolved: 2,
      ambiguous: 1,
      isDone: true,
    })
    expect(tables.companyOrganizationBindings).toEqual([])
    expect(tables.companyAuthorizationInventoryRows).toHaveLength(3)

    await expect(runHandler(backfillCompanyOrganizationBindings, ctx, {})).resolves.toMatchObject({
      inserted: 0,
      unchanged: 0,
      unresolved: 2,
      ambiguous: 1,
      isDone: true,
    })
    expect(tables.companyOrganizationBindings).toEqual([])
  })

  it('does not rewrite an existing binding when current membership points elsewhere', async () => {
    const tables = cutoverTables()
    tables.companyOrganizationBindings = [
      {
        _id: 'binding_existing',
        _creationTime: 80,
        companyId: 'company_unique',
        ownerProfileId: 'profile_owner_unique',
        authProvider: 'workos',
        providerOrgId: 'org_existing',
        source: 'ADMIN_RESOLUTION',
        resolutionReason: 'Previously verified organization',
      },
    ]
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await expect(runHandler(backfillCompanyOrganizationBindings, ctx, {})).resolves.toMatchObject({
      inserted: 0,
      unresolved: 1,
    })
    expect(tables.companyOrganizationBindings).toEqual([
      expect.objectContaining({
        _id: 'binding_existing',
        providerOrgId: 'org_existing',
        source: 'ADMIN_RESOLUTION',
      }),
    ])
  })

  it('records the reason and admin audit evidence for an ambiguous manual resolution', async () => {
    const tables = rolloutTables()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    const reason = 'Validated against the signed issuer onboarding record'

    await expect(
      runHandler(resolveCompanyOrganizationBinding, ctx, {
        companyId: 'company_ambiguous',
        providerOrgId: 'org_ambiguous_b',
        reason,
      })
    ).resolves.toEqual({ companyId: 'company_ambiguous', status: 'BOUND' })
    expect(tables.companyOrganizationBindings).toContainEqual(
      expect.objectContaining({
        companyId: 'company_ambiguous',
        providerOrgId: 'org_ambiguous_b',
        source: 'ADMIN_RESOLUTION',
        updatedByProfileId: 'profile_admin',
        resolutionReason: reason,
      })
    )
    expect(tables.adminAuditLogs).toContainEqual(
      expect.objectContaining({
        adminProfileId: 'profile_admin',
        action: 'SYSTEM_CONFIG_CHANGE',
        targetType: 'COMPANY',
        targetId: 'company_ambiguous',
        notes: reason,
      })
    )
  })

  it('rejects an admin resolution without a current usable owner membership', async () => {
    const tables = rolloutTables()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    const reason = 'Confirmed directly with the issuer administrator before membership provisioning'

    await expect(
      runHandler(resolveCompanyOrganizationBinding, ctx, {
        companyId: 'company_unresolved',
        providerOrgId: 'org_admin_confirmed',
        reason,
      })
    ).rejects.toMatchObject({ data: { code: 'VALIDATION_FAILED' } })
    expect(tables.companyOrganizationBindings).toEqual([])
    expect(tables.adminAuditLogs).toEqual([])
  })

  it('rejects inactive owner memberships', async () => {
    const tables = cutoverTables()
    const membership = tables.organizationMemberships[0]
    membership.status = 'INACTIVE'
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    const inventory = await runHandler(getCompanyOrganizationBindingInventory, ctx, {})
    expect(inventory).toMatchObject({
      rows: [
        {
          companyId: 'company_unique',
          status: 'UNRESOLVED',
          candidateCount: 0,
        },
      ],
    })
    await expect(
      runHandler(resolveCompanyOrganizationBinding, ctx, {
        companyId: 'company_unique',
        providerOrgId: 'org_unique',
        reason: 'The inactive membership must not authorize this binding',
      })
    ).rejects.toMatchObject({ data: { code: 'VALIDATION_FAILED' } })
  })

  it('rejects duplicate usable owner memberships for the same organization', async () => {
    const tables = cutoverTables()
    tables.organizationMemberships.push(
      ownerMembership({
        _id: 'membership_unique_duplicate',
        _creationTime: 101,
        userId: 'user_owner_unique',
        profileId: 'profile_owner_unique',
      })
    )
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    const inventory = await runHandler(getCompanyOrganizationBindingInventory, ctx, {})
    expect(inventory).toMatchObject({
      rows: [
        {
          companyId: 'company_unique',
          status: 'AMBIGUOUS',
          candidateCount: 2,
        },
      ],
    })
    await expect(
      runHandler(resolveCompanyOrganizationBinding, ctx, {
        companyId: 'company_unique',
        providerOrgId: 'org_unique',
        reason: 'Duplicate provider evidence requires reconciliation first',
      })
    ).rejects.toMatchObject({ data: { code: 'VALIDATION_FAILED' } })
  })

  it('requires an explicit admin resolution when membership history crosses organizations', async () => {
    const tables = cutoverTables()
    tables.organizationMemberships.push(
      ownerMembership({
        _id: 'membership_unique_old_org',
        _creationTime: 99,
        userId: 'user_owner_unique',
        profileId: 'profile_owner_unique',
        providerOrgId: 'org_old',
        workosOrgId: 'org_old',
        status: 'INACTIVE',
      })
    )
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await expect(runHandler(backfillCompanyOrganizationBindings, ctx, {})).resolves.toMatchObject({
      inserted: 0,
      ambiguous: 1,
    })
    expect(tables.companyOrganizationBindings).toEqual([])
    await expect(
      runHandler(resolveCompanyOrganizationBinding, ctx, {
        companyId: 'company_unique',
        providerOrgId: 'org_unique',
        reason: 'Current issuer records confirm the surviving organization',
      })
    ).resolves.toEqual({ companyId: 'company_unique', status: 'BOUND' })
  })

  it('requires an explicit admin resolution when a deletion tombstone exists', async () => {
    const tables = cutoverTables()
    tables.organizationMembershipTombstones = [
      {
        _id: 'tombstone_old_org',
        _creationTime: 90,
        authProvider: 'workos',
        providerMembershipId: 'om_old',
        providerOrgId: 'org_old',
        providerUserId: 'workos_owner_unique',
        deletedAt: 90,
      },
    ]
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await expect(runHandler(backfillCompanyOrganizationBindings, ctx, {})).resolves.toMatchObject({
      inserted: 0,
      ambiguous: 1,
    })
    expect(tables.companyOrganizationBindings).toEqual([])
    await expect(
      runHandler(resolveCompanyOrganizationBinding, ctx, {
        companyId: 'company_unique',
        providerOrgId: 'org_unique',
        reason: 'The administrator reconciled the deletion tombstone',
      })
    ).resolves.toEqual({ companyId: 'company_unique', status: 'BOUND' })
  })

  it('treats a WorkOS binding on a Clerk-only owner as invalid and blocks repair or cutover', async () => {
    const tables = cutoverTables()
    const owner = tables.users.find((row) => row._id === 'user_owner_unique')!
    owner.authProvider = 'clerk'
    owner.providerUserId = 'clerk_owner_unique'
    owner.clerkId = 'clerk_owner_unique'
    delete owner.workosUserId
    tables.companyOrganizationBindings = [
      {
        _id: 'stale_binding',
        companyId: 'company_unique',
        ownerProfileId: 'profile_owner_unique',
        authProvider: 'workos',
        providerOrgId: 'org_unique',
        source: 'BACKFILL',
      },
    ]
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    const inventory = await runHandler(getCompanyOrganizationBindingInventory, ctx, {})
    expect(inventory).toMatchObject({
      summary: { workosOwned: 1, invalid: 1, legacy: 0 },
      rows: [
        {
          companyId: 'company_unique',
          status: 'INVALID_BINDING',
          bindingCount: 1,
        },
      ],
    })
    await expect(
      runHandler(resolveCompanyOrganizationBinding, ctx, {
        companyId: 'company_unique',
        providerOrgId: 'org_unique',
        reason: 'Attempted repair without a durable WorkOS owner link',
      })
    ).rejects.toThrow(/WorkOS/i)
    await runHandler(backfillCompanyOrganizationBindings, ctx, {})
    await expect(runHandler(activateCompanyOrganizationBindingCutover, ctx, {})).rejects.toThrow(
      /membresía owner activa y exacta/i
    )
  })

  it('activates only after inventory and explicit binding resolution', async () => {
    const tables = cutoverTables()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await expect(runHandler(activateCompanyOrganizationBindingCutover, ctx, {})).rejects.toThrow(
      /inventario/i
    )
    expect(tables.companyAuthorizationControls).toEqual([])
    expect(tables.adminAuditLogs).toEqual([])

    await expect(runHandler(backfillCompanyOrganizationBindings, ctx, {})).resolves.toMatchObject({
      inserted: 0,
      unresolved: 1,
    })
    await runHandler(resolveCompanyOrganizationBinding, ctx, {
      companyId: 'company_unique',
      providerOrgId: 'org_unique',
      reason: 'The issuer organization was verified before cutover',
    })
    await expect(runHandler(activateCompanyOrganizationBindingCutover, ctx, {})).resolves.toEqual({
      status: 'ENFORCED',
      workosOwned: 1,
    })
    expect(tables.companyAuthorizationControls).toEqual([
      expect.objectContaining({
        key: 'WORKOS_COMPANY_ORG_BINDING_V1',
        status: 'ENFORCED',
        activatedByProfileId: 'profile_admin',
      }),
    ])
    expect(tables.adminAuditLogs).toContainEqual(
      expect.objectContaining({
        action: 'SYSTEM_CONFIG_CHANGE',
        targetType: 'SYSTEM',
        targetId: 'WORKOS_COMPANY_ORG_BINDING_V1',
        newValue: { status: 'ENFORCED', workosOwned: 1, bound: 1 },
      })
    )
  })

  it('detects a company created after the completed inventory and blocks cutover', async () => {
    const tables = cutoverTables()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    await runHandler(backfillCompanyOrganizationBindings, ctx, {})

    tables.users.push({
      _id: 'user_new',
      _creationTime: Number.MAX_SAFE_INTEGER - 2,
      authProvider: 'workos',
      providerUserId: 'workos_new',
      workosUserId: 'workos_new',
      email: 'new@example.com',
      role: 'COMPANY',
    })
    tables.profiles.push({
      _id: 'profile_new',
      _creationTime: Number.MAX_SAFE_INTEGER - 1,
      userId: 'user_new',
      role: 'COMPANY',
      isActive: true,
    })
    tables.companies.push({
      _id: 'company_new',
      _creationTime: Number.MAX_SAFE_INTEGER,
      ownerId: 'profile_new',
      name: 'Issuer New',
    })
    tables.organizationMemberships.push(
      ownerMembership({
        _id: 'membership_new',
        userId: 'user_new',
        profileId: 'profile_new',
        providerOrgId: 'org_new',
        workosOrgId: 'org_new',
      })
    )

    const inventory = await runHandler(getCompanyOrganizationBindingInventory, ctx, {})
    expect(inventory).toMatchObject({
      pageHasDrift: true,
      pageHasCreationDrift: true,
      rows: [
        expect.objectContaining({ companyId: 'company_unique' }),
        expect.objectContaining({
          companyId: 'company_new',
          inventoryRecorded: false,
          inventoryDrift: true,
          createdAfterInventoryStart: true,
        }),
      ],
    })
    await expect(runHandler(activateCompanyOrganizationBindingCutover, ctx, {})).rejects.toThrow(
      /ya no coincide/i
    )
  })

  it('revalidates eligibility at activation when membership changed after inventory', async () => {
    const tables = cutoverTables()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    await runHandler(backfillCompanyOrganizationBindings, ctx, {})
    await runHandler(resolveCompanyOrganizationBinding, ctx, {
      companyId: 'company_unique',
      providerOrgId: 'org_unique',
      reason: 'The issuer organization was verified before cutover',
    })
    tables.organizationMemberships[0].status = 'INACTIVE'

    const inventory = await runHandler(getCompanyOrganizationBindingInventory, ctx, {})
    expect(inventory).toMatchObject({
      pageHasDrift: true,
      rows: [
        {
          companyId: 'company_unique',
          status: 'INVALID_BINDING',
          inventoryStatus: 'BOUND',
          inventoryDrift: true,
        },
      ],
    })
    await expect(runHandler(activateCompanyOrganizationBindingCutover, ctx, {})).rejects.toThrow(
      /membresía owner activa y exacta/i
    )
  })

  it('pauses enforcement, resets inventory progress, and preserves exact bindings', async () => {
    const tables = cutoverTables()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    await runHandler(backfillCompanyOrganizationBindings, ctx, {})
    await runHandler(resolveCompanyOrganizationBinding, ctx, {
      companyId: 'company_unique',
      providerOrgId: 'org_unique',
      reason: 'The issuer organization was verified before cutover',
    })
    await runHandler(activateCompanyOrganizationBindingCutover, ctx, {})

    const reason = 'Pause enforcement while the inventory is rebuilt'
    await expect(
      runHandler(pauseCompanyOrganizationBindingCutover, ctx, { reason })
    ).resolves.toEqual({
      status: 'UNENFORCED',
      inventoryReset: true,
      bindingsPreserved: true,
    })
    expect(tables.companyOrganizationBindings).toEqual([
      expect.objectContaining({
        companyId: 'company_unique',
        providerOrgId: 'org_unique',
        source: 'ADMIN_RESOLUTION',
      }),
    ])
    expect(tables.companyAuthorizationControls).toEqual([
      expect.not.objectContaining({
        inventoryEpoch: expect.anything(),
        inventoryNextCursor: expect.anything(),
        inventoryCompletedAt: expect.anything(),
        activatedAt: expect.anything(),
      }),
    ])
    expect(tables.companyAuthorizationControls[0]).toMatchObject({ status: 'UNENFORCED' })
    expect(tables.adminAuditLogs).toContainEqual(expect.objectContaining({ notes: reason }))
  })

  it('persists paginated coverage and refuses cutover until the final batch completes', async () => {
    const tables = rolloutTables()
    tables.users = tables.users.filter((row) => row._id !== 'user_owner_ambiguous')
    tables.profiles = tables.profiles.filter((row) => row._id !== 'profile_owner_ambiguous')
    tables.companies = tables.companies.filter((row) => row._id !== 'company_ambiguous')
    tables.organizationMemberships = tables.organizationMemberships.filter(
      (row) => !String(row._id).startsWith('membership_ambiguous')
    )
    tables.organizationMemberships.push(
      ownerMembership({
        _id: 'membership_second_unique',
        userId: 'user_owner_unresolved',
        profileId: 'profile_owner_unresolved',
        providerOrgId: 'org_second_unique',
        workosOrgId: 'org_second_unique',
      })
    )
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await expect(
      runHandler(backfillCompanyOrganizationBindings, ctx, {
        numItems: 1,
        cursor: '1',
      })
    ).rejects.toThrow(/cursor inicial/i)
    expect(tables.companyAuthorizationControls).toEqual([])

    const first = await runHandler<
      { numItems: number },
      { inserted: number; isDone: boolean; continueCursor: string }
    >(backfillCompanyOrganizationBindings, ctx, { numItems: 1 })
    expect(first).toMatchObject({ inserted: 0, isDone: false })
    await expect(runHandler(activateCompanyOrganizationBindingCutover, ctx, {})).rejects.toThrow(
      /inventario/i
    )
    expect(tables.companyAuthorizationControls).toContainEqual(
      expect.objectContaining({ inventoryNextCursor: first.continueCursor })
    )
    await expect(
      runHandler(backfillCompanyOrganizationBindings, ctx, {
        numItems: 1,
        cursor: '999',
      })
    ).rejects.toThrow(/progreso durable/i)

    const second = await runHandler(backfillCompanyOrganizationBindings, ctx, {
      numItems: 1,
      cursor: first.continueCursor,
    })
    expect(second).toMatchObject({ inserted: 0, isDone: true })
    expect(tables.companyAuthorizationInventoryRows).toHaveLength(2)

    await runHandler(resolveCompanyOrganizationBinding, ctx, {
      companyId: 'company_unique',
      providerOrgId: 'org_unique',
      reason: 'The first issuer organization was verified before cutover',
    })
    await runHandler(resolveCompanyOrganizationBinding, ctx, {
      companyId: 'company_unresolved',
      providerOrgId: 'org_second_unique',
      reason: 'The second issuer organization was verified before cutover',
    })

    await expect(runHandler(activateCompanyOrganizationBindingCutover, ctx, {})).resolves.toEqual({
      status: 'ENFORCED',
      workosOwned: 2,
    })
  })
})
