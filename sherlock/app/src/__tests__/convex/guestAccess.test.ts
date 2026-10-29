// ============================================================================
// ACCESO DE INVITADOS — OTP, REVOCACIÓN Y EXTENSIÓN
// ============================================================================
// La sala de deal salió del árbol ([F] 2026-09-17), y con ella la invitación
// patrocinada por un ciclo de acceso, los grupos de invitados y el roster por
// transacción. Lo que este archivo sigue probando son las compuertas que NO se
// fueron y que ninguna otra suite cubre con este detalle: la respuesta genérica
// del reto OTP, el sobre firmado del servidor, el hash del código, el tope de
// intentos, el cooldown, el límite de solicitudes, la revocación y la extensión
// acotada con su rastro de auditoría sin PII.
//
// La invitación ahora se siembra por la sala de empresa
// (`createCompanyGuestInvitation`), que es el único camino vivo.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { extend, requestOtpChallenge, revoke } from '../../../convex/guestAccess'
import { createCompanyGuestInvitation } from '../../../convex/_guests/companyRoom'
import {
  GUEST_OTP_MAX_ATTEMPTS,
  prepareOtpChallengeForDelivery,
  verifyGuestOtp,
} from '../../../convex/_guests/service'
import { resend } from '../../../convex/email'
import { hashGuestSessionToken, isGuestSecurityConfigured } from '../../../convex/_guests/crypto'
import { sha256Hex } from '../../../convex/_adminVdr/capability'
import { requireAuth } from '../../../convex/_helpers/auth'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'
import { withGuestServerProof } from './guest-server-proof-fixture'
import { mintAdminVdrCapability, TEST_ADMIN_SESSION_ID } from './admin-vdr-capability-test-helper'

const NOW = 1_790_000_000_000
const OWNER_IDENTITY = {
  subject: 'workos_owner',
  issuer: 'https://api.workos.com/',
  email: 'owner@example.com',
}
const ADMIN_IDENTITY = {
  subject: 'workos_admin',
  sid: TEST_ADMIN_SESSION_ID,
  issuer: 'https://api.workos.com/',
  email: 'admin@example.com',
}

const NDA_CONTENT = 'TEST FIXTURE ONLY. Approved confidentiality text.'

async function guestTables(): Promise<Tables> {
  return {
    users: [
      {
        _id: 'user_owner',
        authProvider: 'workos',
        providerUserId: 'workos_owner',
        workosUserId: 'workos_owner',
        email: 'owner@example.com',
        role: 'COMPANY',
      },
      {
        _id: 'user_admin',
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'admin@example.com',
        role: 'ADMIN',
      },
    ],
    profiles: [
      { _id: 'profile_owner', userId: 'user_owner', role: 'COMPANY', isActive: true },
      { _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true },
    ],
    organizationMemberships: [
      {
        _id: 'membership_owner',
        userId: 'user_owner',
        profileId: 'profile_owner',
        authProvider: 'workos',
        providerOrgId: 'org_company_1',
        status: 'ACTIVE',
        betaRole: 'COMPANY_OWNER',
        profileRole: 'COMPANY',
      },
    ],
    companyOrganizationBindings: [
      {
        _id: 'binding_company_1',
        companyId: 'company_1',
        ownerProfileId: 'profile_owner',
        authProvider: 'workos',
        providerOrgId: 'org_company_1',
      },
    ],
    companies: [{ _id: 'company_1', ownerId: 'profile_owner', name: 'Issuer One' }],
    guestNdaTemplates: [
      {
        _id: 'template_1',
        companyId: 'company_1',
        title: 'Test NDA',
        content: NDA_CONTENT,
        contentHash: await sha256Hex(NDA_CONTENT),
        locale: 'es',
        version: 'v1',
        active: true,
        approvedAt: NOW - 1_000,
        approvedByProfileId: 'profile_admin',
      },
    ],
    documents: [
      {
        _id: 'doc_selected',
        companyId: 'company_1',
        name: 'Estados financieros',
        folder: 'Financieros',
        accessLevel: 'NDA_REQUIRED',
        classification: 'CONFIDENTIAL',
        lifecycleStatus: 'ACTIVE',
        currentVersionId: 'version_selected',
        publishedVersionId: 'version_selected',
        currentVersionNumber: 1,
        storageId: 'storage_selected',
      },
    ],
    documentVersions: [
      {
        _id: 'version_selected',
        documentId: 'doc_selected',
        companyId: 'company_1',
        versionNumber: 1,
        storageId: 'storage_selected',
        displayName: 'Estados financieros',
        declaredMimeType: 'application/pdf',
        detectedMimeType: 'application/pdf',
        byteSize: 2_048,
        sha256: 'a'.repeat(64),
        signatureKind: 'PDF',
        verificationStatus: 'SIGNATURE_VERIFIED',
        malwareScanStatus: 'CLEAN',
        publicationStatus: 'PUBLISHED',
        publishedAt: NOW - 1_000,
        createdAt: NOW - 1_000,
        createdByProfileId: 'profile_owner',
      },
    ],
    guestInvitations: [],
    guestOtpChallenges: [],
    guestSessions: [],
    guestNdaAcceptances: [],
    rateLimits: [],
    activityLogs: [],
    adminAuditLogs: [],
  }
}

async function invite(
  tables: Tables,
  email = 'fixture-bff21e9f@example.com',
  options?: { ctx?: ReturnType<typeof createConvexCtx>; identity?: typeof OWNER_IDENTITY }
) {
  const ctx =
    options?.ctx ?? createConvexCtx(tables, { identity: options?.identity ?? OWNER_IDENTITY })
  const actor = await requireAuth(ctx as never)
  const created = await createCompanyGuestInvitation(ctx as never, {
    companyId: 'company_1' as never,
    documentIds: ['doc_selected' as never],
    email,
    expiresInDays: 7,
    locale: 'es',
    actor,
    now: NOW,
  })
  return { ctx, created }
}

async function inviteWithKnownOtp(tables: Tables, email = 'fixture-bff21e9f@example.com') {
  const { ctx, created } = await invite(tables, email)
  const prepared = await prepareOtpChallengeForDelivery(ctx as never, {
    invitationHandle: created.invitationHandle,
    email,
    now: NOW + 1,
    createToken: () => 'challenge-token-not-persisted',
    createCode: () => '481516',
    createSalt: () => 'challenge-salt',
  })
  return { ctx, created, prepared }
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  // The deterministic crypto fallback exists only behind an explicit local
  // deployment declaration; individual production/adversarial tests override it.
  vi.stubEnv('CONVEX_ENV', 'dev')
})

describe('company room guest access core', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('returns the same generic public challenge response without creating an undeliverable OTP', async () => {
    vi.stubEnv('RESEND_API_KEY', '')
    const tables = await guestTables()
    const ctx = createConvexCtx(tables)
    const firstArgs = {
      invitationHandle: 'known-or-unknown',
      email: 'anyone@example.com',
    }
    const secondArgs = {
      invitationHandle: 'definitely-invalid',
      email: 'not-an-email',
    }
    const first = (await runHandler(
      requestOtpChallenge,
      ctx,
      withGuestServerProof('REQUEST_OTP', Object.values(firstArgs), firstArgs)
    )) as Record<string, unknown>
    const second = (await runHandler(
      requestOtpChallenge,
      ctx,
      withGuestServerProof('REQUEST_OTP', Object.values(secondArgs), secondArgs)
    )) as Record<string, unknown>

    expect(Object.keys(first).sort()).toEqual(Object.keys(second).sort())
    expect(first).toMatchObject({ accepted: true, expiresInSeconds: 600 })
    expect(second).toMatchObject({ accepted: true, expiresInSeconds: 600 })
    expect(String(first.challengeToken)).toHaveLength(64)
    expect(String(second.challengeToken)).toHaveLength(64)
    expect(tables.guestOtpChallenges).toHaveLength(0)
  })

  it('rejects OTP requests that bypass the hardened Next server boundary', async () => {
    const tables = await guestTables()

    await expect(
      runHandler(requestOtpChallenge, createConvexCtx(tables), {
        invitationHandle: 'a'.repeat(64),
        email: 'fixture-bff21e9f@example.com',
        serverIssuedAt: NOW,
        serverProof: 'invalid',
      })
    ).rejects.toThrow(/servidor/i)
    expect(tables.guestOtpChallenges).toHaveLength(0)
  })

  it('transactionally enqueues a deliverable OTP without returning its code or destination', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_guest_delivery')
    vi.stubEnv('RESEND_FROM_EMAIL', 'Sherlock <sender@example.com>')
    vi.stubEnv('APP_URL', 'https://app.example.com')
    vi.stubEnv('CONVEX_ENV', 'dev')
    const enqueue = vi.spyOn(resend, 'sendEmail').mockResolvedValue('email_1' as never)
    const tables = await guestTables()
    const { ctx, created } = await invite(tables)

    const requestArgs = {
      invitationHandle: created.invitationHandle,
      email: 'fixture-bff21e9f@example.com',
    }
    const result = (await runHandler(
      requestOtpChallenge,
      ctx,
      withGuestServerProof('REQUEST_OTP', Object.values(requestArgs), requestArgs)
    )) as Record<string, unknown>

    expect(result).toMatchObject({ accepted: true, expiresInSeconds: 600 })
    expect(String(result.challengeToken)).toHaveLength(64)
    expect(JSON.stringify(result)).not.toContain('fixture-bff21e9f@example.com')
    expect(JSON.stringify(result)).not.toMatch(/\b\d{6}\b/)
    const otpEmail = enqueue.mock.calls.at(-1)?.[1] as unknown as { to: string; text?: string }
    expect(otpEmail.to).toBe('fixture-bff21e9f@example.com')
    expect(otpEmail.text).toMatch(/\b\d{6}\b/)
    expect(tables.guestOtpChallenges).toHaveLength(1)
    expect(tables.guestOtpChallenges[0].status).toBe('ISSUED')
    expect(JSON.stringify(tables)).not.toContain(otpEmail.text?.match(/\b\d{6}\b/)?.[0])
  })

  it('does not enqueue or create a challenge when a forwarded invitation uses another email', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_guest_delivery')
    vi.stubEnv('RESEND_FROM_EMAIL', 'Sherlock <sender@example.com>')
    vi.stubEnv('APP_URL', 'https://app.example.com')
    vi.stubEnv('CONVEX_ENV', 'dev')
    const enqueue = vi.spyOn(resend, 'sendEmail').mockResolvedValue('email_1' as never)
    const tables = await guestTables()
    const { ctx, created } = await invite(tables, 'fixture-817096b2@example.com')
    enqueue.mockClear()

    await expect(
      runHandler(
        requestOtpChallenge,
        ctx,
        withGuestServerProof(
          'REQUEST_OTP',
          [created.invitationHandle, 'fixture-c998dacd@example.com'],
          {
            invitationHandle: created.invitationHandle,
            email: 'fixture-c998dacd@example.com',
          }
        )
      )
    ).resolves.toMatchObject({ accepted: true, expiresInSeconds: 600 })
    expect(enqueue).not.toHaveBeenCalled()
    expect(tables.guestOtpChallenges).toHaveLength(0)
  })

  it('locks a prepared challenge when the durable email enqueue fails', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_guest_delivery')
    vi.stubEnv('RESEND_FROM_EMAIL', 'Sherlock <sender@example.com>')
    vi.stubEnv('APP_URL', 'https://app.example.com')
    vi.stubEnv('CONVEX_ENV', 'dev')
    const tables = await guestTables()
    const { ctx, created } = await invite(tables)
    vi.spyOn(resend, 'sendEmail').mockRejectedValue(new Error('provider details'))

    const requestArgs = {
      invitationHandle: created.invitationHandle,
      email: 'fixture-bff21e9f@example.com',
    }
    const result = await runHandler(
      requestOtpChallenge,
      ctx,
      withGuestServerProof('REQUEST_OTP', Object.values(requestArgs), requestArgs)
    )

    expect(result).toMatchObject({ accepted: true, expiresInSeconds: 600 })
    expect(tables.guestOtpChallenges).toHaveLength(1)
    expect(tables.guestOtpChallenges[0].status).toBe('LOCKED')
  })

  it('fails closed in production when guest secrets or Resend are unavailable', async () => {
    vi.stubEnv('CONVEX_ENV', 'production')
    vi.stubEnv('GUEST_OTP_PEPPER', '')
    vi.stubEnv('RESEND_API_KEY', '')
    const enqueue = vi.spyOn(resend, 'sendEmail').mockResolvedValue('email_1' as never)
    const tables = await guestTables()

    await expect(hashGuestSessionToken('a'.repeat(64))).rejects.toThrow(/configuración segura/i)
    await expect(
      runHandler(
        requestOtpChallenge,
        createConvexCtx(tables),
        withGuestServerProof('REQUEST_OTP', ['a'.repeat(64), 'fixture-bff21e9f@example.com'], {
          invitationHandle: 'a'.repeat(64),
          email: 'fixture-bff21e9f@example.com',
        })
      )
    ).resolves.toMatchObject({ accepted: true, expiresInSeconds: 600 })
    expect(enqueue).not.toHaveBeenCalled()
    expect(tables.guestOtpChallenges).toHaveLength(0)
  })

  it.each([undefined, 'prodution', 'development'])(
    'rejects deterministic guest crypto when CONVEX_ENV is missing or invalid (%s)',
    async (convexEnv) => {
      if (convexEnv === undefined) {
        Reflect.deleteProperty(process.env, 'CONVEX_ENV')
      } else {
        vi.stubEnv('CONVEX_ENV', convexEnv)
      }
      vi.stubEnv('GUEST_IDENTITY_HASH_SECRET', '')
      vi.stubEnv('GUEST_OTP_PEPPER', '')

      expect(isGuestSecurityConfigured()).toBe(false)
      await expect(hashGuestSessionToken('a'.repeat(64))).rejects.toThrow(/configuración segura/i)
    }
  )

  it('hashes OTP material, enforces max attempts, and never stores the raw code or tokens', async () => {
    const tables = await guestTables()
    const { ctx, created, prepared } = await inviteWithKnownOtp(tables)

    expect(prepared.delivery).toMatchObject({
      destination: 'fixture-bff21e9f@example.com',
      code: '481516',
    })
    expect(tables.guestOtpChallenges[0]).toMatchObject({
      status: 'ISSUED',
      attempts: 0,
      maxAttempts: GUEST_OTP_MAX_ATTEMPTS,
    })
    const stored = JSON.stringify(tables.guestOtpChallenges)
    expect(stored).not.toContain('481516')
    expect(stored).not.toContain('challenge-token-not-persisted')
    expect(stored).not.toContain(created.invitationHandle)

    for (let attempt = 0; attempt < GUEST_OTP_MAX_ATTEMPTS; attempt += 1) {
      await expect(
        verifyGuestOtp(ctx as never, {
          invitationHandle: created.invitationHandle,
          challengeToken: 'challenge-token-not-persisted',
          code: '000000',
          now: NOW + 2,
        })
      ).resolves.toEqual({ verified: false })
    }
    expect(tables.guestOtpChallenges[0]).toMatchObject({
      status: 'LOCKED',
      attempts: GUEST_OTP_MAX_ATTEMPTS,
    })
    await expect(
      verifyGuestOtp(ctx as never, {
        invitationHandle: created.invitationHandle,
        challengeToken: 'challenge-token-not-persisted',
        code: '481516',
        now: NOW + 2,
      })
    ).resolves.toEqual({ verified: false })
  })

  it('enforces challenge cooldown and a hashed request rate limit', async () => {
    const tables = await guestTables()
    const { ctx, created } = await invite(tables, 'fixture-5f1bd80c@example.com')
    let sequence = 0
    const prepare = async (now: number) => {
      sequence += 1
      return await prepareOtpChallengeForDelivery(ctx as never, {
        invitationHandle: created.invitationHandle,
        email: 'fixture-5f1bd80c@example.com',
        now,
        createToken: () => `token-${sequence}`,
        createCode: () => '123456',
        createSalt: () => `salt-${sequence}`,
      })
    }

    expect((await prepare(NOW + 1)).delivery).not.toBeNull()
    expect((await prepare(NOW + 2)).delivery).toBeNull()
    expect(tables.guestOtpChallenges).toHaveLength(1)

    // Four more challenges after each cooldown consume the six-request window.
    for (let index = 1; index <= 4; index += 1) {
      expect((await prepare(NOW + 2 + index * 61_000)).delivery).not.toBeNull()
    }
    expect(tables.guestOtpChallenges).toHaveLength(5)
    expect((await prepare(NOW + 6 * 61_000)).delivery).toBeNull()
    expect(tables.guestOtpChallenges).toHaveLength(5)
    expect(tables.rateLimits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ count: 6 }),
        expect.objectContaining({ count: 6 }),
      ])
    )
  })

  it('returns the same generic challenge during cooldown whether or not the email matches', async () => {
    const tables = await guestTables()
    const email = 'fixture-421ae5dc@example.com'
    const { ctx, created } = await invite(tables, email)
    const stored = 'a'.repeat(64)
    const freshForMatch = 'm'.repeat(64)
    const freshForMiss = 'o'.repeat(64)
    await prepareOtpChallengeForDelivery(ctx as never, {
      invitationHandle: created.invitationHandle,
      email,
      now: NOW + 1,
      createToken: () => stored,
      createCode: () => '123456',
      createSalt: () => 'salt-1',
    })

    // El token presentado es el que ya está en pantalla. Devolverlo solo cuando
    // el email coincide le dice al atacante cuál es el buzón invitado.
    const matchedInput = {
      invitationHandle: created.invitationHandle,
      email,
      now: NOW + 2,
      createToken: () => freshForMatch,
      createCode: () => '654321',
      createSalt: () => 'salt-2',
      challengeToken: stored,
    }
    const missedInput = {
      ...matchedInput,
      email: 'fixture-185d546b@example.com',
      createToken: () => freshForMiss,
    }
    const matched = await prepareOtpChallengeForDelivery(ctx as never, matchedInput)
    const missed = await prepareOtpChallengeForDelivery(ctx as never, missedInput)

    expect(matched.response).toEqual({
      accepted: true,
      expiresInSeconds: 600,
      challengeToken: freshForMatch,
    })
    expect(missed.response).toEqual({
      accepted: true,
      expiresInSeconds: 600,
      challengeToken: freshForMiss,
    })
    expect(matched.response.challengeToken).not.toBe(stored)
    expect(missed.response.challengeToken).not.toBe(stored)
    expect(Object.keys(matched.response).sort()).toEqual(Object.keys(missed.response).sort())
    expect(matched.delivery).toBeNull()
    expect(missed.delivery).toBeNull()
    expect(tables.guestOtpChallenges).toHaveLength(1)
    expect(tables.guestOtpChallenges[0].status).toBe('ISSUED')

    await expect(
      verifyGuestOtp(ctx as never, {
        invitationHandle: created.invitationHandle,
        challengeToken: stored,
        code: '123456',
        now: NOW + 2,
      })
    ).resolves.toEqual({ verified: true })
  })

  it('verifies once, denies replay, and never grants room access by itself', async () => {
    const tables = await guestTables()
    const { ctx, created } = await inviteWithKnownOtp(tables)

    await expect(
      verifyGuestOtp(ctx as never, {
        invitationHandle: created.invitationHandle,
        challengeToken: 'challenge-token-not-persisted',
        code: '481516',
        now: NOW + 2,
      })
    ).resolves.toEqual({ verified: true })
    await expect(
      verifyGuestOtp(ctx as never, {
        invitationHandle: created.invitationHandle,
        challengeToken: 'challenge-token-not-persisted',
        code: '481516',
        now: NOW + 2,
      })
    ).resolves.toEqual({ verified: false })

    expect(tables.guestInvitations[0]).toMatchObject({
      status: 'VERIFIED',
      verifiedAt: expect.any(Number),
    })
    expect(tables.guestOtpChallenges[0]).toMatchObject({
      status: 'USED',
      consumedAt: expect.any(Number),
    })
    expect(tables.activityLogs.at(-1)).toMatchObject({
      action: 'GUEST_EMAIL_VERIFIED',
      metadata: expect.objectContaining({
        details: expect.objectContaining({ roomAccessGranted: false }),
      }),
    })
  })

  it('revokes an invitation and kills every live session and outstanding challenge', async () => {
    const tables = await guestTables()
    const { ctx, created } = await inviteWithKnownOtp(tables)
    tables.guestSessions.push({
      _id: 'guest_session_1',
      guestInvitationId: created.invitation._id,
      guestId: created.invitation.guestId,
      principalKey: created.invitation.principalKey,
      sessionTokenHash: 'hash_session_1',
      status: 'ACTIVE',
      createdAt: NOW,
      expiresAt: NOW + 1_800_000,
    })

    await expect(
      runHandler(revoke, ctx, {
        invitationId: created.invitation._id,
        reason: 'Se cerró el acceso de esta contraparte',
      })
    ).resolves.toMatchObject({ status: 'REVOKED' })

    expect(tables.guestSessions[0]).toMatchObject({
      status: 'REVOKED',
      revokedAt: expect.any(Number),
    })
    expect(tables.guestOtpChallenges[0]).toMatchObject({ status: 'LOCKED' })
  })

  it('supports bounded extension and records admin-only actions without guest PII', async () => {
    const tables = await guestTables()
    const adminCtx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    const { created } = await invite(tables, 'fixture-d7477115@example.com')
    const input = {
      invitationId: created.invitation._id,
      additionalDays: 5,
    }
    await expect(
      runHandler(
        extend,
        adminCtx,
        await mintAdminVdrCapability({
          tables,
          input,
          companyId: 'company_1',
          action: 'GUEST_EXTEND',
          target: `GUEST_INVITATION:${created.invitation._id}`,
        })
      )
    ).resolves.toMatchObject({ status: 'PENDING' })

    expect(tables.adminAuditLogs.map((row) => row.action)).toEqual([
      'VDR_ADMIN_CAPABILITY_CONSUME',
      'GUEST_INVITATION_EXTEND',
    ])
    const audits = JSON.stringify(tables.adminAuditLogs)
    expect(audits).not.toContain('fixture-d7477115@example.com')
    expect(audits).not.toContain(created.invitationHandle)
  })
})
