import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pathnameMock = vi.fn<() => string>()

vi.mock('@/i18n/navigation', () => ({
  usePathname: () => pathnameMock(),
}))

import { FooterGate } from '@/components/layout/FooterGate'
import { PUBLIC_CONTENT_PATHS } from '@/lib/product/public-routes'

function renderAt(pathname: string) {
  pathnameMock.mockReturnValue(pathname)
  return render(
    <FooterGate site={<footer>site footer</footer>} product={<footer>legal line</footer>} />
  )
}

describe('FooterGate', () => {
  beforeEach(() => pathnameMock.mockReset())

  it.each([...PUBLIC_CONTENT_PATHS])('shows the site footer on %s', (pathname) => {
    renderAt(pathname)
    expect(screen.getByText('site footer')).toBeInTheDocument()
    expect(screen.queryByText('legal line')).not.toBeInTheDocument()
  })

  it.each(['/my-company/documents', '/admin', '/settings', '/intake', '/vdr-guest'])(
    'shows the one-line legal footer inside the product at %s',
    (pathname) => {
      renderAt(pathname)
      expect(screen.getByText('legal line')).toBeInTheDocument()
      expect(screen.queryByText('site footer')).not.toBeInTheDocument()
    }
  )
})
