import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ADMIN_STEP_UP_MAX_AGE_SECONDS,
  createAdminStepUpCookieValue,
  isRecentAdminStepUpCookie,
} from '@/lib/auth/admin-step-up'

const NOW = new Date('2026-08-03T16:00:00.000-05:00').getTime()
const BINDING = { subject: 'workos_admin_001', sessionId: 'session_admin_001' }
const ORIGINAL_ENV = process.env

describe('admin step-up v2 session binding', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      WORKOS_ADMIN_STEP_UP_COOKIE_SECRET: 'test-admin-step-up-secret-with-strong-entropy',
    }
    delete process.env.WORKOS_ADMIN_STEP_UP_METHODS
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
  })

  it('accepts a signed strong-auth marker only for the exact WorkOS subject and session', () => {
    const cookie = createAdminStepUpCookieValue('Passkey', BINDING, NOW)

    expect(cookie).toBeTruthy()
    expect(cookie).not.toContain(BINDING.subject)
    expect(cookie).not.toContain(BINDING.sessionId)
    expect(isRecentAdminStepUpCookie(cookie ?? undefined, BINDING, NOW + 1_000)).toBe(true)
    expect(
      isRecentAdminStepUpCookie(cookie ?? undefined, { ...BINDING, subject: 'workos_other' }, NOW)
    ).toBe(false)
    expect(
      isRecentAdminStepUpCookie(cookie ?? undefined, { ...BINDING, sessionId: 'sid_other' }, NOW)
    ).toBe(false)
  })

  it('rejects legacy, tampered, expired, and future markers', () => {
    const cookie = createAdminStepUpCookieValue('SSO', BINDING, NOW)
    expect(cookie).toBeTruthy()

    expect(isRecentAdminStepUpCookie(`${NOW}.SSO.legacy-signature`, BINDING, NOW)).toBe(false)
    expect(isRecentAdminStepUpCookie(`${cookie}tampered`, BINDING, NOW)).toBe(false)
    expect(
      isRecentAdminStepUpCookie(
        cookie ?? undefined,
        BINDING,
        NOW + ADMIN_STEP_UP_MAX_AGE_SECONDS * 1_000 + 1
      )
    ).toBe(false)
    expect(isRecentAdminStepUpCookie(cookie ?? undefined, BINDING, NOW - 1)).toBe(false)
  })

  // [F] 2026-09-02: la ventana pasa de 10 minutos a 12 horas. La cookie sigue
  // atada al `sid` de WorkOS, así que sigue siendo "una entrada fuerte por
  // sesión", no una sesión eterna: cerrar sesión invalida el marcador.
  // Reversible en una línea: ADMIN_STEP_UP_MAX_AGE_SECONDS.
  it('mantiene el marcador vivo una jornada de trabajo y lo caduca a las 12 horas', () => {
    expect(ADMIN_STEP_UP_MAX_AGE_SECONDS).toBe(12 * 60 * 60)

    const cookie = createAdminStepUpCookieValue('Passkey', BINDING, NOW)
    const elevenHoursLater = NOW + 11 * 60 * 60 * 1_000

    expect(isRecentAdminStepUpCookie(cookie ?? undefined, BINDING, elevenHoursLater)).toBe(true)
    expect(
      isRecentAdminStepUpCookie(cookie ?? undefined, BINDING, NOW + 12 * 60 * 60 * 1_000 + 1)
    ).toBe(false)
  })

  it('refuses weak or unconfigured authentication methods and missing secrets', () => {
    expect(createAdminStepUpCookieValue('password', BINDING, NOW)).toBeNull()
    process.env.WORKOS_ADMIN_STEP_UP_METHODS = 'HardwareKey'
    expect(createAdminStepUpCookieValue('SSO', BINDING, NOW)).toBeNull()
    expect(createAdminStepUpCookieValue('HardwareKey', BINDING, NOW)).toBeTruthy()

    delete process.env.WORKOS_ADMIN_STEP_UP_COOKIE_SECRET
    delete process.env.WORKOS_COOKIE_PASSWORD
    expect(createAdminStepUpCookieValue('HardwareKey', BINDING, NOW)).toBeNull()
  })
})
