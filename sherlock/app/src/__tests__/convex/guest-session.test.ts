import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  resolveGuestSession,
  revoke,
  revokeGuestSession,
  rotateGuestSession,
  verifyOtpAndCreateSession,
} from '../../../convex/guestAccess'
import { prepareOtpChallengeForDelivery } from '../../../convex/_guests/service'
import { createCompanyGuestInvitation } from '../../../convex/_guests/companyRoom'
import { sha256Hex } from '../../../convex/_adminVdr/capability'
import type { AuthResult } from '../../../convex/_helpers/auth'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'
import { withGuestServerProof } from './guest-server-proof-fixture'

const NOW = Date.now()
const NDA_CONTENT = 'TEST FIXTURE ONLY. Approved confidentiality text.'
const OWNER_IDENTITY = {
  subject: 'workos_owner',
  issuer: 'https://api.workos.com/',
  email: 'owner@example.com',
}

async function guestSessionTables(): Promise<Tables> {
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
      {
        _id: 'profile_owner',
        userId: 'user_owner',
        role: 'COMPANY',
        isActive: true,
      },
      {
        _id: 'profile_admin',
        userId: 'user_admin',
        role: 'ADMIN',
        isActive: true,
      },
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
    guestNdaAcceptances: [],
    guestInvitations: [],
    guestOtpChallenges: [],
    guestSessions: [],
    rateLimits: [],
    activityLogs: [],
    adminAuditLogs: [],
  }
}

async function prepareKnownChallenge(tables: Tables) {
  const ctx = createConvexCtx(tables)
  const actor = {
    identity: {
      subject: 'workos_owner',
      authProvider: 'workos',
      email: 'owner@example.com',
    },
    user: tables.users[0],
    profile: tables.profiles[0],
  } as AuthResult
  const invitation = await createCompanyGuestInvitation(ctx as never, {
    companyId: 'company_1' as never,
    documentIds: ['doc_selected' as never],
    email: 'fixture-bff21e9f@example.com',
    expiresInDays: 7,
    locale: 'es',
    actor,
    now: NOW,
  })
  await prepareOtpChallengeForDelivery(ctx as never, {
    invitationHandle: invitation.invitationHandle,
    email: 'fixture-bff21e9f@example.com',
    now: NOW + 1,
    createToken: () => 'challenge-token-not-persisted',
    createCode: () => '481516',
    createSalt: () => 'challenge-salt',
  })
  return { ctx, invitation }
}

function verifiedSessionArgs(
  invitationHandle: string,
  challengeToken = 'challenge-token-not-persisted',
  code = '481516'
) {
  const args = { invitationHandle, challengeToken, code }
  return withGuestServerProof('VERIFY_OTP', Object.values(args), args)
}

function resolveSessionArgs(sessionToken: string) {
  return withGuestServerProof('RESOLVE_SESSION', [sessionToken], { sessionToken })
}

function rotateSessionArgs(sessionToken: string) {
  return withGuestServerProof('ROTATE_SESSION', [sessionToken], { sessionToken })
}

function revokeSessionArgs(sessionToken: string) {
  return withGuestServerProof('REVOKE_SESSION', [sessionToken], { sessionToken })
}

describe('company room guest sessions', () => {
  beforeEach(() => {
    vi.stubEnv('CONVEX_ENV', 'dev')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('rejects OTP verification that bypasses the hardened Next server boundary', async () => {
    const tables = await guestSessionTables()
    const { ctx, invitation } = await prepareKnownChallenge(tables)

    await expect(
      runHandler(verifyOtpAndCreateSession, ctx, {
        invitationHandle: invitation.invitationHandle,
        challengeToken: 'challenge-token-not-persisted',
        code: '481516',
        serverIssuedAt: NOW,
        serverProof: 'invalid',
      })
    ).rejects.toThrow(/servidor/i)
    expect(tables.guestSessions).toHaveLength(0)
    expect(tables.guestOtpChallenges[0].status).toBe('ISSUED')
  })

  it('rejects session resolution that bypasses the hardened Next server boundary', async () => {
    const tables = await guestSessionTables()
    const { ctx, invitation } = await prepareKnownChallenge(tables)
    const verified = (await runHandler(
      verifyOtpAndCreateSession,
      ctx,
      verifiedSessionArgs(invitation.invitationHandle)
    )) as { verified: true; sessionToken: string }

    await expect(
      runHandler(resolveGuestSession, ctx, {
        sessionToken: verified.sessionToken,
        serverIssuedAt: NOW,
        serverProof: 'invalid',
      })
    ).rejects.toThrow(/servidor/i)
  })

  it('rejects session rotation that bypasses the hardened Next server boundary', async () => {
    const tables = await guestSessionTables()
    const { ctx, invitation } = await prepareKnownChallenge(tables)
    const verified = (await runHandler(
      verifyOtpAndCreateSession,
      ctx,
      verifiedSessionArgs(invitation.invitationHandle)
    )) as { verified: true; sessionToken: string }

    await expect(
      runHandler(rotateGuestSession, ctx, {
        sessionToken: verified.sessionToken,
        serverIssuedAt: NOW,
        serverProof: 'invalid',
      })
    ).rejects.toThrow(/servidor/i)
    expect(tables.guestSessions[0].status).toBe('ACTIVE')
  })

  it('rejects session revocation that bypasses the hardened Next server boundary', async () => {
    const tables = await guestSessionTables()
    const { ctx, invitation } = await prepareKnownChallenge(tables)
    const verified = (await runHandler(
      verifyOtpAndCreateSession,
      ctx,
      verifiedSessionArgs(invitation.invitationHandle)
    )) as { verified: true; sessionToken: string }

    await expect(
      runHandler(revokeGuestSession, ctx, {
        sessionToken: verified.sessionToken,
        serverIssuedAt: NOW,
        serverProof: 'invalid',
      })
    ).rejects.toThrow(/servidor/i)
    expect(tables.guestSessions[0].status).toBe('ACTIVE')
  })

  it('exchanges a one-time OTP for a short opaque session without granting the VDR room', async () => {
    const tables = await guestSessionTables()
    const { ctx, invitation } = await prepareKnownChallenge(tables)

    const verified = (await runHandler(
      verifyOtpAndCreateSession,
      ctx,
      verifiedSessionArgs(invitation.invitationHandle)
    )) as {
      verified: boolean
      sessionToken?: string
      expiresAt?: number
      roomAccessGranted?: boolean
    }

    expect(verified).toMatchObject({
      verified: true,
      roomAccessGranted: false,
      expiresAt: expect.any(Number),
    })
    const sessionToken = verified.sessionToken
    expect(sessionToken).toMatch(/^[a-f0-9]{64}$/)
    if (!sessionToken) throw new Error('Expected an opaque guest session token')
    expect(JSON.stringify(tables.guestSessions)).not.toContain(sessionToken)
    expect(tables.guestSessions[0]).toMatchObject({
      guestInvitationId: tables.guestInvitations[0]._id,
      guestId: tables.guestInvitations[0].guestId,
      status: 'ACTIVE',
    })

    // Verificar el correo NO abre la sala: la sesión nace con el NDA pendiente.
    await expect(
      runHandler(resolveGuestSession, ctx, resolveSessionArgs(sessionToken))
    ).resolves.toMatchObject({
      authenticated: true,
      guestId: tables.guestInvitations[0].guestId,
      roomAccessGranted: false,
      requiredGates: ['NDA'],
    })
    expect(tables.guestNdaAcceptances).toHaveLength(0)
  })

  it('rotates session tokens once and denies replay of the previous token', async () => {
    const tables = await guestSessionTables()
    const { ctx, invitation } = await prepareKnownChallenge(tables)
    const verified = (await runHandler(
      verifyOtpAndCreateSession,
      ctx,
      verifiedSessionArgs(invitation.invitationHandle)
    )) as { verified: true; sessionToken: string }

    const rotated = (await runHandler(
      rotateGuestSession,
      ctx,
      rotateSessionArgs(verified.sessionToken)
    )) as { rotated: true; sessionToken: string }
    expect(rotated.rotated).toBe(true)
    expect(rotated.sessionToken).not.toBe(verified.sessionToken)
    await expect(
      runHandler(resolveGuestSession, ctx, resolveSessionArgs(verified.sessionToken))
    ).resolves.toEqual({ authenticated: false })
    await expect(
      runHandler(rotateGuestSession, ctx, rotateSessionArgs(verified.sessionToken))
    ).resolves.toEqual({ rotated: false })
    await expect(
      runHandler(resolveGuestSession, ctx, resolveSessionArgs(rotated.sessionToken))
    ).resolves.toMatchObject({ authenticated: true })
  })

  it('allows a verified invitation to re-authenticate with a fresh one-time OTP', async () => {
    const tables = await guestSessionTables()
    const { ctx, invitation } = await prepareKnownChallenge(tables)
    const first = (await runHandler(
      verifyOtpAndCreateSession,
      ctx,
      verifiedSessionArgs(invitation.invitationHandle)
    )) as { verified: true; sessionToken: string }

    tables.guestOtpChallenges[0].cooldownUntil = 0
    const preparedAgain = await prepareOtpChallengeForDelivery(ctx as never, {
      invitationHandle: invitation.invitationHandle,
      email: 'fixture-bff21e9f@example.com',
      now: Date.now(),
      createToken: () => 'fresh-challenge-token-not-persisted',
      createCode: () => '112358',
      createSalt: () => 'fresh-challenge-salt',
    })
    expect(preparedAgain.delivery).not.toBeNull()

    const second = (await runHandler(
      verifyOtpAndCreateSession,
      ctx,
      verifiedSessionArgs(
        invitation.invitationHandle,
        'fresh-challenge-token-not-persisted',
        '112358'
      )
    )) as { verified: true; sessionToken: string }
    expect(second.sessionToken).not.toBe(first.sessionToken)
    await expect(
      runHandler(resolveGuestSession, ctx, resolveSessionArgs(first.sessionToken))
    ).resolves.toEqual({ authenticated: false })
    await expect(
      runHandler(resolveGuestSession, ctx, resolveSessionArgs(second.sessionToken))
    ).resolves.toMatchObject({ authenticated: true })
  })

  it('expires and revokes sessions fail-closed, including issuer invitation revocation', async () => {
    const tables = await guestSessionTables()
    const { ctx, invitation } = await prepareKnownChallenge(tables)
    const verified = (await runHandler(
      verifyOtpAndCreateSession,
      ctx,
      verifiedSessionArgs(invitation.invitationHandle)
    )) as { verified: true; sessionToken: string }

    tables.guestSessions[0].expiresAt = NOW - 1
    await expect(
      runHandler(resolveGuestSession, ctx, resolveSessionArgs(verified.sessionToken))
    ).resolves.toEqual({ authenticated: false })
    expect(tables.guestSessions[0].status).toBe('EXPIRED')

    const secondTables = await guestSessionTables()
    const second = await prepareKnownChallenge(secondTables)
    const secondVerified = (await runHandler(
      verifyOtpAndCreateSession,
      second.ctx,
      verifiedSessionArgs(second.invitation.invitationHandle)
    )) as { verified: true; sessionToken: string }

    await runHandler(revokeGuestSession, second.ctx, revokeSessionArgs(secondVerified.sessionToken))
    await expect(
      runHandler(resolveGuestSession, second.ctx, resolveSessionArgs(secondVerified.sessionToken))
    ).resolves.toEqual({ authenticated: false })

    const thirdTables = await guestSessionTables()
    const third = await prepareKnownChallenge(thirdTables)
    const thirdVerified = (await runHandler(
      verifyOtpAndCreateSession,
      third.ctx,
      verifiedSessionArgs(third.invitation.invitationHandle)
    )) as { verified: true; sessionToken: string }
    await runHandler(revoke, createConvexCtx(thirdTables, { identity: OWNER_IDENTITY }), {
      invitationId: thirdTables.guestInvitations[0]._id,
      reason: 'Se cerró el acceso de esta contraparte',
    })
    expect(thirdTables.guestSessions[0].status).toBe('REVOKED')
    await expect(
      runHandler(resolveGuestSession, third.ctx, resolveSessionArgs(thirdVerified.sessionToken))
    ).resolves.toEqual({ authenticated: false })
  })

  it('expires every active session and outstanding challenge when the invitation dies', async () => {
    const tables = await guestSessionTables()
    const { ctx, invitation } = await prepareKnownChallenge(tables)
    const verified = (await runHandler(
      verifyOtpAndCreateSession,
      ctx,
      verifiedSessionArgs(invitation.invitationHandle)
    )) as { verified: true; sessionToken: string }
    const guestInvitation = tables.guestInvitations[0]
    tables.guestSessions.push({
      ...tables.guestSessions[0],
      _id: 'parallel_active_session',
      sessionTokenHash: 'parallel_session_hash',
    })
    tables.guestOtpChallenges.push({
      ...tables.guestOtpChallenges[0],
      _id: 'outstanding_challenge',
      challengeTokenHash: 'outstanding_challenge_hash',
      status: 'ISSUED',
      attempts: 0,
      consumedAt: undefined,
    })
    guestInvitation.expiresAt = NOW - 1

    await expect(
      runHandler(resolveGuestSession, ctx, resolveSessionArgs(verified.sessionToken))
    ).resolves.toEqual({ authenticated: false })

    expect(guestInvitation.status).toBe('EXPIRED')
    expect(tables.guestSessions.filter((session) => session.status === 'ACTIVE')).toHaveLength(0)
    expect(tables.guestSessions.every((session) => session.status === 'EXPIRED')).toBe(true)
    expect(
      tables.guestOtpChallenges.find((row) => row._id === 'outstanding_challenge')
    ).toMatchObject({ status: 'EXPIRED' })
  })
})
