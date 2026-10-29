import { paginationOptsValidator } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { Effect } from 'effect'

import type { Doc, Id } from './_generated/dataModel'
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import { buildCompanyChecklistItems } from './companyChecklist'
import { requireAuth, requireAuthAdmin, type AuthResult } from './_helpers/auth'
import { isDevAuthBypassedViaEnv } from './_helpers/auth.dev'
import { logAdminAction } from './_helpers/auditLog'
import { requireCompanyReadAuthorization } from './_helpers/companyAuthorization'
import { convexPromise, convexSync, runConvex } from './_helpers/effect'
import type { AppError } from './_helpers/errors'
import { invalidState, rateLimitExceeded, unauthorized, validationFailed } from './_helpers/errors'
import { enforceRateLimit } from './_helpers/rateLimit'
import {
  SUPPORT_INBOX_PAGE_MAX,
  SUPPORT_MESSAGE_PAGE_MAX,
  TEMPORARY_INTAKE_SUPPORT_AVAILABLE,
  companySupportScope,
  intakeSupportScope,
  normalizeSupportMessage,
  projectSupportMessage,
  supportScopeKey,
  type SupportThreadScope,
} from './_support/model'
import { scheduleSupportMessageEmail } from './_support/teamEmail'

const SUPPORT_ACCESS_DENIED = 'No tienes permiso para abrir esta conversación.'
const SUPPORT_MANAGE_DENIED = 'Tu acceso a esta sala es de solo lectura.'
const COMPANY_MESSAGE_LIMIT = 12
const ADMIN_MESSAGE_LIMIT = 60
const ADMIN_MESSAGE_READ_LIMIT = 120
const SUPPORT_RATE_WINDOW_MS = 5 * 60 * 1000
const QUEUE_LIMIT_DEFAULT = 20
const QUEUE_LIMIT_MAX = 25
const QUEUE_SOURCE_SCAN_MAX = 40
const READINESS_DOCUMENT_SCAN_MAX = 40

type SupportContext = QueryCtx | MutationCtx

type CompanySupportAuthorization = {
  company: Doc<'companies'>
  profile: Doc<'profiles'>
  access: 'MANAGE' | 'READ_ONLY'
}

const requireCompanySupportAuthorization = Effect.fn('Support.requireCompanyAuthorization')(
  function* (
    ctx: SupportContext,
    companyId: Id<'companies'>,
    authenticated?: AuthResult
  ): Effect.fn.Return<CompanySupportAuthorization, AppError> {
    const auth = authenticated ?? (yield* convexPromise(() => requireAuth(ctx)))
    if (auth.profile.role !== 'COMPANY') {
      return yield* Effect.fail(unauthorized(SUPPORT_ACCESS_DENIED))
    }

    const company = yield* convexPromise(() => ctx.db.get(companyId))
    if (!company) return yield* Effect.fail(unauthorized(SUPPORT_ACCESS_DENIED))

    const authorization = yield* convexPromise(() =>
      requireCompanyReadAuthorization(ctx, auth, company, SUPPORT_ACCESS_DENIED)
    )
    return {
      company,
      profile: auth.profile,
      access: authorization.access,
    }
  }
)

function assertThreadScope(thread: Doc<'supportThreads'>): void {
  if (thread.scopeKey !== supportScopeKey(thread.scope)) {
    throw invalidState('La conversación no tiene un alcance válido.', 'SUPPORT_SCOPE_INVALID')
  }
}

const findThreadByScope = Effect.fn('Support.findThreadByScope')(function* (
  ctx: SupportContext,
  scope: SupportThreadScope
) {
  const scopeKey = supportScopeKey(scope)
  const rows = yield* convexPromise(() =>
    ctx.db
      .query('supportThreads')
      .withIndex('by_scopeKey', (q) => q.eq('scopeKey', scopeKey))
      .take(2)
  )

  if (rows.length > 1) {
    return yield* Effect.fail(
      invalidState('La sala tiene más de una conversación de soporte.', 'SUPPORT_SCOPE_DUPLICATE')
    )
  }
  const thread = rows[0] ?? null
  if (thread) yield* convexSync(() => assertThreadScope(thread))
  return thread
})

function boundedPagination(
  paginationOpts: { cursor: string | null; numItems: number },
  maximum: number
) {
  const requested = Number.isFinite(paginationOpts.numItems)
    ? Math.floor(paginationOpts.numItems)
    : 1
  return {
    cursor: paginationOpts.cursor,
    numItems: Math.min(Math.max(requested, 1), maximum),
  }
}

function emptyPage(cursor: string | null) {
  return {
    page: [] as ReturnType<typeof projectSupportMessage>[],
    isDone: true,
    continueCursor: cursor ?? '',
  }
}

async function enforceSupportRateLimit(
  ctx: MutationCtx,
  config: { key: string; limit: number }
): Promise<void> {
  try {
    await enforceRateLimit(ctx, {
      key: config.key,
      limit: config.limit,
      windowMs: SUPPORT_RATE_WINDOW_MS,
    })
  } catch (error) {
    if (error instanceof ConvexError && error.data === 'Rate limit exceeded') {
      throw rateLimitExceeded(SUPPORT_RATE_WINDOW_MS)
    }
    throw error
  }
}

const appendMessage = Effect.fn('Support.appendMessage')(function* (
  ctx: MutationCtx,
  args: {
    thread: Doc<'supportThreads'> | null
    scope: SupportThreadScope
    author:
      { kind: 'COMPANY'; profileId: Id<'profiles'> } | { kind: 'ADMIN'; profileId: Id<'profiles'> }
    body: string
    now: number
  }
) {
  const previousSequence = args.thread?.lastSequence ?? 0
  if (!Number.isSafeInteger(previousSequence) || previousSequence < 0) {
    return yield* Effect.fail(
      invalidState('La secuencia de la conversación no es válida.', 'SUPPORT_SEQUENCE_INVALID')
    )
  }
  const sequence = previousSequence + 1
  if (!Number.isSafeInteger(sequence)) {
    return yield* Effect.fail(
      invalidState('La conversación alcanzó su límite.', 'SUPPORT_SEQUENCE_LIMIT')
    )
  }

  const existingThread = args.thread
  const threadId = existingThread
    ? existingThread._id
    : yield* convexPromise(() =>
        ctx.db.insert('supportThreads', {
          scope: args.scope,
          scopeKey: supportScopeKey(args.scope),
          lastSequence: 0,
          adminReadThroughSequence: 0,
          clientReadThroughSequence: 0,
          adminUnreadCount: 0,
          clientUnreadCount: 0,
          adminUnread: false,
          clientUnread: false,
          createdAt: args.now,
          updatedAt: args.now,
          lastMessageAt: args.now,
        })
      )

  const messageId = yield* convexPromise(() =>
    ctx.db.insert('supportMessages', {
      threadId,
      sequence,
      author: args.author,
      body: args.body,
      createdAt: args.now,
    })
  )

  if (args.author.kind === 'COMPANY') {
    yield* convexPromise(() =>
      ctx.db.patch(threadId, {
        lastSequence: sequence,
        adminUnreadCount: (args.thread?.adminUnreadCount ?? 0) + 1,
        adminUnread: true,
        clientReadThroughSequence: sequence,
        clientUnreadCount: 0,
        clientUnread: false,
        updatedAt: args.now,
        lastMessageAt: args.now,
      })
    )
  } else {
    yield* convexPromise(() =>
      ctx.db.patch(threadId, {
        lastSequence: sequence,
        adminReadThroughSequence: sequence,
        adminUnreadCount: 0,
        adminUnread: false,
        clientUnreadCount: (args.thread?.clientUnreadCount ?? 0) + 1,
        clientUnread: true,
        updatedAt: args.now,
        lastMessageAt: args.now,
      })
    )
  }

  return { threadId, messageId, sequence }
})

const paginateMessages = Effect.fn('Support.paginateMessages')(function* (
  ctx: SupportContext,
  thread: Doc<'supportThreads'> | null,
  paginationOpts: { cursor: string | null; numItems: number }
) {
  if (!thread) return emptyPage(paginationOpts.cursor)

  const result = yield* convexPromise(() =>
    ctx.db
      .query('supportMessages')
      .withIndex('by_thread_sequence', (q) => q.eq('threadId', thread._id))
      .order('desc')
      .paginate(boundedPagination(paginationOpts, SUPPORT_MESSAGE_PAGE_MAX))
  )

  return {
    page: result.page.map(projectSupportMessage),
    isDone: result.isDone,
    continueCursor: result.continueCursor,
  }
})

const getCompanyThreadProgram = Effect.fn('Support.getCompanyThread')(function* (
  ctx: QueryCtx,
  args: { companyId: Id<'companies'> }
) {
  const authorization = yield* requireCompanySupportAuthorization(ctx, args.companyId)
  const thread = yield* findThreadByScope(ctx, companySupportScope(authorization.company._id))

  return {
    threadId: thread?._id ?? null,
    canSend: authorization.access === 'MANAGE',
    unreadCount: thread?.clientUnreadCount ?? 0,
    lastSequence: thread?.lastSequence ?? 0,
  }
})

export const getCompanyThread = query({
  args: { companyId: v.id('companies') },
  handler: (ctx, args) => runConvex(getCompanyThreadProgram(ctx, args)),
})

const listCompanyMessagesProgram = Effect.fn('Support.listCompanyMessages')(function* (
  ctx: QueryCtx,
  args: { companyId: Id<'companies'>; paginationOpts: { cursor: string | null; numItems: number } }
) {
  const authorization = yield* requireCompanySupportAuthorization(ctx, args.companyId)
  const thread = yield* findThreadByScope(ctx, companySupportScope(authorization.company._id))
  return yield* paginateMessages(ctx, thread, args.paginationOpts)
})

export const listCompanyMessages = query({
  args: {
    companyId: v.id('companies'),
    paginationOpts: paginationOptsValidator,
  },
  handler: (ctx, args) => runConvex(listCompanyMessagesProgram(ctx, args)),
})

const sendCompanyMessageProgram = Effect.fn('Support.sendCompanyMessage')(function* (
  ctx: MutationCtx,
  args: { companyId: Id<'companies'>; body: string }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const authorization = yield* requireCompanySupportAuthorization(ctx, args.companyId, auth)
  if (authorization.access !== 'MANAGE') {
    return yield* Effect.fail(unauthorized(SUPPORT_MANAGE_DENIED))
  }

  const body = yield* convexSync(() => normalizeSupportMessage(args.body))
  yield* convexPromise(() =>
    enforceSupportRateLimit(ctx, {
      key: `supportCompany:${authorization.profile._id}:${authorization.company._id}`,
      limit: COMPANY_MESSAGE_LIMIT,
    })
  )
  const scope = companySupportScope(authorization.company._id)
  const thread = yield* findThreadByScope(ctx, scope)

  const now = Date.now()
  const appended = yield* appendMessage(ctx, {
    thread,
    scope,
    author: { kind: 'COMPANY', profileId: authorization.profile._id },
    body,
    now,
  })

  // El timbre del equipo cuelga de ACÁ y no de `appendMessage`: así la
  // respuesta del admin (`sendAdminMessage`) y la siembra de dev (`seedForDev`)
  // no se avisan a sí mismas. Solo calendariza —el correo se arma en su propia
  // mutación— y se traga sus propios fallos: el mensaje del cliente ya está
  // guardado y nada de este carril puede revertirlo.
  yield* convexPromise(() => scheduleSupportMessageEmail(ctx, { threadId: appended.threadId, now }))

  return appended
})

export const sendCompanyMessage = mutation({
  args: {
    companyId: v.id('companies'),
    body: v.string(),
  },
  handler: (ctx, args) => runConvex(sendCompanyMessageProgram(ctx, args)),
})

const markCompanyThreadReadProgram = Effect.fn('Support.markCompanyThreadRead')(function* (
  ctx: MutationCtx,
  args: { companyId: Id<'companies'>; throughSequence: number }
) {
  const auth = yield* convexPromise(() => requireAuth(ctx))
  const authorization = yield* requireCompanySupportAuthorization(ctx, args.companyId, auth)
  const thread = yield* findThreadByScope(ctx, companySupportScope(authorization.company._id))
  if (!thread || thread.clientUnreadCount === 0) return { marked: false as const }
  if (!Number.isSafeInteger(args.throughSequence) || args.throughSequence !== thread.lastSequence) {
    return { marked: false as const }
  }

  yield* convexPromise(() =>
    ctx.db.patch(thread._id, {
      clientReadThroughSequence: args.throughSequence,
      clientUnreadCount: 0,
      clientUnread: false,
    })
  )
  return { marked: true as const }
})

export const markCompanyThreadRead = mutation({
  args: {
    companyId: v.id('companies'),
    throughSequence: v.number(),
  },
  handler: (ctx, args) => runConvex(markCompanyThreadReadProgram(ctx, args)),
})

type AdminSelection = {
  threadId?: Id<'supportThreads'>
  companyId?: Id<'companies'>
  intakeSessionId?: Id<'intakeSessions'>
}

function validateAdminSelection(selection: AdminSelection): void {
  const selectedCount = [selection.threadId, selection.companyId, selection.intakeSessionId].filter(
    Boolean
  ).length
  if (selectedCount !== 1) {
    throw validationFailed('Selecciona una sola conversación o empresa.', 'threadId')
  }
}

const requireActiveIntakeSession = Effect.fn('Support.requireActiveIntakeSession')(function* (
  ctx: SupportContext,
  intakeSessionId: Id<'intakeSessions'>
) {
  const session = yield* convexPromise(() => ctx.db.get(intakeSessionId))
  if (!session || session.status !== 'ACTIVE' || session.accessExpiresAt <= Date.now()) {
    return yield* Effect.fail(
      invalidState('La sala temporal no está disponible.', 'SUPPORT_INTAKE_NOT_FOUND')
    )
  }
  return session
})

const resolveAdminSelection = Effect.fn('Support.resolveAdminSelection')(function* (
  ctx: SupportContext,
  selection: AdminSelection
) {
  yield* convexSync(() => validateAdminSelection(selection))

  if (selection.threadId) {
    const thread = yield* convexPromise(() => ctx.db.get(selection.threadId!))
    if (!thread) {
      return yield* Effect.fail(
        invalidState('La conversación no está disponible.', 'SUPPORT_THREAD_NOT_FOUND')
      )
    }
    yield* convexSync(() => assertThreadScope(thread))
    if (thread.scope.kind === 'INTAKE') {
      yield* requireActiveIntakeSession(ctx, thread.scope.intakeSessionId)
    }
    return { thread, scope: thread.scope }
  }

  if (selection.companyId) {
    const company = yield* convexPromise(() => ctx.db.get(selection.companyId!))
    if (!company) {
      return yield* Effect.fail(
        invalidState('La empresa no está disponible.', 'SUPPORT_COMPANY_NOT_FOUND')
      )
    }
    const scope = companySupportScope(company._id)
    return { thread: yield* findThreadByScope(ctx, scope), scope }
  }

  const session = yield* requireActiveIntakeSession(ctx, selection.intakeSessionId!)
  const scope = intakeSupportScope(session._id)
  return { thread: yield* findThreadByScope(ctx, scope), scope }
})

const projectAdminThreadSummary = Effect.fn('Support.projectAdminThreadSummary')(function* (
  ctx: SupportContext,
  thread: Doc<'supportThreads'> | null,
  scope: SupportThreadScope
) {
  if (scope.kind === 'COMPANY') {
    const company = yield* convexPromise(() => ctx.db.get(scope.companyId))
    if (!company) {
      return yield* Effect.fail(
        invalidState('La empresa no está disponible.', 'SUPPORT_COMPANY_NOT_FOUND')
      )
    }
    return {
      threadId: thread?._id ?? null,
      roomLabel: company.name,
      scopeKind: 'COMPANY' as const,
      companyId: company._id,
      intakeSessionId: null,
      canSend: true,
      unreadCount: thread?.adminUnreadCount ?? 0,
      lastSequence: thread?.lastSequence ?? 0,
    }
  }

  const session = yield* convexPromise(() => ctx.db.get(scope.intakeSessionId))
  if (!session) {
    return yield* Effect.fail(
      invalidState('La sala temporal no está disponible.', 'SUPPORT_INTAKE_NOT_FOUND')
    )
  }
  return {
    threadId: thread?._id ?? null,
    roomLabel: null,
    scopeKind: 'INTAKE' as const,
    companyId: null,
    intakeSessionId: session._id,
    canSend: TEMPORARY_INTAKE_SUPPORT_AVAILABLE,
    unreadCount: thread?.adminUnreadCount ?? 0,
    lastSequence: thread?.lastSequence ?? 0,
  }
})

const listAdminInboxProgram = Effect.fn('Support.listAdminInbox')(function* (
  ctx: QueryCtx,
  args: { paginationOpts: { cursor: string | null; numItems: number } }
) {
  yield* convexPromise(() => requireAuthAdmin(ctx))
  const result = yield* convexPromise(() =>
    ctx.db
      .query('supportThreads')
      .withIndex('by_lastMessageAt')
      .order('desc')
      .paginate(boundedPagination(args.paginationOpts, SUPPORT_INBOX_PAGE_MAX))
  )

  const projected = yield* convexPromise(() =>
    Promise.all(
      result.page.map(async (thread) => {
        assertThreadScope(thread)
        if (thread.scope.kind === 'COMPANY') {
          const company = await ctx.db.get(thread.scope.companyId)
          if (!company) return null
          return {
            threadId: thread._id,
            roomLabel: company.name,
            scopeKind: 'COMPANY' as const,
            companyId: company._id,
            intakeSessionId: null,
            unreadCount: thread.adminUnreadCount,
            lastMessageAt: thread.lastMessageAt,
          }
        }

        const session = await ctx.db.get(thread.scope.intakeSessionId)
        if (!session || session.status !== 'ACTIVE' || session.accessExpiresAt <= Date.now()) {
          return null
        }
        return {
          threadId: thread._id,
          roomLabel: null,
          scopeKind: 'INTAKE' as const,
          companyId: null,
          intakeSessionId: session._id,
          unreadCount: thread.adminUnreadCount,
          lastMessageAt: thread.lastMessageAt,
        }
      })
    )
  )

  return {
    page: projected.filter((item) => item !== null),
    isDone: result.isDone,
    continueCursor: result.continueCursor,
  }
})

export const listAdminInbox = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: (ctx, args) => runConvex(listAdminInboxProgram(ctx, args)),
})

const getAdminThreadProgram = Effect.fn('Support.getAdminThread')(function* (
  ctx: QueryCtx,
  args: AdminSelection
) {
  yield* convexPromise(() => requireAuthAdmin(ctx))
  const selection = yield* resolveAdminSelection(ctx, args)
  return yield* projectAdminThreadSummary(ctx, selection.thread, selection.scope)
})

export const getAdminThread = query({
  args: {
    threadId: v.optional(v.id('supportThreads')),
    companyId: v.optional(v.id('companies')),
    intakeSessionId: v.optional(v.id('intakeSessions')),
  },
  handler: (ctx, args) => runConvex(getAdminThreadProgram(ctx, args)),
})

const listAdminMessagesProgram = Effect.fn('Support.listAdminMessages')(function* (
  ctx: MutationCtx,
  args: AdminSelection & { paginationOpts: { cursor: string | null; numItems: number } }
) {
  const { profile } = yield* convexPromise(() => requireAuthAdmin(ctx))
  const selection = yield* resolveAdminSelection(ctx, args)
  yield* convexPromise(() =>
    enforceSupportRateLimit(ctx, {
      key: `supportAdminRead:${profile._id}`,
      limit: ADMIN_MESSAGE_READ_LIMIT,
    })
  )
  const result = yield* paginateMessages(ctx, selection.thread, args.paginationOpts)

  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: '[redacted]',
      action: 'SUPPORT_THREAD_READ',
      targetType: 'SUPPORT_THREAD',
      targetId: selection.thread?._id,
      notes: 'SUPPORT_MESSAGES_READ',
      newValue: {
        operation: 'SUPPORT_MESSAGES_READ',
        scopeKey: supportScopeKey(selection.scope),
        supportThreadId: selection.thread?._id,
        messageCount: result.page.length,
        firstSequence: result.page[0]?.sequence ?? null,
        lastSequence: result.page.at(-1)?.sequence ?? null,
        isDone: result.isDone,
        continueCursor: result.continueCursor,
      },
    })
  )

  return result
})

export const listAdminMessages = mutation({
  args: {
    threadId: v.optional(v.id('supportThreads')),
    companyId: v.optional(v.id('companies')),
    intakeSessionId: v.optional(v.id('intakeSessions')),
    paginationOpts: paginationOptsValidator,
  },
  handler: (ctx, args) => runConvex(listAdminMessagesProgram(ctx, args)),
})

const sendAdminMessageProgram = Effect.fn('Support.sendAdminMessage')(function* (
  ctx: MutationCtx,
  args: AdminSelection & { body: string }
) {
  const { profile } = yield* convexPromise(() => requireAuthAdmin(ctx))
  const selection = yield* resolveAdminSelection(ctx, args)

  const body = yield* convexSync(() => normalizeSupportMessage(args.body))
  yield* convexPromise(() =>
    enforceSupportRateLimit(ctx, {
      key: `supportAdmin:${profile._id}:${supportScopeKey(selection.scope)}`,
      limit: ADMIN_MESSAGE_LIMIT,
    })
  )
  const sent = yield* appendMessage(ctx, {
    thread: selection.thread,
    scope: selection.scope,
    author: { kind: 'ADMIN', profileId: profile._id },
    body,
    now: Date.now(),
  })

  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: '[redacted]',
      action: 'SUPPORT_MESSAGE_SEND',
      targetType: 'SUPPORT_THREAD',
      targetId: `${sent.threadId}`,
      notes: 'SUPPORT_MESSAGE_SEND',
      newValue: {
        operation: 'SUPPORT_MESSAGE_SEND',
        supportThreadId: `${sent.threadId}`,
        supportMessageId: `${sent.messageId}`,
      },
    })
  )

  return sent
})

export const sendAdminMessage = mutation({
  args: {
    threadId: v.optional(v.id('supportThreads')),
    companyId: v.optional(v.id('companies')),
    intakeSessionId: v.optional(v.id('intakeSessions')),
    body: v.string(),
  },
  handler: (ctx, args) => runConvex(sendAdminMessageProgram(ctx, args)),
})

const markAdminThreadReadProgram = Effect.fn('Support.markAdminThreadRead')(function* (
  ctx: MutationCtx,
  args: { threadId: Id<'supportThreads'>; throughSequence: number }
) {
  const { profile } = yield* convexPromise(() => requireAuthAdmin(ctx))
  const thread = yield* convexPromise(() => ctx.db.get(args.threadId))
  if (!thread) return { marked: false as const }
  yield* convexSync(() => assertThreadScope(thread))
  if (thread.adminUnreadCount === 0) return { marked: false as const }
  if (!Number.isSafeInteger(args.throughSequence) || args.throughSequence !== thread.lastSequence) {
    return { marked: false as const }
  }

  yield* convexPromise(() =>
    ctx.db.patch(thread._id, {
      adminReadThroughSequence: args.throughSequence,
      adminUnreadCount: 0,
      adminUnread: false,
    })
  )
  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: profile._id,
      adminEmail: '[redacted]',
      action: 'SUPPORT_THREAD_READ',
      targetType: 'SUPPORT_THREAD',
      targetId: `${thread._id}`,
      notes: 'SUPPORT_THREAD_READ',
      newValue: {
        operation: 'SUPPORT_THREAD_READ',
        supportThreadId: `${thread._id}`,
        throughSequence: args.throughSequence,
      },
    })
  )
  return { marked: true as const }
})

export const markAdminThreadRead = mutation({
  args: {
    threadId: v.id('supportThreads'),
    throughSequence: v.number(),
  },
  handler: (ctx, args) => runConvex(markAdminThreadReadProgram(ctx, args)),
})

type QueueDimension = { available: boolean; count: number }

type QueueAccumulator = {
  scope: SupportThreadScope
  scopeKey: string
  actionAt: number
  roomLabel: string | null
  supportThreadId: Id<'supportThreads'> | null
  readiness: {
    available: boolean
    missingCount: number
    completedCount: number
    totalCount: number
  }
  missingEvidence: QueueDimension
  unreadSupport: QueueDimension
  assessmentReview: QueueDimension & { assessmentId: Id<'intakeAssessments'> | null }
  draftReview: QueueDimension & { deliverableId: Id<'deliverables'> | null }
}

function createQueueAccumulator(
  scope: SupportThreadScope,
  actionAt: number,
  roomLabel: string | null = null
): QueueAccumulator {
  return {
    scope,
    scopeKey: supportScopeKey(scope),
    actionAt,
    roomLabel,
    supportThreadId: null,
    readiness: { available: false, missingCount: 0, completedCount: 0, totalCount: 0 },
    missingEvidence: { available: scope.kind === 'COMPANY', count: 0 },
    unreadSupport: { available: scope.kind === 'COMPANY', count: 0 },
    assessmentReview: { available: scope.kind === 'INTAKE', count: 0, assessmentId: null },
    draftReview: { available: scope.kind === 'COMPANY', count: 0, deliverableId: null },
  }
}

const listAdminIntakeQueueProgram = Effect.fn('Support.listAdminIntakeQueue')(function* (
  ctx: QueryCtx,
  args: { limit?: number }
) {
  yield* convexPromise(() => requireAuthAdmin(ctx))
  const requestedLimit = args.limit ?? QUEUE_LIMIT_DEFAULT
  if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
    return yield* Effect.fail(validationFailed('El límite de la cola no es válido.', 'limit'))
  }
  const limit = Math.min(Math.floor(requestedLimit), QUEUE_LIMIT_MAX)
  const sourceLimit = Math.min(Math.max(limit * 3, 30), QUEUE_SOURCE_SCAN_MAX)

  const [companyRows, missingEvidenceRows, draftRows, unreadRows, assessmentRows] =
    yield* convexPromise(() =>
      Promise.all([
        ctx.db
          .query('companies')
          .order('desc')
          .take(sourceLimit + 1),
        ctx.db
          .query('deliverables')
          .withIndex('by_status', (q) => q.eq('status', 'NEEDS_INPUT'))
          .order('desc')
          .take(sourceLimit + 1),
        ctx.db
          .query('deliverables')
          .withIndex('by_status', (q) => q.eq('status', 'DRAFT_READY'))
          .order('desc')
          .take(sourceLimit + 1),
        ctx.db
          .query('supportThreads')
          .withIndex('by_adminUnread_lastMessageAt', (q) => q.eq('adminUnread', true))
          .order('desc')
          .take(sourceLimit + 1),
        ctx.db
          .query('intakeAssessments')
          .withIndex('by_status_updatedAt', (q) => q.eq('status', 'NEEDS_REVIEW'))
          .order('desc')
          .take(sourceLimit + 1),
      ])
    )

  const queue = new Map<string, QueueAccumulator>()
  const recentCompanies = companyRows.slice(0, sourceLimit)
  const readinessRows = yield* convexPromise(() =>
    Promise.all(
      recentCompanies.map(async (company) => {
        const documents = await ctx.db
          .query('documents')
          .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
          .take(READINESS_DOCUMENT_SCAN_MAX + 1)
        if (documents.length > READINESS_DOCUMENT_SCAN_MAX) {
          return { company, documents, readiness: null }
        }
        const readiness = await buildCompanyChecklistItems(ctx, company, documents)
        return { company, documents, readiness }
      })
    )
  )
  const readinessProjectionTruncated = readinessRows.some((row) => row.readiness === null)

  for (const row of readinessRows) {
    const missingCount = row.readiness
      ? Object.values(row.readiness.items).filter((item) => !item.done).length
      : 0
    if (!row.readiness) continue
    const actionAt = row.documents.reduce(
      (latest, document) => Math.max(latest, document._creationTime),
      row.company._creationTime
    )
    const scope = companySupportScope(row.company._id)
    const item = createQueueAccumulator(scope, actionAt, row.company.name)
    item.readiness = {
      available: true,
      missingCount,
      completedCount: row.readiness.completedCount,
      totalCount: Object.keys(row.readiness.items).length,
    }
    queue.set(item.scopeKey, item)
  }

  const companyItem = Effect.fn('Support.queueCompanyItem')(function* (
    companyId: Id<'companies'>,
    actionAt: number
  ) {
    const scope = companySupportScope(companyId)
    const scopeKey = supportScopeKey(scope)
    const existing = queue.get(scopeKey)
    if (existing) {
      existing.actionAt = Math.max(existing.actionAt, actionAt)
      return existing
    }
    const company = yield* convexPromise(() => ctx.db.get(companyId))
    if (!company) return null
    const item = createQueueAccumulator(scope, actionAt, company.name)
    queue.set(scopeKey, item)
    return item
  })

  for (const deliverable of missingEvidenceRows.slice(0, sourceLimit)) {
    const item = yield* companyItem(deliverable.companyId, deliverable.updatedAt)
    if (!item) continue
    item.missingEvidence.count += 1
  }

  for (const deliverable of draftRows.slice(0, sourceLimit)) {
    const item = yield* companyItem(deliverable.companyId, deliverable.updatedAt)
    if (!item) continue
    item.draftReview.count += 1
    item.draftReview.deliverableId ??= deliverable._id
  }

  for (const thread of unreadRows.slice(0, sourceLimit)) {
    yield* convexSync(() => assertThreadScope(thread))
    if (thread.scope.kind === 'COMPANY') {
      const item = yield* companyItem(thread.scope.companyId, thread.lastMessageAt)
      if (!item) continue
      item.supportThreadId = thread._id
      item.unreadSupport.available = true
      item.unreadSupport.count = thread.adminUnreadCount
      continue
    }

    const intakeSessionId = thread.scope.intakeSessionId
    const session = yield* convexPromise(() => ctx.db.get(intakeSessionId))
    if (!session || session.status !== 'ACTIVE' || session.accessExpiresAt <= Date.now()) continue
    const scopeKey = supportScopeKey(thread.scope)
    const item =
      queue.get(scopeKey) ?? createQueueAccumulator(thread.scope, thread.lastMessageAt, null)
    item.actionAt = Math.max(item.actionAt, thread.lastMessageAt)
    item.supportThreadId = thread._id
    item.unreadSupport = { available: true, count: thread.adminUnreadCount }
    queue.set(scopeKey, item)
  }

  for (const assessment of assessmentRows.slice(0, sourceLimit)) {
    const latestAssessment = yield* convexPromise(() =>
      ctx.db
        .query('intakeAssessments')
        .withIndex('by_session', (q) => q.eq('intakeSessionId', assessment.intakeSessionId))
        .order('desc')
        .first()
    )
    if (!latestAssessment || latestAssessment._id !== assessment._id) continue

    const session = yield* convexPromise(() => ctx.db.get(assessment.intakeSessionId))
    if (!session || session.status !== 'ACTIVE' || session.accessExpiresAt <= Date.now()) continue
    const scope: SupportThreadScope = {
      kind: 'INTAKE',
      intakeSessionId: assessment.intakeSessionId,
    }
    const scopeKey = supportScopeKey(scope)
    const item = queue.get(scopeKey) ?? createQueueAccumulator(scope, assessment.updatedAt, null)
    item.actionAt = Math.max(item.actionAt, assessment.updatedAt)
    item.assessmentReview.count += 1
    item.assessmentReview.assessmentId ??= assessment._id
    queue.set(scopeKey, item)
  }

  const actionable = Array.from(queue.values())
    .filter(
      (item) =>
        item.readiness.missingCount > 0 ||
        item.missingEvidence.count > 0 ||
        item.unreadSupport.count > 0 ||
        item.assessmentReview.count > 0 ||
        item.draftReview.count > 0
    )
    .sort(
      (left, right) => right.actionAt - left.actionAt || left.scopeKey.localeCompare(right.scopeKey)
    )

  return {
    items: actionable.slice(0, limit).map((item) => ({
      scopeKey: item.scopeKey,
      scopeKind: item.scope.kind,
      roomLabel: item.roomLabel,
      companyId: item.scope.kind === 'COMPANY' ? item.scope.companyId : null,
      intakeSessionId: item.scope.kind === 'INTAKE' ? item.scope.intakeSessionId : null,
      supportThreadId: item.supportThreadId,
      actionAt: item.actionAt,
      readiness: {
        available: item.readiness.available,
        missingCount: item.readiness.missingCount,
        completedCount: item.readiness.completedCount,
        totalCount: item.readiness.totalCount,
      },
      missingEvidence: {
        available: item.missingEvidence.available,
        count: item.missingEvidence.count,
      },
      unreadSupport: {
        available: item.unreadSupport.available,
        count: item.unreadSupport.count,
      },
      assessmentReview: {
        available: item.assessmentReview.available,
        count: item.assessmentReview.count,
        assessmentId: item.assessmentReview.assessmentId,
      },
      draftReview: {
        available: item.draftReview.available,
        count: item.draftReview.count,
        deliverableId: item.draftReview.deliverableId,
      },
    })),
    truncated:
      companyRows.length > sourceLimit ||
      missingEvidenceRows.length > sourceLimit ||
      draftRows.length > sourceLimit ||
      unreadRows.length > sourceLimit ||
      assessmentRows.length > sourceLimit ||
      readinessProjectionTruncated ||
      actionable.length > limit,
    temporaryIntakeSupportAvailable: TEMPORARY_INTAKE_SUPPORT_AVAILABLE,
  }
})

export const listAdminIntakeQueue = query({
  args: { limit: v.optional(v.number()) },
  handler: (ctx, args) => runConvex(listAdminIntakeQueueProgram(ctx, args)),
})

// ============================================================================
// SEED LOCAL DE VOLUMEN (solo desarrollo)
// ============================================================================
// El inbox se mide con la lista llena (15 hilos a 1440x900). Cada hilo necesita
// un alcance de empresa distinto, y una empresa por dueño: las filas se crean
// con dueños propios para no romper las salas de `company@dev.local`.

const DEV_SEED_SLOT_MAX = 40
const DEV_SEED_EMAIL_PREFIX = 'hilo-medicion-'
const DEV_SEED_EMAIL_DOMAIN = '@dev.local'

function seedSlotLabel(slot: number): string {
  return String(slot).padStart(2, '0')
}

function seedSlotEmail(slot: number): string {
  return `${DEV_SEED_EMAIL_PREFIX}${seedSlotLabel(slot)}${DEV_SEED_EMAIL_DOMAIN}`
}

function seedSlotName(slot: number): string {
  return `Hilo de medición ${seedSlotLabel(slot)}`
}

const removeSeedSlot = Effect.fn('Support.removeSeedSlot')(function* (
  ctx: MutationCtx,
  slot: number
) {
  const email = seedSlotEmail(slot)
  const user = yield* convexPromise(() =>
    ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', email))
      .first()
  )
  if (!user) return { removed: false as const }

  const profile = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .first()
  )
  const company = profile
    ? yield* convexPromise(() =>
        ctx.db
          .query('companies')
          .withIndex('by_ownerId', (q) => q.eq('ownerId', profile._id))
          .first()
      )
    : null
  const thread = company ? yield* findThreadByScope(ctx, companySupportScope(company._id)) : null

  if (thread) {
    // Convex ve sus propios deletes: cada take(50) trae la página siguiente.
    let pageLength = SUPPORT_MESSAGE_PAGE_MAX
    do {
      const messages = yield* convexPromise(() =>
        ctx.db
          .query('supportMessages')
          .withIndex('by_thread_sequence', (q) => q.eq('threadId', thread._id))
          .take(SUPPORT_MESSAGE_PAGE_MAX)
      )
      for (const message of messages) {
        yield* convexPromise(() => ctx.db.delete(message._id))
      }
      pageLength = messages.length
    } while (pageLength >= SUPPORT_MESSAGE_PAGE_MAX)
    yield* convexPromise(() => ctx.db.delete(thread._id))
  }
  if (company) yield* convexPromise(() => ctx.db.delete(company._id))
  if (profile) yield* convexPromise(() => ctx.db.delete(profile._id))
  yield* convexPromise(() => ctx.db.delete(user._id))
  return { removed: true as const }
})

const ensureSeedSlot = Effect.fn('Support.ensureSeedSlot')(function* (
  ctx: MutationCtx,
  slot: number,
  now: number
) {
  const email = seedSlotEmail(slot)
  const name = seedSlotName(slot)
  const workosUserId = `dev_support_seed_${seedSlotLabel(slot)}_workos`

  const existingUser = yield* convexPromise(() =>
    ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', email))
      .first()
  )
  const userId =
    existingUser?._id ??
    (yield* convexPromise(() =>
      ctx.db.insert('users', {
        email,
        name,
        clerkId: `dev_support_seed_${seedSlotLabel(slot)}`,
        workosUserId,
        authProvider: 'workos',
        providerUserId: workosUserId,
        role: 'COMPANY',
        emailVerified: true,
      })
    ))

  const existingProfile = yield* convexPromise(() =>
    ctx.db
      .query('profiles')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .first()
  )
  const profileId =
    existingProfile?._id ??
    (yield* convexPromise(() =>
      ctx.db.insert('profiles', {
        userId,
        role: 'COMPANY',
        fullName: name,
        language: 'es',
        isVerified: true,
        isActive: true,
        kycStatus: 'VERIFIED',
        roleConfirmed: true,
      })
    ))

  const existingCompany = yield* convexPromise(() =>
    ctx.db
      .query('companies')
      .withIndex('by_ownerId', (q) => q.eq('ownerId', profileId))
      .first()
  )
  const companyId =
    existingCompany?._id ??
    (yield* convexPromise(() =>
      ctx.db.insert('companies', {
        ownerId: profileId,
        name,
        country: 'PA',
        demo: true,
      })
    ))
  if (existingCompany && existingCompany.name !== name) {
    yield* convexPromise(() => ctx.db.patch(existingCompany._id, { name }))
  }

  const scope = companySupportScope(companyId)
  const thread = yield* findThreadByScope(ctx, scope)
  if (thread && thread.lastSequence > 0) return { created: false as const, companyId }

  const body = yield* convexSync(() =>
    normalizeSupportMessage(`Mensaje de medición del hilo ${seedSlotLabel(slot)}.`)
  )
  yield* appendMessage(ctx, {
    thread,
    scope,
    author: { kind: 'COMPANY', profileId },
    body,
    now: now - slot * 1_000,
  })
  return { created: true as const, companyId }
})

const seedForDevProgram = Effect.fn('Support.seedForDev')(function* (
  ctx: MutationCtx,
  args: { count: number }
) {
  if (!isDevAuthBypassedViaEnv()) {
    return yield* Effect.fail(
      unauthorized(
        'support.seedForDev solo puede ejecutarse en un deployment de desarrollo ' +
          '(requiere BYPASS_AUTH=true + CONVEX_ENV=dev). Bloqueado en producción.'
      )
    )
  }

  if (!Number.isInteger(args.count) || args.count < 0 || args.count > DEV_SEED_SLOT_MAX) {
    return yield* Effect.fail(
      validationFailed(`count debe ser un entero entre 0 y ${DEV_SEED_SLOT_MAX}`, 'count')
    )
  }

  const now = Date.now()
  let created = 0
  let removed = 0
  for (let slot = 1; slot <= DEV_SEED_SLOT_MAX; slot++) {
    if (slot <= args.count) {
      const result = yield* ensureSeedSlot(ctx, slot, now)
      if (result.created) created += 1
    } else {
      const result = yield* removeSeedSlot(ctx, slot)
      if (result.removed) removed += 1
    }
  }
  return { created, removed, count: args.count }
})

/**
 * Siembra hilos sintéticos para medir el inbox. Cada corrida deja exactamente
 * `count` hilos de medición y borra los que sobren de una corrida anterior.
 */
export const seedForDev = internalMutation({
  args: { count: v.number() },
  handler: (ctx, args) => runConvex(seedForDevProgram(ctx, args)),
})
