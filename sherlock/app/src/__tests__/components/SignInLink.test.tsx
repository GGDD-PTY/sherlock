// ============================================================================
// PUERTA DE AUTENTICACIÓN: NAVEGACIÓN COMPLETA, NO DE CLIENTE
// ============================================================================
// `/sign-in` redirige a `/login`, un route handler que manda a WorkOS, otro
// origen. Con un `<Link>` el router pedía el payload RSC de esa URL, recibía
// un 307 cross-origin que no puede parsear y logueaba «Failed to fetch RSC
// payload for /login?returnTo=…» antes de caer a navegación completa.
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { SignInLink } from '@/components/layout/SignInLink'

vi.mock('next-intl', () => ({
  useLocale: () => 'es',
}))

describe('SignInLink', () => {
  it('renders a plain anchor with the locale prefix and no prefetch', () => {
    render(<SignInLink>Iniciar sesión</SignInLink>)

    const link = screen.getByRole('link', { name: 'Iniciar sesión' })
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', '/es/sign-in')
    // Un `<a>` nativo no prefetchea. Estos atributos solo aparecerían si el
    // enlace volviera a pasar por el router de Next.
    expect(link).not.toHaveAttribute('data-prefetch')
    expect(link).not.toHaveAttribute('prefetch')
  })

  it('forwards click handlers so the compact menu can close itself', () => {
    const onClick = vi.fn()
    render(
      <SignInLink
        onClick={(event) => {
          // jsdom no navega; el preventDefault solo calla su aviso.
          event.preventDefault()
          onClick()
        }}
      >
        Iniciar sesión
      </SignInLink>
    )

    screen.getByRole('link', { name: 'Iniciar sesión' }).click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  // Las cuatro puertas visibles a `/sign-in`. La barra no era la única: la
  // ayuda de acceso de Ajustes y el 404 llevaban al mismo sitio por el router,
  // así que repetían el error de payload RSC y el PKCE quemado.
  const SIGN_IN_DOORS = [
    'src/components/layout/Navbar.tsx',
    'src/components/layout/PublicNavbar.tsx',
    'src/components/settings/SecurityActions.tsx',
    'src/app/[locale]/not-found.tsx',
  ]

  it('keeps every sign-in door off the client router', () => {
    const doors = SIGN_IN_DOORS.map((path) => ({
      path,
      source: readFileSync(join(process.cwd(), path), 'utf8'),
    }))

    const clientRouted = doors
      .filter(({ source }) => /<Link[\s\S]*?href=\{?["'`]?\/sign-in/.test(source))
      .map(({ path }) => path)
    expect(clientRouted).toEqual([])

    const withoutTheAnchor = doors
      .filter(({ source }) => !source.includes('SignInLink'))
      .map(({ path }) => path)
    expect(withoutTheAnchor).toEqual([])
  })
})
