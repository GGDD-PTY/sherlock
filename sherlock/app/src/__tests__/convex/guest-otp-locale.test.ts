import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { requestOtpChallenge } from '../../../convex/guestAccess'
import { resend } from '../../../convex/email'
import {
  hashGuestEmail,
  hashInvitationHandle,
  maskGuestEmail,
} from '../../../convex/_guests/crypto'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'
import { withGuestServerProof } from './guest-server-proof-fixture'

const NOW = Date.now()

type EnqueuedEmail = { to: string; subject: string; text: string; html: string }

function guestTables(): Tables {
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
    ],
    profiles: [{ _id: 'profile_owner', userId: 'user_owner', role: 'COMPANY', isActive: true }],
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
    guestInvitations: [],
    guestOtpChallenges: [],
    guestSessions: [],
    rateLimits: [],
    activityLogs: [],
    adminAuditLogs: [],
  }
}

/**
 * Siembra una invitación ya persistida: el OTP viaja fuera del navegador, así
 * que el idioma solo puede venir de la fila, nunca del request que lo pide.
 */
async function seedInvitation(
  tables: Tables,
  input: { email: string; handle: string; locale?: 'es' | 'en' }
) {
  const emailHash = await hashGuestEmail(input.email)
  tables.guestInvitations.push({
    _id: 'guest_invitation_seed',
    _creationTime: NOW - 10,
    companyId: 'company_1',
    companyRoom: {
      documents: [],
      ndaTemplateId: 'template_1',
    },
    guestId: 'guest_seed',
    principalKey: 'GUEST:guest_seed',
    emailHash,
    emailMasked: maskGuestEmail(input.email),
    invitationHandleHash: await hashInvitationHandle(input.handle),
    status: 'PENDING',
    createdAt: NOW - 10,
    createdByProfileId: 'profile_owner',
    expiresAt: NOW + 86_400_000,
    ...(input.locale ? { locale: input.locale } : {}),
  })
}

async function requestOtp(tables: Tables, input: { handle: string; email: string }) {
  const args = { invitationHandle: input.handle, email: input.email }
  return await runHandler(
    requestOtpChallenge,
    createConvexCtx(tables),
    withGuestServerProof('REQUEST_OTP', Object.values(args), args)
  )
}

describe('guest OTP email locale', () => {
  beforeEach(() => {
    vi.stubEnv('CONVEX_ENV', 'dev')
    vi.stubEnv('RESEND_API_KEY', 're_test_guest_locale')
    vi.stubEnv('RESEND_FROM_EMAIL', 'Sherlock <sender@example.com>')
    vi.stubEnv('APP_URL', 'https://app.sherlock.capital')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('persists the invitation locale and delivers the OTP in that same language', async () => {
    const enqueue = vi.spyOn(resend, 'sendEmail').mockResolvedValue('email_1' as never)
    const tables = guestTables()
    const handle = 'l'.repeat(64)
    await seedInvitation(tables, { email: 'fixture-bff21e9f@example.com', handle, locale: 'en' })

    expect(tables.guestInvitations).toHaveLength(1)
    expect(tables.guestInvitations[0].locale).toBe('en')

    await requestOtp(tables, { handle, email: 'fixture-bff21e9f@example.com' })

    expect(enqueue).toHaveBeenCalledTimes(1)
    const otpEmail = enqueue.mock.calls[0][1] as unknown as EnqueuedEmail
    expect(otpEmail.subject).toBe('Your secure Sherlock access code')
    expect(otpEmail.text).toContain('Use this code to verify your email on Sherlock:')
    expect(otpEmail.text).toContain('The code expires in 10 minutes and can only be used once.')
    expect(otpEmail.html).toContain('If you did not request this code, ignore this message.')
    expect(otpEmail.text).not.toMatch(/código/i)
  })

  it('reads the language from the invitation, not from the request that asks for the code', async () => {
    const enqueue = vi.spyOn(resend, 'sendEmail').mockResolvedValue('email_1' as never)
    const tables = guestTables()
    const handle = 'e'.repeat(64)
    await seedInvitation(tables, {
      email: 'fixture-389db88c@example.com',
      handle,
      locale: 'en',
    })

    await requestOtp(tables, { handle, email: 'fixture-389db88c@example.com' })

    expect(enqueue).toHaveBeenCalledTimes(1)
    const otpEmail = enqueue.mock.calls[0][1] as unknown as EnqueuedEmail
    expect(otpEmail.subject).toBe('Your secure Sherlock access code')
    expect(otpEmail.text).toMatch(/\b\d{6}\b/)
    expect(otpEmail.text).toContain(
      'Verifying your email does not grant access to the data room or its documents.'
    )
  })

  it('falls back to Panamanian Spanish when the invitation carries no locale', async () => {
    const enqueue = vi.spyOn(resend, 'sendEmail').mockResolvedValue('email_1' as never)
    const tables = guestTables()
    const handle = 's'.repeat(64)
    await seedInvitation(tables, { email: 'fixture-b4c63c90@example.com', handle })

    await requestOtp(tables, { handle, email: 'fixture-b4c63c90@example.com' })

    expect(enqueue).toHaveBeenCalledTimes(1)
    const otpEmail = enqueue.mock.calls[0][1] as unknown as EnqueuedEmail
    expect(otpEmail.subject).toBe('Tu código de acceso seguro a Sherlock')
    expect(otpEmail.text).toContain('Usa este código para verificar tu email en Sherlock:')
    expect(otpEmail.text).toContain('El código vence en 10 minutos y solo se puede usar una vez.')
    // Tuteo panameño: nunca voseo ni formas peninsulares.
    expect(otpEmail.text).not.toMatch(/tenés|podés|usá|ignorá|vosotros|vuestro/i)
  })
})
