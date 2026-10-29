import { describe, expect, it, vi } from 'vitest'

import { createFromValidatedUpload } from '../../../convex/_documents/mutations'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

describe('document mutation admin audit', () => {
  it('records a legacy validated upload performed by an ADMIN', async () => {
    const tables: Tables = {
      users: [
        {
          _id: 'user_admin',
          email: 'fixture-14e4636f@example.com',
          role: 'ADMIN',
          authProvider: 'workos',
          providerUserId: 'workos_admin',
          workosUserId: 'workos_admin',
        },
      ],
      profiles: [
        {
          _id: 'profile_admin',
          userId: 'user_admin',
          role: 'ADMIN',
          isActive: true,
        },
      ],
      companies: [{ _id: 'company_1', ownerId: 'profile_owner', name: 'Issuer' }],
      documents: [],
      documentVersions: [],
      adminAuditLogs: [],
    }
    const ctx = createConvexCtx(tables)
    Object.assign(ctx.db, {
      system: {
        get: vi.fn().mockResolvedValue({
          _id: 'storage_1',
          size: 8,
          contentType: 'application/pdf',
          sha256: 'abc123',
        }),
      },
    })

    const documentId = await runHandler(createFromValidatedUpload, ctx, {
      companyId: 'company_1',
      uploaderProfileId: 'profile_admin',
      uploaderRole: 'ADMIN',
      uploaderProviderUserId: 'workos_admin',
      name: 'Financials',
      fileType: 'application/pdf',
      storageId: 'storage_1',
      signatureKind: 'PDF',
      malwareScanStatus: 'CLEAN',
    })

    expect(documentId).toEqual(expect.any(String))
    expect(tables.adminAuditLogs).toContainEqual(
      expect.objectContaining({
        adminProfileId: 'profile_admin',
        adminEmail: 'fixture-14e4636f@example.com',
        action: 'DOCUMENT_UPLOAD',
        targetType: 'DOCUMENT',
        targetId: documentId,
        newValue: expect.objectContaining({
          versionNumber: 1,
          verificationStatus: 'SIGNATURE_VERIFIED',
          malwareScanStatus: 'CLEAN',
        }),
      })
    )
  })
})
