import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequireRole = vi.fn()
const mockRedirect = vi.fn()

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
  setRequestLocale: vi.fn(),
}))

vi.mock('@/lib/auth/session', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}))

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  redirect: (...args: unknown[]) => mockRedirect(...args),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}))

vi.mock('@/components/admin/AdminIntakeQueue', () => ({
  AdminIntakeQueue: () => <div data-testid="admin-intake-queue" />,
}))

vi.mock('@/components/admin/AdminSupportInbox', () => ({
  AdminSupportInbox: () => <div data-testid="admin-support-inbox" />,
}))

vi.mock('@/components/admin/AdminPreparationWorkspace', () => ({
  AdminPreparationWorkspace: ({ intakeSessionId }: { intakeSessionId: string }) => (
    <div data-testid="admin-intake-assessment" data-intake-session-id={intakeSessionId} />
  ),
}))

describe('admin support assessment route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireRole.mockResolvedValue({ role: 'ADMIN', isViewingAs: false })
  })

  it('fails closed while the real admin is operating in View As mode', async () => {
    mockRequireRole.mockResolvedValue({ role: 'ADMIN', isViewingAs: true })
    const { default: AdminSupportPage } = await import('@/app/[locale]/(app)/admin/support/page')

    await AdminSupportPage({
      params: Promise.resolve({ locale: 'es' }),
      searchParams: Promise.resolve({ intake: 'intake_session_1' }),
    })

    expect(mockRedirect).toHaveBeenCalledWith({ href: '/admin', locale: 'es' })
  })

  it('mounts the assessment workspace for the queue intake selection', async () => {
    const { default: AdminSupportPage } = await import('@/app/[locale]/(app)/admin/support/page')

    const page = await AdminSupportPage({
      params: Promise.resolve({ locale: 'es' }),
      searchParams: Promise.resolve({ intake: 'intake_session_1' }),
    })
    render(page)

    expect(screen.getByTestId('admin-intake-assessment')).toHaveAttribute(
      'data-intake-session-id',
      'intake_session_1'
    )
  })

  it('keeps the viewport height when no intake is selected', async () => {
    const { default: AdminSupportPage } = await import('@/app/[locale]/(app)/admin/support/page')

    const page = await AdminSupportPage({
      params: Promise.resolve({ locale: 'es' }),
      searchParams: Promise.resolve({}),
    })
    const { container } = render(page)
    const root = container.firstElementChild

    expect(root?.className).toContain('lg:h-[calc(100dvh-7.5rem)]')
    expect(screen.queryByTestId('admin-intake-assessment')).not.toBeInTheDocument()
    expect(screen.getByTestId('admin-support-inbox').parentElement?.className).not.toContain(
      'lg:h-[36rem]'
    )
  })

  it('drops the viewport height and gives the inbox 36rem when an intake is selected', async () => {
    const { default: AdminSupportPage } = await import('@/app/[locale]/(app)/admin/support/page')

    const page = await AdminSupportPage({
      params: Promise.resolve({ locale: 'es' }),
      searchParams: Promise.resolve({ intake: 'intake_session_1' }),
    })
    const { container } = render(page)
    const root = container.firstElementChild

    expect(root?.className).not.toContain('lg:h-[calc(100dvh-7.5rem)]')
    expect(screen.getByTestId('admin-intake-assessment')).toBeInTheDocument()
    expect(screen.getByTestId('admin-support-inbox').parentElement?.className).toContain(
      'lg:h-[36rem]'
    )
  })
})
