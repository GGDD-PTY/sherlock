// ============================================================================
// EL DUEÑO SEMBRADO ENTRA POR EL DEV-LOGIN ([F] D1, tarjeta O3-01)
// ============================================================================
// `bun run seed:company --email samplefoods@dev.local` deja al dueño en el backend
// local. El dev-login tiene que reconstruir esa sesión desde el correo y dejar
// la cookie `sherlock_dev_user` con el id que el SSR usa para impersonar: es
// esa cookie, y no la lista fija, lo que decide QUÉ sala se abre. Si se rompe,
// Samplefoods Foods aterriza en la sala de `company@dev.local`.
// ============================================================================

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { DevAuthProvider, useDevAuth } from '@/lib/dev-auth/context'
import { devSeedOwnerIds } from '@/lib/dev-auth/seed-identity'
import { DEV_AUTH_COOKIE_ROLE, DEV_AUTH_COOKIE_USER, DEV_USERS } from '@/lib/dev-auth/types'

const SAMPLE_OWNER = 'samplefoods@dev.local'

function readCookie(name: string): string | null {
  const entry = document.cookie.split('; ').find((candidate) => candidate.startsWith(`${name}=`))
  return entry ? entry.slice(name.length + 1) : null
}

function Consumer({ email }: { email: string }) {
  const { signIn, user, currentRole } = useDevAuth()
  return (
    <div>
      <button type="button" onClick={() => signIn(email)}>
        entrar
      </button>
      <p data-testid="user">{user ? `${user.id}|${user.name}|${user.role}` : 'sin sesión'}</p>
      <p data-testid="identity">{user?.convexIdentity.subject ?? ''}</p>
      <p data-testid="role">{currentRole ?? ''}</p>
    </div>
  )
}

function renderWithProvider(email: string) {
  return render(
    <DevAuthProvider>
      <Consumer email={email} />
    </DevAuthProvider>
  )
}

describe('dev-auth: dueño sembrado', () => {
  beforeEach(() => {
    localStorage.clear()
    for (const name of [DEV_AUTH_COOKIE_USER, DEV_AUTH_COOKIE_ROLE]) {
      document.cookie = `${name}=; path=/; max-age=0`
    }
  })

  it('entra con su correo y deja la identidad del seed en la cookie', async () => {
    const ids = devSeedOwnerIds(SAMPLE_OWNER)
    renderWithProvider(SAMPLE_OWNER)

    await userEvent.click(screen.getByRole('button', { name: 'entrar' }))

    expect(screen.getByTestId('user')).toHaveTextContent(`${ids.clerkId}|Samplefoods|COMPANY`)
    expect(screen.getByTestId('identity')).toHaveTextContent(ids.workosUserId)
    expect(readCookie(DEV_AUTH_COOKIE_USER)).toBe(ids.clerkId)
    expect(readCookie(DEV_AUTH_COOKIE_ROLE)).toBe('COMPANY')
  })

  it('sobrevive al recargar: la sesión guardada vuelve al mismo dueño', async () => {
    const ids = devSeedOwnerIds(SAMPLE_OWNER)
    const first = renderWithProvider(SAMPLE_OWNER)
    await userEvent.click(screen.getByRole('button', { name: 'entrar' }))
    first.unmount()

    await act(async () => {
      renderWithProvider(SAMPLE_OWNER)
    })

    expect(screen.getByTestId('user')).toHaveTextContent(`${ids.clerkId}|Samplefoods|COMPANY`)
    expect(screen.getByTestId('role')).toHaveTextContent('COMPANY')
  })

  it('un correo fuera de dev.local no abre sesión ni escribe cookie', async () => {
    renderWithProvider('fixture-bdc28e21@example.com')

    await userEvent.click(screen.getByRole('button', { name: 'entrar' }))

    expect(screen.getByTestId('user')).toHaveTextContent('sin sesión')
    expect(readCookie(DEV_AUTH_COOKIE_USER)).toBeNull()
  })

  it('los dos usuarios fijos siguen entrando con su fila escrita a mano', async () => {
    for (const fixed of DEV_USERS) {
      localStorage.clear()
      const view = renderWithProvider(fixed.email)
      await userEvent.click(screen.getByRole('button', { name: 'entrar' }))

      expect(screen.getByTestId('user')).toHaveTextContent(
        `${fixed.id}|${fixed.name}|${fixed.role}`
      )
      expect(readCookie(DEV_AUTH_COOKIE_ROLE)).toBe(fixed.role)
      view.unmount()
    }
  })
})
