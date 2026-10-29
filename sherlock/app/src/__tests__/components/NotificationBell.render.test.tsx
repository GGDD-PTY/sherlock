import { fireEvent, render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NotificationBell } from '@/components/notifications/NotificationBell'
import esMessages from '@/messages/es.json'

const notificationState = vi.hoisted(() => ({ unreadCount: 0 }))

vi.unmock('next-intl')
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ profile: { _id: 'profile_test' }, isLoading: false }),
}))
vi.mock('convex/react', () => ({
  useQuery: (name: string) => {
    if (name === 'notifications:getNotifications') return []
    if (name === 'notifications:getUnreadCount') return notificationState.unreadCount
    if (name === 'notifications:getPreferences') return null
    return undefined
  },
  useMutation: () => vi.fn(),
}))
vi.mock('../../../convex/_generated/api', () => ({
  api: {
    notifications: {
      getNotifications: 'notifications:getNotifications',
      getUnreadCount: 'notifications:getUnreadCount',
      getPreferences: 'notifications:getPreferences',
      markAsRead: 'notifications:markAsRead',
      markAllAsRead: 'notifications:markAllAsRead',
      updatePreferences: 'notifications:updatePreferences',
    },
  },
}))
vi.mock('@/lib/dev-auth', () => ({ DEV_AUTH_ENABLED: false }))
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    children,
    href,
    onClick,
  }: {
    children: ReactNode
    href: string
    onClick?: () => void
  }) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
}))

function renderBell(locale: 'es') {
  return render(
    <NextIntlClientProvider locale={locale} messages={esMessages} timeZone="America/Panama">
      <NotificationBell showLabel />
    </NextIntlClientProvider>
  )
}

describe('NotificationBell production render', () => {
  beforeEach(() => {
    notificationState.unreadCount = 0
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })

  it.each([['es', 'Notificaciones', 'No tienes notificaciones']] as const)(
    'keeps the bell trigger, accessible name, and empty state in %s',
    (locale, triggerName, emptyState) => {
      renderBell(locale)

      const trigger = screen.getByRole('button', { name: triggerName })
      fireEvent.click(trigger)

      expect(screen.getByRole('heading', { name: triggerName })).toBeInTheDocument()
      expect(screen.getByText(emptyState)).toBeInTheDocument()
    }
  )

  it('renders the unread-count accessible name in Spanish without leaking English', () => {
    notificationState.unreadCount = 2

    renderBell('es')

    expect(screen.getByRole('button', { name: 'Notificaciones (2 sin leer)' })).toBeInTheDocument()
    expect(screen.queryByText(/unread/i)).not.toBeInTheDocument()
  })

  // La píldora era un cuadro de 20x20 con `9+` como tope: dos dígitos ya la
  // llenaban y tres la recortaban. Ahora crece con el número y corta en «99+»
  // (tarjeta O2-02).
  it.each([
    [9, '9'],
    [42, '42'],
    [99, '99'],
    [100, '99+'],
    [1250, '99+'],
  ])('shows %i unread as %s without a fixed-width badge', (unread, label) => {
    notificationState.unreadCount = unread

    const { container } = renderBell('es')

    const badge = container.querySelector('[data-slot="badge"]')
    expect(badge).toHaveTextContent(label)
    expect(badge).toHaveClass('min-w-5')
    expect(badge).not.toHaveClass('w-5')
  })
})
