import { describe, expect, it } from 'vitest'

import { attachRendition } from '../../../convex/deliverables'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const ADMIN_IDENTITY = {
  issuer: 'https://api.workos.com/',
  subject: 'workos_admin',
  email: 'fixture-dbeda5ff@example.com',
}

function seed(): Tables {
  return {
    users: [
      {
        _id: 'user_admin',
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'fixture-dbeda5ff@example.com',
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
    deliverables: [
      {
        _id: 'deliverable_1',
        companyId: 'company_1',
        kind: 'TEASER',
        status: 'DRAFT_READY',
        updatedAt: 1_900_000_000_000,
      },
    ],
    documents: [
      {
        _id: 'rendition_document',
        companyId: 'company_1',
        name: 'teaser.html',
        lifecycleStatus: 'ACTIVE',
      },
      {
        _id: 'source_document',
        companyId: 'company_1',
        name: 'financials.pdf',
        lifecycleStatus: 'ACTIVE',
      },
      {
        _id: 'other_document',
        companyId: 'company_2',
        name: 'other-company.pdf',
        lifecycleStatus: 'ACTIVE',
      },
    ],
    documentVersions: [
      {
        _id: 'source_version',
        documentId: 'source_document',
        companyId: 'company_1',
        versionNumber: 1,
        verificationStatus: 'SIGNATURE_VERIFIED',
      },
      {
        _id: 'other_version',
        documentId: 'other_document',
        companyId: 'company_2',
        versionNumber: 1,
        verificationStatus: 'SIGNATURE_VERIFIED',
      },
      // Lo que deja un push de operador sin firma verificable: el DOCUMENTO
      // sigue ACTIVE (la sala sirve la v1) y solo la fila esta en cuarentena.
      {
        _id: 'quarantined_version',
        documentId: 'source_document',
        companyId: 'company_1',
        versionNumber: 2,
        verificationStatus: 'QUARANTINED',
        publicationStatus: 'DRAFT',
      },
      // La v1 sintetica del ingest: QUARANTINED pero SUPERSEDED, historia real
      // de un documento legacy que si se sirvio.
      {
        _id: 'legacy_version',
        documentId: 'source_document',
        companyId: 'company_1',
        versionNumber: 0,
        verificationStatus: 'QUARANTINED',
        publicationStatus: 'SUPERSEDED',
      },
    ],
  }
}

describe('deliverable rendition source authorization', () => {
  it('rejects a source version from another company before patching the deliverable', async () => {
    const ctx = createConvexCtx(seed(), { identity: ADMIN_IDENTITY })

    await expect(
      runHandler(attachRendition, ctx, {
        deliverableId: 'deliverable_1',
        format: 'HTML',
        documentId: 'rendition_document',
        inputManifest: ['other_version'],
      })
    ).rejects.toThrow(/fuente|empresa|autorizad/i)

    expect(ctx.db.patch).not.toHaveBeenCalled()
    expect(ctx.tables.adminAuditLogs ?? []).toHaveLength(0)
  })

  it('persists only validated source versions and records their count in the audit evidence', async () => {
    const ctx = createConvexCtx(seed(), { identity: ADMIN_IDENTITY })

    await runHandler(attachRendition, ctx, {
      deliverableId: 'deliverable_1',
      format: 'HTML',
      documentId: 'rendition_document',
      inputManifest: ['source_version', 'source_version'],
    })

    expect(ctx.tables.deliverables[0]).toMatchObject({ inputManifest: ['source_version'] })
    expect(ctx.tables.adminAuditLogs).toEqual([
      expect.objectContaining({
        action: 'DELIVERABLE_RENDITION_ATTACH',
        newValue: expect.objectContaining({ sourceVersionCount: 1 }),
      }),
    ])
  })

  // El chequeo rechazaba solo REJECTED. Una version en cuarentena pasaba porque
  // su DOCUMENTO se queda ACTIVE, y el manifiesto — evidencia GIGO auditable —
  // terminaba citando bytes que la sala nunca sirvio.
  it('rejects a quarantined draft source version', async () => {
    const ctx = createConvexCtx(seed(), { identity: ADMIN_IDENTITY })

    await expect(
      runHandler(attachRendition, ctx, {
        deliverableId: 'deliverable_1',
        format: 'HTML',
        documentId: 'rendition_document',
        inputManifest: ['quarantined_version'],
      })
    ).rejects.toThrow(/fuente|autorizad/i)

    expect(ctx.db.patch).not.toHaveBeenCalled()
  })

  it('still accepts the superseded legacy version: it was served', async () => {
    const ctx = createConvexCtx(seed(), { identity: ADMIN_IDENTITY })

    await runHandler(attachRendition, ctx, {
      deliverableId: 'deliverable_1',
      format: 'HTML',
      documentId: 'rendition_document',
      inputManifest: ['legacy_version'],
    })

    expect(ctx.tables.deliverables[0]).toMatchObject({ inputManifest: ['legacy_version'] })
  })
})
