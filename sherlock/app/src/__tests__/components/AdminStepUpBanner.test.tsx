// ============================================================================
// BANNER DE STEP-UP ADMIN — el copy tiene que ser accionable
// ============================================================================
// `requireRole` rebota al equipo a /settings?error=admin-mfa-required cuando la
// cookie de step-up caducó. El banner decía "MFA requerido / configura un
// segundo factor": un TOTP no abre nada, porque el marcador solo lo emite
// `createAdminStepUpCookieValue` para SSO o Passkey (callback/route.ts). Este
// test fija que el banner nombre la acción que sí funciona y ofrezca la puerta.
// ============================================================================

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AdminStepUpBanner } from '@/components/settings/AdminStepUpBanner'
import esMessages from '@/messages/es.json'

const FORBIDDEN_ES = ['MFA', 'segundo factor', 'doble factor']

describe('AdminStepUpBanner', () => {
  it('nombra la passkey y no promete que un segundo factor sirva', () => {
    render(<AdminStepUpBanner locale="es" />)

    const banner = screen.getByRole('alert')
    expect(banner.textContent).toMatch(/passkey/i)
    for (const forbidden of FORBIDDEN_ES) {
      expect(banner.textContent).not.toMatch(new RegExp(forbidden, 'i'))
    }
  })

  it('ofrece la puerta de vuelta al panel con el returnTo localizado', () => {
    render(<AdminStepUpBanner locale="es" />)

    const cta = screen.getByRole('link', { name: /passkey/i })
    expect(cta).toHaveAttribute('href', `/login?returnTo=${encodeURIComponent('/es/admin')}`)
  })

  // El banner recibe el locale como `string` porque vive en una ruta `[locale]`.
  // Retirado el catálogo `en`, lo que se pinnea es que el returnTo se arma con
  // el prefijo que la ruta trae y no con uno cableado.
  it('arma el returnTo con el prefijo de la ruta, no con uno cableado', () => {
    render(<AdminStepUpBanner locale="es" />)

    const cta = screen.getByRole('link', { name: /passkey/i })
    expect(cta).toHaveAttribute('href', `/login?returnTo=${encodeURIComponent('/es/admin')}`)
    expect(cta.getAttribute('href')).not.toContain('/en/')
  })

  it('ships el copy honesto en español', () => {
    const es = esMessages.settings

    for (const key of ['adminStepUpTitle', 'adminStepUpDescription', 'adminStepUpCta'] as const) {
      expect(es[key], `falta ${key} en es.json`).toBeTruthy()
    }

    expect(es.adminStepUpTitle).toMatch(/passkey/i)

    const esCopy = `${es.adminStepUpTitle} ${es.adminStepUpDescription} ${es.adminStepUpCta}`
    for (const forbidden of FORBIDDEN_ES) {
      expect(esCopy).not.toMatch(new RegExp(forbidden, 'i'))
    }

    // Tuteo panameño: nada de voseo ni de peninsular.
    expect(esCopy).not.toMatch(/\b(tenés|podés|vos|debés|vuestro)\b/i)
  })
})
