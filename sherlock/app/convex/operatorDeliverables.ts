// ============================================================================
// ENTREGABLES DE OPERADOR Sherlock <-> Mycroft
// ============================================================================
// El VDR está sellado y Mycroft lo corre el fundador a mano. Este módulo es la
// superficie mínima de ese ciclo, y solo eso: bajar los documentos vigentes de
// UNA empresa a una carpeta local, y devolver el entregable a la sala de ESA
// empresa con etiqueta y nota. Sus únicos llamadores son
// `scripts/operator/vdr-pull.mjs` y `scripts/operator/vdr-push.mjs`.
//
// CONTROL DE ACCESO: todo aquí es `internal*`.
// No es direccionable por ningún cliente autenticado ni por ninguna ruta HTTP —
// solo con la deploy key del deployment. Por eso no hay guard de rol: no hay
// sesión que autorizar. A cambio, ninguna función acepta "todas las empresas":
// el `companyId` es explícito y obligatorio, y toda escritura queda en
// `adminAuditLogs` vía `logAdminAction` con `operator-deliverables` como actor.
//
// Es la única superficie entre la sala y Mycroft: el puente MCP se borró del
// árbol el 2026-09-06 ([F], DECISIONS).
// ============================================================================

import type { PaginationResult } from 'convex/server'
import { v } from 'convex/values'
import { Effect } from 'effect'

import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import { internalAction, internalMutation, internalQuery } from './_generated/server'
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'
import type { FileSignature } from './_documents/fileInspection'
import { matchesDeclaredMimeType } from './_documents/fileInspection'
import { inferDocumentClassification } from './_documents/policy'
import { loadDeliverablePublishedVersion } from './_documents/deliverableVersion'
import { revokeGrantsForDocument, validateVdrShellFolderDestination } from './_documents/shared'
import {
  advanceDeliverableSlot,
  assertNotDeliveredAsOtherKind,
  normalizeDeliveryNote,
  renditionFormatForMimeType,
} from './_deliverables/manualDelivery'
import {
  DELIVERABLE_RENDITION_FORMATS,
  type DeliverableKind,
  type DeliverableRenditionFormat,
  deliverableKindValidator,
} from './_deliverables/model'
import { logAdminAction } from './_helpers/auditLog'
import { convexPromise, convexSync, runConvex, type ConvexEffect } from './_helpers/effect'
import type { AppError } from './_helpers/errors'
import { invalidState, notFound, validationFailed } from './_helpers/errors'
import { type OperatorActor, resolveOperatorActor } from './_helpers/operatorActor'
import { normalizeSha256Hex } from './_helpers/sha256'
import { getVdrShellFolderValue } from '../src/lib/vdr/document-taxonomy'
import {
  type DeliverableNotificationOutcome,
  notifyDeliverablePublished,
} from './_notifications/deliverables'

const OPERATOR_ACTOR = 'operator-deliverables'
const OPERATOR_ACTOR_FALLBACK_EMAIL = 'fixture-2b7da721@example.com'

// Una mutation de Convex ve los METADATOS del blob (`ctx.db.system.get`), nunca
// sus bytes: `detectFileSignature` no es invocable desde acá. La firma se
// deriva entonces del content-type que el storage registró al subir, y
// `matchesDeclaredMimeType` decide si eso cuenta como verificado. Un
// content-type que no está en la tabla cae a UNKNOWN y el documento entra
// QUARANTINED, que es el fallback correcto: no publicar lo que no se probó.
const SIGNATURE_KIND_BY_MIME: Record<string, FileSignature> = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'ZIP',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'ZIP',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'ZIP',
  'application/vnd.ms-excel': 'OLE',
  'application/msword': 'OLE',
  'application/vnd.ms-powerpoint': 'OLE',
  'text/csv': 'TEXT',
}

type DeliverableTarget =
  | { kind: 'MISMATCH' }
  | {
      kind: 'AMBIGUOUS'
      candidates: Array<{ documentId: Id<'documents'>; name: string; folder: string }>
    }
  | {
      kind: 'ALREADY_CURRENT'
      document: Doc<'documents'>
      currentVersion: Doc<'documentVersions'>
    }
  | {
      kind: 'NEW_VERSION'
      document: Doc<'documents'>
      currentVersion: Doc<'documentVersions'> | null
    }
  | { kind: 'NEW_DOCUMENT' }

// Una sola resolución de destino para el sondeo y para la escritura. El script
// sondea antes de subir para no dejar un blob huérfano cuando el entregable ya
// es la versión vigente, pero ese sondeo es una optimización: la mutation la
// vuelve a correr y es ella la que manda.
const resolveDeliverableTarget = Effect.fn('Deliverables.resolveTarget')(function* (
  ctx: QueryCtx | MutationCtx,
  input: {
    companyId: Id<'companies'>
    documentId?: Id<'documents'>
    name: string
    sha256: string
  }
): Effect.fn.Return<DeliverableTarget, AppError> {
  let document: Doc<'documents'> | null = null

  if (input.documentId) {
    const requestedId = input.documentId
    document = yield* convexPromise(() => ctx.db.get(requestedId))
    if (!document || document.companyId !== input.companyId) {
      return { kind: 'MISMATCH' }
    }
  } else {
    const named = (yield* convexPromise(() =>
      ctx.db
        .query('documents')
        .withIndex('by_companyId', (q) => q.eq('companyId', input.companyId))
        .collect()
    )).filter((row) => row.lifecycleStatus === 'ACTIVE' && row.name === input.name)

    if (named.length > 1) {
      return {
        kind: 'AMBIGUOUS',
        candidates: named.map((row) => ({
          documentId: row._id,
          name: row.name,
          folder: getVdrShellFolderValue(row.folder),
        })),
      }
    }
    document = named[0] ?? null
  }

  if (!document) return { kind: 'NEW_DOCUMENT' }

  const currentVersionId = document.currentVersionId
  const currentVersion = yield* convexPromise(() =>
    currentVersionId ? ctx.db.get(currentVersionId) : Promise.resolve(null)
  )

  // Los dos lados se normalizan porque la columna guarda base64 en las filas
  // viejas y hex en las nuevas. `normalizeSha256Hex` devuelve null cuando no
  // puede probar ninguna de las dos formas, y dos nulls NO son una igualdad:
  // sin este guard, dos digests indemostrables se leen como «ya publicado» y
  // el entregable se pierde en silencio, que es la peor falla de esta ruta.
  const currentSha = currentVersion ? normalizeSha256Hex(currentVersion.sha256) : null
  const incomingSha = normalizeSha256Hex(input.sha256)
  if (currentVersion && currentSha !== null && incomingSha !== null && currentSha === incomingSha) {
    return { kind: 'ALREADY_CURRENT', document, currentVersion }
  }
  return { kind: 'NEW_VERSION', document, currentVersion }
})

// Resolver por id o por nombre EXACTO, nunca por parecido. Cero coincidencias y
// varias coincidencias son respuestas legítimas: el script decide el código de
// salida, y "más de una" es justo el caso que evita que el operador escriba en
// la sala equivocada.
function matchesExactName(candidate: string | undefined, needle: string): boolean {
  if (!candidate) return false
  return candidate.trim().localeCompare(needle, undefined, { sensitivity: 'accent' }) === 0
}

// `companies` no tiene índice por nombre ni por razón social: el único índice
// de texto es `search_companies`, full-text y por prefijo, que no decide la
// coincidencia EXACTA que este resolutor exige. Así que la tabla se recorre,
// pero PAGINADA y hasta el final, nunca con un `.collect()` sin techo ni con
// un `.take()` que corte a medias: un corte silencioso devolvía "cero
// coincidencias" para una empresa que sí existe, y la CLI aborta la corrida
// del operador con ese cero. Un techo de páginas protege el deployment; si se
// alcanza, esto FALLA en voz alta en vez de mentir un cero.
const COMPANY_RESOLUTION_PAGE_SIZE = 200
const COMPANY_RESOLUTION_MAX_PAGES = 50

const resolveCompanyProgram = Effect.fn('Deliverables.resolveCompany')(function* (
  ctx: QueryCtx,
  args: { query: string }
) {
  const needle = args.query.trim()
  const normalizedId = ctx.db.normalizeId('companies', needle)
  if (normalizedId) {
    const company = yield* convexPromise(() => ctx.db.get(normalizedId))
    if (company) {
      return {
        matches: [
          { companyId: company._id, name: company.name, legalName: company.legalName ?? null },
        ],
      }
    }
  }

  // El nombre manda sobre la razón social: un seed cuyo `legalName` es
  // "Sample Hydro, S.A." no puede volver ambigua a la empresa que se
  // LLAMA así. Sólo si nadie coincide por nombre se mira la razón social.
  //
  // El barrido no corta en la primera coincidencia: "más de una" es una
  // respuesta que la CLI usa para negarse, y saberlo exige ver el padrón
  // completo.
  const byName: Array<Doc<'companies'>> = []
  const byLegalName: Array<Doc<'companies'>> = []
  let cursor: string | null = null
  for (let page = 0; ; page += 1) {
    if (page >= COMPANY_RESOLUTION_MAX_PAGES) {
      return yield* Effect.fail(
        invalidState(
          `El padrón de empresas superó ${COMPANY_RESOLUTION_MAX_PAGES * COMPANY_RESOLUTION_PAGE_SIZE} filas: pasa el companyId exacto en --company.`,
          'COMPANY_RESOLUTION_SCAN_EXHAUSTED'
        )
      )
    }
    // Anotado: el cursor de la vuelta siguiente sale de la página que este
    // mismo `yield*` produce, y sin el tipo escrito la inferencia se muerde la
    // cola y deja el programa entero en `any`.
    const pageCursor: string | null = cursor
    const companiesPage: PaginationResult<Doc<'companies'>> = yield* convexPromise(() =>
      ctx.db
        .query('companies')
        .paginate({ cursor: pageCursor, numItems: COMPANY_RESOLUTION_PAGE_SIZE })
    )
    for (const company of companiesPage.page) {
      if (matchesExactName(company.name, needle)) byName.push(company)
      else if (matchesExactName(company.legalName, needle)) byLegalName.push(company)
    }
    if (companiesPage.isDone) break
    cursor = companiesPage.continueCursor
  }
  return {
    matches: (byName.length > 0 ? byName : byLegalName).map((company) => ({
      companyId: company._id,
      name: company.name,
      legalName: company.legalName ?? null,
    })),
  }
})

export const resolveCompany = internalQuery({
  args: { query: v.string() },
  handler: (ctx, args) => runConvex(resolveCompanyProgram(ctx, args)),
})

// El inventario que baja el pull. `folder` sale de `getVdrShellFolderValue`, así
// que las carpetas locales llevan las MISMAS llaves que la sala muestra y un
// valor heredado (`model`, `financials`) aterriza donde el cliente lo ve.
const listCompanyDocumentsProgram = Effect.fn('Deliverables.listCompanyDocuments')(function* (
  ctx: QueryCtx,
  args: { companyId: Id<'companies'> }
) {
  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) {
    return yield* Effect.fail(notFound('Company', args.companyId))
  }

  const documents = yield* convexPromise(() =>
    ctx.db
      .query('documents')
      .withIndex('by_companyId', (q) => q.eq('companyId', args.companyId))
      .collect()
  )

  const rows = []
  for (const document of documents) {
    const currentVersionId = document.currentVersionId
    if (document.lifecycleStatus !== 'ACTIVE' || !currentVersionId) continue
    const version = yield* convexPromise(() => ctx.db.get(currentVersionId))
    if (!version) continue
    rows.push({
      documentId: document._id,
      versionId: version._id,
      name: document.name,
      displayName: version.displayName,
      // `folder` es el valor GUARDADO y `shellFolder` es donde la sala lo
      // muestra hoy. El manifiesto conserva los dos: colapsarlos perdía la
      // clasificación original del documento sin ganar nada.
      folder: document.folder ?? null,
      shellFolder: getVdrShellFolderValue(document.folder),
      byteSize: version.byteSize,
      // Convex Storage entrega el digest en base64 y solo algunas rutas de
      // escritura lo normalizan antes de persistirlo, así que la columna
      // mezcla las dos formas. El pull compara contra hex de Node: si acá
      // saliera el valor crudo, cada corrida re-bajaría la sala entera.
      sha256: normalizeSha256Hex(version.sha256) ?? version.sha256,
      detectedMimeType: version.detectedMimeType,
      versionNumber: version.versionNumber,
      url: yield* convexPromise(() => ctx.storage.getUrl(version.storageId)),
    })
  }

  return { companyName: company.name, documents: rows }
})

export const listCompanyDocuments = internalQuery({
  args: { companyId: v.id('companies') },
  handler: (ctx, args) => runConvex(listCompanyDocumentsProgram(ctx, args)),
})

// Sondeo previo a la subida: le dice al script si este entregable ya es la
// versión vigente, para no gastar un blob que después nadie referencia.
const inspectDeliverableTargetProgram = Effect.fn('Deliverables.inspectTarget')(function* (
  ctx: QueryCtx,
  args: {
    companyId: Id<'companies'>
    documentId?: Id<'documents'>
    name: string
    sha256: string
  }
) {
  const target = yield* resolveDeliverableTarget(ctx, {
    companyId: args.companyId,
    documentId: args.documentId,
    name: args.name.trim(),
    sha256: args.sha256,
  })

  // El sondeo también contesta DE QUIÉN es la sala. El script lo imprime antes
  // de subir un solo byte: un `companyId` válido pero equivocado no se ve, un
  // nombre de empresa sí.
  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  const companyName = company?.name ?? null

  switch (target.kind) {
    case 'MISMATCH':
      return { status: 'MISMATCH' as const, companyName }
    case 'AMBIGUOUS':
      return { status: 'AMBIGUOUS' as const, companyName, candidates: target.candidates }
    case 'ALREADY_CURRENT':
      return {
        status: 'ALREADY_CURRENT' as const,
        companyName,
        documentId: target.document._id,
        versionId: target.currentVersion._id,
        versionNumber: target.currentVersion.versionNumber,
        deliveryLabel: target.currentVersion.deliveryLabel ?? null,
        deliveryNote: target.currentVersion.deliveryNote ?? null,
      }
    case 'NEW_VERSION':
      return {
        status: 'NEW_VERSION' as const,
        companyName,
        documentId: target.document._id,
        folder: getVdrShellFolderValue(target.document.folder),
        versionNumber:
          target.document.currentVersionNumber ?? target.currentVersion?.versionNumber ?? 0,
      }
    case 'NEW_DOCUMENT':
      return { status: 'NEW_DOCUMENT' as const, companyName }
  }
})

export const inspectDeliverableTarget = internalQuery({
  args: {
    companyId: v.id('companies'),
    documentId: v.optional(v.id('documents')),
    name: v.string(),
    sha256: v.string(),
  },
  handler: (ctx, args) => runConvex(inspectDeliverableTargetProgram(ctx, args)),
})

// Una action SÍ puede lo que una mutation no (timers, `fetch`, `import()`),
// pero esta solo encadena dos llamadas del runtime, así que su programa es el
// mismo que el de una query: dos pasos con nombre sobre la misma costura.
// La anotación no es adorno: sin ella el `ctx.runQuery` sobre `internal` de
// este mismo módulo cierra un ciclo de inferencia con los exports del archivo y
// `tsc` lo resuelve como `any`.
const createUploadUrlProgram = Effect.fn('Deliverables.createUploadUrl')(function* (
  ctx: ActionCtx,
  args: { companyId: Id<'companies'> }
): Effect.fn.Return<string, AppError> {
  // Una URL de subida no escribe nada por sí sola, pero sigue siendo un
  // permiso: se emite solo si la empresa existe.
  yield* convexPromise(() =>
    ctx.runQuery(internal.operatorDeliverables.listCompanyDocuments, {
      companyId: args.companyId,
    })
  )
  return yield* convexPromise(() => ctx.storage.generateUploadUrl())
})

export const createDeliverableUploadUrl = internalAction({
  args: { companyId: v.id('companies') },
  handler: (ctx, args): Promise<string> => runConvex(createUploadUrlProgram(ctx, args)),
})

type SlotInput = { kind: DeliverableKind; format: DeliverableRenditionFormat }
type SlotAdvance = Awaited<ReturnType<typeof advanceDeliverableSlot>>
type Delivery<Slot> = { slot: Slot; notification: DeliverableNotificationOutcome }
type DeliveryInput = {
  company: Doc<'companies'>
  documentId: Id<'documents'>
  versionId: Id<'documentVersions'>
  name: string
  label: string | undefined
  note: string | undefined
  slot: SlotInput | undefined
  actor: OperatorActor
  now: number
  auditNotes: string
}

// El tramo final de una entrega vive UNA vez: mover el rail y avisarle al
// cliente. Lo comparten el push que subió bytes (`publishDeliverable`) y el
// sello sobre la versión vigente (`sealCurrentVersion`): lo que el cliente
// recibe tiene que ser idéntico venga de donde venga, y la auditoría del slot
// ya la escribe `advanceDeliverableSlot`. Solo se llama con una versión
// PUBLICADA y con firma verificada; esa puerta la decide el llamador antes.
// La nota llega ya acotada por `normalizeDeliveryNote` en la mutation.
const deliverPublishedVersionProgram = Effect.fn('Deliverables.deliverPublishedVersion')(function* (
  ctx: MutationCtx,
  input: DeliveryInput
): Effect.fn.Return<Delivery<SlotAdvance | null>, AppError> {
  // El corte por documento va ANTES de mover el rail y de avisar: el mismo xlsx
  // que ya salió como MODEL no gana el slot TEASER ni por un push con bytes
  // (NEW_VERSION con `--slot`) ni por el sello. Un documento recién creado no
  // puede estar citado, así que en NEW_DOCUMENT el corte no encuentra nada.
  const requestedSlot = input.slot
  if (requestedSlot) {
    yield* convexPromise(() =>
      assertNotDeliveredAsOtherKind(ctx, {
        companyId: input.company._id,
        kind: requestedSlot.kind,
        documentId: input.documentId,
      })
    )
  }
  const slot = requestedSlot
    ? yield* convexPromise(() =>
        advanceDeliverableSlot(ctx, {
          companyId: input.company._id,
          kind: requestedSlot.kind,
          documentId: input.documentId,
          format: requestedSlot.format,
          actor: input.actor,
          now: input.now,
          auditActor: OPERATOR_ACTOR,
          auditNotes: input.auditNotes,
        })
      )
    : null

  // El aviso se deduplica por versión y, si ya existía, se refresca en sitio
  // (mensaje con la nota, de vuelta a no leído) en vez de abrir otra fila. El
  // resultado queda en el log del deployment: es lo único que dice si la
  // campanita del cliente sonó, se refrescó o ya estaba al día.
  const notification = yield* convexPromise(() =>
    notifyDeliverablePublished(ctx, {
      company: input.company,
      documentId: input.documentId,
      versionId: input.versionId,
      name: input.name,
      label: input.label,
      note: input.note,
    })
  )
  yield* Effect.log(
    `[${OPERATOR_ACTOR}] aviso al cliente: ${notification} (versión ${input.versionId})`
  )

  return { slot, notification }
})

// Las dos sobrecargas se conservan: entregar CON slot garantiza el avance, y es
// lo que deja al sello leer `advanced.from` sin un `!`. El programa es uno solo.
function deliverPublishedVersion(
  ctx: MutationCtx,
  input: DeliveryInput & { slot: SlotInput }
): ConvexEffect<Delivery<SlotAdvance>>
function deliverPublishedVersion(
  ctx: MutationCtx,
  input: DeliveryInput
): ConvexEffect<Delivery<SlotAdvance | null>>
function deliverPublishedVersion(
  ctx: MutationCtx,
  input: DeliveryInput
): ConvexEffect<Delivery<SlotAdvance | null>> {
  return deliverPublishedVersionProgram(ctx, input)
}

type PublishDeliverableArgs = {
  companyId: Id<'companies'>
  documentId?: Id<'documents'>
  storageId: Id<'_storage'>
  name: string
  folder: string
  label?: string
  note?: string
  slot?: DeliverableKind
}

const publishDeliverableProgram = Effect.fn('Deliverables.publish')(function* (
  ctx: MutationCtx,
  args: PublishDeliverableArgs
) {
  // Una llave de carpeta desconocida se rechaza, no se coacciona: escribir en
  // `room_corporate` "porque era lo más parecido" mueve el entregable de sala
  // a espaldas del operador.
  const folder = yield* convexSync(() => validateVdrShellFolderDestination(args.folder))
  const name = args.name.trim()
  if (name.length === 0) {
    return yield* Effect.fail(
      validationFailed('El nombre del entregable no puede ir vacío', 'name')
    )
  }
  // El CLI ya formatea la nota; la mutation la acota igual, antes de escribir.
  const note = yield* convexSync(() =>
    args.note === undefined ? undefined : normalizeDeliveryNote(args.note)
  )

  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) {
    return yield* Effect.fail(notFound('Company', args.companyId))
  }
  const blob = yield* convexPromise(() => ctx.db.system.get(args.storageId))
  if (!blob) {
    return yield* Effect.fail(
      validationFailed('El archivo no existe en el almacenamiento', 'storageId')
    )
  }

  const contentType = blob.contentType ?? ''
  const sha256 = normalizeSha256Hex(blob.sha256) ?? blob.sha256
  const signatureKind = SIGNATURE_KIND_BY_MIME[contentType] ?? 'UNKNOWN'
  const signatureVerified = matchesDeclaredMimeType(contentType, signatureKind)

  // Muere ANTES de escribir: descubrir que el slot no puede avanzar después
  // de publicar la versión deja al operador con el documento en la sala y el
  // rail sin mover, que es exactamente el estado que `--slot` viene a evitar.
  const slotFormat = args.slot ? renditionFormatForMimeType(contentType) : undefined
  if (args.slot && signatureVerified && !slotFormat) {
    return yield* Effect.fail(
      validationFailed(
        `Un ${contentType || 'archivo sin content-type'} no tiene rendition ` +
          `(${DELIVERABLE_RENDITION_FORMATS.join(', ')}): el slot ${args.slot} no puede avanzar.`,
        'slot'
      )
    )
  }

  const target = yield* resolveDeliverableTarget(ctx, {
    companyId: args.companyId,
    documentId: args.documentId,
    name,
    sha256,
  })
  if (target.kind === 'MISMATCH') {
    return yield* Effect.fail(
      validationFailed('El documento no pertenece a esta empresa', 'documentId')
    )
  }
  if (target.kind === 'AMBIGUOUS') {
    const ids = target.candidates.map((candidate) => candidate.documentId).join(', ')
    return yield* Effect.fail(
      validationFailed(
        `Hay ${target.candidates.length} documentos activos con ese nombre (${ids}). Indica cuál con --document.`,
        'name'
      )
    )
  }
  if (target.kind === 'ALREADY_CURRENT') {
    return {
      kind: 'ALREADY_CURRENT' as const,
      documentId: target.document._id,
      versionId: target.currentVersion._id,
      versionNumber: target.currentVersion.versionNumber,
    }
  }

  const now = Date.now()
  // Sin respaldo a propósito: un entregable del equipo firmado con el perfil
  // del cliente sería una mentira de procedencia, así que un deployment sin
  // ADMIN falla en vez de publicar mal atribuido.
  const actor = yield* convexPromise(() =>
    resolveOperatorActor(ctx, {
      fallbackEmail: OPERATOR_ACTOR_FALLBACK_EMAIL,
    })
  )
  const lifecycleStatus = signatureVerified ? ('ACTIVE' as const) : ('QUARANTINED' as const)
  const publicationStatus = signatureVerified ? ('PUBLISHED' as const) : ('DRAFT' as const)

  const previousVersion = target.kind === 'NEW_VERSION' ? target.currentVersion : null
  // Una mutation ve los METADATOS del blob, nunca sus bytes: la "firma" es el
  // content-type que el storage registró al subir. Un `.xlsx` sin extensión,
  // un blob sin content-type o una extensión que no está en la tabla caen a
  // UNKNOWN — y eso NO puede costarle al cliente la entrega que ya estaba
  // publicada. Sobre un documento que ya existe, la versión sin verificar
  // entra como BORRADOR en cuarentena y el documento se queda exactamente
  // donde estaba: mismo `lifecycleStatus`, mismo `publishedVersionId`, mismo
  // `currentVersionId` y mismos bytes. Un documento NUEVO sí nace
  // QUARANTINED: ahí no hay nada vigente que desarmar.
  const keepsLiveDocument = target.kind === 'NEW_VERSION' && !signatureVerified
  // Solo una versión que de verdad se publica reemplaza a la anterior.
  const supersedes = signatureVerified ? previousVersion : null
  // El número sale del ÚLTIMO row del historial, no del puntero del documento.
  // `keepsLiveDocument` no sube `currentVersionNumber` a propósito (la sala
  // sigue sirviendo la misma versión), así que derivarlo del puntero le daba
  // el mismo número a cada push sin firma verificada: dos filas "v2" en el
  // mismo `by_document_version`, con la vista de historial mostrando dos
  // versiones homónimas y el orden del índice decidiendo cuál gana.
  const lastVersion =
    target.kind === 'NEW_VERSION'
      ? yield* convexPromise(() =>
          ctx.db
            .query('documentVersions')
            .withIndex('by_document_version', (q) => q.eq('documentId', target.document._id))
            .order('desc')
            .first()
        )
      : null
  const versionNumber =
    target.kind === 'NEW_VERSION'
      ? Math.max(
          target.document.currentVersionNumber ?? 0,
          previousVersion?.versionNumber ?? 0,
          lastVersion?.versionNumber ?? 0
        ) + 1
      : 1

  // `--folder` NUNCA mueve un documento que ya existe: reubicarlo en
  // `NEW_VERSION` lo sacaba de la carpeta donde el cliente lo dejó, sin
  // evidencia de movimiento y sin su auditoría. La llave pedida se ignora y
  // la respuesta lo dice, para que el script lo advierta.
  const documentFolder =
    target.kind === 'NEW_DOCUMENT' ? folder : getVdrShellFolderValue(target.document.folder)
  const folderIgnored = documentFolder !== folder

  let documentId: Id<'documents'>
  if (target.kind === 'NEW_DOCUMENT') {
    const accessLevel = 'NDA_REQUIRED' as const
    documentId = yield* convexPromise(() =>
      ctx.db.insert('documents', {
        companyId: args.companyId,
        name,
        fileType: contentType,
        fileSize: blob.size,
        storageId: args.storageId,
        lifecycleStatus,
        currentVersionNumber: 1,
        accessLevel,
        classification: inferDocumentClassification(accessLevel, 'CONFIDENTIAL'),
        protectionPolicyVersion: 'trust-os-v2',
        updatedAt: now,
        folder,
        sourceType: 'TEAM_DELIVERABLE',
        provenanceNotes: `${OPERATOR_ACTOR}: entregable devuelto a mano desde Mycroft`,
        isExpired: false,
      })
    )
  } else {
    documentId = target.document._id
    if (supersedes) {
      yield* convexPromise(() => ctx.db.patch(supersedes._id, { publicationStatus: 'SUPERSEDED' }))
    }
  }

  const versionId = yield* convexPromise(() =>
    ctx.db.insert('documentVersions', {
      documentId,
      companyId: args.companyId,
      versionNumber,
      storageId: args.storageId,
      displayName: name,
      declaredMimeType: contentType,
      detectedMimeType: contentType,
      byteSize: blob.size,
      sha256,
      signatureKind,
      verificationStatus: signatureVerified ? 'SIGNATURE_VERIFIED' : 'QUARANTINED',
      malwareScanStatus: signatureVerified ? 'NOT_CONFIGURED' : 'PENDING',
      publicationStatus,
      replacesVersionId: supersedes?._id,
      deliveryLabel: args.label,
      deliveryNote: note,
      createdAt: now,
      createdByProfileId: actor.profileId,
      publishedAt: signatureVerified ? now : undefined,
    })
  )

  if (keepsLiveDocument) {
    // Lo único que cambió es que HUBO un intento: los punteros del documento
    // siguen apuntando a la versión que la sala ya servía.
    yield* convexPromise(() => ctx.db.patch(documentId, { updatedAt: now }))
  } else {
    yield* convexPromise(() =>
      ctx.db.patch(documentId, {
        storageId: args.storageId,
        fileType: contentType,
        fileSize: blob.size,
        currentVersionId: versionId,
        publishedVersionId: signatureVerified ? versionId : undefined,
        currentVersionNumber: versionNumber,
        updatedAt: now,
        ...(target.kind === 'NEW_DOCUMENT' ? { folder } : {}),
        lifecycleStatus,
        // Los bytes que la sala sirve ahora los devolvió el equipo: la
        // procedencia acompaña a la versión publicada, no al nombre.
        sourceType: 'TEAM_DELIVERABLE',
      })
    )
  }

  if (supersedes) {
    // Los grants vigentes apuntaban a los bytes anteriores. `revokeGrantsForDocument`
    // toma la razón como string; se reusa el literal que ya existe para
    // "otra versión reemplazó a esta" en vez de ensanchar el vocabulario.
    // Sin `supersedes` los bytes que sirve la sala no cambiaron, y revocar
    // ahí le rompería las descargas al cliente sin haberle entregado nada.
    yield* convexPromise(() =>
      revokeGrantsForDocument(ctx, documentId, 'DOCUMENT_VERSION_RESTORED', now)
    )
  }

  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      userId: actor.profileId,
      action: 'VDR_DOCUMENT_VERSION_INGESTED',
      entityType: 'DOCUMENT_VERSION',
      entityId: `${versionId}`,
      metadata: {
        resourceType: 'COMPANY',
        resourceId: `${args.companyId}`,
        details: { versionNumber, source: OPERATOR_ACTOR, deliveryLabel: args.label ?? null },
      },
    })
  )

  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: actor.profileId,
      adminEmail: actor.email,
      action: 'DOCUMENT_UPLOAD',
      targetType: 'DOCUMENT',
      targetId: `${documentId}`,
      newValue: {
        actor: OPERATOR_ACTOR,
        companyId: args.companyId,
        displayName: name,
        folder: documentFolder,
        requestedFolder: folderIgnored ? folder : null,
        versionNumber,
        deliveryLabel: args.label ?? null,
        verificationStatus: signatureVerified ? 'SIGNATURE_VERIFIED' : 'QUARANTINED',
      },
      notes: `${OPERATOR_ACTOR}: entregable devuelto a mano desde Mycroft`,
    })
  )

  // Solo lo que de verdad quedó publicado mueve el rail y avisa: una versión
  // en cuarentena no la ve el cliente, y marcar "Entregado" ahí sería la
  // misma mentira cara que el script ya grita.
  const delivery = signatureVerified
    ? yield* deliverPublishedVersion(ctx, {
        company,
        documentId,
        versionId,
        name,
        label: args.label,
        note,
        slot: args.slot && slotFormat ? { kind: args.slot, format: slotFormat } : undefined,
        actor,
        now,
        auditNotes: `${OPERATOR_ACTOR}: el push del entregable avanzó el slot`,
      })
    : null

  return {
    kind: target.kind === 'NEW_DOCUMENT' ? ('CREATED' as const) : ('NEW_VERSION' as const),
    documentId,
    versionId,
    versionNumber,
    slot: delivery?.slot ?? null,
    // Las dos cosas que el script tiene que poder gritar: que el entregable
    // NO quedó publicado, y que la carpeta pedida se ignoró.
    signatureVerified,
    folder: documentFolder,
    folderIgnored,
  }
})

export const publishDeliverable = internalMutation({
  args: {
    companyId: v.id('companies'),
    documentId: v.optional(v.id('documents')),
    storageId: v.id('_storage'),
    name: v.string(),
    folder: v.string(),
    label: v.optional(v.string()),
    note: v.optional(v.string()),
    // Opcional a propósito: sin `--slot` el push publica el documento y no toca
    // el workflow, que es el comportamiento que ya tenían los entregables sin
    // etapa propia en el rail.
    slot: v.optional(deliverableKindValidator),
  },
  handler: (ctx, args) => runConvex(publishDeliverableProgram(ctx, args)),
})

// El mismo sha con `--slot` NO es un no-op. El push original pudo salir sin
// `--slot`, o el slot pudo no moverse, y el rail del cliente sigue quieto con
// el archivo ya en la sala: reintentar el push subía cero bytes y tampoco
// movía nada, así que la entrega no tenía forma de repararse. Este sello mueve
// el slot sobre la versión vigente sin subir bytes: sella la nota si la versión
// no la traía, avanza el slot y avisa — por el MISMO tramo que un push con
// bytes. Idempotente por (kind, versión): con el slot ya entregado citando
// este documento y la versión ya sellada no vuelve a mover nada, ni a
// notificar, ni a escribir auditoría.
const sealCurrentVersionProgram = Effect.fn('Deliverables.sealCurrentVersion')(function* (
  ctx: MutationCtx,
  args: {
    companyId: Id<'companies'>
    documentId: Id<'documents'>
    slot: DeliverableKind
    note: string
  }
) {
  const note = yield* convexSync(() => normalizeDeliveryNote(args.note))

  const document = yield* convexPromise(() => ctx.db.get(args.documentId))
  if (!document || document.companyId !== args.companyId) {
    return yield* Effect.fail(
      validationFailed('El documento no pertenece a esta empresa', 'documentId')
    )
  }
  const company = yield* convexPromise(() => ctx.db.get(document.companyId))
  if (!company) {
    return yield* Effect.fail(notFound('Company', document.companyId))
  }

  // Las mismas puertas que el push aplica antes de mover el rail: una versión
  // publicada y con firma verificada, y un formato con rendition. Sin eso el
  // slot prometería un archivo que el cliente no puede abrir.
  const version = yield* convexPromise(() => loadDeliverablePublishedVersion(ctx, document))
  if (!version) {
    return yield* Effect.fail(
      invalidState(
        'El documento no tiene una versión publicada que el cliente pueda abrir.',
        document.lifecycleStatus
      )
    )
  }
  const contentType = version.detectedMimeType || version.declaredMimeType
  const format = renditionFormatForMimeType(contentType)
  if (!format) {
    return yield* Effect.fail(
      validationFailed(
        `Un ${contentType || 'archivo sin content-type'} no tiene rendition ` +
          `(${DELIVERABLE_RENDITION_FORMATS.join(', ')}): el slot ${args.slot} no puede avanzar.`,
        'slot'
      )
    )
  }

  const existing = yield* convexPromise(() =>
    ctx.db
      .query('deliverables')
      .withIndex('by_company_kind', (q) => q.eq('companyId', args.companyId).eq('kind', args.slot))
      .first()
  )
  const sealedNote = version.deliveryNote?.trim() || undefined
  const delivered =
    existing &&
    existing.status === 'DELIVERED' &&
    (existing.renditions ?? []).some((rendition) => rendition.documentId === document._id)
      ? existing
      : undefined
  if (sealedNote && delivered) {
    return {
      delivered: false as const,
      kind: args.slot,
      status: delivered.status,
      versionId: version._id,
      versionNumber: version.versionNumber,
    }
  }

  const now = Date.now()
  const actor = yield* convexPromise(() =>
    resolveOperatorActor(ctx, {
      fallbackEmail: OPERATOR_ACTOR_FALLBACK_EMAIL,
    })
  )
  // La nota es el sello de la versión. Si ya lo traía (del push que subió los
  // bytes) se conserva: la de esta corrida no lo pisa.
  if (!sealedNote) {
    yield* convexPromise(() => ctx.db.patch(version._id, { deliveryNote: note }))
  }
  if (document.sourceType !== 'TEAM_DELIVERABLE') {
    yield* convexPromise(() => ctx.db.patch(document._id, { sourceType: 'TEAM_DELIVERABLE' }))
  }

  const { slot: advanced, notification } = yield* deliverPublishedVersion(ctx, {
    company,
    documentId: document._id,
    versionId: version._id,
    name: document.name,
    label: version.deliveryLabel,
    note: sealedNote ?? note,
    slot: { kind: args.slot, format },
    actor,
    now,
    auditNotes: `${OPERATOR_ACTOR}: el sello sobre la versión vigente avanzó el slot`,
  })

  return {
    delivered: true as const,
    kind: args.slot,
    from: advanced.from,
    status: advanced.to,
    noteApplied: !sealedNote,
    // Qué pasó con la campanita de esta versión: `refreshed` es el caso que
    // este sello repara (un push sin `--slot` ya había avisado sin la nota).
    notification,
    versionId: version._id,
    versionNumber: version.versionNumber,
  }
})

export const sealCurrentVersion = internalMutation({
  args: {
    companyId: v.id('companies'),
    documentId: v.id('documents'),
    slot: deliverableKindValidator,
    note: v.string(),
  },
  handler: (ctx, args) => runConvex(sealCurrentVersionProgram(ctx, args)),
})
