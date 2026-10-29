import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MycroftLanding } from '@/components/mycroft/MycroftLanding'

const mockSetRequestLocale = vi.fn()
const mockGetTranslations = vi.fn()

vi.mock('next-intl/server', () => ({
  setRequestLocale: (...args: unknown[]) => mockSetRequestLocale(...args),
  getTranslations: (...args: unknown[]) => mockGetTranslations(...args),
}))

vi.mock('@/lib/site/brand', () => ({
  buildLocalizedPageMetadata: (input: Record<string, unknown>) => input,
}))

describe('home page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetTranslations.mockImplementation(async ({ namespace }: { namespace: string }) => {
      return (key: string) => `${namespace}.${key}`
    })
  })

  it.each(['es'] as const)(
    'serves the Mycroft intake at / and sends %s sign-up back to the company VDR',
    async (locale) => {
      const { default: HomePage } = await import('@/app/[locale]/(public)/page')

      const element = await HomePage({ params: Promise.resolve({ locale }) })

      expect(mockSetRequestLocale).toHaveBeenCalledWith(locale)
      expect(element.type).toBe(MycroftLanding)
      expect(element.props.secureHref).toBe(
        `/${locale}/sign-up?returnTo=${encodeURIComponent(`/${locale}/my-company/documents`)}`
      )
      expect(element.props.secureHref).not.toContain('onboarding')
    }
  )

  // El noindex murió con /mycroft: el intake es ahora la home y tiene que ser
  // indexable, o el swap costaría toda la presencia orgánica del dominio.
  it('keeps the home indexable and describes it with the Mycroft metadata', async () => {
    const { generateMetadata } = await import('@/app/[locale]/(public)/page')

    const metadata = await generateMetadata({ params: Promise.resolve({ locale: 'es' }) })

    expect(metadata.robots).toBeUndefined()
    expect(metadata).toMatchObject({
      locale: 'es',
      path: '',
      title: 'mycroft.meta.title',
      description: 'mycroft.meta.description',
    })
    expect(mockGetTranslations).not.toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'landing.meta' })
    )
  })
})
