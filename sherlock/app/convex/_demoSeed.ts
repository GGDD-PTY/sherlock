// ============================================================================
// Sherlock - SEED DE LA SALA DEMO SAMPLE_HYDRO, CON ANDINA COMO FIXTURE SINTÉTICA
// ============================================================================
// ES: Levanta la sala demo completa sobre el usuario dev `company@dev.local`:
//     SAMPLE_HYDRO es la demo canónica y Andina Solar queda como fallback sintético.
//     Cada perfil instala sus documentos dentro del VDR y el logo de la empresa.
//     Los orquestadores bajo `scripts/demo/` encadenan
//     ensureRoom -> inventory -> registerFixture (por archivo) -> attachLogo.
//     Las filas de `documents` y `documentVersions` las escribe siempre
//     `_documents/mutations.createFromValidatedUpload`; aquí nunca se escribe
//     un documento a mano.
// SOLO DEV: cada función exportada exige BYPASS_AUTH=true + CONVEX_ENV=dev
//     antes de tocar la base — la misma guarda anti-prod de los seeds locales.
//     Bloqueado en producción.
// ============================================================================

import { v } from 'convex/values'
import { Effect } from 'effect'

import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'
import { internalAction, internalMutation, internalQuery, query } from './_generated/server'
import { isDevAuthBypassedViaEnv } from './_helpers/auth.dev'
import { convexPromise, convexSync, runConvex } from './_helpers/effect'
import type { AppError } from './_helpers/errors'
import { unauthorized, validationFailed } from './_helpers/errors'

function assertDemoSeedEnvironment(): void {
  if (!isDevAuthBypassedViaEnv()) {
    throw unauthorized(
      '_demoSeed solo puede ejecutarse en un deployment de desarrollo ' +
        '(requiere BYPASS_AUTH=true + CONVEX_ENV=dev). Bloqueado en producción.'
    )
  }
}

// LA GUARDA ANTI-PRODUCCIÓN ES LA PRIMERA LÍNEA DE CADA PROGRAMA. `reset` borra
// documentos, versiones y blobs: que su guarda dependa de que alguien se acuerde
// de copiarla al handler siguiente es justo el fallo que no se puede permitir,
// así que acá es un solo valor que se lee y se busca.
const demoSeedOnly = convexSync(assertDemoSeedEnvironment)

const DEV_COMPANY_EMAIL = 'company@dev.local'
const DEV_COMPANY_CLERK_ID = 'dev_company_001'
const DEV_COMPANY_WORKOS_ID = 'dev_company_001_workos'

// Literal idéntico byte por byte al de DEV_USER_DEFINITIONS en
// `_helpers/auth.dev.ts`: si difiere, dev-auth crea un segundo usuario.
const DEV_COMPANY_USER_NAME = 'Sample Hydro, S. A.'

// Una sala demo por dueño dev: `resolveCurrentCompanyAuthorization` niega el
// acceso a un perfil con más de una empresa, así que sembrar una empresa
// implica retirar la otra (el script lo hace con `reset` antes de `ensureRoom`).
export const DEMO_COMPANY_KEYS = ['andina', 'samplehydro'] as const
export type DemoCompanyKey = (typeof DEMO_COMPANY_KEYS)[number]
const demoCompanyArg = v.optional(v.union(v.literal('andina'), v.literal('samplehydro')))

const ANDINA_COMPANY_NAME = 'Andina Solar, S. A.'
const SAMPLE_HYDRO_COMPANY_NAME = 'Sample Hydro, S. A.'

const ANDINA_COMPANY_PROFILE = {
  name: ANDINA_COMPANY_NAME,
  legalName: ANDINA_COMPANY_NAME,
  tagline: 'Generador solar de 42 MW en Panamá con toda su energía contratada bajo PPA.',
  description:
    'Andina Solar, S. A. opera un parque solar de 42 MW en Panamá y vende su generación a ' +
    'Distribuidora Istmeña, S. A. bajo un contrato PPA de largo plazo. En FY24 generó ' +
    '61,200 MWh y facturó 9,840,000 USD, con un EBITDA de 7,120,000 USD.',
  longDescription:
    'El parque vende la totalidad de su energía a Distribuidora Istmeña, S. A. a una tarifa PPA ' +
    'de 0.1607 USD/kWh, de modo que el ingreso FY24 de 9,840,000 USD proviene de un solo ' +
    'contrato y no de mercado spot. Sobre esa base, el EBITDA FY24 fue de 7,120,000 USD y la ' +
    'deuda financiera vigente cerró en 11,500,000 USD. La compañía busca un préstamo senior de ' +
    '18,000,000 USD. Si abres el VDR encuentras los estados financieros FY24, el resumen del ' +
    'contrato PPA, los supuestos operativos y el teaser de crédito.',
  useOfFunds:
    'El préstamo senior de 18,000,000 USD refinancia la deuda financiera vigente de ' +
    '11,500,000 USD y financia el capex del parque junto con los costos de la transacción. ' +
    'El desglose lo revisas en los estados financieros FY24 y en los supuestos operativos.',
  country: 'Panama',
  city: 'Ciudad de Panamá',
  sector: 'utilities',
  industry: 'renewable_utilities',
  businessModel: 'B2B',
  stage: 'MATURE',
  foundedYear: 2016,
  employees: '11-50',
  currency: 'USD',
  revenueCurrent: 9840000,
  // Porcentaje, no fracción: la UI lo etiqueta "Margen EBITDA (%)" y valida -100..100.
  ebitdaMargin: 72.36,
  totalLiabilities: 11500000,
  seekingAmount: 18000000,
  seekingType: 'DEBT',
  fundraisingTimeline: '6_MONTHS',
  // El `/my-company` de dev-auth resuelve la sala por `_demoSeed.roomForDevCompany`
  // (dueño `company@dev.local` + marca `demo`), no por un catálogo público.
  isPublic: true,
  isFeatured: false,
  demo: true,
  onboardingStep: 6,
} as const

// Perfil enteramente ficticio. No deriva de estados financieros ni activos reales.
const SAMPLE_HYDRO_COMPANY_PROFILE = {
  name: SAMPLE_HYDRO_COMPANY_NAME,
  legalName: SAMPLE_HYDRO_COMPANY_NAME,
  tagline: 'Empresa hidroeléctrica ficticia de 24 MW para pruebas del Data Room.',
  description:
    'Sample Hydro, S. A. es una empresa ficticia para probar el producto. Opera la central ' +
    'imaginaria Río Claro, con una capacidad de 24 MW. Las cifras y contrapartes de este ' +
    'perfil se inventaron para pruebas y no describen una empresa real.',
  longDescription:
    'En este escenario sintético, la empresa genera 96,000 MWh al año, tiene ingresos de ' +
    '12,000,000 USD y un EBITDA de 6,000,000 USD. Sus pasivos suman 8,000,000 USD. ' +
    'No hay una emisión de valores ni un mandato de asesoría detrás de esta sala. ' +
    'Los archivos de ejemplo disponibles pertenecen al pack ficticio de Andina Solar.',
  country: 'Panama',
  city: 'Ciudad de Panamá',
  sector: 'utilities',
  industry: 'renewable_utilities',
  businessModel: 'B2B',
  stage: 'MATURE',
  foundedYear: 2020,
  currency: 'USD',
  revenueCurrent: 12000000,
  ebitdaMargin: 50,
  totalLiabilities: 8000000,
  isPublic: false,
  isFeatured: false,
  demo: true,
  onboardingStep: 6,
} as const

const DEMO_COMPANIES = {
  andina: {
    name: ANDINA_COMPANY_NAME,
    profile: ANDINA_COMPANY_PROFILE,
    sourceName: 'Pack demo Andina Solar (e2e/fixtures/andina-solar)',
    provenanceNotes:
      'Documento sintético del pack demo de Andina Solar, S. A. La empresa, su contraparte ' +
      'Distribuidora Istmeña, S. A. y todas las cifras son ficticias y existen solo para ' +
      'demostrar el VDR. Nada de lo que ves aquí es una oferta de valores ni una promesa de retorno.',
  },
  samplehydro: {
    name: SAMPLE_HYDRO_COMPANY_NAME,
    profile: SAMPLE_HYDRO_COMPANY_PROFILE,
    sourceName: 'Pack sintético Andina Solar (e2e/fixtures/andina-solar)',
    provenanceNotes:
      'Documento sintético del pack de Andina Solar. La empresa, sus contrapartes y todas ' +
      'las cifras son ficticias. Este material solo sirve para probar el Data Room.',
  },
} as const

function demoCompany(key: DemoCompanyKey | undefined) {
  return DEMO_COMPANIES[key ?? 'samplehydro']
}

// Sin `company` devuelve la sala demo que tenga el dueño dev, sea cual sea:
// dev-auth la usa para resolver "la empresa del usuario", no una en particular.
// Por eso sin argumento NO se filtra por nombre: la marca `demo: true` es el
// criterio, y así una sala sembrada por otro seed local (`_localSeed`) también
// se abre en `/my-company/documents` en vez de caer al fixture del navegador.
const roomForDevCompanyProgram = Effect.fn('DemoSeed.roomForDevCompany')(function* (
  ctx: QueryCtx,
  args: { company?: DemoCompanyKey }
) {
  yield* demoSeedOnly
  const demoNames: readonly string[] | null = args.company ? [demoCompany(args.company).name] : null

  const user = yield* convexPromise(() =>
    ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', DEV_COMPANY_EMAIL))
      .first()
  )
  if (!user) return null

  const profile = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .first()
  )
  if (!profile || profile.role !== 'COMPANY' || profile.isActive === false) return null

  const companies = yield* convexPromise(() =>
    ctx.db
      .query('companies')
      .withIndex('by_ownerId', (q) => q.eq('ownerId', profile._id))
      .collect()
  )
  return (
    companies.find(
      (company) => (demoNames === null || demoNames.includes(company.name)) && company.demo === true
    ) ?? null
  )
})

export const roomForDevCompany = query({
  args: { company: demoCompanyArg },
  handler: (ctx, args) => runConvex(roomForDevCompanyProgram(ctx, args)),
})

const ensureRoomProgram = Effect.fn('DemoSeed.ensureRoom')(function* (
  ctx: MutationCtx,
  args: { company?: DemoCompanyKey }
) {
  yield* demoSeedOnly
  const target = demoCompany(args.company)

  const existingUser = yield* convexPromise(() =>
    ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', DEV_COMPANY_EMAIL))
      .first()
  )
  const userId =
    existingUser?._id ??
    (yield* convexPromise(() =>
      ctx.db.insert('users', {
        email: DEV_COMPANY_EMAIL,
        name: DEV_COMPANY_USER_NAME,
        clerkId: DEV_COMPANY_CLERK_ID,
        role: 'COMPANY',
        emailVerified: true,
      })
    ))
  const user = yield* convexPromise(() => ctx.db.get(userId))
  if (!user) {
    return yield* Effect.fail(
      validationFailed('No se pudo crear el usuario dev de la sala demo', 'user')
    )
  }

  // `createFromValidatedUpload` liga el subject WorkOS al user persistido, y el
  // usuario dev nace sin `workosUserId`. Sin este parche todo upload es rechazado.
  const providerUserId = user.workosUserId ?? DEV_COMPANY_WORKOS_ID
  if (!user.workosUserId || user.name !== DEV_COMPANY_USER_NAME) {
    yield* convexPromise(() =>
      ctx.db.patch(user._id, {
        ...(!user.workosUserId ? { workosUserId: DEV_COMPANY_WORKOS_ID } : {}),
        ...(user.name !== DEV_COMPANY_USER_NAME ? { name: DEV_COMPANY_USER_NAME } : {}),
      })
    )
  }

  const existingProfile = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .first()
  )
  const ownerProfileId =
    existingProfile?._id ??
    (yield* convexPromise(() =>
      ctx.db.insert('profiles', {
        userId: user._id,
        role: 'COMPANY',
        fullName: DEV_COMPANY_USER_NAME,
        language: 'es',
        isVerified: true,
        isActive: true,
        kycStatus: 'VERIFIED',
        roleConfirmed: true,
      })
    ))
  if (existingProfile && existingProfile.fullName !== DEV_COMPANY_USER_NAME) {
    yield* convexPromise(() =>
      ctx.db.patch(existingProfile._id, { fullName: DEV_COMPANY_USER_NAME })
    )
  }

  const ownedCompanies = yield* convexPromise(() =>
    ctx.db
      .query('companies')
      .withIndex('by_ownerId', (q) => q.eq('ownerId', ownerProfileId))
      .collect()
  )
  const existingCompany = ownedCompanies[0]
  const hasExactTargetRoom =
    ownedCompanies.length === 1 &&
    existingCompany.name === target.name &&
    existingCompany.demo === true
  if (ownedCompanies.length > 0 && !hasExactTargetRoom) {
    return yield* Effect.fail(
      validationFailed(
        'El dueño dev debe tener cero empresas o exactamente una sala demo que coincida con ' +
          `"${target.name}". Retira primero cualquier otra empresa: el resolver niega acceso ` +
          'cuando el perfil tiene más de una.',
        'company'
      )
    )
  }

  const profileFields = { ...target.profile, onboardingCompletedAt: Date.now() }

  if (existingCompany) {
    // `profileFields` no trae `logoUrl`, así que el patch conserva el que ya
    // esté puesto y el script sabe que no necesita volver a subir el PNG.
    yield* convexPromise(() => ctx.db.patch(existingCompany._id, profileFields))
    return {
      companyId: existingCompany._id,
      ownerProfileId,
      providerUserId,
      logoUrl: existingCompany.logoUrl ?? null,
      created: false,
    }
  }

  const companyId = yield* convexPromise(() =>
    ctx.db.insert('companies', {
      ownerId: ownerProfileId,
      ...profileFields,
    })
  )
  return { companyId, ownerProfileId, providerUserId, logoUrl: null, created: true }
})

export const ensureRoom = internalMutation({
  args: { company: demoCompanyArg },
  handler: (ctx, args) => runConvex(ensureRoomProgram(ctx, args)),
})

const inventoryProgram = Effect.fn('DemoSeed.inventory')(function* (
  ctx: QueryCtx,
  args: { companyId: Id<'companies'> }
) {
  yield* demoSeedOnly

  const documents = yield* convexPromise(() =>
    ctx.db
      .query('documents')
      .withIndex('by_companyId', (q) => q.eq('companyId', args.companyId))
      .collect()
  )

  return yield* convexPromise(() =>
    Promise.all(
      documents.map(async (document) => {
        const versionId = document.publishedVersionId ?? document.currentVersionId
        const version = versionId ? await ctx.db.get(versionId) : null
        return {
          documentId: document._id,
          name: document.name,
          folder: document.folder ?? null,
          fileType: document.fileType ?? null,
          fileSize: document.fileSize ?? null,
          lifecycleStatus: document.lifecycleStatus ?? null,
          sourceType: document.sourceType ?? null,
          versionId: version?._id ?? null,
          versionSha256: version?.sha256 ?? null,
          versionByteSize: version?.byteSize ?? null,
          publicationStatus: version?.publicationStatus ?? null,
        }
      })
    )
  )
})

export const inventory = internalQuery({
  args: { companyId: v.id('companies') },
  handler: (ctx, args) => runConvex(inventoryProgram(ctx, args)),
})

export const registerFixture = internalAction({
  args: {
    companyId: v.id('companies'),
    ownerProfileId: v.id('profiles'),
    providerUserId: v.string(),
    storageId: v.id('_storage'),
    name: v.string(),
    description: v.optional(v.string()),
    fileType: v.string(),
    signatureKind: v.union(
      v.literal('PDF'),
      v.literal('ZIP'),
      v.literal('OLE'),
      v.literal('TEXT'),
      v.literal('UNKNOWN')
    ),
    folder: v.string(),
    company: demoCompanyArg,
    sourceName: v.optional(v.string()),
    provenanceNotes: v.optional(v.string()),
    sourceSha256: v.optional(v.string()),
    // El seed de ejemplo usa SYNTHETIC_DEMO; el campo conserva el contrato de procedencia.
    sourceType: v.optional(v.union(v.literal('SYNTHETIC_DEMO'), v.literal('PUBLIC_SOURCE'))),
    accessLevel: v.optional(
      v.union(v.literal('PUBLIC'), v.literal('NDA_REQUIRED'), v.literal('PRIVATE'))
    ),
    classification: v.optional(
      v.union(
        v.literal('PUBLIC_TEASER'),
        v.literal('CONFIDENTIAL'),
        v.literal('RESTRICTED'),
        v.literal('LEGAL'),
        v.literal('KYC_SENSITIVE')
      )
    ),
  },
  handler: (ctx, args): Promise<Id<'documents'>> => runConvex(registerFixtureProgram(ctx, args)),
})

// El tipo de retorno va ESCRITO: `registerFixture` es un export del módulo y
// alcanza `internal._demoSeed.*`, que se teje desde los exports del módulo. Sin
// la anotación, TypeScript entra en el ciclo y el programa degrada a `any` —
// peor que un error, porque compila.
const registerFixtureProgram = Effect.fn('DemoSeed.registerFixture')(function* (
  ctx: ActionCtx,
  args: {
    companyId: Id<'companies'>
    ownerProfileId: Id<'profiles'>
    providerUserId: string
    storageId: Id<'_storage'>
    name: string
    description?: string
    fileType: string
    signatureKind: 'PDF' | 'ZIP' | 'OLE' | 'TEXT' | 'UNKNOWN'
    folder: string
    company?: DemoCompanyKey
    sourceName?: string
    provenanceNotes?: string
    sourceSha256?: string
    sourceType?: 'SYNTHETIC_DEMO' | 'PUBLIC_SOURCE'
    accessLevel?: 'PUBLIC' | 'NDA_REQUIRED' | 'PRIVATE'
    classification?: 'PUBLIC_TEASER' | 'CONFIDENTIAL' | 'RESTRICTED' | 'LEGAL' | 'KYC_SENSITIVE'
  }
): Effect.fn.Return<Id<'documents'>, AppError> {
  yield* demoSeedOnly

  const documentId: Id<'documents'> = yield* convexPromise(() =>
    ctx.runMutation(internal._documents.mutations.createFromValidatedUpload, {
      companyId: args.companyId,
      uploaderProfileId: args.ownerProfileId,
      uploaderRole: 'COMPANY',
      uploaderProviderUserId: args.providerUserId,
      name: args.name,
      description: args.description,
      fileType: args.fileType,
      storageId: args.storageId,
      signatureKind: args.signatureKind,
      malwareScanStatus: 'NOT_CONFIGURED',
      accessLevel: args.accessLevel,
      classification: args.classification,
      folder: args.folder,
    })
  )

  const target = demoCompany(args.company)
  const hashNote = args.sourceSha256 ? ` SHA-256: ${args.sourceSha256}.` : ''
  yield* convexPromise(() =>
    ctx.runMutation(internal._demoSeed.markProvenance, {
      documentId,
      sourceType: args.sourceType ?? 'SYNTHETIC_DEMO',
      sourceName: args.sourceName ?? target.sourceName,
      provenanceNotes: `${args.provenanceNotes ?? target.provenanceNotes}${hashNote}`,
    })
  )

  return documentId
})

const markProvenanceProgram = Effect.fn('DemoSeed.markProvenance')(function* (
  ctx: MutationCtx,
  args: {
    documentId: Id<'documents'>
    sourceType: 'SYNTHETIC_DEMO' | 'PUBLIC_SOURCE'
    sourceName: string
    provenanceNotes: string
  }
) {
  yield* demoSeedOnly

  yield* convexPromise(() =>
    ctx.db.patch(args.documentId, {
      sourceType: args.sourceType,
      sourceName: args.sourceName,
      provenanceNotes: args.provenanceNotes,
    })
  )
})

export const markProvenance = internalMutation({
  args: {
    documentId: v.id('documents'),
    sourceType: v.union(v.literal('SYNTHETIC_DEMO'), v.literal('PUBLIC_SOURCE')),
    sourceName: v.string(),
    provenanceNotes: v.string(),
  },
  handler: (ctx, args) => runConvex(markProvenanceProgram(ctx, args)),
})

const attachLogoProgram = Effect.fn('DemoSeed.attachLogo')(function* (
  ctx: MutationCtx,
  args: { companyId: Id<'companies'>; storageId: Id<'_storage'> }
) {
  yield* demoSeedOnly

  const logoUrl = yield* convexPromise(() => ctx.storage.getUrl(args.storageId))
  if (!logoUrl) {
    return yield* Effect.fail(
      validationFailed('El logo no existe en el almacenamiento de Convex', 'storageId')
    )
  }
  yield* convexPromise(() =>
    ctx.db.patch(args.companyId, {
      logoUrl: `${logoUrl}${LOGO_ID_FRAGMENT}${args.storageId}`,
    })
  )
  return logoUrl
})

export const attachLogo = internalMutation({
  args: { companyId: v.id('companies'), storageId: v.id('_storage') },
  handler: (ctx, args) => runConvex(attachLogoProgram(ctx, args)),
})

// `ctx.storage.getUrl` devuelve una URL con un UUID, no con el id de `_storage`,
// así que del URL solo no se puede recuperar el blob para borrarlo. El id viaja
// en el fragmento: el navegador lo ignora al pintar la imagen y `reset` lo lee.
const LOGO_ID_FRAGMENT = '#sid='

function parseLogoStorageId(ctx: MutationCtx, logoUrl: string | undefined): Id<'_storage'> | null {
  if (!logoUrl) return null
  const markerIndex = logoUrl.indexOf(LOGO_ID_FRAGMENT)
  if (markerIndex < 0) return null
  const candidate = logoUrl.slice(markerIndex + LOGO_ID_FRAGMENT.length)
  return ctx.db.system.normalizeId('_storage', candidate)
}

const resetProgram = Effect.fn('DemoSeed.reset')(function* (
  ctx: MutationCtx,
  args: { company?: DemoCompanyKey }
) {
  yield* demoSeedOnly
  const target = demoCompany(args.company)

  const nothingRemoved = { companies: 0, documents: 0, versions: 0, blobs: 0 }

  const user = yield* convexPromise(() =>
    ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', DEV_COMPANY_EMAIL))
      .first()
  )
  if (!user) return nothingRemoved

  const profile = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .first()
  )
  if (!profile) return nothingRemoved

  const ownedCompanies = yield* convexPromise(() =>
    ctx.db
      .query('companies')
      .withIndex('by_ownerId', (q) => q.eq('ownerId', profile._id))
      .collect()
  )
  const company = ownedCompanies.find(
    (candidate) => candidate.name === target.name && candidate.demo === true
  )
  if (!company) return nothingRemoved

  const documents = yield* convexPromise(() =>
    ctx.db
      .query('documents')
      .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
      .collect()
  )

  // El blob del documento y el de su versión publicada son el MISMO id; un
  // segundo ctx.storage.delete sobre ese id revienta la mutation entera.
  const blobIds = new Set<Id<'_storage'>>()
  let versions = 0

  for (const document of documents) {
    const documentVersions = yield* convexPromise(() =>
      ctx.db
        .query('documentVersions')
        .withIndex('by_document_version', (q) => q.eq('documentId', document._id))
        .collect()
    )
    for (const version of documentVersions) {
      blobIds.add(version.storageId)
      yield* convexPromise(() => ctx.db.delete(version._id))
      versions += 1
    }
    if (document.storageId) blobIds.add(document.storageId)
    yield* convexPromise(() => ctx.db.delete(document._id))
  }

  const logoStorageId = yield* convexSync(() => parseLogoStorageId(ctx, company.logoUrl))
  if (logoStorageId) blobIds.add(logoStorageId)

  for (const blobId of blobIds) {
    yield* convexPromise(() => ctx.storage.delete(blobId))
  }
  yield* convexPromise(() => ctx.db.delete(company._id))

  return {
    companies: 1,
    documents: documents.length,
    versions,
    blobs: blobIds.size,
  }
})

export const reset = internalMutation({
  args: { company: demoCompanyArg },
  handler: (ctx, args) => runConvex(resetProgram(ctx, args)),
})
