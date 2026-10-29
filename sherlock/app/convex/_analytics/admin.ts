import { v } from 'convex/values'
import { Effect } from 'effect'

import type { QueryCtx } from '../_generated/server'
import { query } from '../_generated/server'
import { requireAuthAdmin } from '../_helpers/auth'
import { convexPromise, runConvex } from '../_helpers/effect'
import { buildRecentActivityEffect } from './shared'

const ADMIN_OPERATIONS_SCAN_CAP = 500
const ADMIN_COMPANY_DOCUMENT_COVERAGE_CAP = 20

const operationsOverview = Effect.fn('Analytics.operationsOverview')(function* (ctx: QueryCtx) {
  yield* convexPromise(() => requireAuthAdmin(ctx))
  const now = Date.now()
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000
  const [
    companyRows,
    intakeRows,
    documentRows,
    deliverableRows,
    guestRows,
    supportRows,
  ] = yield* convexPromise(() =>
    Promise.all([
      ctx.db
        .query('companies')
        .order('desc')
        .take(ADMIN_OPERATIONS_SCAN_CAP + 1),
      ctx.db
        .query('intakeSessions')
        .order('desc')
        .take(ADMIN_OPERATIONS_SCAN_CAP + 1),
      ctx.db
        .query('documents')
        .withIndex('by_creation_time')
        .order('desc')
        .take(ADMIN_OPERATIONS_SCAN_CAP + 1),
      ctx.db
        .query('deliverables')
        .order('desc')
        .take(ADMIN_OPERATIONS_SCAN_CAP + 1),
      ctx.db
        .query('guestInvitations')
        .order('desc')
        .take(ADMIN_OPERATIONS_SCAN_CAP + 1),
      ctx.db
        .query('supportThreads')
        .order('desc')
        .take(ADMIN_OPERATIONS_SCAN_CAP + 1),
    ])
  )
  const operationsTruncated = [
    companyRows,
    intakeRows,
    documentRows,
    deliverableRows,
    guestRows,
    supportRows,
  ].some((table) => table.length > ADMIN_OPERATIONS_SCAN_CAP)
  const companies = companyRows.slice(0, ADMIN_OPERATIONS_SCAN_CAP)
  const intake = intakeRows.slice(0, ADMIN_OPERATIONS_SCAN_CAP)
  const documents = documentRows.slice(0, ADMIN_OPERATIONS_SCAN_CAP)
  const deliverables = deliverableRows.slice(0, ADMIN_OPERATIONS_SCAN_CAP)
  const guests = guestRows.slice(0, ADMIN_OPERATIONS_SCAN_CAP)
  const support = supportRows.slice(0, ADMIN_OPERATIONS_SCAN_CAP)
  const companyDocuments = yield* convexPromise(() =>
    Promise.all(
      companies.slice(0, ADMIN_COMPANY_DOCUMENT_COVERAGE_CAP).map(async (company) => {
        const companyDocumentRows = await ctx.db
          .query('documents')
          .withIndex('by_companyId', (q) => q.eq('companyId', company._id))
          .take(ADMIN_OPERATIONS_SCAN_CAP + 1)
        const documentsForCompany = companyDocumentRows.slice(0, ADMIN_OPERATIONS_SCAN_CAP)

        return {
          companyId: company._id,
          companyName: company.name,
          truncated: companyDocumentRows.length > ADMIN_OPERATIONS_SCAN_CAP,
          active: documentsForCompany.filter(
            (document) =>
              document.lifecycleStatus === undefined || document.lifecycleStatus === 'ACTIVE'
          ).length,
          quarantined: documentsForCompany.filter(
            (document) => document.lifecycleStatus === 'QUARANTINED'
          ).length,
          archived: documentsForCompany.filter(
            (document) => document.lifecycleStatus === 'ARCHIVED'
          ).length,
        }
      })
    )
  )
  const truncated = operationsTruncated || companyDocuments.some((company) => company.truncated)
  return {
    companies: {
      total: companies.length,
      newThisMonth: companies.filter((company) => company._creationTime >= monthAgo).length,
    },
    intake: {
      active: intake.filter((session) => session.status === 'ACTIVE').length,
      claimed: intake.filter((session) => session.status === 'CLAIMED').length,
      stagedDocuments: intake
        .filter((session) => session.status === 'ACTIVE' || session.status === 'CLAIMED')
        .reduce((total, session) => total + session.documentCount, 0),
    },
    documents: {
      active: documents.filter(
        (document) =>
          document.lifecycleStatus === undefined || document.lifecycleStatus === 'ACTIVE'
      ).length,
      quarantined: documents.filter((document) => document.lifecycleStatus === 'QUARANTINED')
        .length,
      archived: documents.filter((document) => document.lifecycleStatus === 'ARCHIVED').length,
    },
    deliverables: {
      open: deliverables.filter(
        (deliverable) => deliverable.status !== 'APPROVED' && deliverable.status !== 'DELIVERED'
      ).length,
      reviewQueue: deliverables.filter(
        (deliverable) => deliverable.status === 'DRAFT_READY' || deliverable.status === 'IN_REVIEW'
      ).length,
      approved: deliverables.filter((deliverable) => deliverable.status === 'APPROVED').length,
      delivered: deliverables.filter((deliverable) => deliverable.status === 'DELIVERED').length,
    },
    guests: {
      pending: guests.filter((guest) => guest.status === 'PENDING').length,
      verified: guests.filter((guest) => guest.status === 'VERIFIED').length,
    },
    support: {
      unread: support.reduce((total, thread) => total + thread.adminUnreadCount, 0),
    },
    companyDocuments: {
      companyCap: ADMIN_COMPANY_DOCUMENT_COVERAGE_CAP,
      companies: companyDocuments,
    },
    coverage: { truncated, scanCap: ADMIN_OPERATIONS_SCAN_CAP },
    generatedAt: now,
  }
})

export const getOperationsOverview = query({
  args: {},
  handler: (ctx) => runConvex(operationsOverview(ctx)),
})

const recentActivity = Effect.fn('Analytics.adminRecentActivity')(function* (
  ctx: QueryCtx,
  limit: number
) {
  yield* convexPromise(() => requireAuthAdmin(ctx))
  return yield* buildRecentActivityEffect(ctx, limit)
})

export const getRecentActivity = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: (ctx, args) => runConvex(recentActivity(ctx, args.limit || 10)),
})
