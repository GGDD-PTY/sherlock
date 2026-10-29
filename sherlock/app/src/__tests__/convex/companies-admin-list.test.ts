import { describe, expect, it } from 'vitest'

import { listAdminCompaniesPaginated } from '../../../convex/companies'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const ADMIN_IDENTITY = {
  issuer: 'https://api.workos.com/',
  subject: 'workos_admin',
  email: 'fixture-14e4636f@example.com',
}

function tables(): Tables {
  return {
    users: [
      {
        _id: 'user_admin',
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'fixture-14e4636f@example.com',
        name: 'Admin',
      },
      {
        _id: 'user_samplefoods_a',
        authProvider: 'workos',
        providerUserId: 'workos_samplefoods_a',
        workosUserId: 'workos_samplefoods_a',
        email: 'sample-foods-a@dev.local',
        name: 'SampleFoods A',
      },
      {
        _id: 'user_samplefoods_b',
        authProvider: 'workos',
        providerUserId: 'workos_samplefoods_b',
        workosUserId: 'workos_samplefoods_b',
        email: 'sample-foods-b@dev.local',
        name: 'SampleFoods B',
      },
    ],
    profiles: [
      {
        _id: 'profile_admin',
        userId: 'user_admin',
        role: 'ADMIN',
        isActive: true,
      },
      {
        _id: 'profile_samplefoods_a',
        userId: 'user_samplefoods_a',
        role: 'COMPANY',
        isActive: true,
      },
      {
        _id: 'profile_samplefoods_b',
        userId: 'user_samplefoods_b',
        role: 'COMPANY',
        isActive: true,
      },
    ],
    companies: [
      {
        _id: 'company_samplefoods_a',
        ownerId: 'profile_samplefoods_a',
        name: 'Sample Foods, S.A.',
        country: 'PA',
        _creationTime: 20,
      },
      {
        _id: 'company_samplefoods_b',
        ownerId: 'profile_samplefoods_b',
        name: 'Sample Foods, S.A.',
        country: 'PA',
        _creationTime: 10,
      },
      {
        _id: 'company_orphan',
        ownerId: 'profile_missing',
        name: 'Huérfana',
        country: 'PA',
        _creationTime: 5,
      },
    ],
  }
}

describe('listAdminCompaniesPaginated ownerEmail', () => {
  it('returns the owner email with the same lookup as the operations panel', async () => {
    const ctx = createConvexCtx(tables(), { identity: ADMIN_IDENTITY })

    const result = await runHandler<
      { paginationOpts: { numItems: number; cursor: string | null } },
      {
        page: Array<{ _id: string; name: string; ownerEmail: string | null }>
        isDone: boolean
      }
    >(listAdminCompaniesPaginated, ctx, {
      paginationOpts: { numItems: 10, cursor: null },
    })

    expect(result.page).toEqual([
      expect.objectContaining({
        _id: 'company_samplefoods_a',
        name: 'Sample Foods, S.A.',
        ownerEmail: 'sample-foods-a@dev.local',
      }),
      expect.objectContaining({
        _id: 'company_samplefoods_b',
        name: 'Sample Foods, S.A.',
        ownerEmail: 'sample-foods-b@dev.local',
      }),
      expect.objectContaining({
        _id: 'company_orphan',
        name: 'Huérfana',
        ownerEmail: null,
      }),
    ])
    expect(result.isDone).toBe(true)
  })
})
