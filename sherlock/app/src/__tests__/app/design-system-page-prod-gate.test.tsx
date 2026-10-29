import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockNotFound = vi.fn(() => {
  throw new Error('NOT_FOUND')
})

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
}))

vi.mock('next-intl/server', () => ({
  getTranslations: () => (key: string) => key,
  setRequestLocale: vi.fn(),
}))

vi.mock('@/components/showcase/PrimitiveShowcase', () => ({
  PrimitiveShowcase: () => 'PRIMITIVE_SHOWCASE',
}))

async function loadPage() {
  const { default: DesignSystemPage } = await import('@/app/[locale]/design-system/page')
  return DesignSystemPage
}

describe('design-system page production gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns notFound in production before rendering the showcase', async () => {
    const DesignSystemPage = await loadPage()
    vi.stubEnv('NODE_ENV', 'production')

    await expect(DesignSystemPage({ params: Promise.resolve({ locale: 'es' }) })).rejects.toThrow(
      'NOT_FOUND'
    )
    expect(mockNotFound).toHaveBeenCalledTimes(1)
  })

  it('renders the showcase outside production', async () => {
    const DesignSystemPage = await loadPage()

    const result = await DesignSystemPage({
      params: Promise.resolve({ locale: 'es' }),
    })

    expect(mockNotFound).not.toHaveBeenCalled()
    expect(result.type()).toBe('PRIMITIVE_SHOWCASE')
  })
})
