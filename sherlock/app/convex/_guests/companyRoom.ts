import { Effect, Schema } from 'effect'

import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { AuthResult } from '../_helpers/auth'
import { requireCompanyOwnerOrAdmin } from '../_documents/shared'
import { loadDeliverablePublishedVersion } from '../_documents/deliverableVersion'
import { inferDocumentClassification } from '../_documents/policy'
import { convexPromise, convexSync, runConvex } from '../_helpers/effect'
import { invalidState, unauthorized, validationFailed } from '../_helpers/errors'
import { requireAdminVdrCapability, sha256Hex } from '../_adminVdr/capability'
import { adminVdrTarget } from '../_adminVdr/capabilityFormat'
import {
  createOpaqueGuestSecret,
  hashGuestEmail,
  hashInvitationHandle,
  maskGuestEmail,
  normalizeGuestEmail,
} from './crypto'
import { guestPrincipalKey } from './service'
import { resolveGuestSessionRecordEffect } from './sessions'
import type { GuestRoomProjection } from './projection'

const MAX_DOCUMENTS = 50
const denied = () => unauthorized('No tienes permiso para abrir este documento.')

// Las cuatro clasificaciones que un invitado puede llegar a ver. KYC_SENSITIVE
// no está y no puede estar: el tipo es la lista, y la lista es el tipo.
type GuestVisibleClassification = 'PUBLIC_TEASER' | 'CONFIDENTIAL' | 'RESTRICTED' | 'LEGAL'

export type GuestSafeDocument = {
  viewPath?: string
  name: string
  fileType?: string
  fileSize?: number
  folder: string
  classification: GuestVisibleClassification
  downloadable: false
}

// El idioma del NDA de una sala de empresa. Una definición para la plantilla,
// la invitación y el nombre que firma el invitado.
// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
type CompanyGuestLocale = 'es' | 'en'

// Un nombre de firmante aceptable: entre 2 y 150 caracteres ya recortados.
const SignatoryName = Schema.String.pipe(Schema.check(Schema.isLengthBetween(2, 150)))
const isSignatoryName = Schema.is(SignatoryName)

export async function requireCompanyGuestManager(
  ctx: QueryCtx | MutationCtx,
  actor: AuthResult,
  companyId: Id<'companies'>
) {
  const company = await ctx.db.get(companyId)
  if (!company) throw unauthorized('No tienes permiso para administrar invitados de esta sala.')
  await requireCompanyOwnerOrAdmin(
    ctx,
    actor,
    company,
    'No tienes permiso para administrar invitados de esta sala.'
  )
  return company
}

/**
 * Una plantilla solo vale si su contenido todavía hasea a lo que se aprobó y si
 * quien la aprobó es ADMIN. Un contenido editado por fuera deja de coincidir y
 * la sala se cierra sola.
 */
const validTemplate = Effect.fn('CompanyGuestRoom.validTemplate')(function* (
  ctx: QueryCtx | MutationCtx,
  template: Doc<'guestNdaTemplates'> | null,
  companyId: Id<'companies'>
) {
  if (
    !template ||
    !template.active ||
    template.companyId !== companyId ||
    !template.content.trim()
  ) {
    return null
  }
  const contentHash = yield* convexPromise(() => sha256Hex(template.content))
  if (contentHash !== template.contentHash) return null
  const approver = yield* convexPromise(() => ctx.db.get(template.approvedByProfileId))
  return approver?.role === 'ADMIN' ? template : null
})

const findCompanyGuestNdaTemplateEffect = Effect.fn('CompanyGuestRoom.findNdaTemplate')(function* (
  ctx: QueryCtx | MutationCtx,
  companyId: Id<'companies'>,
  locale: CompanyGuestLocale
) {
  const templates = yield* convexPromise(() =>
    ctx.db
      .query('guestNdaTemplates')
      .withIndex('by_company_locale_active', (q) =>
        q.eq('companyId', companyId).eq('locale', locale).eq('active', true)
      )
      .take(2)
  )
  if (templates.length !== 1) return null
  return yield* validTemplate(ctx, templates[0], companyId)
})

export function findCompanyGuestNdaTemplate(
  ctx: QueryCtx | MutationCtx,
  companyId: Id<'companies'>,
  locale: CompanyGuestLocale
): Promise<Doc<'guestNdaTemplates'> | null> {
  return runConvex(findCompanyGuestNdaTemplateEffect(ctx, companyId, locale))
}

const selectedPublishedDocument = Effect.fn('CompanyGuestRoom.selectedPublishedDocument')(
  function* (
    ctx: QueryCtx | MutationCtx,
    companyId: Id<'companies'>,
    documentId: Id<'documents'>,
    now: number,
    versionId?: Id<'documentVersions'>
  ) {
    const document = yield* convexPromise(() => ctx.db.get(documentId))
    if (
      !document ||
      document.companyId !== companyId ||
      document.accessLevel === 'PRIVATE'
    ) {
      return null
    }
    const classification = inferDocumentClassification(
      document.accessLevel,
      document.classification
    )
    if (classification === 'KYC_SENSITIVE') return null
    const version = yield* convexPromise(() => loadDeliverablePublishedVersion(ctx, document, now))
    if (!version || (versionId !== undefined && version._id !== versionId)) return null
    return { document, version, classification }
  }
)

const createCompanyGuestInvitationEffect = Effect.fn('CompanyGuestRoom.createInvitation')(
  function* (
    ctx: MutationCtx,
    input: {
      companyId: Id<'companies'>
      documentIds: Id<'documents'>[]
      email: string
      expiresInDays: number
      locale: CompanyGuestLocale
      actor: AuthResult
      adminCapability?: string
      now: number
    }
  ) {
    const now = input.now
    const company = yield* convexPromise(() =>
      requireCompanyGuestManager(ctx, input.actor, input.companyId)
    )
    const { actor: _actor, now: _now, adminCapability, ...capabilityInput } = input
    yield* convexPromise(() =>
      requireAdminVdrCapability({
        ctx,
        auth: input.actor,
        company,
        capability: adminCapability,
        action: 'GUEST_INVITE',
        target: adminVdrTarget('COMPANY', company._id),
        input: capabilityInput,
      })
    )
    if (
      !Number.isInteger(input.expiresInDays) ||
      input.expiresInDays < 1 ||
      input.expiresInDays > 30
    ) {
      return yield* Effect.fail(
        validationFailed('La invitación debe durar entre 1 y 30 días.', 'expiresInDays')
      )
    }
    const ids = [...new Set(input.documentIds)]
    if (!ids.length || ids.length > MAX_DOCUMENTS) {
      return yield* Effect.fail(
        validationFailed('Selecciona entre 1 y 50 documentos.', 'documentIds')
      )
    }
    // Lecturas puras y en paralelo, como el `Promise.all` que había: la
    // selección de documentos no puede volverse serial por la conversión.
    const entries = yield* Effect.forEach(
      ids,
      (id) => selectedPublishedDocument(ctx, company._id, id, now),
      { concurrency: 'unbounded' }
    )
    if (entries.some((entry) => entry === null)) {
      return yield* Effect.fail(
        validationFailed('Selecciona documentos publicados de esta sala.', 'documentIds')
      )
    }
    const template = yield* findCompanyGuestNdaTemplateEffect(ctx, company._id, input.locale)
    if (!template) {
      return yield* Effect.fail(
        invalidState(
          'El equipo debe configurar el NDA aprobado para esta empresa e idioma antes de invitar.',
          'GUEST_NDA_TEMPLATE_REQUIRED'
        )
      )
    }
    const email = yield* convexSync(() => normalizeGuestEmail(input.email))
    const emailHash = yield* convexPromise(() => hashGuestEmail(email))
    const previous = yield* convexPromise(() =>
      ctx.db
        .query('guestInvitations')
        .withIndex('by_company_emailHash', (q) =>
          q.eq('companyId', company._id).eq('emailHash', emailHash)
        )
        .filter((q) =>
          q.and(
            q.neq(q.field('companyRoom'), undefined),
            q.or(q.eq(q.field('status'), 'PENDING'), q.eq(q.field('status'), 'VERIFIED')),
            q.gt(q.field('expiresAt'), now)
          )
        )
        .take(1)
    )
    if (previous.length) {
      return yield* Effect.fail(
        invalidState(
          'Ya existe una invitación vigente para este destinatario.',
          'ACTIVE_INVITATION'
        )
      )
    }
    const guestId = createOpaqueGuestSecret()
    const invitationHandle = createOpaqueGuestSecret()
    const invitationHandleHash = yield* convexPromise(() => hashInvitationHandle(invitationHandle))
    const invitationId = yield* convexPromise(() =>
      ctx.db.insert('guestInvitations', {
        companyId: company._id,
        companyRoom: {
          documents: entries.flatMap((entry) =>
            entry ? [{ documentId: entry.document._id, versionId: entry.version._id }] : []
          ),
          ndaTemplateId: template._id,
        },
        guestId,
        principalKey: guestPrincipalKey(guestId),
        emailHash,
        emailMasked: maskGuestEmail(email),
        invitationHandleHash,
        status: 'PENDING',
        createdAt: now,
        createdByProfileId: input.actor.profile._id,
        expiresAt: now + input.expiresInDays * 86_400_000,
        locale: input.locale,
      })
    )
    yield* convexPromise(() =>
      ctx.db.insert('activityLogs', {
        userId: input.actor.profile._id,
        action: 'GUEST_INVITATION_CREATED',
        entityType: 'GUEST_INVITATION',
        entityId: invitationId,
        metadata: {
          resourceType: 'COMPANY',
          resourceId: company._id,
          details: { documentCount: ids.length, ndaTemplateId: template._id },
        },
      })
    )
    const invitation = yield* convexPromise(() => ctx.db.get(invitationId))
    if (!invitation) {
      return yield* Effect.fail(
        invalidState('No se pudo crear la invitación.', 'INVITATION_MISSING')
      )
    }
    return { invitation, invitationHandle }
  }
)

export function createCompanyGuestInvitation(
  ctx: MutationCtx,
  input: {
    companyId: Id<'companies'>
    documentIds: Id<'documents'>[]
    email: string
    expiresInDays: number
    locale: CompanyGuestLocale
    actor: AuthResult
    adminCapability?: string
    now?: number
  }
): Promise<{ invitation: Doc<'guestInvitations'>; invitationHandle: string }> {
  return runConvex(
    createCompanyGuestInvitationEffect(ctx, { ...input, now: input.now ?? Date.now() })
  )
}

const companyGuestSession = Effect.fn('CompanyGuestRoom.session')(function* (
  ctx: MutationCtx,
  input: { sessionToken: string; now: number }
) {
  const now = input.now
  const session = yield* resolveGuestSessionRecordEffect(ctx, input)
  if (!session.authenticated) return null
  const invitation = yield* convexPromise(() => ctx.db.get(session.guestInvitationId))
  if (!invitation?.companyRoom) return null
  const company = yield* convexPromise(() => ctx.db.get(invitation.companyId))
  if (!company) return null
  const ndaTemplateId = invitation.companyRoom.ndaTemplateId
  const template = yield* validTemplate(
    ctx,
    yield* convexPromise(() => ctx.db.get(ndaTemplateId)),
    invitation.companyId
  )
  if (!template || template.locale !== invitation.locale) return null
  return { session, invitation, template, now }
})

const getCompanyGuestNdaEffect = Effect.fn('CompanyGuestRoom.getNda')(function* (
  ctx: MutationCtx,
  input: { sessionToken: string; now: number }
) {
  const evidence = yield* companyGuestSession(ctx, input)
  if (!evidence) return null
  const { template } = evidence
  return {
    title: template.title,
    content: template.content,
    contentHash: template.contentHash,
    version: template.version,
    locale: template.locale,
  }
})

export function getCompanyGuestNda(
  ctx: MutationCtx,
  input: { sessionToken: string; now?: number }
) {
  return runConvex(
    getCompanyGuestNdaEffect(ctx, {
      sessionToken: input.sessionToken,
      now: input.now ?? Date.now(),
    })
  )
}

const acceptCompanyGuestNdaEffect = Effect.fn('CompanyGuestRoom.acceptNda')(function* (
  ctx: MutationCtx,
  input: { sessionToken: string; contentHash: string; signatoryName: string; now: number }
) {
  const evidence = yield* companyGuestSession(ctx, input)
  const name = input.signatoryName.trim()
  if (!evidence || input.contentHash !== evidence.template.contentHash || !isSignatoryName(name)) {
    return yield* Effect.fail(denied())
  }
  const { invitation, template, now } = evidence
  const previous = yield* convexPromise(() =>
    ctx.db
      .query('guestNdaAcceptances')
      .withIndex('by_invitation', (q) => q.eq('guestInvitationId', invitation._id))
      .unique()
  )
  if (previous) {
    if (
      previous.contentHash !== template.contentHash ||
      previous.templateId !== template._id ||
      previous.guestId !== invitation.guestId ||
      previous.companyId !== invitation.companyId
    ) {
      return yield* Effect.fail(denied())
    }
    return { accepted: true as const }
  }
  yield* convexPromise(() =>
    ctx.db.insert('guestNdaAcceptances', {
      guestInvitationId: invitation._id,
      guestId: invitation.guestId,
      companyId: invitation.companyId,
      templateId: template._id,
      contentHash: template.contentHash,
      content: template.content,
      signatoryName: name,
      acceptedAt: now,
    })
  )
  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      action: 'GUEST_NDA_ACCEPTED',
      entityType: 'GUEST_INVITATION',
      entityId: invitation._id,
      metadata: {
        resourceType: 'COMPANY',
        resourceId: invitation.companyId,
        details: { contentHash: template.contentHash, templateId: template._id },
      },
    })
  )
  return { accepted: true as const }
})

export function acceptCompanyGuestNda(
  ctx: MutationCtx,
  input: { sessionToken: string; contentHash: string; signatoryName: string; now?: number }
): Promise<{ accepted: true }> {
  return runConvex(acceptCompanyGuestNdaEffect(ctx, { ...input, now: input.now ?? Date.now() }))
}

/**
 * La sala de empresa se abre solo cuando la aceptación persistida coincide con
 * la plantilla vigente CAMPO POR CAMPO. Un NDA reeditado invalida la aceptación
 * vieja en vez de heredarle el acceso.
 */
const companyGuestAccess = Effect.fn('CompanyGuestRoom.access')(function* (
  ctx: MutationCtx,
  input: { sessionToken: string; now: number }
) {
  const evidence = yield* companyGuestSession(ctx, input)
  if (!evidence) return null
  const acceptance = yield* convexPromise(() =>
    ctx.db
      .query('guestNdaAcceptances')
      .withIndex('by_invitation', (q) => q.eq('guestInvitationId', evidence.invitation._id))
      .unique()
  )
  if (
    !acceptance ||
    acceptance.guestId !== evidence.invitation.guestId ||
    acceptance.companyId !== evidence.invitation.companyId ||
    acceptance.templateId !== evidence.template._id ||
    acceptance.contentHash !== evidence.template.contentHash ||
    acceptance.content !== evidence.template.content ||
    acceptance.acceptedAt > evidence.now
  ) {
    return null
  }
  return evidence
})

export const buildCompanyGuestRoomProjectionEffect = Effect.fn('CompanyGuestRoom.project')(
  function* (ctx: MutationCtx, input: { sessionToken: string; now: number }, expiresAt: number) {
    const evidence = yield* companyGuestAccess(ctx, input)
    if (!evidence) {
      return {
        authenticated: true,
        expiresAt,
        roomAccessGranted: false,
        requiredGates: ['NDA'],
      } satisfies GuestRoomProjection
    }
    const { invitation, now } = evidence
    const company = yield* convexPromise(() => ctx.db.get(invitation.companyId))
    if (!company || !invitation.companyRoom) {
      return { authenticated: false } satisfies GuestRoomProjection
    }
    const entries = yield* Effect.forEach(
      invitation.companyRoom.documents,
      (grant) =>
        selectedPublishedDocument(
          ctx,
          invitation.companyId,
          grant.documentId,
          now,
          grant.versionId
        ),
      { concurrency: 'unbounded' }
    )
    return {
      authenticated: true,
      expiresAt,
      roomAccessGranted: true,
      requiredGates: [],
      room: { title: company.name },
      documents: entries.flatMap((entry) =>
        entry
          ? [
              {
                viewPath:
                  entry.version.detectedMimeType === 'application/pdf' &&
                  entry.version.signatureKind === 'PDF'
                    ? `/api/vdr/guest/documents/${entry.document._id}`
                    : undefined,
                name: entry.document.name,
                fileType: entry.version.detectedMimeType,
                fileSize: entry.version.byteSize,
                folder: entry.document.folder || 'General',
                classification: entry.classification,
                downloadable: false as const,
              },
            ]
          : []
      ),
      documentsTruncated: false,
      downloadDeliveryAvailable: false,
    } satisfies GuestRoomProjection
  }
)

const resolveCompanyGuestDocumentEffect = Effect.fn('CompanyGuestRoom.resolveDocument')(function* (
  ctx: MutationCtx,
  input: { sessionToken: string; documentId: Id<'documents'>; now: number }
) {
  const evidence = yield* companyGuestAccess(ctx, input)
  if (!evidence) return yield* Effect.fail(denied())
  const grant = evidence.invitation.companyRoom?.documents.find(
    (candidate) => candidate.documentId === input.documentId
  )
  if (!grant) return yield* Effect.fail(denied())
  const entry = yield* selectedPublishedDocument(
    ctx,
    evidence.invitation.companyId,
    grant.documentId,
    evidence.now,
    grant.versionId
  )
  if (
    !entry ||
    entry.version.detectedMimeType !== 'application/pdf' ||
    entry.version.signatureKind !== 'PDF'
  ) {
    return yield* Effect.fail(denied())
  }
  return {
    documentId: entry.document._id,
    versionId: entry.version._id,
    storageId: entry.version.storageId,
    fileName: entry.document.name,
    invitationId: evidence.invitation._id,
    guestLabel: evidence.invitation.emailMasked,
    companyId: evidence.invitation.companyId,
  }
})

export function resolveCompanyGuestDocument(
  ctx: MutationCtx,
  input: { sessionToken: string; documentId: Id<'documents'>; now?: number }
) {
  return runConvex(
    resolveCompanyGuestDocumentEffect(ctx, { ...input, now: input.now ?? Date.now() })
  )
}
