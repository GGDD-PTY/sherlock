import { describe, expect, it } from 'vitest'

import {
  createCompany,
  getAdminVdrWorkspace,
  getCompany,
  getCompanyByOwner,
  getMyVdrWorkspace,
  updateCompany,
} from '../../../convex/companies'
import { get, getByCompany, getFolders, listVersions } from '../../../convex/_documents/queries'
import { create as createDocument } from '../../../convex/_documents/mutations'
import { getDownloadUrl } from '../../../convex/_documents/storage'
import { createConvexCtx, runHandler, type Row, type Tables } from './nda-convex-harness'

const MEMBER_IDENTITY = {
  subject: 'workos_member',
  issuer: 'https://api.workos.com/',
  email: 'member@example.com',
}
const OWNER_IDENTITY = {
  subject: 'workos_owner',
  issuer: 'https://api.workos.com/',
  email: 'owner@example.com',
}
const LEGACY_CLERK_IDENTITY = {
  subject: 'clerk_member',
  issuer: 'https://clerk.dev',
  email: 'member@example.com',
}
const ADMIN_IDENTITY = {
  subject: 'workos_admin',
  issuer: 'https://api.workos.com/',
  email: 'fixture-14e4636f@example.com',
}
const LEGACY_OWNER_IDENTITY = {
  subject: 'clerk_owner',
  issuer: 'https://clerk.dev',
  email: 'owner@example.com',
}

function membership(overrides: Partial<Row> = {}): Row {
  return {
    _id: 'membership_member',
    _creationTime: 100,
    userId: 'user_member',
    profileId: 'profile_member',
    authProvider: 'workos',
    providerOrgId: 'org_issuer',
    workosOrgId: 'org_issuer',
    betaRole: 'COMPANY_MEMBER',
    profileRole: 'COMPANY',
    status: 'ACTIVE',
    createdAt: 100,
    ...overrides,
  }
}

function baseTables(): Tables {
  return {
    users: [
      {
        _id: 'user_member',
        authProvider: 'workos',
        providerUserId: 'workos_member',
        workosUserId: 'workos_member',
        email: 'member@example.com',
        role: 'COMPANY',
      },
      {
        _id: 'user_owner',
        authProvider: 'workos',
        providerUserId: 'workos_owner',
        workosUserId: 'workos_owner',
        email: 'owner@example.com',
        role: 'COMPANY',
      },
    ],
    profiles: [
      {
        _id: 'profile_member',
        userId: 'user_member',
        role: 'COMPANY',
        isActive: true,
      },
      {
        _id: 'profile_owner',
        userId: 'user_owner',
        role: 'COMPANY',
        isActive: true,
      },
    ],
    organizationMemberships: [
      membership(),
      membership({
        _id: 'membership_owner',
        _creationTime: 90,
        userId: 'user_owner',
        profileId: 'profile_owner',
        betaRole: 'COMPANY_OWNER',
      }),
    ],
    companies: [
      {
        _id: 'company_issuer',
        _creationTime: 200,
        ownerId: 'profile_owner',
        name: 'Issuer One',
      },
    ],
    companyOrganizationBindings: [
      {
        _id: 'binding_company_issuer',
        companyId: 'company_issuer',
        ownerProfileId: 'profile_owner',
        authProvider: 'workos',
        providerOrgId: 'org_issuer',
        createdAt: 200,
        createdByProfileId: 'profile_owner',
      },
    ],
    workosDirectoryUsers: [],
    workosDirectories: [],
    documents: [
      {
        _id: 'document_index',
        _creationTime: 400,
        companyId: 'company_issuer',
        name: 'Modelo financiero.pdf',
        folder: 'Financieros',
        storageId: 'storage_document_secret',
        storagePath: 'issuer/company_issuer/private/modelo.pdf',
        accessLevel: 'NDA_REQUIRED',
        lifecycleStatus: 'ACTIVE',
        classification: 'CONFIDENTIAL',
        currentVersionId: 'version_index',
        publishedVersionId: 'version_index',
      },
    ],
    documentVersions: [
      {
        _id: 'version_index',
        _creationTime: 401,
        documentId: 'document_index',
        companyId: 'company_issuer',
        versionNumber: 1,
        storageId: 'storage_index',
        displayName: 'Modelo financiero.pdf',
        declaredMimeType: 'application/pdf',
        detectedMimeType: 'application/pdf',
        byteSize: 2048,
        sha256: 'a'.repeat(64),
        signatureKind: 'PDF',
        verificationStatus: 'SIGNATURE_VERIFIED',
        malwareScanStatus: 'CLEAN',
        publicationStatus: 'PUBLISHED',
        createdAt: 350,
        createdByProfileId: 'profile_owner',
        publishedAt: 360,
      },
    ],
  }
}

function ownerDeprovisionedFromIssuerButActiveElsewhere(): Tables {
  const tables = baseTables()
  tables.organizationMemberships[1]!.status = 'INACTIVE'
  tables.organizationMemberships.push(
    membership({
      _id: 'membership_owner_other_org',
      _creationTime: 110,
      userId: 'user_owner',
      profileId: 'profile_owner',
      providerOrgId: 'org_other',
      workosOrgId: 'org_other',
      betaRole: 'COMPANY_OWNER',
    })
  )
  tables.documents[0]!.storageId = 'storage_index'
  return tables
}

function unboundOwnerDeprovisionedFromIssuerButActiveElsewhere(): Tables {
  const tables = ownerDeprovisionedFromIssuerButActiveElsewhere()
  tables.companyOrganizationBindings = []
  return tables
}

function moveMemberToOtherOrganization(tables: Tables): Tables {
  const memberMembership = tables.organizationMemberships.find(
    (row) => row._id === 'membership_member'
  )!
  memberMembership.providerOrgId = 'org_other'
  memberMembership.workosOrgId = 'org_other'
  return tables
}

function bindCompanyToOtherOrganization(
  tables: Tables,
  source: 'BACKFILL' | 'ADMIN_RESOLUTION'
): Tables {
  Object.assign(tables.companyOrganizationBindings[0]!, {
    providerOrgId: 'org_other',
    source,
    ...(source === 'ADMIN_RESOLUTION'
      ? { resolutionReason: 'Confirmed against the issuer organization record' }
      : {}),
  })
  return tables
}

describe('company VDR organization authorization', () => {
  it('returns the exact target company to an admin', async () => {
    const tables = baseTables()
    tables.users.push({
      _id: 'user_admin',
      authProvider: 'workos',
      providerUserId: 'workos_admin',
      workosUserId: 'workos_admin',
      email: 'fixture-14e4636f@example.com',
      role: 'ADMIN',
    })
    tables.profiles.push({
      _id: 'profile_admin',
      userId: 'user_admin',
      role: 'ADMIN',
      isActive: true,
    })
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await expect(
      runHandler(getAdminVdrWorkspace, ctx, { companyId: 'company_issuer' })
    ).resolves.toEqual({
      company: { _id: 'company_issuer', name: 'Issuer One' },
    })
  })

  it('denies the admin workspace query to an issuer principal', async () => {
    const ctx = createConvexCtx(baseTables(), { identity: OWNER_IDENTITY })

    await expect(
      runHandler(getAdminVdrWorkspace, ctx, { companyId: 'company_issuer' })
    ).rejects.toThrow(/admin/i)
  })

  it('resolves the issuer workspace for an active WorkOS company member in the owner organization', async () => {
    const ctx = createConvexCtx(baseTables(), { identity: MEMBER_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).resolves.toEqual({
      access: 'READ_ONLY',
      company: expect.objectContaining({
        _id: 'company_issuer',
        ownerId: 'profile_owner',
        name: 'Issuer One',
      }),
    })
  })

  it('lets that member read the document index of the resolved company room', async () => {
    const ctx = createConvexCtx(baseTables(), { identity: MEMBER_IDENTITY })

    const result = await runHandler<{ companyId: string }, Array<Record<string, unknown>>>(
      getByCompany,
      ctx,
      { companyId: 'company_issuer' }
    )

    expect(result).toEqual([
      expect.objectContaining({
        _id: 'document_index',
        companyId: 'company_issuer',
        name: 'Modelo financiero.pdf',
      }),
    ])
    expect(result[0]).not.toHaveProperty('storageId')
    expect(result[0]).not.toHaveProperty('storagePath')
  })

  it('fails closed for a WorkOS company owner without an active owner membership', async () => {
    const tables = baseTables()
    tables.organizationMemberships = []
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).resolves.toBeNull()
  })

  it('persists the exact WorkOS organization when an owner creates a company', async () => {
    const tables = baseTables()
    tables.companies = []
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await runHandler(createCompany, ctx, {
      ownerId: 'profile_owner',
      name: 'Issuer Bound',
      country: 'PA',
    })

    expect(ctx.tables.companies).toContainEqual(
      expect.objectContaining({
        ownerId: 'profile_owner',
        name: 'Issuer Bound',
      })
    )
    expect(ctx.tables.companyOrganizationBindings).toContainEqual(
      expect.objectContaining({
        companyId: expect.any(String),
        ownerProfileId: 'profile_owner',
        providerOrgId: 'org_issuer',
      })
    )
  })

  it('keeps a WorkOS owner compatible before cutover when the company has no exact binding', async () => {
    const tables = baseTables()
    tables.companyOrganizationBindings = []
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).resolves.toMatchObject({
      access: 'MANAGE',
      company: { _id: 'company_issuer' },
    })
  })

  it('denies an unbound owner after the issuer membership was revoked and another org remains active', async () => {
    const ctx = createConvexCtx(unboundOwnerDeprovisionedFromIssuerButActiveElsewhere(), {
      identity: OWNER_IDENTITY,
    })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).resolves.toBeNull()
  })

  it('denies a member from the surviving org when the owner history contradicts an unbound company', async () => {
    const tables = moveMemberToOtherOrganization(
      unboundOwnerDeprovisionedFromIssuerButActiveElsewhere()
    )
    const ctx = createConvexCtx(tables, { identity: MEMBER_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).rejects.toThrow(/permiso/i)
  })

  it('fails closed after cutover for a WorkOS owner whose company still has no exact binding', async () => {
    const tables = baseTables()
    tables.companyOrganizationBindings = []
    tables.companyAuthorizationControls = [
      {
        _id: 'company_authorization_control',
        key: 'WORKOS_COMPANY_ORG_BINDING_V1',
        status: 'ENFORCED',
        updatedAt: 500,
        activatedAt: 500,
        activatedByProfileId: 'profile_admin',
      },
    ]
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).resolves.toBeNull()
  })

  it('does not let an active owner membership in another WorkOS organization list issuer documents', async () => {
    const ctx = createConvexCtx(ownerDeprovisionedFromIssuerButActiveElsewhere(), {
      identity: OWNER_IDENTITY,
    })

    await expect(runHandler(getByCompany, ctx, { companyId: 'company_issuer' })).rejects.toThrow(
      /permiso/i
    )
  })

  it('rejects a legacy backfill binding when delayed history reveals another organization', async () => {
    const tables = bindCompanyToOtherOrganization(
      ownerDeprovisionedFromIssuerButActiveElsewhere(),
      'BACKFILL'
    )
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).resolves.toBeNull()
  })

  it('rejects members through a legacy backfill binding with contradictory owner history', async () => {
    const tables = moveMemberToOtherOrganization(
      bindCompanyToOtherOrganization(ownerDeprovisionedFromIssuerButActiveElsewhere(), 'BACKFILL')
    )
    const ctx = createConvexCtx(tables, { identity: MEMBER_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).rejects.toThrow(/permiso/i)
  })

  it('keeps an explicitly confirmed organization authoritative despite older membership history', async () => {
    const tables = bindCompanyToOtherOrganization(
      ownerDeprovisionedFromIssuerButActiveElsewhere(),
      'ADMIN_RESOLUTION'
    )
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).resolves.toMatchObject({
      access: 'MANAGE',
      company: { _id: 'company_issuer' },
    })
  })

  it('does not let that cross-organization owner read a document by direct id', async () => {
    const ctx = createConvexCtx(ownerDeprovisionedFromIssuerButActiveElsewhere(), {
      identity: OWNER_IDENTITY,
    })

    await expect(runHandler(get, ctx, { documentId: 'document_index' })).rejects.toThrow(
      /autoriz|permiso/i
    )
  })

  it('does not let that cross-organization owner inspect management-only document metadata', async () => {
    const ctx = createConvexCtx(ownerDeprovisionedFromIssuerButActiveElsewhere(), {
      identity: OWNER_IDENTITY,
    })

    await expect(runHandler(listVersions, ctx, { documentId: 'document_index' })).rejects.toThrow(
      /permiso/i
    )
    await expect(runHandler(getFolders, ctx, { companyId: 'company_issuer' })).rejects.toThrow(
      /permiso/i
    )
  })

  it('does not let that cross-organization owner mutate issuer documents', async () => {
    const ctx = createConvexCtx(ownerDeprovisionedFromIssuerButActiveElsewhere(), {
      identity: OWNER_IDENTITY,
    })

    await expect(
      runHandler(createDocument, ctx, {
        companyId: 'company_issuer',
        name: 'Intento cross-org.pdf',
      })
    ).rejects.toThrow(/dueño|permiso/i)
    expect(ctx.db.insert).not.toHaveBeenCalled()
  })

  it('revokes the same owner across private company reads and edits', async () => {
    const tables = ownerDeprovisionedFromIssuerButActiveElsewhere()

    await expect(
      runHandler(getCompany, createConvexCtx(tables, { identity: OWNER_IDENTITY }), {
        companyId: 'company_issuer',
      })
    ).rejects.toThrow(/permiso/i)
    await expect(
      runHandler(getCompanyByOwner, createConvexCtx(tables, { identity: OWNER_IDENTITY }), {
        ownerId: 'profile_owner',
      })
    ).rejects.toThrow(/permiso/i)
    await expect(
      runHandler(updateCompany, createConvexCtx(tables, { identity: OWNER_IDENTITY }), {
        companyId: 'company_issuer',
        name: 'Unauthorized rename',
      })
    ).rejects.toThrow(/autorizado|permiso/i)
  })

  it('does not issue a download grant after the issuer organization membership was revoked', async () => {
    const ctx = createConvexCtx(ownerDeprovisionedFromIssuerButActiveElsewhere(), {
      identity: OWNER_IDENTITY,
    })

    await expect(
      runHandler(getDownloadUrl, ctx, { documentId: 'document_index' })
    ).resolves.toMatchObject({
      allowed: false,
      code: 'DENIED_COMPANY_AUTHORIZATION_REVOKED',
    })
    expect(ctx.tables.documentAccessGrants ?? []).toHaveLength(0)
  })

  it('preserves explicit legacy owner access without consuming WorkOS memberships', async () => {
    const tables = baseTables()
    tables.organizationMemberships = []
    tables.companyOrganizationBindings = []
    Object.assign(tables.users[1]!, {
      authProvider: 'clerk',
      providerUserId: 'clerk_owner',
      clerkId: 'clerk_owner',
    })
    delete tables.users[1]!.workosUserId
    const ctx = createConvexCtx(tables, { identity: LEGACY_OWNER_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).resolves.toMatchObject({
      access: 'MANAGE',
      company: { _id: 'company_issuer', ownerId: 'profile_owner' },
    })
    await expect(runHandler(get, ctx, { documentId: 'document_index' })).resolves.toMatchObject({
      _id: 'document_index',
      companyId: 'company_issuer',
    })
  })

  it('el dueño ve la ficha completa del documento sin punteros de storage', async () => {
    // H11 del informe A2: la rama de gestión devolvía la fila cruda de
    // `documents` con `storageId`/`storagePath`; ahora es lista blanca.
    const tables = baseTables()
    tables.organizationMemberships = []
    tables.companyOrganizationBindings = []
    Object.assign(tables.users[1], {
      authProvider: 'clerk',
      providerUserId: 'clerk_owner',
      clerkId: 'clerk_owner',
    })
    delete tables.users[1].workosUserId
    const ctx = createConvexCtx(tables, { identity: LEGACY_OWNER_IDENTITY })

    const result = await runHandler<{ companyId: string }, Array<Record<string, unknown>>>(
      getByCompany,
      ctx,
      { companyId: 'company_issuer' }
    )

    expect(result).toEqual([
      expect.objectContaining({
        _id: 'document_index',
        companyId: 'company_issuer',
        name: 'Modelo financiero.pdf',
      }),
    ])
    expect(result[0]).not.toHaveProperty('storageId')
    expect(result[0]).not.toHaveProperty('storagePath')
  })

  it('fails closed when the company membership is inactive', async () => {
    const tables = baseTables()
    tables.organizationMemberships[0]!.status = 'INACTIVE'
    const ctx = createConvexCtx(tables, { identity: MEMBER_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).resolves.toBeNull()
  })

  it('keeps member read access when the WorkOS-linked owner still has stored Clerk metadata', async () => {
    const tables = baseTables()
    Object.assign(tables.users[1]!, {
      authProvider: 'clerk',
      providerUserId: 'clerk_owner',
      clerkId: 'clerk_owner',
      workosUserId: 'workos_owner',
    })
    const ctx = createConvexCtx(tables, { identity: MEMBER_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).resolves.toMatchObject({
      access: 'READ_ONLY',
      company: { _id: 'company_issuer' },
    })
  })

  it('rejects a retained Clerk session before it can consume a WorkOS membership', async () => {
    const tables = baseTables()
    tables.users[0]!.clerkId = 'clerk_member'
    const ctx = createConvexCtx(tables, { identity: LEGACY_CLERK_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).rejects.toThrow(/proveedor incompatible/i)
  })

  it('fails closed when a directory-backed member was deprovisioned', async () => {
    const tables = baseTables()
    Object.assign(tables.organizationMemberships[0]!, {
      workosDirectoryId: 'directory_issuer',
      workosDirectoryUserId: 'directory_user_member',
    })
    tables.workosDirectoryUsers = [
      {
        _id: 'directory_user_row',
        directoryUserId: 'directory_user_member',
        workosDirectoryId: 'directory_issuer',
        workosOrgId: 'org_issuer',
        userId: 'user_member',
        state: 'INACTIVE',
        active: false,
      },
    ]
    tables.workosDirectories = [
      {
        _id: 'directory_row',
        directoryId: 'directory_issuer',
        workosOrgId: 'org_issuer',
        state: 'ACTIVE',
        active: true,
      },
    ]
    const ctx = createConvexCtx(tables, { identity: MEMBER_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).resolves.toBeNull()
  })

  it('fails closed when Directory Sync returns an ambiguous external user id', async () => {
    const tables = baseTables()
    Object.assign(tables.organizationMemberships[0]!, {
      workosDirectoryId: 'directory_issuer',
      workosDirectoryUserId: 'directory_user_member',
    })
    tables.workosDirectoryUsers = [
      {
        _id: 'directory_user_valid',
        directoryUserId: 'directory_user_member',
        workosDirectoryId: 'directory_issuer',
        workosOrgId: 'org_issuer',
        userId: 'user_member',
        state: 'ACTIVE',
        active: true,
      },
      {
        _id: 'directory_user_ambiguous',
        directoryUserId: 'directory_user_member',
        workosDirectoryId: 'directory_issuer',
        workosOrgId: 'org_issuer',
        userId: 'user_other',
        state: 'ACTIVE',
        active: true,
      },
    ]
    tables.workosDirectories = [
      {
        _id: 'directory_row',
        directoryId: 'directory_issuer',
        workosOrgId: 'org_issuer',
        state: 'ACTIVE',
        active: true,
      },
    ]
    const ctx = createConvexCtx(tables, { identity: MEMBER_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).resolves.toBeNull()
  })

  it('fails closed when multiple active company-member mappings make the organization ambiguous', async () => {
    const tables = baseTables()
    tables.organizationMemberships.push(
      membership({ _id: 'membership_member_duplicate', _creationTime: 101 })
    )
    const ctx = createConvexCtx(tables, { identity: MEMBER_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).rejects.toThrow(/permiso/i)
  })

  it('fails closed when the member organization has no active owner mapping', async () => {
    const tables = baseTables()
    tables.organizationMemberships[0]!.providerOrgId = 'org_other'
    tables.organizationMemberships[0]!.workosOrgId = 'org_other'
    const ctx = createConvexCtx(tables, { identity: MEMBER_IDENTITY })

    await expect(runHandler(getMyVdrWorkspace, ctx, {})).rejects.toThrow(/permiso/i)
  })

  it('does not let a member use its valid organization mapping against another company', async () => {
    const tables = baseTables()
    tables.companies.push({
      _id: 'company_other',
      _creationTime: 201,
      ownerId: 'profile_other',
      name: 'Issuer Other',
    })
    const ctx = createConvexCtx(tables, { identity: MEMBER_IDENTITY })

    await expect(runHandler(getByCompany, ctx, { companyId: 'company_other' })).rejects.toThrow(
      /permiso/i
    )
  })

  it('does not promote read-only membership into document creation rights', async () => {
    const ctx = createConvexCtx(baseTables(), { identity: MEMBER_IDENTITY })

    await expect(
      runHandler(createDocument, ctx, {
        companyId: 'company_issuer',
        name: 'Intento de escalación.pdf',
      })
    ).rejects.toThrow(/dueño|permiso/i)
    expect(ctx.db.insert).not.toHaveBeenCalled()
  })
})
