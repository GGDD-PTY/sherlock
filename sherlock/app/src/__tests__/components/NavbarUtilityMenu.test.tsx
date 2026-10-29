import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NavbarUtilityMenu } from '@/components/layout/NavbarUtilityMenu'

const setTheme = vi.fn()
const replace = vi.fn()

vi.mock('@/components/providers/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'system', setTheme }),
}))

vi.mock('next-intl', () => ({
  useLocale: () => 'es',
  useTranslations: (namespace: string) => (key: string) => {
    const translations: Record<string, string> = {
      account: 'Cuenta',
      settings: 'Configuración',
      signOut: 'Cerrar sesión',
      label: namespace.endsWith('theme') ? 'Tema' : 'Idioma',
      light: 'Claro',
      dark: 'Oscuro',
      system: 'Sistema',
    }
    return translations[key] ?? key
  },
}))

vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
  usePathname: () => '/my-company/documents',
  useRouter: () => ({ replace }),
}))

vi.mock('@/components/ui/dropdown-menu', async () => {
  const { createContext, useContext } = await import('react')
  const RadioGroupContext = createContext<{
    value?: string
    onValueChange?: (value: string) => void
  }>({})

  return {
    DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DropdownMenuItem: ({
      children,
      asChild,
      onSelect,
    }: {
      children: ReactNode
      asChild?: boolean
      onSelect?: () => void
    }) =>
      asChild ? (
        children
      ) : (
        <button type="button" onClick={onSelect}>
          {children}
        </button>
      ),
    DropdownMenuRadioGroup: ({
      children,
      value,
      onValueChange,
    }: {
      children: ReactNode
      value?: string
      onValueChange?: (value: string) => void
    }) => (
      <RadioGroupContext.Provider value={{ value, onValueChange }}>
        <div>{children}</div>
      </RadioGroupContext.Provider>
    ),
    DropdownMenuRadioItem: ({ children, value }: { children: ReactNode; value: string }) => {
      const group = useContext(RadioGroupContext)
      return (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={group.value === value}
          onClick={() => group.onValueChange?.(value)}
        >
          {children}
        </button>
      )
    },
  }
})

describe('NavbarUtilityMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('gives every grouped account action an explicit name', () => {
    render(<NavbarUtilityMenu onSignOut={vi.fn()} />)

    for (const label of ['Cuenta', 'Configuración', 'Tema', 'Cerrar sesión']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: 'Configuración' })).toHaveAttribute('href', '/settings')
  })

  // «Cuenta» y «Preferencias» eran dos cosas para lo mismo ([F] 2026-09-07
  // 09:00): este menú es «Cuenta» y la sala se enlaza por su propio nombre.
  it('is named Cuenta and no longer offers Preferencias', () => {
    render(<NavbarUtilityMenu onSignOut={vi.fn()} />)

    expect(screen.getByText('Cuenta')).toBeInTheDocument()
    expect(screen.queryByText('Preferencias')).not.toBeInTheDocument()
  })

  it('marca el tema activo como opción de radio', () => {
    render(<NavbarUtilityMenu onSignOut={vi.fn()} />)

    expect(screen.getByRole('menuitemradio', { name: 'Sistema' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByRole('menuitemradio', { name: 'Claro' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
  })

  // El sitio sirve un solo idioma: `/en/*` responde 308 a `/es`. Ofrecer
  // "Idioma" en Preferencias promete una opción que la ruta deshace sola. El
  // código de i18n queda intacto; lo que se retira es la entrada del menú.
  it('does not offer a language choice the site cannot honor', () => {
    render(<NavbarUtilityMenu onSignOut={vi.fn()} />)

    expect(screen.queryByText('Idioma')).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: 'Español' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: 'English' })).not.toBeInTheDocument()
  })

  it('wires theme and sign-out actions from the named menu', () => {
    const onSignOut = vi.fn()
    render(<NavbarUtilityMenu onSignOut={onSignOut} />)

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Oscuro' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }))

    expect(setTheme).toHaveBeenCalledWith('dark')
    expect(replace).not.toHaveBeenCalled()
    expect(onSignOut).toHaveBeenCalledOnce()
  })

  // El tipo permite que `onSignOut` rechace; antes `void onSignOut()` perdía
  // ese rechazo como promesa no manejada. Ahora corre por `runSignOut`, que
  // registra el error con `console.error` y lo ignora a propósito (cerrar
  // sesión no debe bloquear el menú). Ver research/BUGS.md #17.
  it('logs a rejected sign-out instead of leaving an unhandled rejection', async () => {
    const failure = new Error('workos unreachable')
    const onSignOut = vi.fn().mockRejectedValue(failure)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<NavbarUtilityMenu onSignOut={onSignOut} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }))

    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith('sign out failed', failure)
    })

    consoleError.mockRestore()
  })
})
