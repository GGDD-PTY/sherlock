import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hashIntakeSessionToken } from '../../../convex/_intake/crypto'
import { INTAKE_MAX_ASSESSMENTS_PER_SESSION } from '../../../convex/_intake/model'
import {
  getAdminIntakeWorkspace,
  projectWorkspace,
  recordIntakeAssessment,
  rotateSession,
} from '../../../convex/intake'
import { createIntakeServerProof } from '../../lib/intake/proof'
import { createConvexCtx, runHandler, type Row, type Tables } from './nda-convex-harness'

const SECRET = 'intake-assessment-secret-for-tests-1234567890' // gitleaks:allow -- deterministic test fixture, not a provider credential
const AUDIENCE = 'sherlock-test:intake-assessment'
const ADMIN_SUBJECT = 'workos_admin'
const SESSION_TOKEN_1 = 's'.repeat(43)
const SESSION_TOKEN_2 = 't'.repeat(43)
let proofNonce = 0

function row(overrides: Partial<Row> & Pick<Row, '_id'>): Row {
  return { _creationTime: 1, ...overrides }
}

async function assessmentTables(): Promise<Tables> {
  return {
    users: [
      row({
        _id: 'user_admin',
        authProvider: 'workos',
        providerUserId: ADMIN_SUBJECT,
        workosUserId: ADMIN_SUBJECT,
        email: 'admin@example.com',
        role: 'ADMIN',
      }),
    ],
    profiles: [row({ _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true })],
    intakeSessions: [
      row({
        _id: 'session_1',
        sessionTokenHash: await hashIntakeSessionToken(SESSION_TOKEN_1),
        anonymousKeyHash: 'a'.repeat(64),
        audience: AUDIENCE,
        status: 'ACTIVE',
        claimStatus: 'UNCLAIMED',
        createdAt: 100,
        accessExpiresAt: Date.now() + 60_000,
        absoluteExpiresAt: Date.now() + 120_000,
        deletionProofExpiresAt: Date.now() + 180_000,
        rotationCount: 0,
        documentCount: 1,
        totalStagedBytes: 10,
      }),
      row({
        _id: 'session_2',
        sessionTokenHash: await hashIntakeSessionToken(SESSION_TOKEN_2),
        anonymousKeyHash: 'b'.repeat(64),
        audience: AUDIENCE,
        status: 'ACTIVE',
        claimStatus: 'UNCLAIMED',
        createdAt: 200,
        accessExpiresAt: Date.now() + 60_000,
        absoluteExpiresAt: Date.now() + 120_000,
        deletionProofExpiresAt: Date.now() + 180_000,
        rotationCount: 0,
        documentCount: 1,
        totalStagedBytes: 10,
      }),
    ],
    intakeDocuments: [
      row({
        _id: 'document_1',
        intakeSessionId: 'session_1',
        displayName: 'statements.pdf',
        declaredMimeType: 'application/pdf',
        byteSize: 10,
        storageState: 'STAGED_INTAKE',
        inspectionStatus: 'CLEAN',
        claimable: true,
        createdAt: 100,
      }),
      row({
        _id: 'document_2',
        intakeSessionId: 'session_2',
        displayName: 'other-session.pdf',
        declaredMimeType: 'application/pdf',
        byteSize: 10,
        storageState: 'STAGED_INTAKE',
        inspectionStatus: 'CLEAN',
        claimable: true,
        createdAt: 200,
      }),
    ],
    intakeAssessments: [],
    intakeUploadIntents: [],
    intakeEvents: [],
    intakeProofNonces: [],
    adminAuditLogs: [],
  }
}

function proof(operation: 'PROJECT_WORKSPACE' | 'ROTATE_SESSION', ...bindingParts: string[]) {
  proofNonce += 1
  return createIntakeServerProof({
    operation,
    bindingParts,
    nonce: `assessment_nonce_${String(proofNonce).padStart(24, '0')}`,
    secret: SECRET,
    audience: AUDIENCE,
  })
}

function adminContext(tables: Tables) {
  return createConvexCtx(tables, {
    identity: {
      subject: ADMIN_SUBJECT,
      issuer: 'https://api.workos.com/',
      email: 'admin@example.com',
    },
  })
}

describe('normalized intake assessments', () => {
  beforeEach(() => {
    proofNonce = 0
    vi.stubEnv('INTAKE_DEMO_MODE', 'true')
    vi.stubEnv('INTAKE_SERVER_SECRET', SECRET)
    vi.stubEnv('INTAKE_SERVER_AUDIENCE', AUDIENCE)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('records a bounded external assessment, preserves pending review, and audits the admin write', async () => {
    const tables = await assessmentTables()
    const ctx = adminContext(tables)

    const result = (await runHandler(recordIntakeAssessment, ctx, {
      intakeSessionId: 'session_1',
      source: 'EXTERNAL',
      findings: [
        {
          category: 'financialStatements',
          evidenceDocumentIds: ['document_1'],
          confidence: 0.8,
          reviewState: 'PENDING',
        },
      ],
    })) as { id: string }

    expect(result).toMatchObject({
      intakeSessionId: 'session_1',
      status: 'NEEDS_REVIEW',
      source: 'EXTERNAL',
      findings: [
        {
          category: 'financialStatements',
          evidenceDocumentIds: ['document_1'],
          confidence: 0.8,
          reviewState: 'PENDING',
        },
      ],
    })
    expect(tables.intakeAssessments).toHaveLength(1)
    expect(tables.adminAuditLogs).toHaveLength(1)
    expect(tables.adminAuditLogs[0]).toMatchObject({
      adminProfileId: 'profile_admin',
      targetId: result.id,
    })
  })

  it('allows the assessment cap but rejects the next write without inserting it', async () => {
    const tables = await assessmentTables()
    tables.intakeAssessments.push(
      ...Array.from({ length: INTAKE_MAX_ASSESSMENTS_PER_SESSION - 1 }, (_, index) =>
        row({
          _id: `assessment_existing_${index}`,
          intakeSessionId: 'session_1',
          status: 'PENDING',
          source: 'EXTERNAL',
          findings: [],
          createdAt: index + 1,
          updatedAt: index + 1,
        })
      )
    )
    const ctx = adminContext(tables)
    const input = {
      intakeSessionId: 'session_1',
      source: 'EXTERNAL',
      findings: [],
    }

    await expect(runHandler(recordIntakeAssessment, ctx, input)).resolves.toMatchObject({
      status: 'PENDING',
    })
    expect(tables.intakeAssessments).toHaveLength(INTAKE_MAX_ASSESSMENTS_PER_SESSION)
    const auditLogCountAtCap = tables.adminAuditLogs.length

    await expect(runHandler(recordIntakeAssessment, ctx, input)).rejects.toThrow(/límite|limit/i)
    expect(tables.intakeAssessments).toHaveLength(INTAKE_MAX_ASSESSMENTS_PER_SESSION)
    expect(tables.adminAuditLogs).toHaveLength(auditLogCountAtCap)
  })

  it('projects a safe admin intake workspace and rejects a cross-company scope', async () => {
    const tables = await assessmentTables()
    tables.intakeAssessments.push(
      row({
        _id: 'assessment_latest',
        intakeSessionId: 'session_1',
        status: 'NEEDS_REVIEW',
        source: 'EXTERNAL',
        findings: [
          {
            category: 'financialStatements',
            evidenceDocumentIds: ['document_1'],
            confidence: 0.8,
            reviewState: 'PENDING',
          },
        ],
        createdAt: 300,
        updatedAt: 300,
      })
    )
    const ctx = adminContext(tables)

    const projected = await runHandler(getAdminIntakeWorkspace, ctx, {
      intakeSessionId: 'session_1',
    })

    expect(projected).toMatchObject({
      intakeSessionId: 'session_1',
      documents: [
        {
          id: 'document_1',
          displayName: 'statements.pdf',
          declaredMimeType: 'application/pdf',
        },
      ],
      assessment: {
        id: 'assessment_latest',
        status: 'NEEDS_REVIEW',
        findings: [{ category: 'financialStatements', evidenceDocumentIds: ['document_1'] }],
      },
    })
    expect(JSON.stringify(projected)).not.toContain('storageId')
    expect(tables.adminAuditLogs).toHaveLength(1)
    expect(tables.adminAuditLogs[0]).toMatchObject({
      adminProfileId: 'profile_admin',
      action: 'SYSTEM_CONFIG_CHANGE',
      targetType: 'SYSTEM',
      targetId: 'session_1',
      notes: 'INTAKE_WORKSPACE_READ',
      newValue: {
        operation: 'INTAKE_WORKSPACE_READ',
        intakeSessionId: 'session_1',
        companyId: null,
        sessionStatus: 'ACTIVE',
        documentCount: 1,
        assessmentId: 'assessment_latest',
        assessmentStatus: 'NEEDS_REVIEW',
      },
    })
    expect(tables.rateLimits).toHaveLength(1)
    expect(tables.rateLimits[0]).toMatchObject({
      key: 'adminIntakeWorkspaceRead:profile_admin',
      count: 1,
    })

    tables.intakeSessions[0].claimedCompanyId = 'company_one'
    await expect(
      runHandler(getAdminIntakeWorkspace, ctx, {
        intakeSessionId: 'session_1',
        companyId: 'company_two',
      })
    ).rejects.toThrow(/empresa|company|scope/i)

    await expect(
      runHandler(getAdminIntakeWorkspace, ctx, { intakeSessionId: 'session_missing' })
    ).rejects.toThrow(/no existe|not found|session/i)

    tables.users[0].role = 'COMPANY'
    tables.profiles[0].role = 'COMPANY'
    await expect(
      runHandler(getAdminIntakeWorkspace, adminContext(tables), { intakeSessionId: 'session_1' })
    ).rejects.toThrow(/admin|administr/i)
  })

  it('requires an authenticated admin profile before writing assessment state', async () => {
    const tables = await assessmentTables()
    tables.users[0].role = 'COMPANY'
    tables.profiles[0].role = 'COMPANY'
    const ctx = adminContext(tables)

    await expect(
      runHandler(recordIntakeAssessment, ctx, {
        intakeSessionId: 'session_1',
        source: 'TEAM',
        findings: [],
      })
    ).rejects.toThrow(/admin|administr/i)
    expect(tables.intakeAssessments).toHaveLength(0)
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  it('rejects evidence documents from another intake session before writing an assessment', async () => {
    const tables = await assessmentTables()
    const ctx = adminContext(tables)

    await expect(
      runHandler(recordIntakeAssessment, ctx, {
        intakeSessionId: 'session_1',
        source: 'TEAM',
        findings: [
          {
            category: 'pitch',
            evidenceDocumentIds: ['document_2'],
            confidence: 1,
            reviewState: 'CONFIRMED',
          },
        ],
      })
    ).rejects.toThrow(/sesión|session/i)
    expect(tables.intakeAssessments).toHaveLength(0)
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  it('rejects unsupported categories and confidence outside the closed interval', async () => {
    const tables = await assessmentTables()
    const ctx = adminContext(tables)

    for (const finding of [
      {
        category: 'filenameInference',
        evidenceDocumentIds: [],
        confidence: 0.5,
        reviewState: 'PENDING',
      },
      {
        category: 'country',
        evidenceDocumentIds: [],
        confidence: 1.1,
        reviewState: 'PENDING',
      },
      {
        category: 'country',
        evidenceDocumentIds: [],
        confidence: -0.01,
        reviewState: 'PENDING',
      },
    ]) {
      await expect(
        runHandler(recordIntakeAssessment, ctx, {
          intakeSessionId: 'session_1',
          source: 'EXTERNAL',
          findings: [finding],
        })
      ).rejects.toThrow()
    }

    expect(tables.intakeAssessments).toHaveLength(0)
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  it('rejects external review decisions and status values that hide pending human work', async () => {
    const tables = await assessmentTables()
    const ctx = adminContext(tables)

    for (const input of [
      {
        status: 'NEEDS_REVIEW',
        reviewState: 'CONFIRMED',
      },
      {
        status: 'READY',
        reviewState: 'REJECTED',
      },
      {
        status: 'PENDING',
        reviewState: 'PENDING',
      },
    ] as const) {
      await expect(
        runHandler(recordIntakeAssessment, ctx, {
          intakeSessionId: 'session_1',
          source: 'EXTERNAL',
          status: input.status,
          findings: [
            {
              category: 'financialStatements',
              evidenceDocumentIds: ['document_1'],
              confidence: 0.8,
              reviewState: input.reviewState,
            },
          ],
        })
      ).rejects.toThrow(/revisión|review|estado|status/i)
    }

    expect(tables.intakeAssessments).toHaveLength(0)
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  it('projects only the latest assessment inside the proof-protected session workspace', async () => {
    const tables = await assessmentTables()
    const ctx = adminContext(tables)

    await runHandler(recordIntakeAssessment, ctx, {
      intakeSessionId: 'session_1',
      source: 'EXTERNAL',
      findings: [
        {
          category: 'country',
          evidenceDocumentIds: [],
          confidence: 0.4,
          reviewState: 'PENDING',
        },
      ],
    })
    const latest = (await runHandler(recordIntakeAssessment, ctx, {
      intakeSessionId: 'session_1',
      source: 'TEAM',
      findings: [
        {
          category: 'country',
          evidenceDocumentIds: [],
          confidence: 1,
          reviewState: 'CONFIRMED',
        },
      ],
    })) as { id: string }
    await runHandler(recordIntakeAssessment, ctx, {
      intakeSessionId: 'session_2',
      source: 'TEAM',
      findings: [
        {
          category: 'country',
          evidenceDocumentIds: [],
          confidence: 1,
          reviewState: 'CONFIRMED',
        },
      ],
    })

    const projected = await runHandler(projectWorkspace, ctx, {
      sessionToken: SESSION_TOKEN_1,
      ...proof('PROJECT_WORKSPACE', SESSION_TOKEN_1),
    })

    expect(projected).toMatchObject({
      authenticated: true,
      assessment: {
        id: latest.id,
        intakeSessionId: 'session_1',
        source: 'TEAM',
        status: 'READY',
        findings: [
          {
            category: 'country',
            confidence: 1,
            reviewState: 'CONFIRMED',
            evidenceDocumentIds: [],
          },
        ],
      },
    })
    expect(JSON.stringify(projected)).not.toContain('session_2')
  })

  it('fails closed if a persisted assessment contains cross-session evidence', async () => {
    const tables = await assessmentTables()
    tables.intakeAssessments.push(
      row({
        _id: 'assessment_corrupt',
        intakeSessionId: 'session_1',
        status: 'READY',
        source: 'TEAM',
        findings: [
          {
            category: 'country',
            evidenceDocumentIds: ['document_2'],
            confidence: 1,
            reviewState: 'CONFIRMED',
          },
        ],
        createdAt: 300,
        updatedAt: 300,
      })
    )
    const ctx = adminContext(tables)

    await expect(
      runHandler(projectWorkspace, ctx, {
        sessionToken: SESSION_TOKEN_1,
        ...proof('PROJECT_WORKSPACE', SESSION_TOKEN_1),
      })
    ).rejects.toThrow(/evidencia|evidence|sesión|session/i)
  })

  it('binds rotated name evidence into the proof and projects normalized identity', async () => {
    const tables = await assessmentTables()
    const ctx = adminContext(tables)
    const rawName = '  Nuevo   Nombre  '

    await expect(
      runHandler(rotateSession, ctx, {
        sessionToken: SESSION_TOKEN_1,
        identityName: rawName,
        ...proof('ROTATE_SESSION', SESSION_TOKEN_1),
      })
    ).rejects.toThrow(/autorizada|authorized/i)

    const rotated = await runHandler(rotateSession, ctx, {
      sessionToken: SESSION_TOKEN_1,
      identityName: rawName,
      ...proof('ROTATE_SESSION', SESSION_TOKEN_1, rawName),
    })

    expect(tables.intakeSessions[0]).toMatchObject({
      identityEvidence: {
        kind: 'NAME',
        name: 'Nuevo Nombre',
        capturedAt: expect.any(Number),
      },
    })
    expect(rotated).toMatchObject({
      rotated: true,
      workspace: { identityName: 'Nuevo Nombre' },
    })
  })

  it('does not infer findings from document names and leaves an empty assessment pending', async () => {
    const tables = await assessmentTables()
    tables.intakeDocuments[0].displayName =
      '2022 2023 audited financial statements Panama debt pitch.pdf'
    const ctx = adminContext(tables)

    const result = await runHandler(recordIntakeAssessment, ctx, {
      intakeSessionId: 'session_1',
      source: 'EXTERNAL',
      findings: [],
    })

    expect(result).toMatchObject({ status: 'PENDING', findings: [] })
    expect((result as Record<string, unknown>).inferred).toBeUndefined()
  })
})
