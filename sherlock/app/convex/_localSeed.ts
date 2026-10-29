// ============================================================================
// Sherlock - SEED LOCAL EXPLÍCITO: EMPRESAS SINTÉTICAS PARA PRUEBAS
// ============================================================================
// ES: Levanta salas sintéticas sobre un backend Convex local (`convex dev`
//     anónimo) para probar sin nube y sin datos reales.
//     `seed` siembra las dos fijas: "Sintética Uno, S. A." la posee el usuario
//     dev `company@dev.local` y "Sintética Dos, S. A." un segundo dueño,
//     `company2@dev.local`. `seedCompany` fabrica una más a la carta
//     (`bun run seed:company`). Son dueños distintos porque
//     `resolveCurrentCompanyAuthorization` niega el acceso a un perfil con más
//     de una empresa: una sala por dueño.
//     Los documentos se registran por el mismo camino que el resto del repo
//     (`_demoSeed.registerFixture` -> `createFromValidatedUpload`); aquí nunca
//     se escribe una fila de `documents` a mano.
// IDEMPOTENTE: re-correrlo converge. La empresa se busca por dueño + nombre y
//     cada documento por nombre dentro de la sala; lo que ya está no se
//     duplica ni se vuelve a subir a storage.
// SOLO DEV: exige BYPASS_AUTH=true + CONVEX_ENV=dev, la misma guarda
//     anti-producción de `_demoSeed`. Bloqueado en producción.
// ============================================================================

import { v } from 'convex/values'
import { Effect } from 'effect'

import { internal } from './_generated/api'
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { internalAction, internalMutation, internalQuery } from './_generated/server'
import { isDevAuthBypassedViaEnv } from './_helpers/auth.dev'
import { convexPromise, convexSync, runConvex } from './_helpers/effect'
import type { AppError } from './_helpers/errors'
import { unauthorized, validationFailed } from './_helpers/errors'
import { DEV_ADMIN_WORKOS_USER_ID } from '../src/lib/dev-auth/types'
import { devSeedOwnerIds } from '../src/lib/dev-auth/seed-identity'

function assertLocalSeedEnvironment(): void {
  if (!isDevAuthBypassedViaEnv()) {
    throw unauthorized(
      '_localSeed solo puede ejecutarse en un deployment de desarrollo ' +
        '(requiere BYPASS_AUTH=true + CONVEX_ENV=dev). Bloqueado en producción.'
    )
  }
}

// LA GUARDA ANTI-PRODUCCIÓN ES LA PRIMERA LÍNEA DE CADA PROGRAMA, y ahora es un
// solo valor en vez de una llamada repetida por handler: `yield* localSeedOnly`
// se lee y se busca. Un seed siembra y borra; que su guarda dependa de que
// alguien se acuerde de copiarla al handler siguiente es justo el fallo que no
// se puede permitir.
const localSeedOnly = convexSync(assertLocalSeedEnvironment)

export const LOCAL_SEED_COMPANY_KEYS = ['uno', 'dos'] as const
export type LocalSeedCompanyKey = (typeof LOCAL_SEED_COMPANY_KEYS)[number]
const localSeedCompanyArg = v.union(v.literal('uno'), v.literal('dos'))

const PROVENANCE_NOTES =
  'Documento sintético del seed local explícito (`bun run seed:local`). La empresa, sus contrapartes y ' +
  'todas las cifras son ficticias y existen solo para iterar sobre el producto en una máquina ' +
  'de desarrollo. No es una oferta de valores ni una promesa de retorno.'

type SeedDocumentMeta = {
  name: string
  description: string
  folder: string
}

type SeedDocument =
  | (SeedDocumentMeta & { kind: 'PDF'; body: readonly string[] })
  | (SeedDocumentMeta & { kind: 'CSV'; body: readonly string[] })
  | (SeedDocumentMeta & { kind: 'PDF_BYTES'; bytes: Uint8Array<ArrayBuffer> })
  | (SeedDocumentMeta & { kind: 'XLSX'; bytes: Uint8Array<ArrayBuffer> })

// Las cinco carpetas del shell (`src/lib/vdr/document-taxonomy.ts`). El seed
// a la carta las recorre por turnos; el valor es el que queda en `documents.folder`.
export const CUSTOM_SEED_FOLDERS = [
  'room_legal',
  'room_corporate',
  'room_financial',
  'room_operations',
  'room_marketing',
] as const
export type CustomSeedFolder = (typeof CUSTOM_SEED_FOLDERS)[number]

const CUSTOM_SEED_FOLDER_STEMS: Record<CustomSeedFolder, string> = {
  room_legal: 'Legales',
  room_corporate: 'Corporativos',
  room_financial: 'Financieros',
  room_operations: 'Operaciones',
  room_marketing: 'Mercadeo',
}

type SeedCompany = {
  ownerEmail: string
  ownerName: string
  ownerClerkId: string
  ownerWorkosUserId: string
  company: {
    name: string
    legalName: string
    tagline: string
    description: string
    country: string
    city: string
    sector: 'utilities' | 'industrials'
    industry: 'renewable_utilities' | 'logistics'
    businessModel: 'B2B'
    stage: 'MATURE'
    foundedYear: number
    employees: string
    currency: 'USD'
    revenueCurrent: number
    ebitdaMargin: number
    totalLiabilities: number
    seekingAmount: number
    seekingType: 'DEBT'
    isPublic: boolean
    isFeatured: boolean
    demo: boolean
    onboardingStep: number
  }
  documents: readonly SeedDocument[]
}

// `company@dev.local` es el usuario COMPANY de dev-auth: el literal del nombre
// tiene que ser el mismo de DEV_USER_DEFINITIONS (`_helpers/auth.dev.ts`) o
// dev-auth crea un segundo usuario con el mismo correo.
const DEV_COMPANY_USER_NAME = 'Sample Hydro, S. A.'

// Literales de DEV_USER_DEFINITIONS (`_helpers/auth.dev.ts`).
const DEV_ADMIN_EMAIL = 'admin@dev.local'
const DEV_ADMIN_NAME = 'Dev Admin User'

const SEED_COMPANIES: Record<LocalSeedCompanyKey, SeedCompany> = {
  uno: {
    ownerEmail: 'company@dev.local',
    ownerName: DEV_COMPANY_USER_NAME,
    ownerClerkId: 'dev_company_001',
    ownerWorkosUserId: 'dev_company_001_workos',
    company: {
      name: 'Sintética Uno, S. A.',
      legalName: 'Sintética Uno, S. A.',
      tagline:
        'Empresa sintética de prueba: generador solar de 30 MW con toda su energía contratada.',
      description:
        'Sintética Uno, S. A. es una empresa ficticia del seed local. Opera un parque solar de ' +
        '30 MW y vende su generación bajo un PPA de largo plazo. En FY25 facturó 7,200,000 USD ' +
        'con un EBITDA de 4,600,000 USD. Nada de esto es real.',
      country: 'PA',
      city: 'Ciudad de Panamá',
      sector: 'utilities',
      industry: 'renewable_utilities',
      businessModel: 'B2B',
      stage: 'MATURE',
      foundedYear: 2015,
      employees: '11-50',
      currency: 'USD',
      revenueCurrent: 7200000,
      // Porcentaje, no fracción: la UI valida -100..100.
      ebitdaMargin: 63.89,
      totalLiabilities: 9100000,
      seekingAmount: 14000000,
      seekingType: 'DEBT',
      isPublic: true,
      isFeatured: false,
      demo: true,
      onboardingStep: 6,
    },
    documents: [
      {
        name: 'Estados financieros FY25.pdf',
        description: 'Estados financieros auditados sintéticos del ejercicio 2025.',
        folder: 'room_financial',
        kind: 'PDF',
        body: [
          'Sintetica Uno, S. A.',
          'Estados financieros FY25 (sinteticos)',
          '',
          'Ingresos               7,200,000 USD',
          'EBITDA                 4,600,000 USD',
          'Margen EBITDA               63.89 %',
          'Pasivos totales        9,100,000 USD',
          '',
          'Documento sintetico del seed local. Cifras ficticias.',
        ],
      },
      {
        name: 'Balance de comprobación FY25.csv',
        description: 'Balance de comprobación sintético al cierre del ejercicio 2025.',
        folder: 'room_financial',
        kind: 'CSV',
        body: [
          'cuenta,descripcion,debe,haber',
          '1101,Efectivo y equivalentes,412000.00,0.00',
          '1201,Cuentas por cobrar comerciales,986500.00,0.00',
          '1501,Propiedad planta y equipo neto,18400000.00,0.00',
          '2101,Cuentas por pagar comerciales,0.00,742300.00',
          '2301,Deuda financiera de largo plazo,0.00,8357700.00',
          '4101,Ingresos por venta de energia,0.00,7200000.00',
        ],
      },
      {
        name: 'Pacto social.pdf',
        description: 'Pacto social sintético y certificado de existencia.',
        folder: 'room_legal',
        kind: 'PDF',
        body: [
          'Sintetica Uno, S. A.',
          'Pacto social (sintetico)',
          '',
          'Sociedad anonima constituida en la Republica de Panama en 2015.',
          'Capital autorizado: 10,000 acciones sin valor nominal.',
          '',
          'Documento sintetico del seed local. Sin valor legal.',
        ],
      },
      {
        name: 'Teaser de crédito.pdf',
        description: 'Teaser sintético de la transacción de deuda.',
        folder: 'room_marketing',
        kind: 'PDF',
        body: [
          'Sintetica Uno, S. A.',
          'Teaser de credito (sintetico)',
          '',
          'Prestamo senior solicitado: 14,000,000 USD',
          'Uso de fondos: refinanciamiento y capex del parque.',
          '',
          'Documento sintetico del seed local. No es una oferta de valores.',
        ],
      },
    ],
  },
  dos: {
    ownerEmail: 'company2@dev.local',
    ownerName: 'Sintética Dos, S. A.',
    ownerClerkId: 'dev_company_002',
    ownerWorkosUserId: 'dev_company_002_workos',
    company: {
      name: 'Sintética Dos, S. A.',
      legalName: 'Sintética Dos, S. A.',
      tagline: 'Empresa sintética de prueba: operador logístico de carga en el Pacífico panameño.',
      description:
        'Sintética Dos, S. A. es una empresa ficticia del seed local. Opera almacenaje y ' +
        'distribución de carga con contratos anuales renovables. En FY25 facturó 21,400,000 USD ' +
        'con un EBITDA de 3,900,000 USD. Nada de esto es real.',
      country: 'PA',
      city: 'Colón',
      sector: 'industrials',
      industry: 'logistics',
      businessModel: 'B2B',
      stage: 'MATURE',
      foundedYear: 2008,
      employees: '201-500',
      currency: 'USD',
      revenueCurrent: 21400000,
      ebitdaMargin: 18.22,
      totalLiabilities: 12600000,
      seekingAmount: 25000000,
      seekingType: 'DEBT',
      isPublic: true,
      isFeatured: false,
      demo: true,
      onboardingStep: 6,
    },
    documents: [
      {
        name: 'Estados financieros FY25.pdf',
        description: 'Estados financieros auditados sintéticos del ejercicio 2025.',
        folder: 'room_financial',
        kind: 'PDF',
        body: [
          'Sintetica Dos, S. A.',
          'Estados financieros FY25 (sinteticos)',
          '',
          'Ingresos              21,400,000 USD',
          'EBITDA                 3,900,000 USD',
          'Margen EBITDA               18.22 %',
          'Pasivos totales       12,600,000 USD',
          '',
          'Documento sintetico del seed local. Cifras ficticias.',
        ],
      },
      {
        name: 'Contrato marco de suministro.pdf',
        description: 'Contrato marco sintético con la contraparte principal.',
        folder: 'room_legal',
        kind: 'PDF',
        body: [
          'Sintetica Dos, S. A.',
          'Contrato marco de suministro (sintetico)',
          '',
          'Vigencia: 2024-2029, renovable por periodos de un ano.',
          'Contraparte: Naviera Istmena, S. A. (ficticia).',
          '',
          'Documento sintetico del seed local. Sin valor legal.',
        ],
      },
      {
        name: 'Reporte operativo FY25.csv',
        description: 'Volúmenes operativos sintéticos por trimestre.',
        folder: 'room_operations',
        kind: 'CSV',
        body: [
          'trimestre,teus_movidos,ocupacion_almacen_pct,ingreso_usd',
          '2025-Q1,18420,81.4,5120000.00',
          '2025-Q2,19980,86.2,5480000.00',
          '2025-Q3,20740,88.9,5610000.00',
          '2025-Q4,19310,84.1,5190000.00',
        ],
      },
    ],
  },
}

type LocalSeedCompanyFields = {
  name: string
  country: string
  demo: boolean
  legalName?: string
  tagline?: string
  description?: string
  city?: string
  sector?: SeedCompany['company']['sector']
  industry?: SeedCompany['company']['industry']
  businessModel?: SeedCompany['company']['businessModel']
  stage?: SeedCompany['company']['stage']
  foundedYear?: number
  employees?: string
  currency?: SeedCompany['company']['currency']
  revenueCurrent?: number
  ebitdaMargin?: number
  totalLiabilities?: number
  seekingAmount?: number
  seekingType?: SeedCompany['company']['seekingType']
  isPublic?: boolean
  isFeatured?: boolean
  onboardingStep?: number
  onboardingCompletedAt?: number
}

type EnsuredRoom = {
  companyId: Id<'companies'>
  ownerProfileId: Id<'profiles'>
  providerUserId: string
  created: boolean
}

type RegisteredDocuments = {
  created: number
  documents: number
}

export type SeedCompanyProfile = 'vacio' | 'completo' | 'desordenado'

export const MAX_SEED_COMPANY_DOCUMENTS = 200

export const ENCRYPTED_SEED_PDF_USER_PASSWORD = '1234'

/** N documentos en las cinco carpetas por turnos, PDF y CSV alternados. */
export function buildCustomSeedDocuments(args: {
  count: number
  companyName: string
}): SeedDocument[] {
  const documents: SeedDocument[] = []
  for (let index = 0; index < args.count; index += 1) {
    const folder = CUSTOM_SEED_FOLDERS[index % CUSTOM_SEED_FOLDERS.length]
    const kind = index % 2 === 0 ? 'PDF' : 'CSV'
    const n = index + 1
    const stem = CUSTOM_SEED_FOLDER_STEMS[folder]
    const extension = kind === 'CSV' ? 'csv' : 'pdf'
    documents.push({
      name: `${stem} ${n}.${extension}`,
      description: `Documento sintético ${n} de ${args.companyName}.`,
      folder,
      kind,
      body:
        kind === 'CSV'
          ? ['campo,valor', `empresa,${args.companyName}`, `documento,${n}`, 'origen,seed local']
          : [
              args.companyName,
              `${stem} ${n} (sintetico)`,
              '',
              'Documento sintetico del seed local. Cifras ficticias.',
            ],
    })
  }
  return documents
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(new ArrayBuffer(length))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function u16le(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(2))
  new DataView(bytes.buffer).setUint16(0, value, true)
  return bytes
}

function u32le(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(4))
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let crc = index
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    table[index] = crc
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** ZIP stored (sin comprimir): el xlsx del seed es un paquete OOXML mínimo. */
function buildStoredZip(
  entries: readonly { name: string; data: Uint8Array }[]
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const local = concatBytes([
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      u16le(20),
      u16le(0),
      u16le(0),
      u16le(0),
      u16le(0),
      u32le(crc),
      u32le(entry.data.length),
      u32le(entry.data.length),
      u16le(nameBytes.length),
      u16le(0),
      nameBytes,
      entry.data,
    ])
    const central = concatBytes([
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
      u16le(20),
      u16le(20),
      u16le(0),
      u16le(0),
      u16le(0),
      u16le(0),
      u32le(crc),
      u32le(entry.data.length),
      u32le(entry.data.length),
      u16le(nameBytes.length),
      u16le(0),
      u16le(0),
      u16le(0),
      u16le(0),
      u32le(0),
      u32le(offset),
      nameBytes,
    ])
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const localPart = concatBytes(locals)
  const centralPart = concatBytes(centrals)
  return concatBytes([
    localPart,
    centralPart,
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    u16le(0),
    u16le(0),
    u16le(entries.length),
    u16le(entries.length),
    u32le(centralPart.length),
    u32le(localPart.length),
    u16le(0),
  ])
}

function assemblePdf(objectBodies: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [latin1Bytes('%PDF-1.4\n')]
  const offsets: number[] = []
  let length = parts[0].length
  objectBodies.forEach((body, index) => {
    offsets.push(length)
    const object = concatBytes([
      latin1Bytes(`${index + 1} 0 obj\n`),
      body,
      latin1Bytes('\nendobj\n'),
    ])
    parts.push(object)
    length += object.length
  })
  let xref = `xref\n0 ${objectBodies.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, '0')} 00000 n \n`
  }
  xref +=
    `trailer\n<< /Size ${objectBodies.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${length}\n%%EOF\n`
  parts.push(latin1Bytes(xref))
  return concatBytes(parts)
}

/** Una página que es solo una imagen: no hay operadores de texto. */
export function buildScannedPdf(args: { mark?: string } = {}): Uint8Array<ArrayBuffer> {
  const pixels = new Uint8Array(new ArrayBuffer(64))
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = (index * 13) & 0xff
  }
  // `mark` va en un comentario del content stream para que dos escaneos
  // del perfil desordenado no compartan sha (OB-RES-5-4).
  const mark = args.mark?.replaceAll(/[\r\n]/g, ' ')
  const content = `${mark ? `% ${mark}\n` : ''}q\n612 0 0 792 0 0 cm\n/Im0 Do\nQ\n`
  const imageDict =
    `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 ` +
    `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`
  return assemblePdf([
    latin1Bytes('<< /Type /Catalog /Pages 2 0 R >>'),
    latin1Bytes('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    latin1Bytes(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'
    ),
    concatBytes([latin1Bytes(imageDict), pixels, latin1Bytes('\nendstream')]),
    latin1Bytes(`<< /Length ${latin1Bytes(content).length} >>\nstream\n${content}endstream`),
  ])
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0
  }
  return bytes
}

// PDF cifrado RC4 de 40 bits (V=1, R=2) con contraseña de usuario 1234.
// Va embebido porque las actions de Convex no leen disco y Node 24 ya no
// escribe RC4. Generado con qpdf --allow-weak-crypto --encrypt 1234 1234 40.
const ENCRYPTED_SEED_PDF_BASE64 =
  'JVBERi0xLjQKJb/3ov4KMSAwIG9iago8PCAvUGFnZXMgMiAwIFIgL1R5cGUgL0NhdGFsb2cgPj4K' +
  'ZW5kb2JqCjIgMCBvYmoKPDwgL0NvdW50IDEgL0tpZHMgWyAzIDAgUiBdIC9UeXBlIC9QYWdlcyA+' +
  'PgplbmRvYmoKMyAwIG9iago8PCAvQ29udGVudHMgNCAwIFIgL01lZGlhQm94IFsgMCAwIDYxMiA3' +
  'OTIgXSAvUGFyZW50IDIgMCBSIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDUgMCBSID4+ID4+' +
  'IC9UeXBlIC9QYWdlID4+CmVuZG9iago0IDAgb2JqCjw8IC9MZW5ndGggMTAzIC9GaWx0ZXIgL0Zs' +
  'YXRlRGVjb2RlID4+CnN0cmVhbQoySWSkv49pNbrVp9u36Xjv+bkOBKkzQ+xT2SclQ7vA2dSCv5mY' +
  'OHKe9p3K0+HMNi/vDoBTmvDK9nVx55djqeIxVKfwgIONDVNVOoKjktvy1QNySlQR2w22hCeqg+V2' +
  '/DWll8vgz4wbZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9CYXNlRm9udCAvSGVsdmV0aWNh' +
  'IC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9TdWJ0eXBlIC9UeXBlMSAvVHlwZSAvRm9udCA+' +
  'PgplbmRvYmoKNiAwIG9iago8PCAvRmlsdGVyIC9TdGFuZGFyZCAvTGVuZ3RoIDQwIC9PIDxiZmJm' +
  'MDI2Yzk2YTk5YTIzNDZhOTQxMjEwNjhjYWQ0ZjgzNWU1ZDBlY2JiNjIwYThiN2EzMTYxMzNjOGYw' +
  'MjkxPiAvUCAtNCAvUiAyIC9VIDw0YzU3MmE0Y2Q2NGNmMjg2NzdmMmI2MWZjYzBiMDIxMTk3MWVk' +
  'ZTgyZWEwZmYxMzc4MjgxYzBjZTFhM2EwMWEyPiAvViAxID4+CmVuZG9iagp4cmVmCjAgNwowMDAw' +
  'MDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA2NCAwMDAwMCBuIAow' +
  'MDAwMDAwMTIzIDAwMDAwIG4gCjAwMDAwMDAyNTEgMDAwMDAgbiAKMDAwMDAwMDQyNSAwMDAwMCBu' +
  'IAowMDAwMDAwNTIyIDAwMDAwIG4gCnRyYWlsZXIgPDwgL1Jvb3QgMSAwIFIgL1NpemUgNyAvSUQg' +
  'WzwzMTQxNTkyNjUzNTg5NzkzMjM4NDYyNjQzMzgzMjc5NT48MzE0MTU5MjY1MzU4OTc5MzIzODQ2' +
  'MjY0MzM4MzI3OTU+XSAvRW5jcnlwdCA2IDAgUiA+PgpzdGFydHhyZWYKNzI4CiUlRU9GCg=='

export function buildPasswordProtectedPdf(): Uint8Array<ArrayBuffer> {
  return decodeBase64(ENCRYPTED_SEED_PDF_BASE64)
}

/** CSV latinoamericano: punto y coma, decimales con coma. */
export function buildSemicolonCsv(args: { companyName: string }): string {
  return [
    'periodo;empresa;ingreso_usd;margen_pct',
    `2025-Q1;${args.companyName};1250000,50;18,25`,
    `2025-Q2;${args.companyName};1410300,75;19,10`,
    `2025-Q3;${args.companyName};1380400,00;17,80`,
  ].join('\n')
}

export function buildSeedXlsx(args: { title: string }): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const title = xmlEscape(args.title)
  return buildStoredZip([
    {
      name: '[Content_Types].xml',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>'
      ),
    },
    {
      name: '_rels/.rels',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>'
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Hoja1" sheetId="1" r:id="rId1"/></sheets></workbook>'
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>'
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${title}</t></is></c></row></sheetData>` +
          '</worksheet>'
      ),
    },
  ])
}

function desordenadoAnomalies(companyName: string): SeedDocument[] {
  const encrypted = buildPasswordProtectedPdf()
  const csvLines = buildSemicolonCsv({ companyName }).split('\n')
  return [
    {
      name: 'scan0001.pdf',
      description: `Escaneo sin OCR de ${companyName}.`,
      folder: 'room_operations',
      kind: 'PDF_BYTES',
      bytes: buildScannedPdf({ mark: `scan0001.pdf ${companyName}` }),
    },
    {
      name: 'IMG_2031.pdf',
      description: `Otro escaneo sin OCR de ${companyName}, otro nombre.`,
      folder: 'room_marketing',
      kind: 'PDF_BYTES',
      bytes: buildScannedPdf({ mark: `IMG_2031.pdf ${companyName}` }),
    },
    {
      name: 'final_v3 (2).xlsx',
      description: `Libro sin título usable de ${companyName}.`,
      folder: 'room_corporate',
      kind: 'XLSX',
      bytes: buildSeedXlsx({ title: `${companyName} final_v3 (2)` }),
    },
    {
      name: 'Copy of final_v3.xlsx',
      description: `Copia de nombre del libro final_v3 de ${companyName}.`,
      folder: 'room_operations',
      kind: 'XLSX',
      bytes: buildSeedXlsx({ title: `${companyName} Copy of final_v3` }),
    },
    {
      name: 'contrato_arrendamiento.pdf',
      description: `Contrato de ${companyName} dejado en la carpeta financiera.`,
      folder: 'room_financial',
      kind: 'PDF',
      body: [companyName, 'Contrato de arrendamiento (sintetico)', '', 'Cifras ficticias.'],
    },
    {
      name: 'balance general 2024.pdf',
      description: `Balance de ${companyName} dejado en la carpeta legal.`,
      folder: 'room_legal',
      kind: 'PDF',
      body: [companyName, 'Balance general 2024 (sintetico)', '', 'Cifras ficticias.'],
    },
    {
      name: 'estados financieros FINAL FINAL.pdf',
      description: `PDF con contraseña de usuario ${ENCRYPTED_SEED_PDF_USER_PASSWORD}.`,
      folder: 'room_financial',
      kind: 'PDF_BYTES',
      bytes: encrypted,
    },
    {
      name: 'ventas_2024.csv',
      description: `Export bancario con separador ; de ${companyName}.`,
      folder: 'room_operations',
      kind: 'CSV',
      body: csvLines,
    },
  ]
}

function extraDesordenadoDocument(args: { index: number; companyName: string }): SeedDocument {
  const n = args.index + 1
  const folder = CUSTOM_SEED_FOLDERS[args.index % CUSTOM_SEED_FOLDERS.length]
  const rotation = args.index % 3
  if (rotation === 1) {
    const name = `datos ${n} (1).csv`
    return {
      name,
      description: `Export ${n} de ${args.companyName}.`,
      folder,
      kind: 'CSV',
      body: buildSemicolonCsv({ companyName: `${args.companyName} ${n} ${name}` }).split('\n'),
    }
  }
  if (rotation === 2) {
    const name = `final_v${n} (${(n % 3) + 1}).xlsx`
    return {
      name,
      description: `Libro ${n} de ${args.companyName}.`,
      folder,
      kind: 'XLSX',
      bytes: buildSeedXlsx({ title: `${args.companyName} ${n} ${name}` }),
    }
  }
  const name = `scan${String(n).padStart(4, '0')}.pdf`
  return {
    name,
    description: `Documento ${n} de ${args.companyName}.`,
    folder,
    kind: 'PDF',
    body: [args.companyName, `Documento ${n} (sintetico)`, name, '', 'Cifras ficticias.'],
  }
}

/** Empresa con perfil completo y documentos de una sala real desordenada. */
export function buildDesordenadoSeedDocuments(args: {
  count: number
  companyName: string
}): SeedDocument[] {
  if (args.count <= 0) return []
  const anomalies = desordenadoAnomalies(args.companyName)
  if (args.count <= anomalies.length) return anomalies.slice(0, args.count)
  const used = new Set(anomalies.map((document) => document.name))
  const extra: SeedDocument[] = []
  let index = anomalies.length
  while (anomalies.length + extra.length < args.count) {
    const document = extraDesordenadoDocument({ index, companyName: args.companyName })
    if (!used.has(document.name)) {
      used.add(document.name)
      extra.push(document)
    }
    index += 1
  }
  return [...anomalies, ...extra]
}

function emptyCompanyFields(name: string): LocalSeedCompanyFields {
  // El seed guarda el código ISO, igual que el intake real.
  return { name, country: 'PA', demo: true }
}

// Re-sembrar con un perfil más corto tiene que borrar los campos que el perfil
// nuevo no trae: en un `patch`, `undefined` elimina la clave del documento.
function companyFieldClears(
  fields: LocalSeedCompanyFields
): Partial<Record<keyof LocalSeedCompanyFields, undefined>> {
  const clears: Partial<Record<keyof LocalSeedCompanyFields, undefined>> = {}
  for (const key of Object.keys(completeCompanyFields(fields.name)) as Array<
    keyof LocalSeedCompanyFields
  >) {
    if (!(key in fields)) clears[key] = undefined
  }
  return clears
}

function completeCompanyFields(name: string): LocalSeedCompanyFields {
  const template = SEED_COMPANIES.uno.company
  return {
    ...template,
    name,
    legalName: name,
    description:
      `${name} es una empresa ficticia del seed local. Opera un parque solar de ` +
      '30 MW y vende su generación bajo un PPA de largo plazo. En FY25 facturó 7,200,000 USD ' +
      'con un EBITDA de 4,600,000 USD. Nada de esto es real.',
    onboardingCompletedAt: Date.now(),
  }
}

function ownerIdentityForSeed(args: { email: string; name: string }): {
  ownerEmail: string
  ownerName: string
  ownerClerkId: string
  ownerWorkosUserId: string
} {
  if (args.email === 'company@dev.local') {
    return {
      ownerEmail: args.email,
      ownerName: DEV_COMPANY_USER_NAME,
      ownerClerkId: 'dev_company_001',
      ownerWorkosUserId: 'dev_company_001_workos',
    }
  }
  if (args.email === 'company2@dev.local') {
    return {
      ownerEmail: args.email,
      ownerName: args.name,
      ownerClerkId: 'dev_company_002',
      ownerWorkosUserId: 'dev_company_002_workos',
    }
  }
  const ids = devSeedOwnerIds(args.email)
  return {
    ownerEmail: args.email,
    ownerName: args.name,
    ownerClerkId: ids.clerkId,
    ownerWorkosUserId: ids.workosUserId,
  }
}

function assertSeedCompanyArgs(args: {
  slug: string
  name: string
  ownerEmail: string
  documents: number
}): void {
  if (!args.name.trim()) {
    throw validationFailed('name no puede estar vacío', 'name')
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.slug)) {
    throw validationFailed('slug inválido', 'slug')
  }
  if (!args.ownerEmail.includes('@')) {
    throw validationFailed('ownerEmail inválido', 'ownerEmail')
  }
  if (!Number.isInteger(args.documents) || args.documents < 0) {
    throw validationFailed('documents debe ser un entero >= 0', 'documents')
  }
  if (args.documents > MAX_SEED_COMPANY_DOCUMENTS) {
    throw validationFailed(
      `documents no puede ser mayor a ${MAX_SEED_COMPANY_DOCUMENTS}`,
      'documents'
    )
  }
}

// ============================================================================
// BYTES SINTÉTICOS
// ============================================================================
// `createFromValidatedUpload` deja el documento en QUARANTINED si el
// `signatureKind` declarado no casa con el contentType que Convex registró en
// el blob, así que los bytes tienen que ser un PDF y un CSV de verdad, no un
// placeholder con la extensión puesta.

function latin1Bytes(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(text.length))
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    bytes[index] = code > 0xff ? 0x3f : code
  }
  return bytes
}

function escapePdfText(text: string): string {
  return text.replace(/[\\()]/g, (character) => `\\${character}`)
}

/** PDF 1.4 de una página con xref válido: los offsets se calculan al armarlo. */
function buildPdf(lines: readonly string[]): Uint8Array<ArrayBuffer> {
  const content =
    'BT\n/F1 11 Tf\n14 TL\n64 720 Td\n' +
    lines.map((line) => `(${escapePdfText(line)}) Tj T*\n`).join('') +
    'ET\n'

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${latin1Bytes(content).length} >>\nstream\n${content}endstream`,
  ]

  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(latin1Bytes(body).length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })

  const xrefOffset = latin1Bytes(body).length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    body += `${offset.toString().padStart(10, '0')} 00000 n \n`
  }
  body +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` + `startxref\n${xrefOffset}\n%%EOF\n`

  return latin1Bytes(body)
}

function documentBytes(document: SeedDocument): {
  bytes: Uint8Array<ArrayBuffer>
  mimeType: string
} {
  switch (document.kind) {
    case 'CSV':
      return {
        bytes: new TextEncoder().encode(`${document.body.join('\n')}\n`),
        mimeType: 'text/csv',
      }
    case 'XLSX':
      return {
        bytes: document.bytes,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }
    case 'PDF_BYTES':
      return { bytes: document.bytes, mimeType: 'application/pdf' }
    case 'PDF':
      return { bytes: buildPdf(document.body), mimeType: 'application/pdf' }
    default: {
      const _exhaustive: never = document
      return _exhaustive
    }
  }
}

function seedSignatureKind(document: SeedDocument): 'PDF' | 'TEXT' | 'ZIP' {
  switch (document.kind) {
    case 'CSV':
      return 'TEXT'
    case 'XLSX':
      return 'ZIP'
    case 'PDF':
    case 'PDF_BYTES':
      return 'PDF'
    default: {
      const _exhaustive: never = document
      return _exhaustive
    }
  }
}

// ============================================================================
// SALA
// ============================================================================

const ensureOwnerRoomProgram = Effect.fn('LocalSeed.ensureOwnerRoom')(function* (
  ctx: MutationCtx,
  target: {
    ownerEmail: string
    ownerName: string
    ownerClerkId: string
    ownerWorkosUserId: string
    company: LocalSeedCompanyFields
  }
): Effect.fn.Return<EnsuredRoom, AppError> {
  yield* localSeedOnly

  const existingUser = yield* convexPromise(() =>
    ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', target.ownerEmail))
      .first()
  )
  const userId =
    existingUser?._id ??
    (yield* convexPromise(() =>
      ctx.db.insert('users', {
        email: target.ownerEmail,
        name: target.ownerName,
        clerkId: target.ownerClerkId,
        workosUserId: target.ownerWorkosUserId,
        role: 'COMPANY',
        emailVerified: true,
      })
    ))
  const user = yield* convexPromise(() => ctx.db.get(userId))
  if (!user) {
    return yield* Effect.fail(
      validationFailed('No se pudo crear el usuario dueño de la sala local', 'user')
    )
  }

  // `createFromValidatedUpload` liga el subject WorkOS al usuario persistido y
  // el usuario dev de `auth.dev.ts` nace sin `workosUserId`: sin este parche
  // todo registro de documento se rechaza como identidad inválida.
  if (!user.workosUserId) {
    yield* convexPromise(() => ctx.db.patch(user._id, { workosUserId: target.ownerWorkosUserId }))
  }
  const providerUserId = user.workosUserId ?? target.ownerWorkosUserId

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
        fullName: target.ownerName,
        language: 'es',
        isVerified: true,
        isActive: true,
        kycStatus: 'VERIFIED',
        roleConfirmed: true,
      })
    ))

  const ownedCompanies = yield* convexPromise(() =>
    ctx.db
      .query('companies')
      .withIndex('by_ownerId', (q) => q.eq('ownerId', ownerProfileId))
      .collect()
  )
  const existingCompany = ownedCompanies.find((candidate) => candidate.name === target.company.name)
  const strays = ownedCompanies.filter((candidate) => candidate.name !== target.company.name)
  if (strays.length > 0) {
    return yield* Effect.fail(
      validationFailed(
        `${target.ownerEmail} ya posee otra empresa ("${strays[0].name}"). El resolver niega ` +
          'el acceso cuando un perfil tiene más de una: borra la base local ' +
          '(`bun run convex:local:reset`) y vuelve a sembrar.',
        'company'
      )
    )
  }

  const profileFields = target.company
  if (existingCompany) {
    yield* convexPromise(() =>
      ctx.db.patch(existingCompany._id, {
        ...companyFieldClears(profileFields),
        ...profileFields,
      })
    )
    return {
      companyId: existingCompany._id,
      ownerProfileId,
      providerUserId,
      created: false,
    }
  }

  const companyId = yield* convexPromise(() =>
    ctx.db.insert('companies', {
      ownerId: ownerProfileId,
      ...profileFields,
    })
  )
  return { companyId, ownerProfileId, providerUserId, created: true }
})

const ensureRoomProgram = Effect.fn('LocalSeed.ensureRoom')(function* (
  ctx: MutationCtx,
  args: { company: LocalSeedCompanyKey }
) {
  const target = SEED_COMPANIES[args.company]
  return yield* ensureOwnerRoomProgram(ctx, {
    ownerEmail: target.ownerEmail,
    ownerName: target.ownerName,
    ownerClerkId: target.ownerClerkId,
    ownerWorkosUserId: target.ownerWorkosUserId,
    company: { ...target.company, onboardingCompletedAt: Date.now() },
  })
})

export const ensureRoom = internalMutation({
  args: { company: localSeedCompanyArg },
  handler: (ctx, args) => runConvex(ensureRoomProgram(ctx, args)),
})

const seedCompanyProfileArg = v.union(
  v.literal('vacio'),
  v.literal('completo'),
  v.literal('desordenado')
)

const ensureCustomRoomProgram = Effect.fn('LocalSeed.ensureCustomRoom')(function* (
  ctx: MutationCtx,
  args: { slug: string; name: string; ownerEmail: string; profile: SeedCompanyProfile }
) {
  yield* localSeedOnly
  const name = args.name.trim()
  const ownerEmail = args.ownerEmail.trim().toLowerCase()
  yield* convexSync(() =>
    assertSeedCompanyArgs({ slug: args.slug, name, ownerEmail, documents: 0 })
  )
  const identity = ownerIdentityForSeed({ email: ownerEmail, name })
  const company = args.profile === 'vacio' ? emptyCompanyFields(name) : completeCompanyFields(name)
  return yield* ensureOwnerRoomProgram(ctx, { ...identity, company })
})

export const ensureCustomRoom = internalMutation({
  args: {
    slug: v.string(),
    name: v.string(),
    ownerEmail: v.string(),
    profile: seedCompanyProfileArg,
  },
  handler: (ctx, args) => runConvex(ensureCustomRoomProgram(ctx, args)),
})

// `requireAuth` en una query resuelve dev-auth con `getDevAuthResult`, que exige
// `admin@dev.local` y NO puede crearlo (una query no escribe). Los dev users
// nacen en la primera mutation del app; sin ellos, la primera carga de la sala
// pierde el SSR de la lista de documentos. El seed los deja puestos.
const ensureDevAdminProgram = Effect.fn('LocalSeed.ensureDevAdmin')(function* (ctx: MutationCtx) {
  yield* localSeedOnly

  const existingUser = yield* convexPromise(() =>
    ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', DEV_ADMIN_EMAIL))
      .first()
  )
  const userId =
    existingUser?._id ??
    (yield* convexPromise(() =>
      ctx.db.insert('users', {
        email: DEV_ADMIN_EMAIL,
        name: DEV_ADMIN_NAME,
        clerkId: 'dev_admin_001',
        workosUserId: DEV_ADMIN_WORKOS_USER_ID,
        authProvider: 'workos',
        providerUserId: DEV_ADMIN_WORKOS_USER_ID,
        role: 'ADMIN',
        emailVerified: true,
      })
    ))

  const user = yield* convexPromise(() => ctx.db.get(userId))
  if (!user) {
    return yield* Effect.fail(validationFailed('No se pudo crear el usuario admin local', 'user'))
  }
  if (
    user.workosUserId !== DEV_ADMIN_WORKOS_USER_ID ||
    user.authProvider !== 'workos' ||
    user.providerUserId !== DEV_ADMIN_WORKOS_USER_ID
  ) {
    yield* convexPromise(() =>
      ctx.db.patch(user._id, {
        workosUserId: DEV_ADMIN_WORKOS_USER_ID,
        authProvider: 'workos',
        providerUserId: DEV_ADMIN_WORKOS_USER_ID,
      })
    )
  }

  const existingProfile = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .first()
  )
  if (existingProfile) return { created: false }

  yield* convexPromise(() =>
    ctx.db.insert('profiles', {
      userId,
      role: 'ADMIN',
      fullName: DEV_ADMIN_NAME,
      language: 'es',
      isVerified: true,
      isActive: true,
      kycStatus: 'VERIFIED',
      roleConfirmed: true,
    })
  )
  return { created: true }
})

export const ensureDevAdmin = internalMutation({
  args: {},
  handler: (ctx) => runConvex(ensureDevAdminProgram(ctx)),
})

const documentNamesProgram = Effect.fn('LocalSeed.documentNames')(function* (
  ctx: QueryCtx,
  args: { companyId: Id<'companies'> }
) {
  yield* localSeedOnly
  const documents = yield* convexPromise(() =>
    ctx.db
      .query('documents')
      .withIndex('by_companyId', (q) => q.eq('companyId', args.companyId))
      .collect()
  )
  return documents.map((document) => document.name)
})

export const documentNames = internalQuery({
  args: { companyId: v.id('companies') },
  handler: (ctx, args) => runConvex(documentNamesProgram(ctx, args)),
})

// El tipo de retorno va ESCRITO, no inferido: `seed` es un export del módulo y
// alcanza `internal._localSeed.*`, que a su vez se teje desde los exports del
// módulo. Sin la anotación, TypeScript entra en el ciclo y todo el programa
// degrada a `any` — que es peor que un error, porque compila.
type LocalSeedRoomSummary = {
  key: LocalSeedCompanyKey
  name: string
  companyId: Id<'companies'>
  owner: string
  documents: number
  created: number
}

const registerMissingSeedDocuments = Effect.fn('LocalSeed.registerMissingDocuments')(function* (
  ctx: ActionCtx,
  args: {
    companyId: Id<'companies'>
    ownerProfileId: Id<'profiles'>
    providerUserId: string
    documents: readonly SeedDocument[]
    sourceName: string
  }
): Effect.fn.Return<RegisteredDocuments, AppError> {
  const existingNames: string[] = yield* convexPromise(() =>
    ctx.runQuery(internal._localSeed.documentNames, { companyId: args.companyId })
  )

  let created = 0
  for (const document of args.documents) {
    if (existingNames.includes(document.name)) continue
    const { bytes, mimeType } = documentBytes(document)
    const storageId = yield* convexPromise(() =>
      ctx.storage.store(new Blob([bytes], { type: mimeType }))
    )
    yield* convexPromise(() =>
      ctx.runAction(internal._demoSeed.registerFixture, {
        companyId: args.companyId,
        ownerProfileId: args.ownerProfileId,
        providerUserId: args.providerUserId,
        storageId,
        name: document.name,
        description: document.description,
        fileType: mimeType,
        signatureKind: seedSignatureKind(document),
        folder: document.folder,
        sourceName: args.sourceName,
        provenanceNotes: PROVENANCE_NOTES,
        sourceType: 'SYNTHETIC_DEMO',
        accessLevel: 'NDA_REQUIRED',
      })
    )
    created += 1
  }

  return { created, documents: existingNames.length + created }
})

const seedProgram = Effect.fn('LocalSeed.seed')(function* (
  ctx: ActionCtx
): Effect.fn.Return<LocalSeedRoomSummary[], AppError> {
  yield* localSeedOnly
  yield* convexPromise(() => ctx.runMutation(internal._localSeed.ensureDevAdmin, {}))

  const rooms: LocalSeedRoomSummary[] = []

  for (const key of LOCAL_SEED_COMPANY_KEYS) {
    const target = SEED_COMPANIES[key]
    const room = yield* convexPromise(() =>
      ctx.runMutation(internal._localSeed.ensureRoom, { company: key })
    )
    const registered = yield* registerMissingSeedDocuments(ctx, {
      companyId: room.companyId,
      ownerProfileId: room.ownerProfileId,
      providerUserId: room.providerUserId,
      documents: target.documents,
      sourceName: `Seed local (${target.company.name})`,
    })

    rooms.push({
      key,
      name: target.company.name,
      companyId: room.companyId,
      owner: target.ownerEmail,
      documents: registered.documents,
      created: registered.created,
    })
  }

  return rooms
})

export const seed = internalAction({
  args: {},
  handler: (ctx) => runConvex(seedProgram(ctx)),
})

type SeedCompanyResult = {
  companyId: Id<'companies'>
  ownerEmail: string
  providerUserId: string
  created: boolean
  documents: number
  documentsCreated: number
}

const seedCompanyProgram = Effect.fn('LocalSeed.seedCompany')(function* (
  ctx: ActionCtx,
  args: {
    slug: string
    name: string
    ownerEmail: string
    documents: number
    profile: SeedCompanyProfile
  }
): Effect.fn.Return<SeedCompanyResult, AppError> {
  yield* localSeedOnly
  const name = args.name.trim()
  const ownerEmail = args.ownerEmail.trim().toLowerCase()
  yield* convexSync(() =>
    assertSeedCompanyArgs({
      slug: args.slug,
      name,
      ownerEmail,
      documents: args.documents,
    })
  )
  yield* convexPromise(() => ctx.runMutation(internal._localSeed.ensureDevAdmin, {}))

  const room = yield* convexPromise(() =>
    ctx.runMutation(internal._localSeed.ensureCustomRoom, {
      slug: args.slug,
      name,
      ownerEmail,
      profile: args.profile,
    })
  )
  const documents =
    args.profile === 'desordenado'
      ? buildDesordenadoSeedDocuments({ count: args.documents, companyName: name })
      : buildCustomSeedDocuments({ count: args.documents, companyName: name })
  const registered = yield* registerMissingSeedDocuments(ctx, {
    companyId: room.companyId,
    ownerProfileId: room.ownerProfileId,
    providerUserId: room.providerUserId,
    documents,
    sourceName: `Seed local (${name})`,
  })

  return {
    companyId: room.companyId,
    ownerEmail,
    providerUserId: room.providerUserId,
    created: room.created,
    documents: registered.documents,
    documentsCreated: registered.created,
  }
})

export const seedCompany = internalAction({
  args: {
    slug: v.string(),
    name: v.string(),
    ownerEmail: v.string(),
    documents: v.number(),
    profile: seedCompanyProfileArg,
  },
  handler: (ctx, args) => runConvex(seedCompanyProgram(ctx, args)),
})
