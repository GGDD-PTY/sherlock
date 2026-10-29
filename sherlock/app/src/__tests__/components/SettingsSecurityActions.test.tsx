import { fireEvent, render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DeleteAccountDialog } from '@/components/settings/DeleteAccountDialog'
import { SecurityActions } from '@/components/settings/SecurityActions'
import esMessages from '@/messages/es.json'

const { mockToastInfo } = vi.hoisted(() => ({ mockToastInfo: vi.fn() }))

vi.unmock('next-intl')
vi.mock('@/lib/dev-auth/config', () => ({ DEV_AUTH_ENABLED: false }))
vi.mock('sonner', () => ({
  toast: { info: mockToastInfo, success: vi.fn(), error: vi.fn() },
}))
vi.mock('@/app/[locale]/(app)/settings/actions', () => ({
  deleteAccount: vi.fn().mockResolvedValue({ success: true }),
}))

function renderSpanish(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages} timeZone="America/Panama">
      {ui}
    </NextIntlClientProvider>
  )
}

describe('settings security production renders', () => {
  beforeEach(() => mockToastInfo.mockReset())

  it('catches the paused-account dialog reverting to social-connection copy', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderSpanish(<DeleteAccountDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Pausar mi cuenta' }))

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText('Tus mensajes y solicitudes de acceso')).toBeInTheDocument()
    expect(screen.queryByText('Tus mensajes y conexiones')).not.toBeInTheDocument()
    expect(
      consoleError.mock.calls
        .flat()
        .some((value) => String(value).includes('cannot be a descendant'))
    ).toBe(false)
    consoleError.mockRestore()
  })

  it('routes password recovery through the real sign-in flow', () => {
    renderSpanish(<SecurityActions />)

    expect(
      screen.getByText(
        'Si necesitas recuperar tu contraseña, abre el inicio de sesión y elige la opción de recuperación. Si entras con Google, gestiona el acceso desde tu cuenta de Google.'
      )
    ).toBeVisible()
    // [F] 2026-09-17: arregla los hallazgos del E2E. La puerta de sesión es un
    // ancla nativa con el locale a mano: termina fuera del origen (WorkOS) y
    // una navegación de cliente pediría un payload RSC que no existe.
    const door = screen.getByRole('link', { name: 'Abrir inicio de sesión' })
    expect(door).toHaveAttribute('href', '/es/sign-in')
    expect(door).not.toHaveAttribute('data-prefetch')
    expect(mockToastInfo).not.toHaveBeenCalled()
  })
})
