import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NextIntlClientProvider } from 'next-intl'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Id } from '@/../convex/_generated/dataModel'
import { NotificationsPageClient } from '@/components/notifications/NotificationsPageClient'
import esMessages from '@/messages/es.json'

const mockUseNotifications = vi.hoisted(() => vi.fn())

vi.unmock('next-intl')

vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: mockUseNotifications,
}))

vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

function notification(index: number, isRead: boolean) {
  return {
    id: `notification_${index}` as Id<'notifications'>,
    user_id: 'user_1' as Id<'users'>,
    type: 'new_message' as const,
    title: `Aviso ${index}`,
    message: 'Un aviso de la sala.',
    link: null,
    is_read: isRead,
    created_at: new Date().toISOString(),
  }
}

describe('NotificationsPageClient', () => {
  beforeEach(() => {
    mockUseNotifications.mockReturnValue({
      notifications: [
        {
          id: 'notification_1' as Id<'notifications'>,
          user_id: 'user_1' as Id<'users'>,
          type: 'new_message',
          title: 'Activity update',
          message: 'A new activity is ready for review.',
          link: null,
          is_read: false,
          created_at: new Date().toISOString(),
          metadata: {
            actorId: undefined,
            entityType: undefined,
            entityId: undefined,
          },
        },
      ],
      unreadCount: 1,
      preferences: {
        emailNewConnection: true,
        emailNewMessage: true,
        emailDealUpdates: true,
        emailWeeklyDigest: true,
        emailAnalysisComplete: true,
        pushEnabled: true,
      },
      isLoading: false,
      error: null,
      markAsRead: vi.fn().mockResolvedValue(undefined),
      markAllAsRead: vi.fn().mockResolvedValue(undefined),
      updatePreferences: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
    })
  })

  // La tarjeta O2-02 cambió la tarjeta por una fila: título, texto corto, fecha
  // y punto de no leída. La etiqueta del tipo («Mensaje», «Sistema») salió de
  // la pantalla y con ella `notifications.types` de `es.json`.
  it('renders the Spanish page copy as rows, without cards or type labels', () => {
    const { container } = render(
      <NextIntlClientProvider locale="es" messages={esMessages} timeZone="America/Panama">
        <NotificationsPageClient />
      </NextIntlClientProvider>
    )

    expect(screen.getByRole('button', { name: 'Marcar todas como leídas' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Todas (1)' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Sin leer (1)' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Leídas (0)' })).toBeInTheDocument()
    expect(screen.getByText('Hace un momento')).toBeInTheDocument()
    expect(screen.getByText('Activity update')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
    expect(container.querySelector('ul.divide-y')).toBeInTheDocument()
    expect(screen.queryByText('Mensaje')).not.toBeInTheDocument()
    expect(screen.queryByText('Sistema')).not.toBeInTheDocument()
  })

  // A 363px las tres pestañas con ícono, texto y contador se salían del cuerpo
  // (clientWidth 346, scrollWidth 370). La lista toma el ancho completo y cada
  // pestaña se queda con su tercio, así que nada empuja el ancho del cuerpo.
  it('shows a three-tab skeleton before the rows while loading', () => {
    mockUseNotifications.mockReturnValue({
      notifications: [],
      unreadCount: 0,
      preferences: {
        emailNewConnection: true,
        emailNewMessage: true,
        emailDealUpdates: true,
        emailWeeklyDigest: true,
        emailAnalysisComplete: true,
        pushEnabled: true,
      },
      isLoading: true,
      error: null,
      markAsRead: vi.fn(async () => {}),
      markAllAsRead: vi.fn(async () => {}),
      updatePreferences: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
    })

    const { container } = render(
      <NextIntlClientProvider locale="es" messages={esMessages} timeZone="America/Panama">
        <NotificationsPageClient />
      </NextIntlClientProvider>
    )

    expect(screen.getByRole('heading', { name: 'Notificaciones' })).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    const row = container.querySelector('.mt-4.mb-2.flex.h-10.w-full')
    expect(row).toBeInTheDocument()
    expect(row).toHaveClass('h-10', 'w-full')
    expect(row!.children).toHaveLength(3)
    expect(row!.children[0]).toHaveClass('h-10', 'flex-1')
    expect(row!.children[1]).toHaveClass('h-10', 'flex-1')
    expect(row!.children[2]).toHaveClass('h-10', 'flex-1')
  })

  it('spreads the tabs across the full width so narrow screens never scroll sideways', () => {
    render(
      <NextIntlClientProvider locale="es" messages={esMessages} timeZone="America/Panama">
        <NotificationsPageClient />
      </NextIntlClientProvider>
    )

    expect(screen.getByRole('tablist')).toHaveClass('w-full')

    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).toHaveClass('flex-1', 'min-w-0')
    }
  })

  it('keeps the tab count out of the truncated label at a 320px tab', () => {
    render(
      <NextIntlClientProvider locale="es" messages={esMessages} timeZone="America/Panama">
        <NotificationsPageClient />
      </NextIntlClientProvider>
    )

    for (const tab of screen.getAllByRole('tab')) {
      tab.classList.add('w-[320px]')
      const label = tab.querySelector('span.truncate')
      const count = tab.querySelector('span.shrink-0')
      expect(label).toHaveClass('truncate')
      expect(label).not.toHaveClass('shrink-0')
      expect(count).toHaveClass('shrink-0')
      expect(count).not.toHaveClass('truncate')
      expect(count).toHaveTextContent(/\(\d+\)/)
    }
  })

  // El hook pide 20 avisos y aparte el total sin leer de la cuenta. Con 25 sin
  // leer y 20 en la lista, «Leídas» era `20 - 25` = -5 y la pestaña «Sin leer»
  // prometía 25 que no estaban. Los tres contadores salen de la lista cargada y
  // el resto se dice en una línea.
  it('cuenta las pestañas con la lista cargada y avisa por las que quedaron afuera', async () => {
    mockUseNotifications.mockReturnValue({
      notifications: Array.from({ length: 20 }, (_, index) => notification(index, false)),
      unreadCount: 25,
      preferences: {
        emailNewConnection: true,
        emailNewMessage: true,
        emailDealUpdates: true,
        emailWeeklyDigest: true,
        emailAnalysisComplete: true,
        pushEnabled: true,
      },
      isLoading: false,
      error: null,
      markAsRead: vi.fn(async () => {}),
      markAllAsRead: vi.fn(async () => {}),
      updatePreferences: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
    })

    render(
      <NextIntlClientProvider locale="es" messages={esMessages} timeZone="America/Panama">
        <NotificationsPageClient />
      </NextIntlClientProvider>
    )

    expect(screen.getByRole('tab', { name: 'Todas (20)' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Sin leer (20)' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Leídas (0)' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Sin leer (20)' }))

    expect(
      screen.getByText('Tienes 5 notificaciones más sin leer que no aparecen aquí.')
    ).toBeInTheDocument()
  })

  // El subtítulo y «Marcar todas» leen la lista que se muestra, no el contador
  // de la cuenta (tarjeta O2-02, PENDING del 2026-09-10): con el filtro
  // «Leídas» puesto el subtítulo decía «13 sin leer» sobre una lista donde no
  // había ninguno, y el botón ofrecía marcarlos.
  it('el subtítulo y «Marcar todas» cuentan la lista filtrada, no el total', async () => {
    mockUseNotifications.mockReturnValue({
      notifications: Array.from({ length: 20 }, (_, index) => notification(index, index % 3 === 0)),
      unreadCount: 13,
      preferences: {
        emailNewConnection: true,
        emailNewMessage: true,
        emailDealUpdates: true,
        emailWeeklyDigest: true,
        emailAnalysisComplete: true,
        pushEnabled: true,
      },
      isLoading: false,
      error: null,
      markAsRead: vi.fn(async () => {}),
      markAllAsRead: vi.fn(async () => {}),
      updatePreferences: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
    })

    render(
      <NextIntlClientProvider locale="es" messages={esMessages} timeZone="America/Panama">
        <NotificationsPageClient />
      </NextIntlClientProvider>
    )

    expect(screen.getByText('13 sin leer')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Marcar todas como leídas' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Leídas (7)' }))

    // [F] 2026-09-17: arregla los hallazgos del E2E. Con avisos sin leer en la
    // cuenta, «Leídas» dice de qué habla la pestaña; «Todas las notificaciones
    // leídas» queda solo para cuando no queda ninguno sin leer.
    expect(screen.getByText('Aquí solo ves las que ya leíste.')).toBeInTheDocument()
    expect(screen.queryByText('Todas las notificaciones leídas')).not.toBeInTheDocument()
    expect(screen.queryByText('13 sin leer')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Marcar todas como leídas' })
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Sin leer (13)' }))

    expect(screen.getByText('13 sin leer')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Marcar todas como leídas' })).toBeInTheDocument()
  })

  // Las 20 cargadas pueden estar todas leídas y la cuenta seguir con avisos
  // viejos sin leer. Con el contador atado solo a la lista, la pantalla decía
  // «Todas las notificaciones leídas» y escondía el único botón que podía
  // marcarlos. El botón marca todos los del usuario, así que se queda.
  it('con las 20 cargadas leídas y avisos viejos sin leer, avisa y deja marcar', async () => {
    mockUseNotifications.mockReturnValue({
      notifications: Array.from({ length: 20 }, (_, index) => notification(index, true)),
      unreadCount: 25,
      preferences: {
        emailNewConnection: true,
        emailNewMessage: true,
        emailDealUpdates: true,
        emailWeeklyDigest: true,
        emailAnalysisComplete: true,
        pushEnabled: true,
      },
      isLoading: false,
      error: null,
      markAsRead: vi.fn(async () => {}),
      markAllAsRead: vi.fn(async () => {}),
      updatePreferences: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
    })

    render(
      <NextIntlClientProvider locale="es" messages={esMessages} timeZone="America/Panama">
        <NotificationsPageClient />
      </NextIntlClientProvider>
    )

    expect(
      screen.getByText('Tienes 25 notificaciones más sin leer que no aparecen aquí.')
    ).toBeInTheDocument()
    expect(screen.queryByText('Todas las notificaciones leídas')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Marcar todas como leídas' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Sin leer (0)' }))

    expect(screen.getByRole('button', { name: 'Marcar todas como leídas' })).toBeInTheDocument()

    // «Leídas» no habla de avisos sin leer: ahí el botón no aparece.
    await userEvent.click(screen.getByRole('tab', { name: 'Leídas (20)' }))

    // [F] 2026-09-17: arregla los hallazgos del E2E. Quedan 25 sin leer en la
    // cuenta, así que la frase de «todo leído» sería mentira.
    expect(screen.getByText('Aquí solo ves las que ya leíste.')).toBeInTheDocument()
    expect(screen.queryByText('Todas las notificaciones leídas')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Marcar todas como leídas' })
    ).not.toBeInTheDocument()
  })

  // Las 20 cargadas pueden estar todas leídas y el global seguir con avisos
  // viejos. El vacío de «Sin leer» decía que no había nada, al lado de la
  // línea que cuenta los que quedaron afuera.
  it('en Sin leer no dice que no hay avisos si quedaron sin leer fuera de la lista', async () => {
    mockUseNotifications.mockReturnValue({
      notifications: Array.from({ length: 20 }, (_, index) => notification(index, true)),
      unreadCount: 25,
      preferences: {
        emailNewConnection: true,
        emailNewMessage: true,
        emailDealUpdates: true,
        emailWeeklyDigest: true,
        emailAnalysisComplete: true,
        pushEnabled: true,
      },
      isLoading: false,
      error: null,
      markAsRead: vi.fn(async () => {}),
      markAllAsRead: vi.fn(async () => {}),
      updatePreferences: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
    })

    render(
      <NextIntlClientProvider locale="es" messages={esMessages} timeZone="America/Panama">
        <NotificationsPageClient />
      </NextIntlClientProvider>
    )

    await userEvent.click(screen.getByRole('tab', { name: 'Sin leer (0)' }))

    expect(
      screen.getByText('Tienes 25 notificaciones más sin leer que no aparecen aquí.')
    ).toBeInTheDocument()
    expect(screen.queryByText('No tienes notificaciones sin leer')).not.toBeInTheDocument()
  })
  // Reproducción exacta del hallazgo del E2E: un aviso sin leer en la cuenta y
  // la pestaña «Leídas» abierta.
  it('«Leídas» nunca dice «todo leído» mientras quede un aviso sin leer', async () => {
    mockUseNotifications.mockReturnValue({
      notifications: [notification(1, true), notification(2, false)],
      unreadCount: 1,
      preferences: {
        emailNewConnection: true,
        emailNewMessage: true,
        emailDealUpdates: true,
        emailWeeklyDigest: true,
        emailAnalysisComplete: true,
        pushEnabled: true,
      },
      isLoading: false,
      error: null,
      markAsRead: vi.fn(async () => {}),
      markAllAsRead: vi.fn(async () => {}),
      updatePreferences: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
    })

    render(
      <NextIntlClientProvider locale="es" messages={esMessages} timeZone="America/Panama">
        <NotificationsPageClient />
      </NextIntlClientProvider>
    )

    await userEvent.click(screen.getByRole('tab', { name: 'Leídas (1)' }))

    expect(screen.getByText('Aquí solo ves las que ya leíste.')).toBeInTheDocument()
    expect(screen.queryByText('Todas las notificaciones leídas')).not.toBeInTheDocument()
  })

  it('«Leídas» dice «todo leído» cuando de verdad no queda ninguno sin leer', async () => {
    mockUseNotifications.mockReturnValue({
      notifications: [notification(1, true), notification(2, true)],
      unreadCount: 0,
      preferences: {
        emailNewConnection: true,
        emailNewMessage: true,
        emailDealUpdates: true,
        emailWeeklyDigest: true,
        emailAnalysisComplete: true,
        pushEnabled: true,
      },
      isLoading: false,
      error: null,
      markAsRead: vi.fn(async () => {}),
      markAllAsRead: vi.fn(async () => {}),
      updatePreferences: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
    })

    render(
      <NextIntlClientProvider locale="es" messages={esMessages} timeZone="America/Panama">
        <NotificationsPageClient />
      </NextIntlClientProvider>
    )

    await userEvent.click(screen.getByRole('tab', { name: 'Leídas (2)' }))

    expect(screen.getByText('Todas las notificaciones leídas')).toBeInTheDocument()
    expect(screen.queryByText('Aquí solo ves las que ya leíste.')).not.toBeInTheDocument()
  })
})
