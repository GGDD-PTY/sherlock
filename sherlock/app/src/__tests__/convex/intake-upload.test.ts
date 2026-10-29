import { describe, expect, it, vi } from 'vitest'

import { INTAKE_MAX_ROTATIONS, isIntakeDocumentClaimable } from '../../../convex/_intake/model'
import {
  deleteIntakeDataForClaimedProfile,
  deleteIntakeSessionData,
} from '../../../convex/_intake/storage'
import { _prepareUpload, inspectAndRegisterUpload } from '../../../convex/intake'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

describe('intake staging custody', () => {
  it('keeps token rotation bounded independently of document counts', () => {
    expect(INTAKE_MAX_ROTATIONS).toBeLessThanOrEqual(48)
  })

  it('keeps truthful scanner state and only accepts NOT_CONFIGURED in an optional-scanner deployment', () => {
    const base = {
      storageState: 'STAGED_INTAKE' as const,
      inspectionStatus: 'CLEAN' as const,
      claimable: true,
    }
    expect(isIntakeDocumentClaimable(base)).toBe(true)
    expect(
      isIntakeDocumentClaimable({ ...base, inspectionStatus: 'UNINSPECTED', claimable: false })
    ).toBe(false)
    expect(
      isIntakeDocumentClaimable({ ...base, inspectionStatus: 'SUSPICIOUS', claimable: false })
    ).toBe(false)
    expect(
      isIntakeDocumentClaimable(
        { ...base, inspectionStatus: 'NOT_CONFIGURED' },
        { CONVEX_ENV: 'dev' }
      )
    ).toBe(true)
    expect(
      isIntakeDocumentClaimable(
        { ...base, inspectionStatus: 'NOT_CONFIGURED' },
        { CONVEX_ENV: 'production' }
      )
    ).toBe(false)
    expect(
      isIntakeDocumentClaimable({ ...base, storageState: 'OWNED_BY_COMPANY', claimable: true })
    ).toBe(false)
  })

  it('persists NOT_CONFIGURED instead of quarantining when the deployment allows no scanner', async () => {
    vi.stubEnv('CONVEX_ENV', 'dev')
    vi.stubEnv('VDR_FILE_SCANNER_URL', '')
    vi.stubEnv('VDR_FILE_SCANNER_TOKEN', '')
    const blob = new Blob([new TextEncoder().encode('%PDF-1.7\nfixture')], {
      type: 'application/pdf',
    })
    const finalized = vi.fn(async (args: Record<string, unknown>) => ({
      registered: true,
      document: {
        id: 'intake_document_not_configured',
        inspectionStatus: args.inspectionStatus,
        claimable: true,
      },
    }))
    const runMutation = vi.fn(async (_reference: unknown, args: Record<string, unknown>) => {
      if ('inspectionStatus' in args) return await finalized(args)
      return {
        status: 'READY',
        size: blob.size,
        sha256: 'a'.repeat(64),
        contentType: 'application/pdf',
      }
    })
    const ctx = {
      runMutation,
      storage: { get: vi.fn(async () => blob) },
    }

    const result = await runHandler(inspectAndRegisterUpload, ctx as never, {
      sessionToken: 's'.repeat(43),
      intentId: 'intent_not_configured',
      storageId: 'storage_not_configured',
      serverIssuedAt: Date.now(),
      proofNonce: 'n'.repeat(32),
      serverProof: 'p'.repeat(43),
    })

    expect(result).toMatchObject({
      registered: true,
      document: { inspectionStatus: 'NOT_CONFIGURED', claimable: true },
    })
    expect(finalized).toHaveBeenCalledWith(
      expect.objectContaining({
        inspectionStatus: 'NOT_CONFIGURED',
      })
    )
    expect(finalized.mock.calls[0]![0]).not.toHaveProperty('quarantineReason')
  })

  it('deletes an explicitly requested intake blob only when no retained reference still owns it', async () => {
    const tables: Tables = {
      intakeSessions: [
        {
          _id: 'session_delete',
          status: 'ACTIVE',
        },
      ],
      intakeDocuments: [
        {
          _id: 'intake_document_delete',
          intakeSessionId: 'session_delete',
          storageId: 'storage_delete',
          storageState: 'STAGED_INTAKE',
        },
      ],
      intakeUploadIntents: [],
      intakeAssessments: [],
      intakeEvents: [],
      intakeProofNonces: [],
      documents: [],
      documentVersions: [],
      vdrUploadIntents: [],
      assetUploadIntents: [],
    }
    const ctx = createConvexCtx(tables)
    const deleteBlob = vi.fn(async () => undefined)
    Object.assign(ctx, { storage: { delete: deleteBlob } })

    await deleteIntakeSessionData(ctx as never, 'session_delete' as never)

    expect(deleteBlob).toHaveBeenCalledWith('storage_delete')
    expect(tables.intakeSessions).toHaveLength(0)
    expect(tables.intakeDocuments).toHaveLength(0)
  })

  it('deletes intake-scoped support messages and thread with the session metadata', async () => {
    const tables: Tables = {
      intakeSessions: [
        {
          _id: 'session_delete',
          status: 'ACTIVE',
        },
      ],
      intakeDocuments: [],
      intakeUploadIntents: [],
      intakeAssessments: [],
      intakeEvents: [],
      intakeProofNonces: [],
      supportThreads: [
        {
          _id: 'intake_support_thread',
          scope: { kind: 'INTAKE', intakeSessionId: 'session_delete' },
          scopeKey: 'intake:session_delete',
        },
      ],
      supportMessages: [
        {
          _id: 'intake_support_message',
          threadId: 'intake_support_thread',
        },
      ],
      documents: [],
      documentVersions: [],
      vdrUploadIntents: [],
      assetUploadIntents: [],
    }
    const ctx = createConvexCtx(tables)

    await deleteIntakeSessionData(ctx as never, 'session_delete' as never)

    expect(tables.supportMessages).toHaveLength(0)
    expect(tables.supportThreads).toHaveLength(0)
  })

  it('cleans an attributed orphan only during explicit intake deletion', async () => {
    const tables: Tables = {
      intakeSessions: [{ _id: 'session_orphan', status: 'ACTIVE' }],
      intakeDocuments: [],
      intakeUploadIntents: [
        {
          _id: 'intent_orphan',
          intakeSessionId: 'session_orphan',
          status: 'INSPECTING',
          storageId: 'storage_orphan',
        },
      ],
      intakeAssessments: [],
      intakeEvents: [],
      intakeProofNonces: [],
      documents: [],
      documentVersions: [],
      vdrUploadIntents: [],
      assetUploadIntents: [],
    }
    const ctx = createConvexCtx(tables)
    const deleteBlob = vi.fn(async () => undefined)
    Object.assign(ctx, { storage: { delete: deleteBlob } })

    await deleteIntakeSessionData(ctx as never, 'session_orphan' as never)

    expect(deleteBlob).toHaveBeenCalledWith('storage_orphan')
    expect(tables.intakeUploadIntents).toHaveLength(0)
  })

  it('deletes unreferenced rejected intent blobs while preserving shared storage references', async () => {
    const tables: Tables = {
      intakeSessions: [
        { _id: 'session_rejected_cleanup', status: 'ACTIVE' },
        { _id: 'session_rejected_other', status: 'ACTIVE' },
      ],
      intakeDocuments: [],
      intakeUploadIntents: [
        {
          _id: 'intent_rejected_unreferenced',
          intakeSessionId: 'session_rejected_cleanup',
          status: 'REJECTED',
          storageId: 'storage_rejected_unreferenced',
        },
        {
          _id: 'intent_rejected_shared',
          intakeSessionId: 'session_rejected_cleanup',
          status: 'REJECTED',
          storageId: 'storage_rejected_shared',
        },
        {
          _id: 'intent_rejected_other_session',
          intakeSessionId: 'session_rejected_other',
          status: 'REJECTED',
          storageId: 'storage_rejected_shared',
        },
      ],
      intakeAssessments: [],
      intakeEvents: [],
      intakeProofNonces: [],
      documents: [],
      documentVersions: [],
      vdrUploadIntents: [],
      assetUploadIntents: [],
    }
    const ctx = createConvexCtx(tables)
    const deleteBlob = vi.fn(async () => undefined)
    Object.assign(ctx, { storage: { delete: deleteBlob } })

    await deleteIntakeSessionData(ctx as never, 'session_rejected_cleanup' as never)

    expect(deleteBlob).toHaveBeenCalledTimes(1)
    expect(deleteBlob).toHaveBeenCalledWith('storage_rejected_unreferenced')
    expect(deleteBlob).not.toHaveBeenCalledWith('storage_rejected_shared')
    expect(tables.intakeUploadIntents).toEqual([
      expect.objectContaining({
        _id: 'intent_rejected_other_session',
        storageId: 'storage_rejected_shared',
      }),
    ])
  })

  it('never deletes a blob that canonical company custody still references', async () => {
    const tables: Tables = {
      intakeSessions: [{ _id: 'session_claimed', status: 'CLAIMED' }],
      intakeDocuments: [
        {
          _id: 'intake_document_claimed',
          intakeSessionId: 'session_claimed',
          storageId: 'storage_shared',
          storageState: 'OWNED_BY_COMPANY',
        },
      ],
      intakeUploadIntents: [],
      intakeAssessments: [],
      intakeEvents: [],
      intakeProofNonces: [],
      documents: [
        {
          _id: 'company_document',
          companyId: 'company_1',
          storageId: 'storage_shared',
        },
      ],
      documentVersions: [],
      vdrUploadIntents: [],
      assetUploadIntents: [],
    }
    const ctx = createConvexCtx(tables)
    const deleteBlob = vi.fn(async () => undefined)
    Object.assign(ctx, { storage: { delete: deleteBlob } })

    await deleteIntakeSessionData(ctx as never, 'session_claimed' as never)

    expect(deleteBlob).not.toHaveBeenCalled()
    expect(tables.documents).toHaveLength(1)
    expect(tables.intakeSessions).toHaveLength(0)
  })

  it('erases linked intake support while preserving company-scoped support', async () => {
    const tables: Tables = {
      intakeSessions: [
        {
          _id: 'session_claimed',
          status: 'CLAIMED',
          claimedProfileId: 'profile_target',
        },
      ],
      intakeDocuments: [],
      intakeUploadIntents: [],
      intakeAssessments: [],
      intakeEvents: [],
      intakeProofNonces: [],
      supportThreads: [
        {
          _id: 'intake_support_thread',
          scope: { kind: 'INTAKE', intakeSessionId: 'session_claimed' },
          scopeKey: 'intake:session_claimed',
        },
        {
          _id: 'company_support_thread',
          scope: { kind: 'COMPANY', companyId: 'company_target' },
          scopeKey: 'company:company_target',
        },
      ],
      supportMessages: [
        { _id: 'intake_support_message', threadId: 'intake_support_thread' },
        { _id: 'company_support_message', threadId: 'company_support_thread' },
      ],
      documents: [],
      documentVersions: [],
      vdrUploadIntents: [],
      assetUploadIntents: [],
    }
    const ctx = createConvexCtx(tables)

    await deleteIntakeDataForClaimedProfile(ctx as never, 'profile_target' as never)

    expect(tables.intakeSessions).toHaveLength(0)
    expect(tables.supportThreads.map((thread) => thread._id)).toEqual(['company_support_thread'])
    expect(tables.supportMessages.map((message) => message._id)).toEqual([
      'company_support_message',
    ])
  })
})
