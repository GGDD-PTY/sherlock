import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const privacyPolicy = readFileSync(
  resolve(process.cwd(), 'src/app/[locale]/(public)/privacy/page.tsx'),
  'utf8'
)
const implementationGuide = readFileSync(
  resolve(process.cwd(), 'docs/CONSENT_IMPLEMENTATION.md'),
  'utf8'
)

describe('PostHog privacy-policy contract', () => {
  // [F] 2026-09-03 23:30: el sitio ships solo en español; la política ya no
  // lleva su gemela en inglés, así que el contrato se pinnea sobre la española.
  it('describes analytics without cookies and browser opt-out without a banner', () => {
    expect(privacyPolicy).toContain('Herramienta de analítica sin cookies')
    expect(privacyPolicy).toContain('Do Not Track')
    expect(privacyPolicy).not.toContain("Platform's cookie notice")
    expect(privacyPolicy).not.toContain('aviso de cookies de la Plataforma')
  })

  it('keeps the implementation guide aligned with replay and localStorage', () => {
    expect(implementationGuide).toContain("persistence: 'localStorage'")
    expect(implementationGuide).toContain('Session Replay')
    expect(privacyPolicy).toContain('localStorage')
    expect(privacyPolicy).not.toContain('excluye las rutas confidenciales')
    expect(implementationGuide).toContain('Do Not Track')
    expect(implementationGuide).not.toContain('getConsent()')
    expect(implementationGuide).not.toContain('revokeConsent()')
  })
})
