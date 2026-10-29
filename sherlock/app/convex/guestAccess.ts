// ============================================================================
// GUEST ACCESS — el control de acceso de los invitados a una sala
// ============================================================================
// Nadie de este lado tiene cuenta: un invitado prueba un correo con un OTP,
// firma un NDA y recibe una sesión acotada. Todo lo que decide qué puede ver
// vive detrás de una guarda, y cada guarda de este archivo entra al canal de
// error de Effect por `convexSync`/`convexPromise`: un `AppError` es la
// respuesta que el invitado puede ver y cualquier otra excepción es un bug
// nuestro que muere como defecto, nunca como «acceso denegado» ni —peor— como
// acceso concedido.
//
// QUIÉN MANDA EN UNA INVITACIÓN: el manager de la empresa de la sala, y nadie
// más. La sala es una por empresa desde que el subsistema de transacciones
// salió del árbol ([F] 2026-09-17).
// ============================================================================

import { v, type Infer } from 'convex/values'
import { Effect } from 'effect'

import {
  createCompanyGuestInvitation,
  findCompanyGuestNdaTemplate,
  getCompanyGuestNda,
  acceptCompanyGuestNda,
  resolveCompanyGuestDocument,
  requireCompanyGuestManager,
} from './_guests/companyRoom'
import type { Id } from './_generated/dataModel'

import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import { requireAuth } from './_helpers/auth'
import { logAdminAction } from './_helpers/auditLog'
import { convexPromise, runConvex } from './_helpers/effect'
import { invalidState, unauthorized, validationFailed } from './_helpers/errors'
import { enforceRateLimit } from './_helpers/rateLimit'
import { getGuestAccessCapabilities } from './_guests/capabilities'
import { enqueueGuestInvitationDelivery, requestGuestOtpDelivery } from './_guests/delivery'
import { revokeGuestInvitationRecord } from './_guests/service'
import {
  resolveGuestSessionRecord,
  revokeGuestSessionRecord,
  rotateGuestSessionRecord,
  verifyGuestOtpAndCreateSession,
} from './_guests/sessions'
import { buildGuestRoomProjection } from './_guests/projection'
import { requireVdrGuestServerProof } from './_guests/serverProof'
import {
  sha256Hex,
  adminVdrCapabilityValidator,
  requireAdminVdrCapability,
  withoutAdminVdrCapability,
} from './_adminVdr/capability'
import { adminVdrTarget } from './_adminVdr/capabilityFormat'

const DAY_MS = 24 * 60 * 60 * 1000
const GUEST_ROSTER_PAGE_LIMIT = 100
const GUEST_INVITATION_ROSTER_STATUSES = ['PENDING', 'VERIFIED', 'REVOKED', 'EXPIRED'] as const

const guestLocaleValidator = v.union(v.literal('es'), v.literal('en'))

// El sobre firmado que envuelve toda llamada del invitado: la ruta de Sherlock
// prueba que el pedido salió de ella con estos argumentos exactos.
const serverProofArgs = {
  serverIssuedAt: v.number(),
  serverProof: v.string(),
} as const

type ServerProofArgs = { serverIssuedAt: number; serverProof: string }
type AdminCapability = Infer<typeof adminVdrCapabilityValidator>


const requestOtpChallengeProgram = Effect.fn('GuestAccess.requestOtpChallenge')(function* (
  ctx: MutationCtx,
  args: ServerProofArgs & { invitationHandle: string; email: string }
) {
  yield* convexPromise(() =>
    requireVdrGuestServerProof({
      operation: 'REQUEST_OTP',
      issuedAt: args.serverIssuedAt,
      proof: args.serverProof,
      bindingParts: [args.invitationHandle, args.email],
    })
  )
  return yield* convexPromise(() => requestGuestOtpDelivery(ctx, args))
})

/**
 * Prepara y encola el OTP de forma transaccional. La respuesta conserva la
 * misma forma para invitaciones válidas, desconocidas, vencidas o en
 * enfriamiento; nunca contiene el email, el código ni un token que el
 * navegador ya tuviera.
 */
export const requestOtpChallenge = mutation({
  args: {
    invitationHandle: v.string(),
    email: v.string(),
    ...serverProofArgs,
  },
  handler: (ctx, args) => runConvex(requestOtpChallengeProgram(ctx, args)),
})

const verifyOtpAndCreateSessionProgram = Effect.fn('GuestAccess.verifyOtpAndCreateSession')(
  function* (
    ctx: MutationCtx,
    args: ServerProofArgs & { invitationHandle: string; challengeToken: string; code: string }
  ) {
    yield* convexPromise(() =>
      requireVdrGuestServerProof({
        operation: 'VERIFY_OTP',
        issuedAt: args.serverIssuedAt,
        proof: args.serverProof,
        bindingParts: [args.invitationHandle, args.challengeToken, args.code],
      })
    )
    return yield* convexPromise(() => verifyGuestOtpAndCreateSession(ctx, args))
  }
)

export const verifyOtpAndCreateSession = mutation({
  args: {
    invitationHandle: v.string(),
    challengeToken: v.string(),
    code: v.string(),
    ...serverProofArgs,
  },
  handler: (ctx, args) => runConvex(verifyOtpAndCreateSessionProgram(ctx, args)),
})

const resolveGuestSessionProgram = Effect.fn('GuestAccess.resolveGuestSession')(function* (
  ctx: MutationCtx,
  args: ServerProofArgs & { sessionToken: string }
) {
  yield* convexPromise(() =>
    requireVdrGuestServerProof({
      operation: 'RESOLVE_SESSION',
      issuedAt: args.serverIssuedAt,
      proof: args.serverProof,
      bindingParts: [args.sessionToken],
    })
  )
  return yield* convexPromise(() => resolveGuestSessionRecord(ctx, args))
})

export const resolveGuestSession = mutation({
  args: {
    sessionToken: v.string(),
    ...serverProofArgs,
  },
  handler: (ctx, args) => runConvex(resolveGuestSessionProgram(ctx, args)),
})

const getGuestRoomProjectionProgram = Effect.fn('GuestAccess.getGuestRoomProjection')(function* (
  ctx: MutationCtx,
  args: ServerProofArgs & { sessionToken: string }
) {
  yield* convexPromise(() =>
    requireVdrGuestServerProof({
      operation: 'PROJECT_ROOM',
      issuedAt: args.serverIssuedAt,
      proof: args.serverProof,
      bindingParts: [args.sessionToken],
    })
  )
  return yield* convexPromise(() => buildGuestRoomProjection(ctx, args))
})

export const getGuestRoomProjection = mutation({
  args: {
    sessionToken: v.string(),
    ...serverProofArgs,
  },
  handler: (ctx, args) => runConvex(getGuestRoomProjectionProgram(ctx, args)),
})

const rotateGuestSessionProgram = Effect.fn('GuestAccess.rotateGuestSession')(function* (
  ctx: MutationCtx,
  args: ServerProofArgs & { sessionToken: string }
) {
  yield* convexPromise(() =>
    requireVdrGuestServerProof({
      operation: 'ROTATE_SESSION',
      issuedAt: args.serverIssuedAt,
      proof: args.serverProof,
      bindingParts: [args.sessionToken],
    })
  )
  return yield* convexPromise(() => rotateGuestSessionRecord(ctx, args))
})

export const rotateGuestSession = mutation({
  args: {
    sessionToken: v.string(),
    ...serverProofArgs,
  },
  handler: (ctx, args) => runConvex(rotateGuestSessionProgram(ctx, args)),
})

const revokeGuestSessionProgram = Effect.fn('GuestAccess.revokeGuestSession')(function* (
  ctx: MutationCtx,
  args: ServerProofArgs & { sessionToken: string }
) {
  yield* convexPromise(() =>
    requireVdrGuestServerProof({
      operation: 'REVOKE_SESSION',
      issuedAt: args.serverIssuedAt,
      proof: args.serverProof,
      bindingParts: [args.sessionToken],
    })
  )
  return yield* convexPromise(() => revokeGuestSessionRecord(ctx, args))
})

export const revokeGuestSession = mutation({
  args: {
    sessionToken: v.string(),
    ...serverProofArgs,
  },
  handler: (ctx, args) => runConvex(revokeGuestSessionProgram(ctx, args)),
})

const revokeProgram = Effect.fn('GuestAccess.revoke')(function* (
  ctx: MutationCtx,
  args: {
    invitationId: Id<'guestInvitations'>
    reason: string
    adminCapability?: AdminCapability
  }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const { user, profile } = auth
  const invitation = yield* convexPromise(() => ctx.db.get(args.invitationId))
  if (!invitation) {
    return yield* Effect.fail(
      unauthorized('No tienes permiso para administrar invitados de esta sala.')
    )
  }
  const company = yield* convexPromise(() =>
    requireCompanyGuestManager(ctx, auth, invitation.companyId)
  )
  yield* convexPromise(() =>
    requireAdminVdrCapability({
      ctx,
      auth,
      capability: args.adminCapability,
      company,
      action: 'GUEST_REVOKE',
      target: adminVdrTarget('GUEST_INVITATION', `${invitation._id}`),
      input: withoutAdminVdrCapability(args),
    })
  )
  const reason = args.reason.trim()
  if (reason.length < 5 || reason.length > 500) {
    return yield* Effect.fail(
      validationFailed('Explica brevemente por qué se revoca la invitación.', 'reason')
    )
  }
  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `guestRevoke:${profile._id}`,
      limit: 100,
      windowMs: 60 * 60 * 1000,
    })
  )
  const updated = yield* convexPromise(() =>
    revokeGuestInvitationRecord(ctx, {
      invitation,
      actorProfileId: profile._id,
      reason,
      now: Date.now(),
    })
  )
  if (profile.role === 'ADMIN') {
    yield* convexPromise(() =>
      logAdminAction({
        ctx,
        adminProfileId: profile._id,
        adminEmail: user.email,
        action: 'GUEST_INVITATION_REVOKE',
        targetType: 'GUEST_INVITATION',
        targetId: `${invitation._id}`,
        previousValue: { status: invitation.status },
        newValue: { status: updated.status, revokedAt: updated.revokedAt },
        notes: reason,
      })
    )
  }
  return { invitationId: updated._id, status: updated.status, revokedAt: updated.revokedAt }
})

export const revoke = mutation({
  args: {
    invitationId: v.id('guestInvitations'),
    reason: v.string(),
    adminCapability: adminVdrCapabilityValidator,
  },
  handler: (ctx, args) => runConvex(revokeProgram(ctx, args)),
})

const extendProgram = Effect.fn('GuestAccess.extend')(function* (
  ctx: MutationCtx,
  args: {
    invitationId: Id<'guestInvitations'>
    additionalDays: number
    adminCapability?: AdminCapability
  }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const { user, profile } = auth
  const invitation = yield* convexPromise(() => ctx.db.get(args.invitationId))
  if (!invitation) {
    return yield* Effect.fail(
      unauthorized('No tienes permiso para administrar invitados de esta sala.')
    )
  }
  const company = yield* convexPromise(() =>
    requireCompanyGuestManager(ctx, auth, invitation.companyId)
  )
  yield* convexPromise(() =>
    requireAdminVdrCapability({
      ctx,
      auth,
      capability: args.adminCapability,
      company,
      action: 'GUEST_EXTEND',
      target: adminVdrTarget('GUEST_INVITATION', `${invitation._id}`),
      input: withoutAdminVdrCapability(args),
    })
  )
  if (invitation.status !== 'PENDING' && invitation.status !== 'VERIFIED') {
    return yield* Effect.fail(
      invalidState('Esta invitación ya no se puede extender.', invitation.status)
    )
  }
  if (
    !Number.isInteger(args.additionalDays) ||
    args.additionalDays < 1 ||
    args.additionalDays > 30
  ) {
    return yield* Effect.fail(
      validationFailed('La extensión debe ser de 1 a 30 días.', 'additionalDays')
    )
  }
  const now = Date.now()
  const expiresAt = Math.max(now, invitation.expiresAt) + args.additionalDays * DAY_MS
  if (expiresAt > now + 90 * DAY_MS) {
    return yield* Effect.fail(
      validationFailed('La vigencia total no puede exceder 90 días.', 'additionalDays')
    )
  }
  yield* convexPromise(() =>
    ctx.db.patch(invitation._id, {
      expiresAt,
      extendedAt: now,
      extendedByProfileId: profile._id,
    })
  )
  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      userId: profile._id,
      action: 'GUEST_INVITATION_EXTENDED',
      entityType: 'GUEST_INVITATION',
      entityId: `${invitation._id}`,
      metadata: {
        resourceType: 'COMPANY',
        resourceId: `${invitation.companyId}`,
        details: { guestId: invitation.guestId, expiresAt },
      },
    })
  )
  if (profile.role === 'ADMIN') {
    yield* convexPromise(() =>
      logAdminAction({
        ctx,
        adminProfileId: profile._id,
        adminEmail: user.email,
        action: 'GUEST_INVITATION_EXTEND',
        targetType: 'GUEST_INVITATION',
        targetId: `${invitation._id}`,
        previousValue: { expiresAt: invitation.expiresAt },
        newValue: { expiresAt },
      })
    )
  }
  return { invitationId: invitation._id, status: invitation.status, expiresAt }
})

export const extend = mutation({
  args: {
    invitationId: v.id('guestInvitations'),
    additionalDays: v.number(),
    adminCapability: adminVdrCapabilityValidator,
  },
  handler: (ctx, args) => runConvex(extendProgram(ctx, args)),
})



const inviteToCompanyProgram = Effect.fn('GuestAccess.inviteToCompany')(function* (
  ctx: MutationCtx,
  args: {
    companyId: Id<'companies'>
    documentIds: Array<Id<'documents'>>
    email: string
    expiresInDays: number
    locale: 'es' | 'en'
    adminCapability?: AdminCapability
  }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  yield* convexPromise(() => requireCompanyGuestManager(ctx, auth, args.companyId))
  if (!getGuestAccessCapabilities().canInvite) {
    return yield* Effect.fail(
      invalidState(
        'La invitación externa no está disponible temporalmente.',
        'GUEST_INVITATION_JOURNEY_UNAVAILABLE'
      )
    )
  }
  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `guestInvite:${auth.profile._id}`,
      limit: 50,
      windowMs: 3600000,
    })
  )
  const created = yield* convexPromise(() =>
    createCompanyGuestInvitation(ctx, { ...args, actor: auth })
  )
  yield* convexPromise(() =>
    enqueueGuestInvitationDelivery(ctx, {
      email: args.email,
      invitationHandle: created.invitationHandle,
      locale: args.locale,
    })
  )
  if (auth.profile.role === 'ADMIN') {
    yield* convexPromise(() =>
      logAdminAction({
        ctx,
        adminProfileId: auth.profile._id,
        adminEmail: auth.user.email,
        action: 'GUEST_INVITATION_CREATE',
        targetType: 'GUEST_INVITATION',
        targetId: created.invitation._id,
        newValue: { companyId: args.companyId, documentCount: args.documentIds.length },
      })
    )
  }
  return {
    invitationId: created.invitation._id,
    maskedEmail: created.invitation.emailMasked,
    expiresAt: created.invitation.expiresAt,
    status: created.invitation.status,
  }
})

export const inviteToCompany = mutation({
  args: {
    companyId: v.id('companies'),
    documentIds: v.array(v.id('documents')),
    email: v.string(),
    expiresInDays: v.number(),
    locale: guestLocaleValidator,
    adminCapability: adminVdrCapabilityValidator,
  },
  handler: (ctx, args) => runConvex(inviteToCompanyProgram(ctx, args)),
})

const listForCompanyProgram = Effect.fn('GuestAccess.listForCompany')(function* (
  ctx: QueryCtx,
  args: { companyId: Id<'companies'>; locale: 'es' | 'en' }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  yield* convexPromise(() => requireCompanyGuestManager(ctx, auth, args.companyId))
  const lanes = yield* Effect.forEach(
    GUEST_INVITATION_ROSTER_STATUSES,
    (status) =>
      convexPromise(() =>
        ctx.db
          .query('guestInvitations')
          .withIndex('by_company_status', (q) =>
            q.eq('companyId', args.companyId).eq('status', status)
          )
          .filter((q) => q.neq(q.field('companyRoom'), undefined))
          .order('desc')
          .take(GUEST_ROSTER_PAGE_LIMIT + 1)
      ),
    { concurrency: 'unbounded' }
  )
  const template = yield* convexPromise(() =>
    findCompanyGuestNdaTemplate(ctx, args.companyId, args.locale)
  )
  return {
    ndaConfigured: Boolean(template),
    capabilities: getGuestAccessCapabilities(),
    hasMore: lanes.some((lane) => lane.length > GUEST_ROSTER_PAGE_LIMIT),
    invitations: lanes
      .flatMap((lane) => lane.slice(0, GUEST_ROSTER_PAGE_LIMIT))
      .map((invitation) => ({
        invitationId: invitation._id,
        maskedEmail: invitation.emailMasked,
        status:
          invitation.expiresAt <= Date.now() && invitation.status !== 'REVOKED'
            ? 'EXPIRED'
            : invitation.status,
        expiresAt: invitation.expiresAt,
        documentCount: invitation.companyRoom?.documents.length ?? 0,
      })),
  }
})

export const listForCompany = query({
  args: { companyId: v.id('companies'), locale: guestLocaleValidator },
  handler: (ctx, args) => runConvex(listForCompanyProgram(ctx, args)),
})

const configureCompanyNdaProgram = Effect.fn('GuestAccess.configureCompanyNda')(function* (
  ctx: MutationCtx,
  args: {
    companyId: Id<'companies'>
    title: string
    content: string
    version: string
    locale: 'es' | 'en'
    adminCapability?: AdminCapability
  }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  if (auth.profile.role !== 'ADMIN') {
    return yield* Effect.fail(unauthorized('Solo el equipo puede configurar el NDA aprobado.'))
  }
  const company = yield* convexPromise(() => requireCompanyGuestManager(ctx, auth, args.companyId))
  yield* convexPromise(() =>
    requireAdminVdrCapability({
      ctx,
      auth,
      company,
      capability: args.adminCapability,
      action: 'GUEST_INVITE',
      target: adminVdrTarget('COMPANY_NDA', company._id),
      input: withoutAdminVdrCapability(args),
    })
  )
  if (
    !args.title.trim() ||
    args.title.length > 200 ||
    !args.content.trim() ||
    args.content.length > 12000 ||
    !args.version.trim() ||
    args.version.length > 100 ||
    /\{\{.*?\}\}/.test(args.content)
  ) {
    return yield* Effect.fail(
      validationFailed('Carga el texto aprobado completo, sin campos pendientes.', 'content')
    )
  }
  const active = yield* convexPromise(() =>
    ctx.db
      .query('guestNdaTemplates')
      .withIndex('by_company_locale_active', (q) =>
        q.eq('companyId', company._id).eq('locale', args.locale).eq('active', true)
      )
      .take(21)
  )
  if (active.length > 20) {
    return yield* Effect.fail(
      invalidState('El equipo debe revisar las versiones del NDA.', 'GUEST_NDA_HISTORY_LIMIT')
    )
  }
  for (const template of active) {
    yield* convexPromise(() => ctx.db.patch(template._id, { active: false }))
  }
  const contentHash = yield* convexPromise(() => sha256Hex(args.content))
  const templateId = yield* convexPromise(() =>
    ctx.db.insert('guestNdaTemplates', {
      companyId: company._id,
      title: args.title.trim(),
      content: args.content,
      contentHash,
      locale: args.locale,
      version: args.version.trim(),
      active: true,
      approvedAt: Date.now(),
      approvedByProfileId: auth.profile._id,
    })
  )
  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: auth.profile._id,
      adminEmail: auth.user.email,
      action: 'NDA_TEMPLATE_CREATE',
      targetType: 'COMPANY',
      targetId: company._id,
      newValue: {
        templateId,
        contentHash,
        version: args.version,
        locale: args.locale,
        replacedTemplates: active.map((template) => template._id),
      },
    })
  )
  return { templateId, contentHash }
})

export const configureCompanyNda = mutation({
  args: {
    companyId: v.id('companies'),
    title: v.string(),
    content: v.string(),
    version: v.string(),
    locale: guestLocaleValidator,
    adminCapability: adminVdrCapabilityValidator,
  },
  handler: (ctx, args) => runConvex(configureCompanyNdaProgram(ctx, args)),
})

const getCompanyNdaProgram = Effect.fn('GuestAccess.getCompanyNda')(function* (
  ctx: MutationCtx,
  args: ServerProofArgs & { sessionToken: string }
) {
  yield* convexPromise(() =>
    requireVdrGuestServerProof({
      operation: 'READ_NDA',
      issuedAt: args.serverIssuedAt,
      proof: args.serverProof,
      bindingParts: [args.sessionToken],
    })
  )
  return yield* convexPromise(() => getCompanyGuestNda(ctx, args))
})

export const getCompanyNda = mutation({
  args: { sessionToken: v.string(), ...serverProofArgs },
  handler: (ctx, args) => runConvex(getCompanyNdaProgram(ctx, args)),
})

const acceptCompanyNdaProgram = Effect.fn('GuestAccess.acceptCompanyNda')(function* (
  ctx: MutationCtx,
  args: ServerProofArgs & { sessionToken: string; contentHash: string; signatoryName: string }
) {
  yield* convexPromise(() =>
    requireVdrGuestServerProof({
      operation: 'ACCEPT_NDA',
      issuedAt: args.serverIssuedAt,
      proof: args.serverProof,
      bindingParts: [args.sessionToken, args.contentHash, args.signatoryName],
    })
  )
  return yield* convexPromise(() => acceptCompanyGuestNda(ctx, args))
})

export const acceptCompanyNda = mutation({
  args: {
    sessionToken: v.string(),
    contentHash: v.string(),
    signatoryName: v.string(),
    ...serverProofArgs,
  },
  handler: (ctx, args) => runConvex(acceptCompanyNdaProgram(ctx, args)),
})

const authorizeCompanyGuestDocumentProgram = Effect.fn('GuestAccess.authorizeGuestDocument')(
  function* (
    ctx: MutationCtx,
    args: ServerProofArgs & { sessionToken: string; documentId: Id<'documents'> }
  ) {
    yield* convexPromise(() =>
      requireVdrGuestServerProof({
        operation: 'VIEW_DOCUMENT',
        issuedAt: args.serverIssuedAt,
        proof: args.serverProof,
        bindingParts: [args.sessionToken, args.documentId],
      })
    )
    const document = yield* convexPromise(() => resolveCompanyGuestDocument(ctx, args))
    yield* convexPromise(() =>
      ctx.db.insert('activityLogs', {
        action: 'GUEST_DOCUMENT_VIEW_AUTHORIZED',
        entityType: 'DOCUMENT',
        entityId: document.documentId,
        metadata: {
          resourceType: 'COMPANY',
          resourceId: document.companyId,
          details: {
            invitationId: document.invitationId,
            versionId: document.versionId,
            action: 'VIEW',
          },
        },
      })
    )
    return {
      storageId: document.storageId,
      documentId: document.documentId,
      versionId: document.versionId,
      invitationId: document.invitationId,
      guestLabel: document.guestLabel,
      fileName: document.fileName,
    }
  }
)

// ES: Interna a propósito. `ctx.storage.getUrl` acuña una URL permanente y sin
// auth; si esa URL sale del deployment sobrevive al NDA, a la sesión y a la
// revocación. Esta mutation autoriza y devuelve un `storageId`, y sólo el
// httpAction `POST /vdr/guest/document` (convex/http.ts) resuelve los bytes.
// EN: internal on purpose; the permanent storage URL never leaves Convex.
export const authorizeCompanyGuestDocument = internalMutation({
  args: {
    sessionToken: v.string(),
    documentId: v.id('documents'),
    ...serverProofArgs,
  },
  handler: (ctx, args) => runConvex(authorizeCompanyGuestDocumentProgram(ctx, args)),
})
