// ============================================================================
// DELIVERABLES — carril manual del pipeline sell-side (fase 2 del scaffold)
// ============================================================================
// Facade público del dominio `_deliverables/`. Disciplina de frontera: TODA la
// validación (auth, rol, ownership, integridad cross-empresa) vive aquí, en el
// handler de la mutation; la lógica de negocio (kinds, estados, transiciones)
// es pura y vive en `_deliverables/model.ts`. Adentro no se re-valida.
//
// El carril manual es el producto: el equipo llena los slots con entregables
// hechos a mano (producedBy TEAM). Mycroft corre fuera del repo y nunca se
// conecta a la sala; las transiciones de revisión, aprobación y entrega son
// humanas y siempre dejan evidencia en el audit log.
//
// «FUENTE CITABLE» SE DECIDE EN UN SOLO LUGAR. La condición —la versión existe,
// es de esta empresa, no está rechazada ni en cuarentena como borrador, y su
// documento no está en cuarentena ni archivado— estaba escrita dos veces:
// `attachRendition` la usaba para rechazar y `listForCompany` para esconder. Dos
// copias de la misma regla de evidencia, y la de lectura es la que decide qué
// ve el cliente. `resolveCitableSource` es ahora la única.

import { v } from 'convex/values'
import { Effect } from 'effect'

import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import { loadDeliverablePublishedVersion } from './_documents/deliverableVersion'
import { requireAuth, requireAuthAdmin, requireAuthenticatedCompany } from './_helpers/auth'
import { requireCompanyManagementAuthorization } from './_helpers/companyAuthorization'
import { logAdminAction } from './_helpers/auditLog'
import { convexPromise, convexSync, runConvex } from './_helpers/effect'
import type { AppError } from './_helpers/errors'
import { invalidState, notFound, unauthorized, validationFailed } from './_helpers/errors'
import { enforceRateLimit } from './_helpers/rateLimit'
import {
  advanceDeliverableSlot,
  assertNotDeliveredAsOtherKind,
  normalizeDeliveryNote,
  renditionFormatForMimeType,
} from './_deliverables/manualDelivery'
import {
  DELIVERABLE_KINDS,
  DELIVERABLE_RENDITION_FORMATS,
  canTransitionDeliverable,
  deliverableKindValidator,
  deliverableRenditionFormatValidator,
  deliverableStatusValidator,
} from './_deliverables/model'
import { notifyDeliverablePublished } from './_notifications/deliverables'

type DbCtx = Pick<QueryCtx | MutationCtx, 'db'>
type DeliverableKind = Doc<'deliverables'>['kind']
type DeliverableStatus = Doc<'deliverables'>['status']
type RenditionFormat = NonNullable<Doc<'deliverables'>['renditions']>[number]['format']

/**
 * Una fuente citable del `inputManifest`: bytes que la sala de verdad sirvió.
 *
 * Rechazar solo `REJECTED` dejaba pasar la cuarentena. Un push de operador cuya
 * firma no se pudo verificar entra QUARANTINED como DRAFT y NO mueve los
 * punteros del documento (`operatorDeliverables.publishDeliverable`, rama
 * `keepsLiveDocument`), así que el DOCUMENTO se queda ACTIVE y el chequeo de
 * `lifecycleStatus` que sigue no lo ve: el manifiesto — que es evidencia GIGO
 * auditable — podía citar un archivo que nadie pudo abrir.
 *
 * El corte es el borrador en cuarentena, no "todo lo QUARANTINED": el v1
 * sintético del ingest es QUARANTINED y SUPERSEDED, y es la historia real de un
 * documento legacy que sí se sirvió.
 */
function isCitableSourceVersion(version: Doc<'documentVersions'>): boolean {
  if (version.verificationStatus === 'REJECTED') return false
  return !(version.verificationStatus === 'QUARANTINED' && version.publicationStatus === 'DRAFT')
}

/**
 * La versión citada y su documento, o `null` si la cita no se sostiene. Quien
 * rechaza (`attachRendition`) y quien esconde (`listForCompany`) preguntan lo
 * mismo acá y no pueden divergir.
 */
const resolveCitableSource = Effect.fn('Deliverables.resolveCitableSource')(function* (
  ctx: DbCtx,
  versionId: Id<'documentVersions'>,
  companyId: Id<'companies'>
): Effect.fn.Return<
  { document: Doc<'documents'>; version: Doc<'documentVersions'> } | null,
  AppError
> {
  const version = yield* convexPromise(() => ctx.db.get(versionId))
  if (!version || version.companyId !== companyId || !isCitableSourceVersion(version)) {
    return null
  }

  const document = yield* convexPromise(() => ctx.db.get(version.documentId))
  if (
    !document ||
    document.companyId !== companyId ||
    document.lifecycleStatus === 'QUARANTINED' ||
    document.lifecycleStatus === 'ARCHIVED'
  ) {
    return null
  }

  return { document, version }
})

const isUsableRenditionDocument = Effect.fn('Deliverables.isUsableRenditionDocument')(function* (
  ctx: DbCtx,
  document: Doc<'documents'> | null,
  companyId: string
) {
  if (!document || document.companyId !== companyId) return false
  return (yield* convexPromise(() => loadDeliverablePublishedVersion(ctx, document))) !== null
})

const requestProgram = Effect.fn('Deliverables.request')(function* (
  ctx: MutationCtx,
  args: { kind: DeliverableKind; companyId?: Id<'companies'> }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const { profile, user } = auth

  let companyId
  if (profile.role === 'ADMIN') {
    const requestedCompanyId = args.companyId
    if (!requestedCompanyId) {
      return yield* Effect.fail(
        validationFailed('Un admin debe indicar la empresa del entregable.', 'companyId')
      )
    }
    const company = yield* convexPromise(() => ctx.db.get(requestedCompanyId))
    if (!company) return yield* Effect.fail(notFound('company', `${requestedCompanyId}`))
    companyId = company._id
  } else {
    const { company } = yield* convexPromise(() => requireAuthenticatedCompany(ctx))
    yield* convexPromise(() => requireCompanyManagementAuthorization(ctx, auth, company))
    if (args.companyId && args.companyId !== company._id) {
      return yield* Effect.fail(
        unauthorized('Solo puedes solicitar entregables para tu propia empresa.')
      )
    }
    companyId = company._id
  }

  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `deliverablesRequest:${profile._id}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    })
  )

  const existing = yield* convexPromise(() =>
    ctx.db
      .query('deliverables')
      .withIndex('by_company_kind', (q) => q.eq('companyId', companyId).eq('kind', args.kind))
      .first()
  )
  if (existing) {
    return { deliverableId: existing._id, status: existing.status, created: false as const }
  }

  const now = Date.now()
  const deliverableId = yield* convexPromise(() =>
    ctx.db.insert('deliverables', {
      companyId,
      kind: args.kind,
      status: 'REQUESTED',
      requestedByProfileId: profile._id,
      updatedAt: now,
    })
  )

  if (profile.role === 'ADMIN') {
    yield* convexPromise(() =>
      logAdminAction({
        ctx,
        adminProfileId: profile._id,
        adminEmail: user.email,
        action: 'DELIVERABLE_REQUEST',
        targetType: 'DELIVERABLE',
        targetId: `${deliverableId}`,
        newValue: { companyId: `${companyId}`, kind: args.kind, status: 'REQUESTED' },
      })
    )
  }

  return { deliverableId, status: 'REQUESTED' as const, created: true as const }
})

/**
 * Crea (o devuelve) el slot de un entregable para una empresa. Idempotente por
 * (empresa, kind): pedir dos veces el teaser no crea dos teasers — devuelve el
 * slot existente. La empresa solo puede pedir sobre sí misma; un admin debe
 * nombrar la empresa explícitamente.
 */
export const request = mutation({
  args: {
    kind: deliverableKindValidator,
    // Solo para ADMIN: la empresa dueña del slot. El path de empresa lo deriva
    // de su propia fila y rechaza cualquier intento de apuntar a otra.
    companyId: v.optional(v.id('companies')),
  },
  handler: (ctx, args) => runConvex(requestProgram(ctx, args)),
})

const transitionProgram = Effect.fn('Deliverables.transition')(function* (
  ctx: MutationCtx,
  args: { deliverableId: Id<'deliverables'>; to: DeliverableStatus }
) {
  const { user, profile } = yield* convexPromise(() => requireAuthAdmin(ctx))

  const deliverable = yield* convexPromise(() => ctx.db.get(args.deliverableId))
  if (!deliverable) return yield* Effect.fail(notFound('deliverable', `${args.deliverableId}`))

  if (!canTransitionDeliverable(deliverable.status, args.to)) {
    return yield* Effect.fail(
      invalidState(
        `La transición ${deliverable.status} → ${args.to} no existe en el ciclo de entregables.`,
        deliverable.status
      )
    )
  }

  if (args.to === 'APPROVED' || args.to === 'DELIVERED') {
    const usable = yield* Effect.forEach(
      deliverable.renditions ?? [],
      Effect.fn('Deliverables.renditionIsUsable')(function* (rendition: {
        format: RenditionFormat
        documentId: Id<'documents'>
      }) {
        const document = yield* convexPromise(() => ctx.db.get(rendition.documentId))
        return yield* isUsableRenditionDocument(ctx, document, deliverable.companyId)
      }),
      { concurrency: 'unbounded' }
    )

    if (!usable.some(Boolean)) {
      return yield* Effect.fail(
        invalidState(
          'El entregable necesita al menos una rendition vigente para aprobarse o entregarse.',
          deliverable.status
        )
      )
    }
  }

  const now = Date.now()
  yield* convexPromise(() =>
    ctx.db.patch(deliverable._id, {
      status: args.to,
      updatedAt: now,
      ...(args.to === 'APPROVED' ? { approvedAt: now, reviewedByProfileId: profile._id } : {}),
      ...(args.to === 'DELIVERED' ? { deliveredAt: now } : {}),
    })
  )

  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: user.email,
      action: 'DELIVERABLE_TRANSITION',
      targetType: 'DELIVERABLE',
      targetId: `${deliverable._id}`,
      previousValue: { status: deliverable.status },
      newValue: { status: args.to },
    })
  )

  return { deliverableId: deliverable._id, status: args.to }
})

/**
 * Transición humana del slot. Solo ADMIN: en el carril manual el equipo mueve
 * el trabajo; la empresa observa en tiempo real. La máquina de estados pura
 * decide qué movimientos existen — aquí solo se aplica y se audita.
 */
export const transition = mutation({
  args: {
    deliverableId: v.id('deliverables'),
    to: deliverableStatusValidator,
  },
  handler: (ctx, args) => runConvex(transitionProgram(ctx, args)),
})

const attachRenditionProgram = Effect.fn('Deliverables.attachRendition')(function* (
  ctx: MutationCtx,
  args: {
    deliverableId: Id<'deliverables'>
    format: RenditionFormat
    documentId: Id<'documents'>
    inputManifest?: Array<Id<'documentVersions'>>
  }
) {
  const { user, profile } = yield* convexPromise(() => requireAuthAdmin(ctx))

  const deliverable = yield* convexPromise(() => ctx.db.get(args.deliverableId))
  if (!deliverable) return yield* Effect.fail(notFound('deliverable', `${args.deliverableId}`))

  const document = yield* convexPromise(() => ctx.db.get(args.documentId))
  if (!document) return yield* Effect.fail(notFound('document', `${args.documentId}`))
  if (document.companyId !== deliverable.companyId) {
    return yield* Effect.fail(
      unauthorized('El documento pertenece a otra empresa; la rendition no puede cruzar.')
    )
  }

  const inputManifest = args.inputManifest ? Array.from(new Set(args.inputManifest)) : undefined
  if (inputManifest && inputManifest.length > 20) {
    return yield* Effect.fail(
      validationFailed('El manifiesto de fuentes excede el límite permitido.', 'inputManifest')
    )
  }
  for (const versionId of inputManifest ?? []) {
    const source = yield* resolveCitableSource(ctx, versionId, deliverable.companyId)
    if (!source) {
      return yield* Effect.fail(
        unauthorized('Una versión fuente no está autorizada para este entregable.')
      )
    }
  }

  const renditions = [
    ...(deliverable.renditions ?? []).filter((r) => r.format !== args.format),
    { format: args.format, documentId: args.documentId },
  ]

  yield* convexPromise(() =>
    ctx.db.patch(deliverable._id, {
      renditions,
      producedBy: deliverable.producedBy ?? 'TEAM',
      ...(inputManifest ? { inputManifest } : {}),
      updatedAt: Date.now(),
    })
  )

  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: user.email,
      action: 'DELIVERABLE_RENDITION_ATTACH',
      targetType: 'DELIVERABLE',
      targetId: `${deliverable._id}`,
      newValue: {
        format: args.format,
        documentId: `${args.documentId}`,
        sourceVersionCount: inputManifest?.length ?? 0,
      },
    })
  )

  return { deliverableId: deliverable._id, renditionCount: renditions.length }
})

/**
 * Adjunta (o reemplaza) una rendition del entregable apuntando a un documento
 * en custodia. Integridad cross-empresa en la frontera: el documento debe
 * pertenecer a la MISMA empresa del slot — un admin no puede colgar el CIM de
 * una empresa en el slot de otra ni por error.
 */
export const attachRendition = mutation({
  args: {
    deliverableId: v.id('deliverables'),
    format: deliverableRenditionFormatValidator,
    documentId: v.id('documents'),
    // GIGO auditable: versiones exactas de los insumos usados. Se fija al
    // adjuntar la primera rendition del ciclo y se reemplaza completo (nunca
    // se edita in-place: es evidencia, no estado de trabajo).
    inputManifest: v.optional(v.array(v.id('documentVersions'))),
  },
  handler: (ctx, args) => runConvex(attachRenditionProgram(ctx, args)),
})

const markDocumentAsDeliveryProgram = Effect.fn('Deliverables.markDocumentAsDelivery')(function* (
  ctx: MutationCtx,
  args: { documentId: Id<'documents'>; kind: DeliverableKind; note: string }
) {
  const { user, profile } = yield* convexPromise(() => requireAuthAdmin(ctx))

  const note = yield* convexSync(() => normalizeDeliveryNote(args.note))

  const document = yield* convexPromise(() => ctx.db.get(args.documentId))
  if (!document) return yield* Effect.fail(notFound('document', `${args.documentId}`))
  const company = yield* convexPromise(() => ctx.db.get(document.companyId))
  if (!company) return yield* Effect.fail(notFound('company', `${document.companyId}`))

  // La misma puerta que `transition` exige para aprobar o entregar: sin una
  // versión publicada y verificada el slot prometería un archivo que el
  // cliente no puede abrir.
  const version = yield* convexPromise(() => loadDeliverablePublishedVersion(ctx, document))
  if (!version) {
    return yield* Effect.fail(
      invalidState(
        'El documento no tiene una versión publicada que el cliente pueda abrir.',
        document.lifecycleStatus
      )
    )
  }

  const format = renditionFormatForMimeType(version.detectedMimeType || version.declaredMimeType)
  if (!format) {
    return yield* Effect.fail(
      validationFailed(
        `Este documento no tiene rendition (${DELIVERABLE_RENDITION_FORMATS.join(', ')}): ` +
          `el slot ${args.kind} no puede entregarse.`,
        'documentId'
      )
    )
  }

  // Acotado por diseño (un slot por kind): los ≤ 8 del cliente entran en una
  // lectura, y de ahí sale el slot del kind pedido.
  const slots = yield* convexPromise(() =>
    ctx.db
      .query('deliverables')
      .withIndex('by_companyId', (q) => q.eq('companyId', document.companyId))
      .collect()
  )
  const slot = slots.find((row) => row.kind === args.kind)
  const citesThisDocument = (row: Doc<'deliverables'>): boolean =>
    (row.renditions ?? []).some((rendition) => rendition.documentId === document._id)
  const isSealed = version.deliveryNote !== undefined

  // Idempotencia por (KIND, VERSIÓN), no por documento: un segundo clic sobre
  // el mismo slot y la misma versión no vuelve a mover el rail ni a escribir
  // auditoría (la campanita ya deduplica por `entityId`), pero una v2 del
  // mismo documento sí reabre el ciclo y se entrega de nuevo.
  if (slot && slot.status === 'DELIVERED' && citesThisDocument(slot) && isSealed) {
    return { deliverableId: slot._id, status: slot.status, delivered: false as const }
  }

  // El corte es por DOCUMENTO, no por versión (el porqué vive junto a
  // `assertNotDeliveredAsOtherKind`): corre ANTES de pisar la nota, y es el
  // mismo corte que aplican el push y el sello del operador.
  yield* convexPromise(() =>
    assertNotDeliveredAsOtherKind(ctx, {
      companyId: document.companyId,
      kind: args.kind,
      documentId: document._id,
    })
  )

  const now = Date.now()
  // El sello viaja en la VERSIÓN, igual que en el push: es lo que el cliente
  // ve junto al número de versión y lo que hace idempotente un segundo clic.
  yield* convexPromise(() => ctx.db.patch(version._id, { deliveryNote: note }))
  // La procedencia es un campo: lo que se marca como entrega lo devolvió el equipo.
  if (document.sourceType !== 'TEAM_DELIVERABLE') {
    yield* convexPromise(() => ctx.db.patch(document._id, { sourceType: 'TEAM_DELIVERABLE' }))
  }

  const advanced = yield* convexPromise(() =>
    advanceDeliverableSlot(ctx, {
      companyId: document.companyId,
      kind: args.kind,
      documentId: document._id,
      format,
      actor: { profileId: profile._id, email: user.email },
      now,
      auditActor: 'admin-preparation',
      auditNotes: 'el equipo marcó un documento de la sala como entrega',
    })
  )

  yield* convexPromise(() =>
    notifyDeliverablePublished(ctx, {
      company,
      documentId: document._id,
      versionId: version._id,
      name: document.name,
      label: version.deliveryLabel,
      note,
    })
  )

  return { deliverableId: advanced.deliverableId, status: advanced.to, delivered: true as const }
})

/**
 * Marca un documento que YA está en la sala como la entrega de un slot.
 *
 * El camino manual del equipo (bajar el zip, correr Mycroft, subir el archivo
 * por «Subir documento») dejaba el rail en «Entregas 0» y al cliente sin aviso:
 * la entrega sólo existía por `bun run vdr:push --slot`. Esto la produce desde
 * la UI y por el MISMO camino — `advanceDeliverableSlot` +
 * `notifyDeliverablePublished` — para que el cliente reciba exactamente lo
 * mismo: campanita genérica, sin la nota ni el nombre, y correo genérico.
 */
export const markDocumentAsDelivery = mutation({
  args: {
    documentId: v.id('documents'),
    kind: deliverableKindValidator,
    // La nota es el texto que el cliente lee en la campanita y, a la vez, el
    // sello que prueba que ESTA versión ya salió. Por eso no es opcional.
    note: v.string(),
  },
  handler: (ctx, args) => runConvex(markDocumentAsDeliveryProgram(ctx, args)),
})

const projectDeliverableRow = Effect.fn('Deliverables.projectRow')(function* (
  ctx: QueryCtx,
  row: Doc<'deliverables'>,
  companyId: Id<'companies'>
) {
  const resolvedSources = yield* Effect.forEach(
    (row.inputManifest ?? []).slice(0, 20),
    (versionId) => resolveCitableSource(ctx, versionId, companyId),
    { concurrency: 'unbounded' }
  )
  const sources = resolvedSources
    .filter((source) => source !== null)
    .map((source) => ({
      documentId: source.document._id,
      name: source.document.name,
      versionNumber: source.version.versionNumber,
    }))

  const resolvedRenditions = yield* Effect.forEach(
    row.renditions ?? [],
    Effect.fn('Deliverables.projectRendition')(function* (rendition: {
      format: RenditionFormat
      documentId: Id<'documents'>
    }) {
      const document = yield* convexPromise(() => ctx.db.get(rendition.documentId))
      if (!document || document.companyId !== companyId) return null
      // versionId viaja en la proyección para el deep-link de Entregado.
      // Sin versión publicada la rendition no es usable y se omite.
      const version = yield* convexPromise(() => loadDeliverablePublishedVersion(ctx, document))
      if (!version) return null
      return {
        format: rendition.format,
        documentId: rendition.documentId,
        versionId: version._id,
      }
    }),
    { concurrency: 'unbounded' }
  )
  const renditions = resolvedRenditions.filter((rendition) => rendition !== null)

  // La nota del equipo viaja en la versión del documento que el slot
  // cita (la última rendition usable es la entrega vigente): el rail del
  // cliente la muestra bajo la etapa sin abrir la sala. Solo un slot
  // entregado la lleva, así que son ≤ 8 lecturas extra por empresa.
  const delivered = row.status === 'DELIVERED' ? renditions[renditions.length - 1] : undefined
  const deliveredDocument = delivered
    ? yield* convexPromise(() => ctx.db.get(delivered.documentId))
    : null
  const deliveredVersion = deliveredDocument
    ? yield* convexPromise(() => loadDeliverablePublishedVersion(ctx, deliveredDocument))
    : null

  return {
    deliverableId: row._id,
    kind: row.kind,
    status: row.status,
    producedBy: row.producedBy ?? null,
    renditions,
    sources,
    sourcesTruncated: (row.inputManifest?.length ?? 0) > 20,
    deliveryNote: deliveredVersion?.deliveryNote ?? null,
    approvedAt: row.approvedAt ?? null,
    deliveredAt: row.deliveredAt ?? null,
    updatedAt: row.updatedAt,
  }
})

const listForCompanyProgram = Effect.fn('Deliverables.listForCompany')(function* (
  ctx: QueryCtx,
  args: { companyId?: Id<'companies'> }
) {
  const { profile } = yield* convexPromise(() => requireAuth(ctx))

  let companyId
  if (profile.role === 'ADMIN') {
    if (!args.companyId) {
      return yield* Effect.fail(
        validationFailed('Un admin debe indicar la empresa a listar.', 'companyId')
      )
    }
    companyId = args.companyId
  } else {
    const { company } = yield* convexPromise(() => requireAuthenticatedCompany(ctx))
    if (args.companyId && args.companyId !== company._id) {
      return yield* Effect.fail(
        unauthorized('Solo puedes ver los entregables de tu propia empresa.')
      )
    }
    companyId = company._id
  }

  // Acotado por diseño: máximo un slot por kind — la colección completa de
  // una empresa son ≤ 8 filas.
  const rows = yield* convexPromise(() =>
    ctx.db
      .query('deliverables')
      .withIndex('by_companyId', (q) => q.eq('companyId', companyId))
      .collect()
  )

  const projectedRows = yield* Effect.forEach(
    rows,
    (row) => projectDeliverableRow(ctx, row, companyId),
    { concurrency: 'unbounded' }
  )

  return projectedRows.sort(
    (a, b) => DELIVERABLE_KINDS.indexOf(a.kind) - DELIVERABLE_KINDS.indexOf(b.kind)
  )
})

/**
 * Lista los entregables de una empresa en el orden canónico de la suite.
 * Reactiva: el workspace del cliente ve el status cambiar en tiempo real.
 * La empresa solo ve los suyos; un admin nombra la empresa.
 */
export const listForCompany = query({
  args: {
    companyId: v.optional(v.id('companies')),
  },
  handler: (ctx, args) => runConvex(listForCompanyProgram(ctx, args)),
})
