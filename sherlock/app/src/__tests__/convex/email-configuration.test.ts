import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEmailConfiguration } from '../../../convex/_helpers/emailConfig'
import { isProductEmailEnabled, resend, sendProductEmail } from '../../../convex/email'
import {
  isGuestInitialInvitationDeliveryConfigured,
  isGuestOtpDeliveryConfigured,
  requestGuestOtpDelivery,
} from '../../../convex/_guests/delivery'

beforeEach(() => {
  vi.stubEnv('CONVEX_ENV', 'dev')
  vi.stubEnv('RESEND_API_KEY', 'test-key')
  vi.stubEnv('RESEND_FROM_EMAIL', 'Installation <sender@example.com>')
  vi.stubEnv('APP_URL', 'https://app.example.com/')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('installation email configuration', () => {
  it('uses only the explicitly configured sender and app origin', () => {
    expect(getEmailConfiguration()).toEqual({
      from: 'Installation <sender@example.com>',
      appOrigin: 'https://app.example.com',
    })
  })

  it.each(['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'APP_URL'])(
    'disables product, invitation and OTP delivery without %s',
    async (missing) => {
      vi.stubEnv(missing, ' ')
      expect(getEmailConfiguration()).toBeNull()
      expect(isProductEmailEnabled()).toBe(false)
      expect(isGuestOtpDeliveryConfigured()).toBe(false)
      expect(isGuestInitialInvitationDeliveryConfigured()).toBe(false)
      const enqueue = vi.spyOn(resend, 'sendEmail')
      const db = { get: vi.fn(), query: vi.fn() }
      const ctx = { db } as unknown as Parameters<typeof sendProductEmail>[0]
      await sendProductEmail(ctx, {
        recipientProfileId: 'profile_1' as never,
        event: 'deliverable_published',
      })
      await expect(
        requestGuestOtpDelivery(ctx, {
          invitationHandle: 'a'.repeat(64),
          email: 'guest@example.com',
        })
      ).resolves.toMatchObject({ accepted: true })
      expect(enqueue).not.toHaveBeenCalled()
      expect(db.get).not.toHaveBeenCalled()
      expect(db.query).not.toHaveBeenCalled()
    }
  )

  it.each([
    'invalid',
    'https://user:pass@app.example.com',
    'https://app.example.com/path',
    'https://app.example.com?query=1',
  ])('rejects an invalid APP_URL: %s', (appUrl) => {
    vi.stubEnv('APP_URL', appUrl)
    expect(getEmailConfiguration()).toBeNull()
  })

  it('requires explicit live delivery and a public HTTPS origin in production', () => {
    vi.stubEnv('CONVEX_ENV', 'production')
    vi.stubEnv('RESEND_TEST_MODE', '')
    expect(getEmailConfiguration()).toBeNull()
    vi.stubEnv('RESEND_TEST_MODE', 'false')
    expect(getEmailConfiguration()?.appOrigin).toBe('https://app.example.com')
    vi.stubEnv('APP_URL', 'https://localhost:3000')
    expect(getEmailConfiguration()).toBeNull()
  })
})
