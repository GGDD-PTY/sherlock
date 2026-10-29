import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConsentBanner } from '@/components/analytics/ConsentBanner'

describe('ConsentBanner', () => {
  it('renders no consent prompt and does not access browser storage', () => {
    const localStorageAccess = vi.spyOn(window, 'localStorage', 'get')
    const sessionStorageAccess = vi.spyOn(window, 'sessionStorage', 'get')

    render(<ConsentBanner />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(localStorageAccess).not.toHaveBeenCalled()
    expect(sessionStorageAccess).not.toHaveBeenCalled()
  })
})
