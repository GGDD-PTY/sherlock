// ============================================================================
// STORE DEL DEMO EN EL NAVEGADOR
// ============================================================================
// Persistencia de mentira sobre `localStorage` para la sala de demostración.
//
// LO QUE SALE DE `localStorage` NO ES DE FIAR. `JSON.parse` devuelve `unknown` y
// hasta ahora se casteaba: `Array.isArray(parsed) ? parsed : []` daba por buena
// cualquier cosa que fuera un arreglo. Un `[1, 2, 3]` guardado por una versión
// vieja del demo —o por otra pestaña, o a mano desde la consola— entraba a la
// interfaz como documento y reventaba en el primer `.name`. Ahora cada fila se
// DECODIFICA con su `Schema`: la que no encaja se descarta y las demás siguen.
//
// El acceso al almacenamiento va por `Effect.try`, con su fallo tipado
// (`DemoStoreError`) en vez de un `catch {}` mudo: un navegador con la cuota
// llena o con el almacenamiento bloqueado es una condición esperada, no un
// misterio. Hacia afuera cada función conserva su firma síncrona — el programa
// se corre adentro con `Effect.runSync`.
// ============================================================================

import { Effect, Option, Schema } from 'effect'

const DEMO_DOCUMENTS_KEY = 'sherlock.demo.documents.v1'

const DemoAccessLevelSchema = Schema.Literals(['PUBLIC', 'NDA_REQUIRED', 'PRIVATE'])
const DocumentClassificationSchema = Schema.Literals([
  'PUBLIC_TEASER',
  'CONFIDENTIAL',
  'RESTRICTED',
  'LEGAL',
  'KYC_SENSITIVE',
])
const DemoStoredDocumentSchema = Schema.Struct({
  id: Schema.String,
  companyId: Schema.String,
  name: Schema.String,
  accessLevel: DemoAccessLevelSchema,
  classification: Schema.optional(DocumentClassificationSchema),
  fileType: Schema.NullOr(Schema.String),
  folder: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
})

export type DemoStoredDocument = typeof DemoStoredDocumentSchema.Type

type DemoDocumentInput = Omit<DemoStoredDocument, 'id' | 'createdAt'>

/** El almacenamiento del navegador falló o rechazó la operación. */
class DemoStoreError extends Schema.TaggedError<DemoStoreError>()('DemoStoreError', {
  operation: Schema.Literals(['read', 'write']),
  key: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const DEFAULT_DEMO_DOCUMENTS: DemoStoredDocument[] = [
  {
    id: 'demo_doc_espave_teaser',
    companyId: 'demo_company_001',
    name: 'SAMPLE_HYDRO illustrative credit summary',
    accessLevel: 'PUBLIC',
    classification: 'PUBLIC_TEASER',
    fileType: 'application/pdf',
    folder: 'Teaser',
    createdAt: '2026-05-20T00:00:00.000Z',
  },
  {
    id: 'demo_doc_espave_financials',
    companyId: 'demo_company_001',
    name: 'SAMPLE_HYDRO financial statements and MD&A extract',
    accessLevel: 'NDA_REQUIRED',
    classification: 'CONFIDENTIAL',
    fileType: 'application/pdf',
    folder: 'Financieros',
    createdAt: '2026-05-20T00:05:00.000Z',
  },
  {
    id: 'demo_doc_espave_source_manifest',
    companyId: 'demo_company_001',
    name: 'Regional exchange (demo) source manifest and raw-material index',
    accessLevel: 'NDA_REQUIRED',
    classification: 'CONFIDENTIAL',
    fileType: 'text/markdown',
    folder: 'Diligence',
    createdAt: '2026-05-20T00:10:00.000Z',
  },
  {
    id: 'demo_doc_espave_legal_diligence',
    companyId: 'demo_company_001',
    name: 'Legal diligence memo placeholder - collateral and corporate authority',
    accessLevel: 'PRIVATE',
    classification: 'LEGAL',
    fileType: 'application/pdf',
    folder: 'Legal',
    createdAt: '2026-05-20T00:15:00.000Z',
  },
]

function canUseLocalStorage() {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

function createDemoId(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID()}`
  }

  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function describeFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const decodeDocument = Schema.decodeUnknownOption(DemoStoredDocumentSchema)

/**
 * Lee una llave y devuelve SOLO las filas que su schema acepta. Una fila
 * corrupta se descarta; no tumba a las demás ni viaja a la interfaz con campos
 * ausentes que el render da por seguros.
 */
function readStored<A>(key: string, decode: (input: unknown) => Option.Option<A>): A[] {
  const program = Effect.try({
    try: () => {
      if (!canUseLocalStorage()) return []
      const raw = window.localStorage.getItem(key)
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    },
    catch: (cause) =>
      new DemoStoreError({
        operation: 'read',
        key,
        message: describeFailure(cause),
        cause,
      }),
  }).pipe(
    Effect.map((rows: unknown[]) =>
      rows.flatMap((row) => Option.toArray(decode(row)) as ReadonlyArray<A>)
    ),
    // El demo nunca puede tumbar la interfaz principal: sin almacenamiento
    // legible se sigue con la semilla.
    Effect.catchTag('DemoStoreError', () => Effect.succeed<ReadonlyArray<A>>([]))
  )

  return [...Effect.runSync(program)]
}

function readDocuments(): DemoStoredDocument[] {
  return readStored(DEMO_DOCUMENTS_KEY, decodeDocument)
}

function writeItems<T>(key: string, items: readonly T[]): void {
  const program = Effect.try({
    try: () => {
      if (!canUseLocalStorage()) return
      window.localStorage.setItem(key, JSON.stringify(items))
      window.dispatchEvent(new Event('sherlock-demo-store'))
    },
    catch: (cause) =>
      new DemoStoreError({
        operation: 'write',
        key,
        message: describeFailure(cause),
        cause,
      }),
  }).pipe(
    // Demo-only persistence should never break the main UI.
    Effect.catchTag('DemoStoreError', () => Effect.void)
  )

  Effect.runSync(program)
}

// Scoped demo getters fail closed: a missing/empty filter must never widen into
// "return everything" (see issue #141 — a guest with companyId '' received the
// full cross-company catalog).
function hasExplicitDemoScope(filters: { companyId?: string | null }) {
  return typeof filters.companyId === 'string' && filters.companyId.length > 0
}

export function getDemoDocuments(filters: { companyId?: string } = {}) {
  if (!hasExplicitDemoScope(filters)) return []

  const storedDocuments = readDocuments()
  const storedIds = new Set(storedDocuments.map((document) => document.id))
  const documents = [
    ...storedDocuments,
    ...DEFAULT_DEMO_DOCUMENTS.filter((document) => !storedIds.has(document.id)),
  ]

  return documents.filter((document) => !filters.companyId || document.companyId === filters.companyId)
}

export function addDemoDocument(input: DemoDocumentInput) {
  const document: DemoStoredDocument = {
    ...input,
    id: createDemoId('demo_doc'),
    createdAt: new Date().toISOString(),
  }

  writeItems(DEMO_DOCUMENTS_KEY, [document, ...readDocuments()])
  return document
}

export function updateDemoDocument(
  documentId: string,
  changes: Partial<Omit<DemoStoredDocument, 'id' | 'companyId' | 'createdAt'>>
) {
  const stored = readDocuments()
  const existing = stored.find((document) => document.id === documentId)

  // Los documentos por defecto no viven en localStorage; para poder editarlos hay
  // que materializarlos primero, o el cambio se perdería en el próximo render.
  if (!existing) {
    const seeded = DEFAULT_DEMO_DOCUMENTS.find((document) => document.id === documentId)
    if (!seeded) return null

    const materialized: DemoStoredDocument = { ...seeded, ...changes }
    writeItems(DEMO_DOCUMENTS_KEY, [materialized, ...stored])
    return materialized
  }

  const updated: DemoStoredDocument = { ...existing, ...changes }
  writeItems(
    DEMO_DOCUMENTS_KEY,
    stored.map((document) => (document.id === documentId ? updated : document))
  )
  return updated
}

export function removeDemoDocument(documentId: string) {
  writeItems(
    DEMO_DOCUMENTS_KEY,
    readDocuments().filter((document) => document.id !== documentId)
  )
}
