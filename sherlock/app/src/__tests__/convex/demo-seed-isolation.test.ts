import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { ensureRoom, registerFixture } from '../../../convex/_demoSeed'

type Company = {
  _id: string
  name: string
  demo?: boolean
  logoUrl?: string
}

const ensureRoomHandler = (
  ensureRoom as unknown as {
    _handler: (ctx: unknown, args: { company: 'samplehydro' }) => Promise<unknown>
  }
)._handler

const registerFixtureHandler = (
  registerFixture as unknown as {
    _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<string>
  }
)._handler

const originalBypassAuth = process.env.BYPASS_AUTH
const originalConvexEnv = process.env.CONVEX_ENV

function contextWithOwnedCompanies(companies: Company[]) {
  const user = { _id: 'user_1', workosUserId: 'workos_1' }
  const profile = { _id: 'profile_1', role: 'COMPANY' }
  const rows = {
    users: [user],
    profiles: [profile],
    companies,
  }
  const insert = vi.fn(async (table: string) => `${table}_new`)
  const patch = vi.fn(async () => undefined)

  return {
    ctx: {
      db: {
        query: vi.fn((table: keyof typeof rows) => ({
          withIndex: vi.fn(() => ({
            first: vi.fn(async () => rows[table][0] ?? null),
            collect: vi.fn(async () => rows[table]),
          })),
        })),
        get: vi.fn(async () => user),
        insert,
        patch,
      },
    },
    insert,
    patch,
  }
}

describe('_demoSeed.ensureRoom company isolation', () => {
  beforeAll(() => {
    process.env.BYPASS_AUTH = 'true'
    process.env.CONVEX_ENV = 'dev'
  })

  afterAll(() => {
    if (originalBypassAuth === undefined) delete process.env.BYPASS_AUTH
    else process.env.BYPASS_AUTH = originalBypassAuth
    if (originalConvexEnv === undefined) delete process.env.CONVEX_ENV
    else process.env.CONVEX_ENV = originalConvexEnv
  })

  it('allows an owner with no companies and creates the requested demo room', async () => {
    const { ctx, insert } = contextWithOwnedCompanies([])

    await expect(ensureRoomHandler(ctx, { company: 'samplehydro' })).resolves.toMatchObject({
      companyId: 'companies_new',
      created: true,
    })
    expect(insert).toHaveBeenCalledWith(
      'companies',
      expect.objectContaining({ name: 'Sample Hydro, S. A.', demo: true })
    )
  })

  it('allows exactly one matching demo room and updates it in place', async () => {
    const existing = {
      _id: 'company_samplehydro',
      name: 'Sample Hydro, S. A.',
      demo: true,
    }
    const { ctx, patch } = contextWithOwnedCompanies([existing])

    await expect(ensureRoomHandler(ctx, { company: 'samplehydro' })).resolves.toMatchObject({
      companyId: 'company_samplehydro',
      created: false,
    })
    expect(patch).toHaveBeenCalledWith(
      'user_1',
      expect.objectContaining({ name: 'Sample Hydro, S. A.' })
    )
    expect(patch).toHaveBeenCalledWith('profile_1', {
      fullName: 'Sample Hydro, S. A.',
    })
    expect(patch).toHaveBeenCalledWith(
      'company_samplehydro',
      expect.objectContaining({ demo: true })
    )
  })

  it.each([
    {
      label: 'an unrelated non-demo company',
      companies: [{ _id: 'company_real', name: 'Empresa real', demo: false }],
    },
    {
      label: 'a same-name non-demo company',
      companies: [{ _id: 'company_real_samplehydro', name: 'Sample Hydro, S. A.', demo: false }],
    },
    {
      label: 'the target demo plus any second company',
      companies: [
        { _id: 'company_samplehydro', name: 'Sample Hydro, S. A.', demo: true },
        { _id: 'company_other', name: 'Otra empresa', demo: false },
      ],
    },
    {
      label: 'two matching demo rows',
      companies: [
        { _id: 'company_samplehydro_1', name: 'Sample Hydro, S. A.', demo: true },
        { _id: 'company_samplehydro_2', name: 'Sample Hydro, S. A.', demo: true },
      ],
    },
  ])('rejects $label', async ({ companies }) => {
    const { ctx } = contextWithOwnedCompanies(companies)

    await expect(ensureRoomHandler(ctx, { company: 'samplehydro' })).rejects.toThrow(
      /una empresa|sala demo/i
    )
  })

  it('keeps the visible dev journey on SAMPLE_HYDRO and makes it the default room', () => {
    const appRoot = resolve(process.cwd())
    const visibleEntrypoints = [
      'src/lib/dev-auth/types.ts',
      'src/lib/dev-auth/demo-data.ts',
      'src/lib/dev-auth/demo-company.ts',
      'src/lib/dev-auth/demo-browser-store.ts',
      'src/components/admin/AdminSecurityClient.tsx',
      'src/components/company/vdr/helpers.ts',
      'convex/_helpers/auth.dev.ts',
      'convex/_demoSeed.ts',
    ]

    for (const file of visibleEntrypoints) {
      const source = readFileSync(resolve(appRoot, file), 'utf8')
      expect(source, file).not.toMatch(/Agroindustrias Espav|Deal Sponsor|Capital Raise/)
    }

    const demoSeed = readFileSync(resolve(appRoot, 'convex/_demoSeed.ts'), 'utf8')
    expect(demoSeed).toContain("return DEMO_COMPANIES[key ?? 'samplehydro']")
  })
})

describe('_demoSeed.registerFixture provenance', () => {
  beforeAll(() => {
    process.env.BYPASS_AUTH = 'true'
    process.env.CONVEX_ENV = 'dev'
  })

  afterAll(() => {
    if (originalBypassAuth === undefined) delete process.env.BYPASS_AUTH
    else process.env.BYPASS_AUTH = originalBypassAuth
    if (originalConvexEnv === undefined) delete process.env.CONVEX_ENV
    else process.env.CONVEX_ENV = originalConvexEnv
  })

  it('persists the synthetic document provenance and computed SHA-256', async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce('document_synthetic')
      .mockResolvedValueOnce(undefined)
    const digest = 'a'.repeat(64)

    await registerFixtureHandler(
      { runMutation },
      {
        companyId: 'company_samplehydro',
        ownerProfileId: 'profile_1',
        providerUserId: 'workos_1',
        storageId: 'storage_synthetic',
        name: 'Estados financieros de ejemplo',
        fileType: 'application/pdf',
        signatureKind: 'PDF',
        folder: 'room_financial',
        company: 'samplehydro',
        sourceType: 'SYNTHETIC_DEMO',
        sourceName: 'estados-financieros-fy24.pdf',
        provenanceNotes: 'Documento ficticio para pruebas.',
        sourceSha256: digest,
      }
    )

    expect(runMutation).toHaveBeenCalledTimes(2)
    expect(runMutation.mock.calls[1]?.[1]).toMatchObject({
      documentId: 'document_synthetic',
      sourceType: 'SYNTHETIC_DEMO',
      sourceName: 'estados-financieros-fy24.pdf',
      provenanceNotes: `Documento ficticio para pruebas. SHA-256: ${digest}.`,
    })
  })
})
