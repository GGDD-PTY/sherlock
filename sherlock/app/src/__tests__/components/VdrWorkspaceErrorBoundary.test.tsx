import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRefresh = vi.hoisted(() => vi.fn())

vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ refresh: mockRefresh }),
}))

function BrokenWorkspace(): never {
  throw new Error('sensitive provider payload')
}

describe('VdrWorkspaceErrorBoundary', () => {
  beforeEach(() => {
    mockRefresh.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('contains a workspace render failure behind safe bilingual recovery actions', async () => {
    const { VdrWorkspaceErrorBoundary } =
      await import('@/components/company/vdr/VdrWorkspaceErrorBoundary')

    render(
      <VdrWorkspaceErrorBoundary locale="es">
        <BrokenWorkspace />
      </VdrWorkspaceErrorBoundary>
    )

    expect(screen.getByRole('heading', { name: 'No pudimos cargar este espacio' })).toBeVisible()
    expect(screen.queryByText('sensitive provider payload')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Volver a la biblioteca' })).toHaveAttribute(
      'href',
      '/my-company/documents?room=company&view=documents&category=all'
    )

    await userEvent.click(screen.getByRole('button', { name: 'Intentar de nuevo' }))
    expect(mockRefresh).toHaveBeenCalledOnce()
  })
})
