import { describe, expect, it, vi } from 'vitest'

import * as documentMutations from '../../../convex/_documents/mutations'
import { create, deleteStorageFileInternal } from '../../../convex/_documents/mutations'
import { evaluateDocumentAccess } from '../../../convex/_documents/shared'
import { filterApi } from './nda-convex-harness'

type Row = Record<string, unknown> & { _id: string }
type Tables = Record<string, Row[]>
type Filter = { field: string; value: unknown }

function createQueryBuilder(rows: Row[]) {
  let filters: Filter[] = []
  const predicates: Array<(row: Row) => boolean> = []
  const matchesRow = (row: Row) =>
    filters.every((filter) => row[filter.field] === filter.value) &&
    predicates.every((predicate) => predicate(row))

  const builder = {
    withIndex: vi.fn(
      (
        _index: string,
        callback?: (query: { eq: (field: string, value: unknown) => unknown }) => unknown
      ) => {
        filters = []
        const range = {
          eq: (field: string, value: unknown) => {
            filters.push({ field, value })
            return range
          },
        }
        callback?.(range)
        return builder
      }
    ),
    filter: vi.fn((callback: (query: typeof filterApi) => unknown) => {
      const predicate = callback(filterApi) as { __predicate: (row: Row) => unknown }
      predicates.push((row) => Boolean(predicate.__predicate(row)))
      return builder
    }),
    order: vi.fn(() => builder),
    first: vi.fn(async () => rows.find(matchesRow) ?? null),
    unique: vi.fn(async () => rows.find(matchesRow) ?? null),
    collect: vi.fn(async () => rows.filter(matchesRow)),
    take: vi.fn(async (count: number) => rows.filter(matchesRow).slice(0, count)),
  }

  return builder
}

function createCtx(seed: Tables) {
  const tables: Tables = Object.fromEntries(
    Object.entries(seed).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))])
  )

  return {
    auth: {
      getUserIdentity: vi.fn(async () => ({
        issuer: 'https://api.workos.com/',
        subject: 'user_workos_investor',
        email: 'investor@example.com',
      })),
    },
    db: {
      query: vi.fn((table: string) => createQueryBuilder(tables[table] ?? [])),
      get: vi.fn(async (id: string) => {
        for (const rows of Object.values(tables)) {
          const row = rows.find((candidate) => candidate._id === id)
          if (row) return row
        }
        return null
      }),
      patch: vi.fn(),
      insert: vi.fn(),
    },
  }
}

const runCreateDocument = (ctx: unknown, args: Record<string, unknown>) =>
  (
    create as unknown as {
      _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>
    }
  )._handler(ctx, args)

const runDeleteStorageFileInternal = (ctx: unknown, storageId: string) =>
  (
    deleteStorageFileInternal as unknown as {
      _handler: (ctx: unknown, args: { storageId: string }) => Promise<unknown>
    }
  )._handler(ctx, { storageId })

function investorAuth() {
  return {
    identity: {
      subject: 'user_workos_investor',
      authProvider: 'workos',
    },
    user: {
      _id: 'user_1',
      workosUserId: 'user_workos_investor',
    },
    profile: {
      _id: 'investor_profile_1',
      role: 'COMPANY',
      kycStatus: 'VERIFIED',
    },
  } as never
}

describe('VDR security regressions', () => {
  it('keeps the company library closed to a principal without management authorization', async () => {
    const ctx = createCtx({
      companies: [{ _id: 'company_1', ownerId: 'issuer_profile_1' }],
      investors: [{ _id: 'investor_1', ownerId: 'investor_profile_1' }],
      connections: [
        {
          _id: 'connection_company_level',
          companyId: 'company_1',
          investorId: 'investor_1',
          dealId: 'deal_unrelated',
          status: 'ACCEPTED',
        },
      ],
      ndas: [
        {
          _id: 'nda_1',
          investorId: 'investor_1',
          companyId: 'company_1',
          isActive: true,
          signedAt: Date.now() - 1000,
        },
      ],
    })

    const decision = await evaluateDocumentAccess(ctx as never, investorAuth(), {
      _id: 'document_standalone',
      companyId: 'company_1',
      accessLevel: 'NDA_REQUIRED',
      classification: 'CONFIDENTIAL',
    } as never)

    expect(decision.decision).toBe('DENY')
    expect(decision.outcome).toBe('DENIED_COMPANY_ROOM_NOT_SHARED')
  })

  it('does not delete a storage file that is still referenced by a document', async () => {
    const deleteStorage = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ctx = createCtx({
      documents: [{ _id: 'document_1', storageId: 'storage_1' }],
    })

    const result = await runDeleteStorageFileInternal(
      {
        ...ctx,
        storage: { delete: deleteStorage },
      },
      'storage_1'
    )

    expect(result).toEqual({ deleted: false, reason: 'referenced-document' })
    expect(deleteStorage).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('no expone una mutation pública que escriba bitácoras de acceso', () => {
    expect(documentMutations).not.toHaveProperty('logAccess')
    expect(documentMutations).not.toHaveProperty('deleteStorageFile')
    expect(documentMutations).toHaveProperty('deleteStorageFileInternal')
  })

  it('rejects public document creation when callers attach raw storage ids directly', async () => {
    const ctx = createCtx({
      users: [
        {
          _id: 'user_company',
          authProvider: 'workos',
          providerUserId: 'user_workos_investor',
          workosUserId: 'user_workos_investor',
          email: 'issuer@example.com',
        },
      ],
      profiles: [{ _id: 'issuer_profile_1', userId: 'user_company', role: 'COMPANY' }],
      companies: [{ _id: 'company_1', ownerId: 'issuer_profile_1' }],
      organizationMemberships: [
        {
          _id: 'membership_issuer',
          userId: 'user_company',
          profileId: 'issuer_profile_1',
          authProvider: 'workos',
          providerOrgId: 'org_issuer',
          workosOrgId: 'org_issuer',
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
        },
      ],
      companyOrganizationBindings: [
        {
          _id: 'binding_company_1',
          companyId: 'company_1',
          ownerProfileId: 'issuer_profile_1',
          authProvider: 'workos',
          providerOrgId: 'org_issuer',
          createdAt: 1,
          createdByProfileId: 'issuer_profile_1',
        },
      ],
    })

    await expect(
      runCreateDocument(ctx, {
        companyId: 'company_1',
        name: 'unvalidated-upload.pdf',
        fileType: 'application/pdf',
        fileSize: 1234,
        storageId: 'storage_unvalidated_1',
        accessLevel: 'NDA_REQUIRED',
      })
    ).rejects.toThrow(/upload|validado|storage/i)

    expect(ctx.db.insert).not.toHaveBeenCalled()
  })
})
