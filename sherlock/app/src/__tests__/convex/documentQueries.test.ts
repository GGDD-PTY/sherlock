// ============================================================================
// VDR QUERIES — convex/_documents/queries.ts
// ============================================================================
// `getAccessibleForCounterparty` es el listado del data room que ve un inversionista:
// el `.filter(({ evaluation }) => evaluation.decision === 'ALLOW')` es lo que
// materializa anonymous-until-NDA en la lista. Relajarlo a `!== 'DENY'` filtra
// nombres, carpetas y storageId de documentos CONFIDENTIAL antes del gate
// NDA + Contrato de Fee. Estas queries no tenían ninguna ejecución en la suite.
//
// Se usan las implementaciones reales (incluido requireAuth, con users/profiles
// sembrados) sobre un ctx de base de datos en memoria.
// ============================================================================

import { describe, expect, it, vi } from 'vitest'

import {
  get,
  getByCompany,
  getManualReviewQueue,
} from '../../../convex/_documents/queries'
import { filterApi } from './nda-convex-harness'

type Row = Record<string, unknown> & { _id: string }
type Tables = Record<string, Row[]>
type Filter = { field: string; value: unknown }

function createQueryBuilder(rows: Row[]) {
  let filters: Filter[] = []
  const predicates: Array<(row: Row) => boolean> = []
  const matchesRow = (row: Row) =>
    filters.every((f) => row[f.field] === f.value) && predicates.every((p) => p(row))

  const builder = {
    withIndex: vi.fn(
      (
        _index: string,
        callback?: (q: { eq: (field: string, value: unknown) => unknown }) => unknown
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
    order: vi.fn(() => builder),
    filter: vi.fn((callback: (q: typeof filterApi) => unknown) => {
      const predicate = callback(filterApi) as { __predicate: (row: Row) => unknown }
      predicates.push((row) => Boolean(predicate.__predicate(row)))
      return builder
    }),
    first: vi.fn(async () => rows.find(matchesRow) ?? null),
    unique: vi.fn(async () => rows.find(matchesRow) ?? null),
    collect: vi.fn(async () => rows.filter(matchesRow)),
    take: vi.fn(async (count: number) => rows.filter(matchesRow).slice(0, count)),
  }

  return builder
}

function createCtx(seed: Tables, subject = 'user_workos_outsider') {
  const tables: Tables = Object.fromEntries(
    Object.entries(seed).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))])
  )

  return {
    auth: {
      getUserIdentity: vi.fn(async () => ({
        issuer: 'https://api.workos.com/',
        subject,
        email: `${subject}@example.com`,
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

const runHandler = <TArgs>(fn: unknown, ctx: unknown, args: TArgs) =>
  (fn as { _handler: (ctx: unknown, args: TArgs) => Promise<unknown> })._handler(ctx, args)

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

const NOW = Date.now()

const DOCUMENTS: Row[] = [
  {
    _id: 'doc_teaser',
    _creationTime: NOW - 4000,
    companyId: 'company_1',
    name: 'teaser.pdf',
    folder: 'General',
    storageId: 'storage_teaser',
    accessLevel: 'PUBLIC',
    classification: 'PUBLIC_TEASER',
    // Metadatos internos de la sala: los ve quien la administra, no un tercero.
    sourceUrl: 'https://intranet.example/teaser-origen',
    provenanceNotes: 'Versión revisada por el equipo',
  },
  {
    _id: 'doc_confidential',
    _creationTime: NOW - 3000,
    companyId: 'company_1',
    name: 'financials.xlsx',
    folder: 'Financieros',
    storageId: 'storage_confidential',
    accessLevel: 'NDA_REQUIRED',
    classification: 'CONFIDENTIAL',
  },
  {
    _id: 'doc_private',
    _creationTime: NOW - 2000,
    companyId: 'company_1',
    name: 'board-minutes.pdf',
    folder: 'Legal',
    storageId: 'storage_private',
    accessLevel: 'PRIVATE',
    classification: 'RESTRICTED',
  },
  {
    _id: 'doc_kyc',
    _creationTime: NOW - 1000,
    companyId: 'company_1',
    name: 'kyc-passport.pdf',
    folder: 'KYC',
    storageId: 'storage_kyc',
    accessLevel: 'NDA_REQUIRED',
    classification: 'KYC_SENSITIVE',
  },
]

// Un principal autenticado que NO administra esta empresa: es todo lo que queda
// al otro lado de la sala desde que el rol de contraparte salió del producto.
const OUTSIDER_IDENTITY = {
  users: [
    {
      _id: 'user_outsider',
      authProvider: 'workos',
      providerUserId: 'user_workos_outsider',
      workosUserId: 'user_workos_outsider',
      email: 'outsider@example.com',
    },
  ],
  profiles: [
    {
      _id: 'outsider_profile_1',
      userId: 'user_outsider',
      role: 'COMPANY',
      kycStatus: 'VERIFIED',
    },
  ],
}

const OWNER_IDENTITY = {
  users: [
    {
      _id: 'user_company',
      authProvider: 'workos',
      providerUserId: 'user_workos_company',
      workosUserId: 'user_workos_company',
      email: 'issuer@example.com',
    },
  ],
  profiles: [
    { _id: 'issuer_profile_1', userId: 'user_company', role: 'COMPANY', kycStatus: 'VERIFIED' },
  ],
  organizationMemberships: [
    {
      _id: 'membership_company_owner',
      userId: 'user_company',
      profileId: 'issuer_profile_1',
      authProvider: 'workos',
      providerOrgId: 'org_company_1',
      workosOrgId: 'org_company_1',
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
      providerOrgId: 'org_company_1',
    },
  ],
}

const ADMIN_IDENTITY = {
  users: [
    {
      _id: 'user_admin',
      authProvider: 'workos',
      providerUserId: 'user_workos_admin',
      workosUserId: 'user_workos_admin',
      email: 'admin@example.com',
    },
  ],
  profiles: [
    { _id: 'admin_profile_1', userId: 'user_admin', role: 'ADMIN', kycStatus: 'VERIFIED' },
  ],
}

const COMPANY_ROW: Row = {
  _id: 'company_1',
  ownerId: 'issuer_profile_1',
  name: 'Agro Espavé',
}
function outsiderCtx() {
  return createCtx({
    ...OUTSIDER_IDENTITY,
    companies: [COMPANY_ROW],
    documents: DOCUMENTS,
  })
}

// ---------------------------------------------------------------------------
// getByCompany
// ---------------------------------------------------------------------------

describe('documents.getByCompany', () => {
  it('rejects a non-owner, non-admin caller', async () => {
    const ctx = outsiderCtx()

    await expect(
      runHandler(getByCompany, ctx, { companyId: 'company_1' })
    ).rejects.toThrow(/No tienes permiso para listar estos documentos/)
  })

  it('returns every document of the company room to its owner', async () => {
    const ctx = createCtx(
      {
        ...OWNER_IDENTITY,
        companies: [COMPANY_ROW],
        documents: DOCUMENTS,
      },
      'user_workos_company'
    )

    const result = (await runHandler(getByCompany, ctx, {
      companyId: 'company_1',
    })) as Row[]

    expect(result).toHaveLength(4)
  })

  it('applies the folder and accessLevel filters', async () => {
    const ctx = createCtx(
      {
        ...OWNER_IDENTITY,
        companies: [COMPANY_ROW],
        documents: DOCUMENTS,
      },
      'user_workos_company'
    )

    const byFolder = (await runHandler(getByCompany, ctx, {
      companyId: 'company_1',
      folder: 'Legal',
    })) as Array<{ name: string }>
    expect(byFolder.map((document) => document.name)).toEqual(['board-minutes.pdf'])

    const byAccessLevel = (await runHandler(getByCompany, ctx, {
      companyId: 'company_1',
      accessLevel: 'NDA_REQUIRED',
    })) as Array<{ name: string }>
    expect(byAccessLevel.map((document) => document.name)).toEqual([
      'financials.xlsx',
      'kyc-passport.pdf',
    ])
  })

})

// ---------------------------------------------------------------------------
// get (single document)
// ---------------------------------------------------------------------------

describe('documents.get', () => {
  it('returns null for a missing document', async () => {
    const ctx = outsiderCtx()

    await expect(runHandler(get, ctx, { documentId: 'doc_missing' })).resolves.toBeNull()
  })

  it('denies a confidential document to a principal outside the company', async () => {
    const ctx = outsiderCtx()

    await expect(runHandler(get, ctx, { documentId: 'doc_confidential' })).rejects.toThrow(
      /autorización|sala/i
    )
  })

  it('returns the document to the company owner', async () => {
    const ctx = createCtx(
      {
        ...OWNER_IDENTITY,
        companies: [COMPANY_ROW],
        documents: DOCUMENTS,
      },
      'user_workos_company'
    )

    const result = (await runHandler(get, ctx, { documentId: 'doc_confidential' })) as {
      name: string
    }

    expect(result.name).toBe('financials.xlsx')
  })
})

// ---------------------------------------------------------------------------
// getManualReviewQueue
// ---------------------------------------------------------------------------

describe('documents.getManualReviewQueue', () => {
  it('rejects non-admin callers', async () => {
    const ctx = createCtx(
      {
        ...OWNER_IDENTITY,
        companies: [COMPANY_ROW],
        documents: DOCUMENTS,
      },
      'user_workos_company'
    )

    await expect(runHandler(getManualReviewQueue, ctx, {})).rejects.toThrow(/administradores/i)
  })

  it('returns the KYC_SENSITIVE queue with company and latest review log for admins', async () => {
    const ctx = createCtx(
      {
        ...ADMIN_IDENTITY,
        companies: [COMPANY_ROW],
        documents: DOCUMENTS,
        documentAccessLogs: [
          {
            _id: 'log_1',
            documentId: 'doc_kyc',
            accessedAt: NOW - 500,
            decision: 'REQUIRE_REVIEW',
            outcome: 'REVIEW_REQUIRED_KYC_SENSITIVE',
            reason: 'Documento KYC sensitive',
            ipAddress: '203.0.113.9',
            userAgent: 'Vitest Browser',
          },
          {
            _id: 'log_2',
            documentId: 'doc_kyc',
            accessedAt: NOW - 5000,
            decision: 'ALLOW',
            outcome: 'ALLOWED_ADMIN',
          },
        ],
      },
      'user_workos_admin'
    )

    const queue = (await runHandler(getManualReviewQueue, ctx, {})) as Array<{
      _id: string
      company: Row | null
      latestReviewLog: Row | null
    }>

    expect(queue).toHaveLength(1)
    expect(queue[0]?._id).toBe('doc_kyc')
    expect(queue[0]?.company).toEqual({ _id: 'company_1', name: 'Agro Espavé' })
    expect(queue[0]?.latestReviewLog).toEqual({
      accessedAt: NOW - 500,
      outcome: 'REVIEW_REQUIRED_KYC_SENSITIVE',
      reason: 'Documento KYC sensitive',
    })
  })

  // La fila cruda de `documents` trae storageId/storagePath, la de la bitácora
  // trae IP/user agent y la de `companies` trae contacto/KYB. El panel admin
  // pinta nombre, clasificación y último intento — la respuesta es esa lista
  // blanca y nada más.
  it('projects a whitelist: no raw document, company or log fields leak', async () => {
    const ctx = createCtx(
      {
        ...ADMIN_IDENTITY,
        companies: [{ ...COMPANY_ROW, contactEmail: 'founder@example.com' }],
        documents: DOCUMENTS,
        documentAccessLogs: [
          {
            _id: 'log_1',
            documentId: 'doc_kyc',
            accessedAt: NOW - 500,
            decision: 'REQUIRE_REVIEW',
            outcome: 'REVIEW_REQUIRED_KYC_SENSITIVE',
            ipAddress: '203.0.113.9',
            userAgent: 'Vitest Browser',
            riskScore: 80,
          },
        ],
      },
      'user_workos_admin'
    )

    const queue = (await runHandler(getManualReviewQueue, ctx, {})) as Array<
      Record<string, unknown>
    >

    expect(Object.keys(queue[0] ?? {}).sort()).toEqual([
      '_creationTime',
      '_id',
      'accessLevel',
      'classification',
      'company',
      'latestReviewLog',
      'name',
    ])
    expect(Object.keys((queue[0]?.company as Row) ?? {}).sort()).toEqual(['_id', 'name'])
    expect(Object.keys((queue[0]?.latestReviewLog as Row) ?? {}).sort()).toEqual([
      'accessedAt',
      'outcome',
      'reason',
    ])
  })

  it('caps both scans instead of collecting whole tables', async () => {
    const ctx = createCtx(
      {
        ...ADMIN_IDENTITY,
        companies: [COMPANY_ROW],
        documents: DOCUMENTS,
        documentAccessLogs: [],
      },
      'user_workos_admin'
    )

    await runHandler(getManualReviewQueue, ctx, { limit: 10 })

    // Ninguna de las dos lecturas puede volver a ser un `.collect()` sin techo.
    const builders = (ctx.db.query as ReturnType<typeof vi.fn>).mock.results.map(
      (result) =>
        result.value as { collect: ReturnType<typeof vi.fn>; take: ReturnType<typeof vi.fn> }
    )
    const collectCalls = builders.reduce(
      (count, builder) => count + builder.collect.mock.calls.length,
      0
    )
    const takeCalls = builders.reduce((count, builder) => count + builder.take.mock.calls.length, 0)

    expect(collectCalls).toBe(0)
    expect(takeCalls).toBeGreaterThan(0)
  })

  it('skips expired documents', async () => {
    const ctx = createCtx(
      {
        ...ADMIN_IDENTITY,
        companies: [COMPANY_ROW],
        documents: [{ ...DOCUMENTS[3], isExpired: true }],
        documentAccessLogs: [],
      },
      'user_workos_admin'
    )

    await expect(runHandler(getManualReviewQueue, ctx, {})).resolves.toEqual([])
  })

  it('does not hide an active document behind newer expired rows', async () => {
    const expiredDocuments = Array.from({ length: 40 }, (_, index) => ({
      ...DOCUMENTS[3],
      _id: `expired_${index}`,
      _creationTime: NOW - index,
      isExpired: true,
    }))
    const activeDocument = {
      ...DOCUMENTS[3],
      _id: 'active_after_expired_window',
      _creationTime: NOW - 1000,
      isExpired: false,
    }
    const ctx = createCtx(
      {
        ...ADMIN_IDENTITY,
        companies: [COMPANY_ROW],
        documents: [...expiredDocuments, activeDocument],
        documentAccessLogs: [],
      },
      'user_workos_admin'
    )

    const queue = (await runHandler(getManualReviewQueue, ctx, { limit: 10 })) as Row[]

    expect(queue.map((document) => document._id)).toEqual(['active_after_expired_window'])
  })
})
