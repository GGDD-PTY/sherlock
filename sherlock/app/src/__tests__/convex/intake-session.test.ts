import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSession,
  deleteData,
  getIntakeSupport,
  issueUploadIntent,
  projectWorkspace,
  resolveSession,
  revokeSession,
  rotateSession,
} from '../../../convex/intake'
import { createIntakeServerProof } from '../../lib/intake/proof'
import { MAX_CSV_UPLOAD_BYTES } from '../../../convex/_documents/uploadLimits'
import { createConvexCtx, runHandler, type Row, type Tables } from './nda-convex-harness'

const SECRET = 'intake-server-secret-for-tests-1234567890'
const AUDIENCE = 'sherlock-test:intake'
const ANONYMOUS_KEY = 'a'.repeat(64)
let nonce = 0

function intakeTables(): Tables {
  return {
    intakeSessions: [],
    intakeDocuments: [],
    intakeUploadIntents: [],
    intakeEvents: [],
    intakeProofNonces: [],
    intakeAssessments: [],
    rateLimits: [],
  }
}

function proof(
  operation:
    | 'CREATE_SESSION'
    | 'RESOLVE_SESSION'
    | 'PROJECT_WORKSPACE'
    | 'ROTATE_SESSION'
    | 'REVOKE_SESSION'
    | 'DELETE_DATA'
    | 'SUPPORT_READ'
    | 'ISSUE_UPLOAD',
  bindingParts: readonly string[],
  audience = AUDIENCE
) {
  nonce += 1
  return createIntakeServerProof({
    operation,
    bindingParts,
    nonce: `proof_nonce_${String(nonce).padStart(24, '0')}`,
    secret: SECRET,
    audience,
  })
}

async function createKnownSession(tables: Tables, identityName?: string) {
  const ctx = createConvexCtx(tables)
  const args = {
    anonymousKey: ANONYMOUS_KEY,
    identityName,
    ...proof('CREATE_SESSION', [ANONYMOUS_KEY, identityName ?? '-']),
  }
  const created = await runHandler<
    typeof args,
    {
      sessionToken: string
      accessExpiresAt: number
      deletionProofExpiresAt: number
    }
  >(createSession, ctx, args)
  return { ctx, created }
}

describe('temporary intake session authority', () => {
  beforeEach(() => {
    nonce = 0
    vi.stubEnv('INTAKE_DEMO_MODE', 'true')
    vi.stubEnv('INTAKE_SERVER_SECRET', SECRET)
    vi.stubEnv('INTAKE_SERVER_AUDIENCE', AUDIENCE)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is default-off and creates no anonymous authority when the mode is disabled', async () => {
    vi.stubEnv('INTAKE_DEMO_MODE', 'false')
    const tables = intakeTables()
    const ctx = createConvexCtx(tables)
    const args = {
      anonymousKey: ANONYMOUS_KEY,
      ...proof('CREATE_SESSION', [ANONYMOUS_KEY, '-']),
    }

    await expect(runHandler(createSession, ctx, args)).rejects.toThrow(/temporal/i)
    expect(tables.intakeSessions).toHaveLength(0)
    expect(tables.intakeProofNonces).toHaveLength(0)
  })

  it.each(['accessExpiresAt', 'absoluteExpiresAt'])(
    'allows a new session when three ACTIVE rows have expired by %s without deleting evidence',
    async (expiryField) => {
      const tables = intakeTables()
      for (let index = 0; index < 3; index += 1) await createKnownSession(tables)
      const now = Date.now()
      for (const session of tables.intakeSessions) session[expiryField] = now - 1
      const retained = tables.intakeSessions.map((session) => ({ ...session }))
      tables.intakeDocuments.push({ _id: 'retained-document', intakeSessionId: retained[0]._id })

      await expect(createKnownSession(tables, 'Nueva empresa')).resolves.toMatchObject({
        created: { sessionToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) },
      })

      expect(tables.intakeSessions).toHaveLength(4)
      expect(tables.intakeSessions.slice(0, 3)).toEqual(retained)
      expect(tables.intakeDocuments).toEqual([
        { _id: 'retained-document', intakeSessionId: retained[0]._id },
      ])
    }
  )

  it('still rejects a fourth live session after expired rows precede the live rows', async () => {
    const tables = intakeTables()
    for (let index = 0; index < 3; index += 1) await createKnownSession(tables)
    const active = tables.intakeSessions[0]
    tables.intakeSessions.unshift(
      ...Array.from({ length: 4 }, (_, index) => ({
        ...active,
        _id: `expired-${index}`,
        _creationTime: 0,
        accessExpiresAt: Date.now() - 1,
      }))
    )

    await expect(createKnownSession(tables, 'Cuarta empresa')).rejects.toMatchObject({
      data: { details: { currentState: 'INTAKE_SESSION_LIMIT' } },
    })
    expect(tables.intakeSessions).toHaveLength(7)
  })

  it('keeps the ten-creations-per-day limit when each earlier session expires', async () => {
    const tables = intakeTables()
    for (let index = 0; index < 10; index += 1) {
      await createKnownSession(tables)
      tables.intakeSessions[index].accessExpiresAt = Date.now() - 1
    }

    await expect(createKnownSession(tables)).rejects.toMatchObject({ data: 'Rate limit exceeded' })
    expect(tables.intakeSessions).toHaveLength(10)
  })

  it('mints an opaque bounded token, stores only its digest, and permits an explicit name skip', async () => {
    const tables = intakeTables()
    const { ctx, created } = await createKnownSession(tables)

    const storedSession = tables.intakeSessions[0] as Row & {
      accessExpiresAt: number
      absoluteExpiresAt: number
      createdAt: number
    }

    expect(created.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(created.accessExpiresAt).toBeGreaterThan(Date.now())
    expect(created.deletionProofExpiresAt).toBeGreaterThan(created.accessExpiresAt)
    expect(storedSession.accessExpiresAt - storedSession.createdAt).toBe(24 * 60 * 60 * 1000)
    expect(storedSession.absoluteExpiresAt - storedSession.createdAt).toBe(48 * 60 * 60 * 1000)
    expect(JSON.stringify(tables.intakeSessions)).not.toContain(created.sessionToken)
    expect(tables.intakeSessions[0]).toMatchObject({
      status: 'ACTIVE',
      audience: AUDIENCE,
      identityEvidence: undefined,
      claimStatus: 'UNCLAIMED',
      rotationCount: 0,
    })

    const resolvedArgs = {
      sessionToken: created.sessionToken,
      ...proof('RESOLVE_SESSION', [created.sessionToken]),
    }
    await expect(runHandler(resolveSession, ctx, resolvedArgs)).resolves.toMatchObject({
      authenticated: true,
      accessExpiresAt: created.accessExpiresAt,
    })
  })

  it('normalizes optional name evidence without creating a synthetic profile', async () => {
    const tables = intakeTables()
    await createKnownSession(tables, '  Acme   Panamá  ')

    expect(tables.intakeSessions[0]).toMatchObject({
      identityEvidence: {
        kind: 'NAME',
        name: 'Acme Panamá',
        capturedAt: expect.any(Number),
      },
    })
    expect(tables.profiles ?? []).toHaveLength(0)
    expect(tables.users ?? []).toHaveLength(0)
  })

  it('rotates in place, invalidates the prior token, and preserves retained staged rows', async () => {
    const tables = intakeTables()
    const { ctx, created } = await createKnownSession(tables)
    const sessionId = tables.intakeSessions[0]._id
    tables.intakeDocuments.push({
      _id: 'intake_document_1',
      intakeSessionId: sessionId,
      displayName: 'Financials.pdf',
      storageId: 'storage_1',
      storageState: 'STAGED_INTAKE',
      inspectionStatus: 'CLEAN',
      claimable: true,
      createdAt: Date.now(),
    })

    const rotateArgs = {
      sessionToken: created.sessionToken,
      ...proof('ROTATE_SESSION', [created.sessionToken]),
    }
    const rotated = await runHandler<
      typeof rotateArgs,
      { rotated: true; sessionToken: string; accessExpiresAt: number }
    >(rotateSession, ctx, rotateArgs)

    expect(rotated.sessionToken).not.toBe(created.sessionToken)
    expect(tables.intakeSessions).toHaveLength(1)
    expect(tables.intakeSessions[0]).toMatchObject({
      _id: sessionId,
      status: 'ACTIVE',
      rotationCount: 1,
      rotatedAt: expect.any(Number),
    })
    expect(tables.intakeDocuments).toHaveLength(1)

    await expect(
      runHandler(resolveSession, ctx, {
        sessionToken: created.sessionToken,
        ...proof('RESOLVE_SESSION', [created.sessionToken]),
      })
    ).resolves.toEqual({ authenticated: false })
    await expect(
      runHandler(resolveSession, ctx, {
        sessionToken: rotated.sessionToken,
        ...proof('RESOLVE_SESSION', [rotated.sessionToken]),
      })
    ).resolves.toMatchObject({ authenticated: true })
  })

  // Reclamada la sala, la sesión temporal queda CLAIMED: sus documentos ya son
  // de la empresa y rotarla resucitaría una autoridad que nadie debe tener. La
  // segunda tanda del mismo navegador abre sesión nueva y la reclamada no se
  // toca (prod 2026-09-03 03:25).
  it('refuses to rotate a claimed session and still opens a new one for the next batch', async () => {
    const tables = intakeTables()
    const { ctx, created } = await createKnownSession(tables)
    const claimedId = tables.intakeSessions[0]._id
    tables.intakeSessions[0].status = 'CLAIMED'
    tables.intakeSessions[0].claimStatus = 'CLAIMED'
    tables.intakeSessions[0].claimedCompanyId = 'company_1'

    await expect(
      runHandler(rotateSession, ctx, {
        sessionToken: created.sessionToken,
        ...proof('ROTATE_SESSION', [created.sessionToken]),
      })
    ).resolves.toEqual({ rotated: false })
    await expect(
      runHandler(projectWorkspace, ctx, {
        sessionToken: created.sessionToken,
        ...proof('PROJECT_WORKSPACE', [created.sessionToken]),
      })
    ).resolves.toEqual({ authenticated: false })
    expect(tables.intakeSessions[0]).toMatchObject({ status: 'CLAIMED', rotationCount: 0 })

    const secondArgs = {
      anonymousKey: ANONYMOUS_KEY,
      identityName: 'Sample Foods, S.A.',
      ...proof('CREATE_SESSION', [ANONYMOUS_KEY, 'Sample Foods, S.A.']),
    }
    const second = await runHandler<typeof secondArgs, { sessionToken: string }>(
      createSession,
      ctx,
      secondArgs
    )

    expect(second.sessionToken).not.toBe(created.sessionToken)
    expect(tables.intakeSessions).toHaveLength(2)
    expect(tables.intakeSessions[0]._id).toBe(claimedId)
    expect(tables.intakeSessions[1]).toMatchObject({ status: 'ACTIVE', claimStatus: 'UNCLAIMED' })
    await expect(
      runHandler(resolveSession, ctx, {
        sessionToken: second.sessionToken,
        ...proof('RESOLVE_SESSION', [second.sessionToken]),
      })
    ).resolves.toMatchObject({ authenticated: true })
  })

  it('expires and revokes access without silently deleting retained intake data', async () => {
    const expiredTables = intakeTables()
    const expired = await createKnownSession(expiredTables)
    expiredTables.intakeDocuments.push({
      _id: 'retained_document',
      intakeSessionId: expiredTables.intakeSessions[0]._id,
      storageId: 'retained_storage',
      storageState: 'STAGED_INTAKE',
      inspectionStatus: 'CLEAN',
      claimable: true,
    })
    expiredTables.intakeSessions[0].accessExpiresAt = Date.now() - 1

    await expect(
      runHandler(resolveSession, expired.ctx, {
        sessionToken: expired.created.sessionToken,
        ...proof('RESOLVE_SESSION', [expired.created.sessionToken]),
      })
    ).resolves.toEqual({ authenticated: false })
    expect(expiredTables.intakeSessions[0].status).toBe('EXPIRED')
    expect(expiredTables.intakeDocuments).toHaveLength(1)

    const revokedTables = intakeTables()
    const revoked = await createKnownSession(revokedTables)
    revokedTables.intakeDocuments.push({
      _id: 'retained_after_revoke',
      intakeSessionId: revokedTables.intakeSessions[0]._id,
      storageId: 'retained_storage_2',
      storageState: 'STAGED_INTAKE',
      inspectionStatus: 'CLEAN',
      claimable: true,
    })
    await runHandler(revokeSession, revoked.ctx, {
      sessionToken: revoked.created.sessionToken,
      ...proof('REVOKE_SESSION', [revoked.created.sessionToken]),
    })
    expect(revokedTables.intakeSessions[0].status).toBe('REVOKED')
    expect(revokedTables.intakeDocuments).toHaveLength(1)
    await expect(
      runHandler(resolveSession, revoked.ctx, {
        sessionToken: revoked.created.sessionToken,
        ...proof('RESOLVE_SESSION', [revoked.created.sessionToken]),
      })
    ).resolves.toEqual({ authenticated: false })
  })

  it('allows explicit deletion after visitor-ended access while preserving the access revocation', async () => {
    const tables = intakeTables()
    const { ctx, created } = await createKnownSession(tables)
    const sessionId = tables.intakeSessions[0]._id
    tables.intakeDocuments.push({
      _id: 'retained_after_end_access',
      intakeSessionId: sessionId,
      storageId: 'retained_storage_after_end_access',
      storageState: 'STAGED_INTAKE',
    })
    const deleteBlob = vi.fn(async () => undefined)
    Object.assign(ctx, { storage: { delete: deleteBlob } })

    await runHandler(revokeSession, ctx, {
      sessionToken: created.sessionToken,
      ...proof('REVOKE_SESSION', [created.sessionToken]),
    })
    expect(tables.intakeSessions[0]).toMatchObject({
      status: 'REVOKED',
      revokedReason: 'VISITOR_ENDED_ACCESS',
    })

    await expect(
      runHandler(deleteData, ctx, {
        sessionToken: created.sessionToken,
        ...proof('DELETE_DATA', [created.sessionToken]),
      })
    ).resolves.toEqual({ deleted: true })

    expect(deleteBlob).toHaveBeenCalledWith('retained_storage_after_end_access')
    expect(tables.intakeSessions).toHaveLength(0)
    expect(tables.intakeDocuments).toHaveLength(0)
  })

  it('rejects deletion after visitor-ended access when the deletion proof has expired', async () => {
    const tables = intakeTables()
    const { ctx, created } = await createKnownSession(tables)
    tables.intakeSessions[0].deletionProofExpiresAt = Date.now() - 1

    await runHandler(revokeSession, ctx, {
      sessionToken: created.sessionToken,
      ...proof('REVOKE_SESSION', [created.sessionToken]),
    })

    await expect(
      runHandler(deleteData, ctx, {
        sessionToken: created.sessionToken,
        ...proof('DELETE_DATA', [created.sessionToken]),
      })
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })
    expect(tables.intakeSessions).toHaveLength(1)
  })

  it('rejects arbitrary revoked sessions and wrong-audience deletion proofs', async () => {
    const arbitraryRevokedTables = intakeTables()
    const arbitraryRevoked = await createKnownSession(arbitraryRevokedTables)
    await runHandler(revokeSession, arbitraryRevoked.ctx, {
      sessionToken: arbitraryRevoked.created.sessionToken,
      ...proof('REVOKE_SESSION', [arbitraryRevoked.created.sessionToken]),
    })
    arbitraryRevokedTables.intakeSessions[0].revokedReason = 'CLAIM_SUCCEEDED'

    await expect(
      runHandler(deleteData, arbitraryRevoked.ctx, {
        sessionToken: arbitraryRevoked.created.sessionToken,
        ...proof('DELETE_DATA', [arbitraryRevoked.created.sessionToken]),
      })
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })
    expect(arbitraryRevokedTables.intakeSessions).toHaveLength(1)

    const wrongAudienceTables = intakeTables()
    const wrongAudience = await createKnownSession(wrongAudienceTables)
    await runHandler(revokeSession, wrongAudience.ctx, {
      sessionToken: wrongAudience.created.sessionToken,
      ...proof('REVOKE_SESSION', [wrongAudience.created.sessionToken]),
    })

    await expect(
      runHandler(deleteData, wrongAudience.ctx, {
        sessionToken: wrongAudience.created.sessionToken,
        ...proof('DELETE_DATA', [wrongAudience.created.sessionToken], 'another:intake-audience'),
      })
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })
    expect(wrongAudienceTables.intakeSessions).toHaveLength(1)
  })

  it('never reopens workspace, support, or upload access after visitor revocation', async () => {
    const tables = intakeTables()
    const { ctx, created } = await createKnownSession(tables)
    await runHandler(revokeSession, ctx, {
      sessionToken: created.sessionToken,
      ...proof('REVOKE_SESSION', [created.sessionToken]),
    })

    await expect(
      runHandler(projectWorkspace, ctx, {
        sessionToken: created.sessionToken,
        ...proof('PROJECT_WORKSPACE', [created.sessionToken]),
      })
    ).resolves.toEqual({ authenticated: false })
    await expect(
      runHandler(getIntakeSupport, ctx, {
        sessionToken: created.sessionToken,
        ...proof('SUPPORT_READ', [created.sessionToken]),
      })
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })

    const fileName = 'financials.pdf'
    const declaredMimeType = 'application/pdf'
    const declaredByteSize = 1
    const declaredSha256 = 'a'.repeat(64)
    await expect(
      runHandler(issueUploadIntent, ctx, {
        sessionToken: created.sessionToken,
        fileName,
        declaredMimeType,
        declaredByteSize,
        declaredSha256,
        ...proof('ISSUE_UPLOAD', [
          created.sessionToken,
          fileName,
          declaredMimeType,
          `${declaredByteSize}`,
          declaredSha256,
        ]),
      })
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })
  })

  it('allows another upload after twenty documents and 250 MB in the session', async () => {
    const tables = intakeTables()
    const { ctx, created } = await createKnownSession(tables)
    tables.intakeSessions[0].documentCount = 21
    tables.intakeSessions[0].totalStagedBytes = 270 * 1024 * 1024
    const generateUploadUrl = vi.fn().mockResolvedValue('https://storage.example/upload')
    Object.assign(ctx, { storage: { generateUploadUrl } })
    const fileName = 'financials.pdf'
    const declaredMimeType = 'application/pdf'
    const declaredByteSize = 1024
    const declaredSha256 = 'b'.repeat(64)
    const result = await runHandler(issueUploadIntent, ctx, {
      sessionToken: created.sessionToken,
      fileName,
      declaredMimeType,
      declaredByteSize,
      declaredSha256,
      ...proof('ISSUE_UPLOAD', [
        created.sessionToken,
        fileName,
        declaredMimeType,
        `${declaredByteSize}`,
        declaredSha256,
      ]),
    })
    expect(result).toMatchObject({
      uploadUrl: 'https://storage.example/upload',
      intentId: expect.any(String),
    })
    expect(tables.intakeUploadIntents).toHaveLength(1)
  })

  it.each([
    ['CSV at 20 MB', 'balance.csv', 'text/csv', MAX_CSV_UPLOAD_BYTES, true],
    ['CSV at 20 MB + 1', 'balance.csv', 'text/csv', MAX_CSV_UPLOAD_BYTES + 1, false],
    ['PDF at 20 MB + 1', 'financials.pdf', 'application/pdf', MAX_CSV_UPLOAD_BYTES + 1, true],
  ])(
    'applies the temporary per-format cap before issuing storage authority: %s',
    async (_label, fileName, declaredMimeType, declaredByteSize, accepted) => {
      const tables = intakeTables()
      const { ctx, created } = await createKnownSession(tables)
      const generateUploadUrl = vi.fn().mockResolvedValue('https://storage.example/upload')
      Object.assign(ctx, { storage: { generateUploadUrl } })
      const declaredSha256 = 'b'.repeat(64)
      const args = {
        sessionToken: created.sessionToken,
        fileName,
        declaredMimeType,
        declaredByteSize,
        declaredSha256,
        ...proof('ISSUE_UPLOAD', [
          created.sessionToken,
          fileName,
          declaredMimeType,
          `${declaredByteSize}`,
          declaredSha256,
        ]),
      }

      const result = await runHandler(issueUploadIntent, ctx, args)

      if (accepted) {
        expect(result).toMatchObject({
          intentId: expect.any(String),
          uploadUrl: expect.any(String),
        })
        expect(generateUploadUrl).toHaveBeenCalledTimes(1)
        expect(tables.intakeUploadIntents).toHaveLength(1)
      } else {
        expect(result).toEqual({ registered: false, code: 'FILE_TOO_LARGE' })
        expect(generateUploadUrl).not.toHaveBeenCalled()
        expect(tables.intakeUploadIntents).toHaveLength(0)
      }
    }
  )

  // F13 (#553): cancelar a mitad de bytes dejaba el intent ISSUED diez minutos
  // y el reintento recibía INTAKE_UPLOAD_PENDING. Un ISSUED de la misma sesión
  // y huella se supersede solo cuando el cliente lo pide (`supersedePending`,
  // que manda tras un intento terminal no recibido del mismo archivo): otra
  // pestaña a mitad de XHR no se pisa por accidente.
  describe('retrying the same file after a cancelled upload', () => {
    const fileName = 'financials.pdf'
    const declaredMimeType = 'application/pdf'
    const declaredByteSize = 1
    const declaredSha256 = 'c'.repeat(64)

    function issueArgs(sessionToken: string, extra: { supersedePending?: boolean } = {}) {
      return {
        sessionToken,
        fileName,
        declaredMimeType,
        declaredByteSize,
        declaredSha256,
        ...extra,
        ...proof('ISSUE_UPLOAD', [
          sessionToken,
          fileName,
          declaredMimeType,
          `${declaredByteSize}`,
          declaredSha256,
        ]),
      }
    }

    it('keeps an ISSUED intent pending when the client does not ask to supersede it', async () => {
      const tables = intakeTables()
      const { ctx, created } = await createKnownSession(tables)
      const generateUploadUrl = vi.fn().mockResolvedValue('https://storage.example/upload/1')
      Object.assign(ctx, { storage: { generateUploadUrl } })

      const first = await runHandler<ReturnType<typeof issueArgs>, { intentId: string }>(
        issueUploadIntent,
        ctx,
        issueArgs(created.sessionToken)
      )

      await expect(
        runHandler(issueUploadIntent, ctx, issueArgs(created.sessionToken))
      ).rejects.toMatchObject({ data: { details: { currentState: 'INTAKE_UPLOAD_PENDING' } } })
      expect(generateUploadUrl).toHaveBeenCalledTimes(1)
      expect(tables.intakeUploadIntents).toHaveLength(1)
      expect(tables.intakeUploadIntents.find((row) => row._id === first.intentId)).toMatchObject({
        status: 'ISSUED',
      })
    })

    it('supersedes an ISSUED intent for the same file and issues a new one with a new URL when asked', async () => {
      const tables = intakeTables()
      const { ctx, created } = await createKnownSession(tables)
      const generateUploadUrl = vi
        .fn()
        .mockResolvedValueOnce('https://storage.example/upload/1')
        .mockResolvedValueOnce('https://storage.example/upload/2')
      Object.assign(ctx, { storage: { generateUploadUrl } })

      const first = await runHandler<
        ReturnType<typeof issueArgs>,
        { intentId: string; uploadUrl: string }
      >(issueUploadIntent, ctx, issueArgs(created.sessionToken))
      const second = await runHandler<
        ReturnType<typeof issueArgs>,
        { intentId: string; uploadUrl: string }
      >(issueUploadIntent, ctx, issueArgs(created.sessionToken, { supersedePending: true }))

      expect(second.intentId).not.toBe(first.intentId)
      expect(second.uploadUrl).toBe('https://storage.example/upload/2')
      expect(generateUploadUrl).toHaveBeenCalledTimes(2)
      expect(tables.intakeUploadIntents).toHaveLength(2)
      expect(tables.intakeUploadIntents.find((row) => row._id === first.intentId)).toMatchObject({
        status: 'EXPIRED',
        expiredAt: expect.any(Number),
      })
      expect(tables.intakeUploadIntents.find((row) => row._id === second.intentId)).toMatchObject({
        status: 'ISSUED',
        declaredSha256,
      })
      expect(
        tables.intakeEvents.filter((event) => event.type === 'UPLOAD_INTENT_ISSUED')
      ).toHaveLength(2)
    })

    it('keeps rejecting while the bytes of the same file are under inspection, even when asked to supersede', async () => {
      const tables = intakeTables()
      const { ctx, created } = await createKnownSession(tables)
      const generateUploadUrl = vi.fn().mockResolvedValue('https://storage.example/upload')
      Object.assign(ctx, { storage: { generateUploadUrl } })

      const first = await runHandler<ReturnType<typeof issueArgs>, { intentId: string }>(
        issueUploadIntent,
        ctx,
        issueArgs(created.sessionToken)
      )
      const inspecting = tables.intakeUploadIntents.find((row) => row._id === first.intentId)!
      inspecting.status = 'INSPECTING'
      inspecting.storageId = 'storage_inspecting'

      await expect(
        runHandler(
          issueUploadIntent,
          ctx,
          issueArgs(created.sessionToken, { supersedePending: true })
        )
      ).rejects.toMatchObject({ data: { details: { currentState: 'INTAKE_UPLOAD_PENDING' } } })
      expect(generateUploadUrl).toHaveBeenCalledTimes(1)
      expect(tables.intakeUploadIntents).toHaveLength(1)
      expect(inspecting.status).toBe('INSPECTING')
    })
  })

  it('rejects replayed and wrong-audience server proofs before effects', async () => {
    const tables = intakeTables()
    const ctx = createConvexCtx(tables)
    const sharedProof = proof('CREATE_SESSION', [ANONYMOUS_KEY, '-'])
    const args = { anonymousKey: ANONYMOUS_KEY, ...sharedProof }

    await expect(runHandler(createSession, ctx, args)).resolves.toMatchObject({
      sessionToken: expect.any(String),
    })
    await expect(runHandler(createSession, ctx, args)).rejects.toThrow(/servidor/i)
    expect(tables.intakeSessions).toHaveLength(1)

    const wrongAudienceTables = intakeTables()
    const wrongAudienceCtx = createConvexCtx(wrongAudienceTables)
    await expect(
      runHandler(createSession, wrongAudienceCtx, {
        anonymousKey: ANONYMOUS_KEY,
        ...proof('CREATE_SESSION', [ANONYMOUS_KEY, '-'], 'another:intake-audience'),
      })
    ).rejects.toThrow(/servidor/i)
    expect(wrongAudienceTables.intakeSessions).toHaveLength(0)
  })

  it('projects only documents owned by the exact session authority', async () => {
    const tables = intakeTables()
    const first = await createKnownSession(tables)
    const firstSessionId = tables.intakeSessions[0]._id
    const second = await createKnownSession(tables)
    const secondSessionId = tables.intakeSessions[1]._id
    tables.intakeDocuments.push(
      {
        _id: 'first_document',
        intakeSessionId: firstSessionId,
        displayName: 'First.pdf',
        declaredMimeType: 'application/pdf',
        byteSize: 10,
        storageId: 'storage_first',
        storageState: 'STAGED_INTAKE',
        inspectionStatus: 'CLEAN',
        claimable: true,
        createdAt: 1,
      },
      {
        _id: 'second_document',
        intakeSessionId: secondSessionId,
        displayName: 'Second.pdf',
        declaredMimeType: 'application/pdf',
        byteSize: 20,
        storageId: 'storage_second',
        storageState: 'STAGED_INTAKE',
        inspectionStatus: 'CLEAN',
        claimable: true,
        createdAt: 2,
      }
    )

    const projected = await runHandler<
      {
        sessionToken: string
        serverIssuedAt: number
        serverProof: string
        proofNonce: string
      },
      { authenticated: true; documents: Array<{ id: string; displayName: string }> }
    >(projectWorkspace, first.ctx, {
      sessionToken: first.created.sessionToken,
      ...proof('PROJECT_WORKSPACE', [first.created.sessionToken]),
    })

    expect(projected.documents).toEqual([
      expect.objectContaining({ id: 'first_document', displayName: 'First.pdf' }),
    ])
    expect(JSON.stringify(projected)).not.toContain('Second.pdf')
    expect(JSON.stringify(projected)).not.toContain('storage_first')
    expect(second.created.sessionToken).not.toBe(first.created.sessionToken)
  })
})
