import { Effect } from 'effect'

import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { convexPromise, runConvex } from '../_helpers/effect'
import { intakeSupportScope, supportScopeKey } from '../_support/model'

const deleteRows = Effect.fn('IntakeStorage.deleteRows')(function* (
  ctx: MutationCtx,
  rows: Array<{
    _id:
      | Id<'intakeDocuments'>
      | Id<'intakeUploadIntents'>
      | Id<'intakeAssessments'>
      | Id<'intakeEvents'>
      | Id<'intakeProofNonces'>
      | Id<'supportThreads'>
      | Id<'supportMessages'>
  }>
) {
  yield* Effect.forEach(rows, (row) => convexPromise(() => ctx.db.delete(row._id)))
})

const deleteIntakeSupportData = Effect.fn('IntakeStorage.deleteSupportData')(function* (
  ctx: MutationCtx,
  intakeSessionId: Id<'intakeSessions'>
) {
  const scopeKey = supportScopeKey(intakeSupportScope(intakeSessionId))
  const threads = yield* convexPromise(() =>
    ctx.db
      .query('supportThreads')
      .withIndex('by_scopeKey', (q) => q.eq('scopeKey', scopeKey))
      .collect()
  )

  for (const thread of threads) {
    if (
      thread.scopeKey !== scopeKey ||
      thread.scope.kind !== 'INTAKE' ||
      thread.scope.intakeSessionId !== intakeSessionId
    ) {
      continue
    }

    const messages = yield* convexPromise(() =>
      ctx.db
        .query('supportMessages')
        .withIndex('by_thread_sequence', (q) => q.eq('threadId', thread._id))
        .collect()
    )
    yield* deleteRows(ctx, messages)
    yield* convexPromise(() => ctx.db.delete(thread._id))
  }
})

/**
 * Un blob solo se borra cuando NADIE más lo referencia. Cada consulta de aquí
 * es una custodia distinta que puede retenerlo.
 */
const hasRetainedStorageReference = Effect.fn('IntakeStorage.hasRetainedReference')(
  function* (args: {
    ctx: MutationCtx
    storageId: Id<'_storage'>
    deletingIntakeSessionId: Id<'intakeSessions'>
  }) {
    const [
      intakeDocuments,
      canonicalDocuments,
      versions,
      intakeIntents,
      vdrIntents,
      assetIntents,
    ] = yield* convexPromise(() =>
      Promise.all([
        args.ctx.db
          .query('intakeDocuments')
          .withIndex('by_storageId', (q) => q.eq('storageId', args.storageId))
          .collect(),
        args.ctx.db
          .query('documents')
          .withIndex('by_storageId', (q) => q.eq('storageId', args.storageId))
          .collect(),
        args.ctx.db
          .query('documentVersions')
          .withIndex('by_storageId', (q) => q.eq('storageId', args.storageId))
          .collect(),
        args.ctx.db
          .query('intakeUploadIntents')
          .withIndex('by_storageId', (q) => q.eq('storageId', args.storageId))
          .collect(),
        args.ctx.db
          .query('vdrUploadIntents')
          .withIndex('by_storageId', (q) => q.eq('storageId', args.storageId))
          .collect(),
        args.ctx.db
          .query('assetUploadIntents')
          .withIndex('by_storageId', (q) => q.eq('storageId', args.storageId))
          .collect(),
      ])
    )

    return (
      intakeDocuments.some((row) => row.intakeSessionId !== args.deletingIntakeSessionId) ||
      canonicalDocuments.length > 0 ||
      versions.length > 0 ||
      intakeIntents.some((row) => row.intakeSessionId !== args.deletingIntakeSessionId) ||
      vdrIntents.length > 0 ||
      assetIntents.length > 0
    )
  }
)

const deleteIntakeSessionDataEffect = Effect.fn('IntakeStorage.deleteSessionData')(function* (
  ctx: MutationCtx,
  intakeSessionId: Id<'intakeSessions'>
) {
  const [documents, intents, assessments, events, proofNonces] = yield* convexPromise(() =>
    Promise.all([
      ctx.db
        .query('intakeDocuments')
        .withIndex('by_session_createdAt', (q) => q.eq('intakeSessionId', intakeSessionId))
        .collect(),
      ctx.db
        .query('intakeUploadIntents')
        .withIndex('by_session_status', (q) => q.eq('intakeSessionId', intakeSessionId))
        .collect(),
      ctx.db
        .query('intakeAssessments')
        .withIndex('by_session', (q) => q.eq('intakeSessionId', intakeSessionId))
        .collect(),
      ctx.db
        .query('intakeEvents')
        .withIndex('by_session_createdAt', (q) => q.eq('intakeSessionId', intakeSessionId))
        .collect(),
      ctx.db
        .query('intakeProofNonces')
        .withIndex('by_sessionId', (q) => q.eq('intakeSessionId', intakeSessionId))
        .collect(),
    ])
  )

  const deletableStorageIds = new Set<Id<'_storage'>>()
  for (const document of documents) {
    if (document.storageState === 'STAGED_INTAKE') {
      deletableStorageIds.add(document.storageId)
    }
  }
  for (const intent of intents) {
    if (
      intent.storageId &&
      (intent.status === 'INSPECTING' ||
        intent.status === 'UNCERTAIN' ||
        intent.status === 'REJECTED')
    ) {
      deletableStorageIds.add(intent.storageId)
    }
  }

  for (const storageId of deletableStorageIds) {
    const retained = yield* hasRetainedStorageReference({
      ctx,
      storageId,
      deletingIntakeSessionId: intakeSessionId,
    })
    if (!retained) {
      yield* convexPromise(() => ctx.storage.delete(storageId))
    }
  }

  yield* deleteIntakeSupportData(ctx, intakeSessionId)
  yield* deleteRows(ctx, documents)
  yield* deleteRows(ctx, intents)
  yield* deleteRows(ctx, assessments)
  yield* deleteRows(ctx, events)
  yield* deleteRows(ctx, proofNonces)
  yield* convexPromise(() => ctx.db.delete(intakeSessionId))
})

export async function deleteIntakeSessionData(
  ctx: MutationCtx,
  intakeSessionId: Id<'intakeSessions'>
): Promise<void> {
  await runConvex(deleteIntakeSessionDataEffect(ctx, intakeSessionId))
}

const deleteIntakeDataForClaimedProfileEffect = Effect.fn('IntakeStorage.deleteForClaimedProfile')(
  function* (ctx: MutationCtx, profileId: Id<'profiles'>) {
    const sessions = yield* convexPromise(() =>
      ctx.db
        .query('intakeSessions')
        .withIndex('by_claimedProfileId', (q) => q.eq('claimedProfileId', profileId))
        .collect()
    )
    for (const session of sessions) {
      yield* deleteIntakeSessionDataEffect(ctx, session._id)
    }
  }
)

export async function deleteIntakeDataForClaimedProfile(
  ctx: MutationCtx,
  profileId: Id<'profiles'>
): Promise<void> {
  await runConvex(deleteIntakeDataForClaimedProfileEffect(ctx, profileId))
}
