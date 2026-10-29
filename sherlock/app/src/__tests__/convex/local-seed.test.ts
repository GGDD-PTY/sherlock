// ============================================================================
// _localSeed — guarda anti-producción e idempotencia
// ============================================================================
// El seed local escribe empresas, perfiles y documentos sin sesión: lo único
// que lo separa de producción es `BYPASS_AUTH=true` + `CONVEX_ENV=dev`. Estos
// tests pinnean esa guarda y el hecho de que re-correrlo converge en vez de
// duplicar. Mismo patrón de stubs que `demo-seed-isolation.test.ts`.
// ============================================================================

import { createHash } from 'node:crypto'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildCustomSeedDocuments,
  buildDesordenadoSeedDocuments,
  buildPasswordProtectedPdf,
  buildScannedPdf,
  buildSeedXlsx,
  buildSemicolonCsv,
  CUSTOM_SEED_FOLDERS,
  documentNames,
  ENCRYPTED_SEED_PDF_USER_PASSWORD,
  ensureCustomRoom,
  ensureDevAdmin,
  ensureRoom,
  MAX_SEED_COMPANY_DOCUMENTS,
  seed,
  seedCompany,
} from '../../../convex/_localSeed'

type Handler<Args> = (ctx: unknown, args: Args) => Promise<unknown>

const ensureRoomHandler = (
  ensureRoom as unknown as { _handler: Handler<{ company: 'uno' | 'dos' }> }
)._handler
const ensureCustomRoomHandler = (
  ensureCustomRoom as unknown as {
    _handler: Handler<{
      slug: string
      name: string
      ownerEmail: string
      profile: 'vacio' | 'completo' | 'desordenado'
    }>
  }
)._handler
const ensureDevAdminHandler = (
  ensureDevAdmin as unknown as { _handler: Handler<Record<string, never>> }
)._handler
const documentNamesHandler = (
  documentNames as unknown as { _handler: Handler<{ companyId: string }> }
)._handler
const seedHandler = (seed as unknown as { _handler: Handler<Record<string, never>> })._handler
const seedCompanyHandler = (
  seedCompany as unknown as {
    _handler: Handler<{
      slug: string
      name: string
      ownerEmail: string
      documents: number
      profile: 'vacio' | 'completo' | 'desordenado'
    }>
  }
)._handler

const originalBypassAuth = process.env.BYPASS_AUTH
const originalConvexEnv = process.env.CONVEX_ENV

function enableDevEnvironment() {
  process.env.BYPASS_AUTH = 'true'
  process.env.CONVEX_ENV = 'dev'
}

function restoreEnv() {
  if (originalBypassAuth === undefined) delete process.env.BYPASS_AUTH
  else process.env.BYPASS_AUTH = originalBypassAuth
  if (originalConvexEnv === undefined) delete process.env.CONVEX_ENV
  else process.env.CONVEX_ENV = originalConvexEnv
}

type Company = { _id: string; name: string; demo?: boolean }

function contextWithNewOwner() {
  const newUser = { _id: 'users_new' }
  const profile = { _id: 'profile_1', role: 'COMPANY' }
  const rows: Record<string, unknown[]> = {
    users: [],
    profiles: [profile],
    companies: [],
  }
  const insert = vi.fn(async (table: string, _fields?: Record<string, unknown>) => `${table}_new`)
  const patch = vi.fn(async () => undefined)

  return {
    ctx: {
      db: {
        query: vi.fn((table: string) => ({
          withIndex: vi.fn(() => ({
            first: vi.fn(async () => rows[table][0] ?? null),
            collect: vi.fn(async () => rows[table]),
          })),
        })),
        get: vi.fn(async () => newUser),
        insert,
        patch,
      },
    },
    insert,
    patch,
  }
}

function contextWithOwnedCompanies(companies: Company[]) {
  const user = { _id: 'user_1', workosUserId: 'workos_1' }
  const profile = { _id: 'profile_1', role: 'COMPANY' }
  const rows: Record<string, unknown[]> = { users: [user], profiles: [profile], companies }
  const insert = vi.fn(async (table: string, _fields?: Record<string, unknown>) => `${table}_new`)
  const patch = vi.fn(async () => undefined)

  return {
    ctx: {
      db: {
        query: vi.fn((table: string) => ({
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

function hexBytes(
  documents: Array<{ name: string; kind: string; bytes?: Uint8Array }>,
  name: string
): string {
  const document = documents.find((candidate) => candidate.name === name)
  if (!document || !('bytes' in document) || !document.bytes) return ''
  return Buffer.from(document.bytes).toString('hex')
}

function seedPayloadSha(document: {
  kind: string
  bytes?: Uint8Array
  body?: readonly string[]
}): string {
  const hash = createHash('sha256')
  if (document.kind === 'CSV' && document.body) {
    hash.update(`${document.body.join('\n')}\n`)
    return hash.digest('hex')
  }
  if (document.bytes) {
    hash.update(document.bytes)
    return hash.digest('hex')
  }
  if (document.body) {
    hash.update(document.body.join('\n'))
    return hash.digest('hex')
  }
  return hash.digest('hex')
}

afterAll(restoreEnv)

describe('_localSeed fail-closed fuera de dev', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const cases = [
    { name: 'sin BYPASS_AUTH', bypass: undefined, convexEnv: 'dev' },
    { name: 'con CONVEX_ENV de producción', bypass: 'true', convexEnv: 'prod' },
    { name: 'sin CONVEX_ENV', bypass: 'true', convexEnv: undefined },
  ]

  for (const scenario of cases) {
    it(`bloquea todas las funciones del seed ${scenario.name}`, async () => {
      if (scenario.bypass === undefined) delete process.env.BYPASS_AUTH
      else process.env.BYPASS_AUTH = scenario.bypass
      if (scenario.convexEnv === undefined) delete process.env.CONVEX_ENV
      else process.env.CONVEX_ENV = scenario.convexEnv

      const { ctx, insert } = contextWithOwnedCompanies([])
      const runMutation = vi.fn()

      await expect(ensureRoomHandler(ctx, { company: 'uno' })).rejects.toThrow(
        /deployment de desarrollo/
      )
      await expect(
        ensureCustomRoomHandler(ctx, {
          slug: 'samplefoods-foods',
          name: 'SampleFoods Foods',
          ownerEmail: 'samplefoods-foods@dev.local',
          profile: 'vacio',
        })
      ).rejects.toThrow(/deployment de desarrollo/)
      await expect(ensureDevAdminHandler(ctx, {})).rejects.toThrow(/deployment de desarrollo/)
      await expect(documentNamesHandler(ctx, { companyId: 'company_1' })).rejects.toThrow(
        /deployment de desarrollo/
      )
      await expect(seedHandler({ runMutation }, {})).rejects.toThrow(/deployment de desarrollo/)
      await expect(
        seedCompanyHandler(
          { runMutation },
          {
            slug: 'samplefoods-foods',
            name: 'SampleFoods Foods',
            ownerEmail: 'samplefoods-foods@dev.local',
            documents: 8,
            profile: 'completo',
          }
        )
      ).rejects.toThrow(/deployment de desarrollo/)

      // La guarda corre ANTES de tocar la base: nada se escribe ni se encola.
      expect(insert).not.toHaveBeenCalled()
      expect(runMutation).not.toHaveBeenCalled()
    })
  }
})

describe('_localSeed.ensureRoom idempotencia', () => {
  beforeEach(() => {
    enableDevEnvironment()
    vi.clearAllMocks()
  })

  it('crea la sala la primera vez', async () => {
    const { ctx, insert } = contextWithOwnedCompanies([])

    await expect(ensureRoomHandler(ctx, { company: 'uno' })).resolves.toMatchObject({
      companyId: 'companies_new',
      created: true,
    })
    expect(insert).toHaveBeenCalledWith(
      'companies',
      expect.objectContaining({ country: 'PA', demo: true })
    )
  })

  it('reusa la sala existente en vez de insertar otra', async () => {
    const { ctx, insert, patch } = contextWithOwnedCompanies([
      { _id: 'company_uno', name: 'Sintética Uno, S. A.', demo: true },
    ])

    await expect(ensureRoomHandler(ctx, { company: 'uno' })).resolves.toMatchObject({
      companyId: 'company_uno',
      created: false,
    })
    expect(insert).not.toHaveBeenCalledWith('companies', expect.anything())
    expect(patch).toHaveBeenCalledWith('company_uno', expect.objectContaining({ demo: true }))
  })

  it('se niega cuando el dueño ya tiene otra empresa', async () => {
    const { ctx, insert } = contextWithOwnedCompanies([
      { _id: 'company_otra', name: 'Sample Hydro, S. A.', demo: true },
    ])

    await expect(ensureRoomHandler(ctx, { company: 'uno' })).rejects.toThrow(
      /ya posee otra empresa/
    )
    expect(insert).not.toHaveBeenCalledWith('companies', expect.anything())
  })
})

describe('_localSeed.seed idempotencia de documentos', () => {
  beforeEach(() => {
    enableDevEnvironment()
    vi.clearAllMocks()
  })

  function actionContext(existingNames: Record<string, string[]>) {
    const store = vi.fn(async () => 'storage_new')
    const runAction = vi.fn(async () => 'document_new')
    const runMutation = vi.fn(async (_ref: unknown, args: { company?: 'uno' | 'dos' }) =>
      args?.company
        ? {
            companyId: `company_${args.company}`,
            ownerProfileId: 'profile_1',
            providerUserId: 'workos_1',
            created: false,
          }
        : { created: false }
    )
    const runQuery = vi.fn(
      async (_ref: unknown, args: { companyId: string }) => existingNames[args.companyId] ?? []
    )
    return { ctx: { runMutation, runQuery, runAction, storage: { store } }, store, runAction }
  }

  it('sube los siete documentos en un backend vacío', async () => {
    const { ctx, store, runAction } = actionContext({})

    const rooms = (await seedHandler(ctx, {})) as Array<{ created: number; documents: number }>

    expect(rooms.map((room) => room.created)).toEqual([4, 3])
    expect(rooms.map((room) => room.documents)).toEqual([4, 3])
    expect(store).toHaveBeenCalledTimes(7)
    expect(runAction).toHaveBeenCalledTimes(7)
  })

  it('no vuelve a subir un documento que ya está en la sala', async () => {
    const { ctx, store, runAction } = actionContext({
      company_uno: [
        'Estados financieros FY25.pdf',
        'Balance de comprobación FY25.csv',
        'Pacto social.pdf',
        'Teaser de crédito.pdf',
      ],
      company_dos: [
        'Estados financieros FY25.pdf',
        'Contrato marco de suministro.pdf',
        'Reporte operativo FY25.csv',
      ],
    })

    const rooms = (await seedHandler(ctx, {})) as Array<{ created: number; documents: number }>

    expect(rooms.map((room) => room.created)).toEqual([0, 0])
    expect(rooms.map((room) => room.documents)).toEqual([4, 3])
    expect(store).not.toHaveBeenCalled()
    expect(runAction).not.toHaveBeenCalled()
  })
})

describe('buildCustomSeedDocuments', () => {
  it('reparte por las cinco carpetas, alterna PDF/CSV y nombra sin colisiones', () => {
    const documents = buildCustomSeedDocuments({ count: 8, companyName: 'SampleFoods Foods' })

    expect(documents).toHaveLength(8)
    expect(documents.map((document) => document.folder)).toEqual([
      'room_legal',
      'room_corporate',
      'room_financial',
      'room_operations',
      'room_marketing',
      'room_legal',
      'room_corporate',
      'room_financial',
    ])
    expect(documents.map((document) => document.kind)).toEqual([
      'PDF',
      'CSV',
      'PDF',
      'CSV',
      'PDF',
      'CSV',
      'PDF',
      'CSV',
    ])
    expect(new Set(documents.map((document) => document.name)).size).toBe(8)
    expect(documents[0]?.name).toBe('Legales 1.pdf')
    expect(documents[1]?.name).toBe('Corporativos 2.csv')
    expect(CUSTOM_SEED_FOLDERS).toHaveLength(5)
  })

  it('con cero documentos no fabrica nada', () => {
    expect(buildCustomSeedDocuments({ count: 0, companyName: 'SampleFoods Foods' })).toEqual([])
  })
})

describe('_localSeed.ensureCustomRoom perfil', () => {
  beforeEach(() => {
    enableDevEnvironment()
    vi.clearAllMocks()
  })

  it('el perfil vacío solo escribe name, country PA y la marca demo', async () => {
    const { ctx, insert } = contextWithOwnedCompanies([])

    await expect(
      ensureCustomRoomHandler(ctx, {
        slug: 'samplefoods-foods',
        name: 'SampleFoods Foods',
        ownerEmail: 'samplefoods-foods@dev.local',
        profile: 'vacio',
      })
    ).resolves.toMatchObject({ companyId: 'companies_new', created: true })

    expect(insert).toHaveBeenCalledWith('companies', {
      ownerId: 'profile_1',
      name: 'SampleFoods Foods',
      country: 'PA',
      demo: true,
    })
  })

  it('el perfil completo copia los campos de Sintética Uno con el nombre nuevo', async () => {
    const { ctx, insert } = contextWithOwnedCompanies([])

    await ensureCustomRoomHandler(ctx, {
      slug: 'samplefoods-foods',
      name: 'SampleFoods Foods',
      ownerEmail: 'samplefoods-foods@dev.local',
      profile: 'completo',
    })

    expect(insert).toHaveBeenCalledWith(
      'companies',
      expect.objectContaining({
        name: 'SampleFoods Foods',
        legalName: 'SampleFoods Foods',
        country: 'PA',
        revenueCurrent: 7200000,
        demo: true,
        onboardingStep: 6,
      })
    )
  })

  it('re-sembrar con perfil vacío borra los campos del perfil completo', async () => {
    const { ctx, patch } = contextWithOwnedCompanies([
      { _id: 'company_samplefoods', name: 'SampleFoods Foods', demo: true },
    ])

    await expect(
      ensureCustomRoomHandler(ctx, {
        slug: 'samplefoods-foods',
        name: 'SampleFoods Foods',
        ownerEmail: 'samplefoods-foods@dev.local',
        profile: 'vacio',
      })
    ).resolves.toMatchObject({ companyId: 'company_samplefoods', created: false })

    expect(patch).toHaveBeenCalledWith(
      'company_samplefoods',
      expect.objectContaining({
        name: 'SampleFoods Foods',
        country: 'PA',
        demo: true,
        description: undefined,
        revenueCurrent: undefined,
        onboardingStep: undefined,
      })
    )
  })
})

describe('_localSeed.ensureCustomRoom identidad del dueño', () => {
  beforeEach(() => {
    enableDevEnvironment()
    vi.clearAllMocks()
  })

  it('dos correos distintos para el mismo nombre reciben identidades distintas', async () => {
    const casos = [
      {
        email: 'a@dev.local',
        clerkId: 'dev_a-dev-local',
        workosUserId: 'dev_a-dev-local_workos',
      },
      {
        email: 'b@dev.local',
        clerkId: 'dev_b-dev-local',
        workosUserId: 'dev_b-dev-local_workos',
      },
    ]

    for (const caso of casos) {
      const { ctx, insert } = contextWithNewOwner()

      await ensureCustomRoomHandler(ctx, {
        slug: 'samplefoods-foods',
        name: 'SampleFoods Foods',
        ownerEmail: caso.email,
        profile: 'vacio',
      })

      expect(insert).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({
          email: caso.email,
          clerkId: caso.clerkId,
          workosUserId: caso.workosUserId,
        })
      )
    }
  })

  it('los dueños fijos conservan su identidad aunque cambie el slug', async () => {
    const { ctx, insert } = contextWithNewOwner()

    await ensureCustomRoomHandler(ctx, {
      slug: 'otra-cosa',
      name: 'Otra Cosa',
      ownerEmail: 'company@dev.local',
      profile: 'vacio',
    })

    expect(insert).toHaveBeenCalledWith(
      'users',
      expect.objectContaining({
        clerkId: 'dev_company_001',
        workosUserId: 'dev_company_001_workos',
      })
    )
  })
})

describe('_localSeed.seedCompany idempotencia de documentos', () => {
  beforeEach(() => {
    enableDevEnvironment()
    vi.clearAllMocks()
  })

  function actionContext(existingNames: string[]) {
    const store = vi.fn(async () => 'storage_new')
    const runAction = vi.fn(
      async (_ref?: unknown, _args?: Record<string, unknown>) => 'document_new'
    )
    const runMutation = vi.fn(async (_ref: unknown, args: { slug?: string }) =>
      args?.slug
        ? {
            companyId: 'company_custom',
            ownerProfileId: 'profile_1',
            providerUserId: 'workos_1',
            created: false,
          }
        : { created: false }
    )
    const runQuery = vi.fn(async () => existingNames)
    return { ctx: { runMutation, runQuery, runAction, storage: { store } }, store, runAction }
  }

  const args = {
    slug: 'samplefoods-foods',
    name: 'SampleFoods Foods',
    ownerEmail: 'samplefoods-foods@dev.local',
    documents: 5,
    profile: 'completo' as const,
  }

  it('sube un documento por carpeta en un backend vacío', async () => {
    const { ctx, store, runAction } = actionContext([])

    await expect(seedCompanyHandler(ctx, args)).resolves.toMatchObject({
      companyId: 'company_custom',
      ownerEmail: 'samplefoods-foods@dev.local',
      created: false,
      documents: 5,
    })
    expect(store).toHaveBeenCalledTimes(5)
    expect(runAction).toHaveBeenCalledTimes(5)
    expect(runAction.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ folder: 'room_legal', name: 'Legales 1.pdf' }),
        expect.objectContaining({ folder: 'room_corporate', name: 'Corporativos 2.csv' }),
        expect.objectContaining({ folder: 'room_financial', name: 'Financieros 3.pdf' }),
        expect.objectContaining({ folder: 'room_operations', name: 'Operaciones 4.csv' }),
        expect.objectContaining({ folder: 'room_marketing', name: 'Mercadeo 5.pdf' }),
      ])
    )
  })

  it('no vuelve a subir un documento que ya está en la sala', async () => {
    const { ctx, store, runAction } = actionContext([
      'Legales 1.pdf',
      'Corporativos 2.csv',
      'Financieros 3.pdf',
      'Operaciones 4.csv',
      'Mercadeo 5.pdf',
    ])

    await expect(seedCompanyHandler(ctx, args)).resolves.toMatchObject({
      created: false,
      documents: 5,
    })
    expect(store).not.toHaveBeenCalled()
    expect(runAction).not.toHaveBeenCalled()
  })

  it('rechaza más de 200 documentos antes de tocar Convex', async () => {
    const { ctx, store, runAction } = actionContext([])

    await expect(
      seedCompanyHandler(ctx, {
        ...args,
        documents: MAX_SEED_COMPANY_DOCUMENTS + 1,
      })
    ).rejects.toThrow(/200/)
    expect(store).not.toHaveBeenCalled()
    expect(runAction).not.toHaveBeenCalled()
  })
})

describe('generadores del perfil desordenado', () => {
  it('el PDF escaneado es una imagen sin operadores de texto', () => {
    const bytes = buildScannedPdf()
    const latin1 = new TextDecoder('latin1').decode(bytes)
    expect(latin1.startsWith('%PDF-')).toBe(true)
    expect(latin1).toContain('/Subtype /Image')
    expect(latin1).not.toMatch(/\bBT\b/)
    expect(latin1).not.toContain('Tj')
  })

  it('el PDF con contraseña es RC4 de 40 bits y cabe en menos de 8 KB', () => {
    const bytes = buildPasswordProtectedPdf()
    const latin1 = new TextDecoder('latin1').decode(bytes)
    expect(latin1.startsWith('%PDF-')).toBe(true)
    expect(bytes.byteLength).toBeLessThan(8 * 1024)
    expect(latin1).toContain('/Filter /Standard')
    expect(latin1).toContain('/R 2')
    expect(latin1).toContain('/V 1')
    expect(latin1).toContain('/Length 40')
    expect(ENCRYPTED_SEED_PDF_USER_PASSWORD).toBe('1234')
  })

  it('el CSV usa punto y coma y decimales con coma', () => {
    const csv = buildSemicolonCsv({ companyName: 'SampleFoods Foods' })
    expect(csv).toContain('periodo;empresa;ingreso_usd;margen_pct')
    expect(csv).toContain('1250000,50')
    expect(csv).toContain('18,25')
    expect(csv.split('\n')[0]).not.toContain(',')
  })

  it('el xlsx empieza con la firma ZIP', () => {
    const bytes = buildSeedXlsx({ title: 'SampleFoods Foods' })
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
  })
})

describe('buildDesordenadoSeedDocuments', () => {
  it('con 30 documentos trae las anomalías, nombres únicos y bytes únicos', () => {
    const documents = buildDesordenadoSeedDocuments({
      count: 30,
      companyName: 'Prueba Desorden',
    })

    expect(documents).toHaveLength(30)
    expect(new Set(documents.map((document) => document.name)).size).toBe(30)
    expect(documents.map((document) => document.name)).toEqual(
      expect.arrayContaining([
        'scan0001.pdf',
        'final_v3 (2).xlsx',
        'IMG_2031.pdf',
        'estados financieros FINAL FINAL.pdf',
      ])
    )

    const contrato = documents.find((document) => document.name === 'contrato_arrendamiento.pdf')
    const balance = documents.find((document) => document.name === 'balance general 2024.pdf')
    expect(contrato?.folder).toBe('room_financial')
    expect(balance?.folder).toBe('room_legal')

    expect(documents.find((document) => document.name === 'scan0001.pdf')).toEqual(
      expect.objectContaining({ kind: 'PDF_BYTES' })
    )
    expect(documents.find((document) => document.name === 'IMG_2031.pdf')).toEqual(
      expect.objectContaining({ kind: 'PDF_BYTES' })
    )
    // STALE_TEST OB-RES-5-4: el perfil ya no reusa bytes entre documentos.
    expect(hexBytes(documents, 'scan0001.pdf')).not.toEqual(hexBytes(documents, 'IMG_2031.pdf'))

    expect(documents.find((document) => document.name === 'final_v3 (2).xlsx')).toEqual(
      expect.objectContaining({ kind: 'XLSX' })
    )
    expect(documents.find((document) => document.name === 'Copy of final_v3.xlsx')).toEqual(
      expect.objectContaining({ kind: 'XLSX' })
    )
    expect(hexBytes(documents, 'final_v3 (2).xlsx')).not.toEqual(
      hexBytes(documents, 'Copy of final_v3.xlsx')
    )

    expect(
      documents.find((document) => document.name === 'estados financieros FINAL FINAL.pdf')
    ).toEqual(expect.objectContaining({ kind: 'PDF_BYTES' }))

    expect(documents.find((document) => document.name === 'ventas_2024.csv')).toEqual(
      expect.objectContaining({
        kind: 'CSV',
        body: expect.arrayContaining([
          'periodo;empresa;ingreso_usd;margen_pct',
          expect.stringContaining(',50'),
        ]),
      })
    )
  })

  it('dos documentos del mismo perfil no comparten sha', () => {
    const documents = buildDesordenadoSeedDocuments({
      count: 30,
      companyName: 'Residuo, S. A.',
    })
    const shas = documents.map((document) => seedPayloadSha(document))
    expect(shas).toHaveLength(30)
    expect(new Set(shas).size).toBe(30)
  })

  it('con 200 documentos rota tipos y no colisiona nombres', () => {
    const documents = buildDesordenadoSeedDocuments({
      count: 200,
      companyName: 'Sala Grande',
    })
    expect(documents).toHaveLength(200)
    expect(new Set(documents.map((document) => document.name)).size).toBe(200)
    expect(documents.some((document) => document.kind === 'PDF')).toBe(true)
    expect(documents.some((document) => document.kind === 'CSV')).toBe(true)
    expect(documents.some((document) => document.kind === 'XLSX')).toBe(true)
  })

  it('con cero documentos no fabrica nada', () => {
    expect(buildDesordenadoSeedDocuments({ count: 0, companyName: 'SampleFoods Foods' })).toEqual([])
  })
})

describe('_localSeed.ensureCustomRoom perfil desordenado', () => {
  beforeEach(() => {
    enableDevEnvironment()
    vi.clearAllMocks()
  })

  it('el perfil desordenado escribe los campos del perfil completo', async () => {
    const { ctx, insert } = contextWithOwnedCompanies([])

    await ensureCustomRoomHandler(ctx, {
      slug: 'prueba-desorden',
      name: 'Prueba Desorden',
      ownerEmail: 'prueba-desorden@dev.local',
      profile: 'desordenado',
    })

    expect(insert).toHaveBeenCalledWith(
      'companies',
      expect.objectContaining({
        name: 'Prueba Desorden',
        legalName: 'Prueba Desorden',
        country: 'PA',
        revenueCurrent: 7200000,
        demo: true,
        onboardingStep: 6,
      })
    )
  })
})

describe('_localSeed.seedCompany perfil desordenado', () => {
  beforeEach(() => {
    enableDevEnvironment()
    vi.clearAllMocks()
  })

  it('registra las anomalías en un backend vacío', async () => {
    const store = vi.fn(async () => 'storage_new')
    const runAction = vi.fn(
      async (_ref?: unknown, _args?: Record<string, unknown>) => 'document_new'
    )
    const runMutation = vi.fn(async (_ref: unknown, mutationArgs: { slug?: string }) =>
      mutationArgs?.slug
        ? {
            companyId: 'company_custom',
            ownerProfileId: 'profile_1',
            providerUserId: 'workos_1',
            created: true,
          }
        : { created: false }
    )
    const runQuery = vi.fn(async () => [])
    const ctx = { runMutation, runQuery, runAction, storage: { store } }

    await expect(
      seedCompanyHandler(ctx, {
        slug: 'prueba-desorden',
        name: 'Prueba Desorden',
        ownerEmail: 'prueba-desorden@dev.local',
        documents: 30,
        profile: 'desordenado',
      })
    ).resolves.toMatchObject({
      companyId: 'company_custom',
      documents: 30,
      documentsCreated: 30,
      created: true,
    })
    expect(store).toHaveBeenCalledTimes(30)
    expect(runAction.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'scan0001.pdf' }),
        expect.objectContaining({ name: 'contrato_arrendamiento.pdf', folder: 'room_financial' }),
        expect.objectContaining({ name: 'balance general 2024.pdf', folder: 'room_legal' }),
        expect.objectContaining({
          name: 'estados financieros FINAL FINAL.pdf',
          fileType: 'application/pdf',
        }),
        expect.objectContaining({
          name: 'final_v3 (2).xlsx',
          signatureKind: 'ZIP',
        }),
        expect.objectContaining({ name: 'ventas_2024.csv', signatureKind: 'TEXT' }),
      ])
    )
  })
})
