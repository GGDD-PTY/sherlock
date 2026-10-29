import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import esMessages from '@/messages/es.json'

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) =>
    key === 'title'
      ? esMessages.settings.privacy.meta.title
      : esMessages.settings.privacy.meta.description,
  setRequestLocale: vi.fn(),
}))

vi.mock('@/lib/auth/session', () => ({
  requireAuth: vi.fn(async () => ({ id: 'user_1' })),
}))

vi.mock('@/app/[locale]/(app)/settings/privacy/PrivacySettingsClient', () => ({
  PrivacySettingsClient: () => null,
}))

const source = readFileSync(
  join(process.cwd(), 'src/app/[locale]/(app)/settings/privacy/page.tsx'),
  'utf8'
)

describe('privacy settings server page', () => {
  it('gates the route with requireAuth and does not ship as a client page', () => {
    expect(source).not.toMatch(/^\s*['"]use client['"]/m)
    expect(source).toContain("requireAuth('/settings/privacy', locale)")
  })

  it('uses the privacy catalog for title and description', async () => {
    const { generateMetadata } = await import('@/app/[locale]/(app)/settings/privacy/page')
    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: 'es' }),
    })

    expect(metadata.title).toBe('Privacidad')
    expect(metadata.description).toBe('Tus consentimientos, exportación y borrado de datos.')
  })
})
