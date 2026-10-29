import { Effect } from 'effect'
import { LogOut, Settings, Sun, UserCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { runSignOut } from '@/components/layout/run-sign-out'
import { isTheme, ThemeSchema, type Theme } from '@/components/providers/theme-schema'
import { useTheme } from '@/components/providers/ThemeProvider'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Link } from '@/i18n/navigation'
import { runClientEffect, runClientSync } from '@/lib/effect/client-runtime'

type NavbarUtilityMenuProps = {
  readonly onSignOut: () => void | Promise<void>
}

// El control de Radix entrega un `string` cualquiera. `isTheme` ya rechaza
// lo que no está en el catálogo; el programa nombra el paso que escribe.
const applyThemeFromControl = Effect.fn('NavbarUtilityMenu.applyTheme')(function* (
  value: string,
  apply: (theme: Theme) => void
) {
  if (!isTheme(value)) return
  yield* Effect.sync(() => apply(value))
})

// «Cuenta» agrupa lo que es de la persona: configuración, tema y cerrar sesión
// ([F] 2026-09-07 09:00, antes «Preferencias»). La sala se alcanza por su
// propio enlace («Data Room» / «Panel»), no desde aquí.
// El sitio sirve un solo idioma: `/en/*` responde 308 a `/es`, así que ofrecer
// "Idioma" aquí prometería una opción que la propia ruta deshace.
export function NavbarUtilityMenu({ onSignOut }: NavbarUtilityMenuProps) {
  const { theme, setTheme } = useTheme()
  const tNavbar = useTranslations('common.navbar')
  const tButtons = useTranslations('common.buttons')
  const tTheme = useTranslations('common.controls.theme')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="hidden xl:inline-flex">
          <UserCircle className="h-4 w-4" />
          <span>{tNavbar('account')}</span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings className="h-4 w-4" />
            <span>{tNavbar('settings')}</span>
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Sun className="h-4 w-4" />
            <span>{tTheme('label')}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={theme}
              // El control de Radix entrega un `string` cualquiera. Antes se
              // casteaba a `Theme` y un valor desconocido habría entrado al
              // proveedor y a `localStorage`; ahora se comprueba contra la
              // misma lista que pinta las opciones.
              onValueChange={(value) => {
                runClientSync(applyThemeFromControl(value, setTheme))
              }}
            >
              {ThemeSchema.literals.map((option) => (
                <DropdownMenuRadioItem key={option} value={option}>
                  <span>{tTheme(option)}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            void runClientEffect(runSignOut(onSignOut))
          }}
        >
          <LogOut className="h-4 w-4" />
          <span>{tButtons('signOut')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
