'use client'

import { Schema } from 'effect'
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { isTheme, ThemeSchema, type Theme } from '@/components/providers/theme-schema'
import { useTheme } from '@/components/providers/ThemeProvider'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const THEME_ICONS = {
  light: Sun,
  dark: Moon,
  system: Monitor,
} satisfies Record<Theme, LucideIcon>

// `showLabel` cambia el tamaño del botón (`sm` vs `icon`) y si el texto
// queda visible. Un truthy que no es booleano agrandaría el control. El
// guard cae a false (solo icono), que es el default del menú compacto.
const isShowLabel = Schema.is(Schema.Boolean)

type ThemeToggleProps = {
  readonly triggerId?: string
  readonly showLabel?: boolean
}

export function ThemeToggle({
  triggerId = 'sherlock-theme-menu-trigger',
  showLabel = false,
}: ThemeToggleProps = {}) {
  const { theme, setTheme } = useTheme()
  const t = useTranslations('common.controls.theme')
  const safeShowLabel = isShowLabel(showLabel) ? showLabel : false

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild id={triggerId}>
        <Button
          variant="ghost"
          size={safeShowLabel ? 'sm' : 'icon'}
          className={safeShowLabel ? 'min-h-11' : undefined}
          aria-label={t('toggle')}
        >
          <span className="relative h-5 w-5 shrink-0" aria-hidden="true">
            <Sun className="absolute inset-0 h-5 w-5 rotate-0 opacity-100 transition-[opacity,transform] motion-reduce:transition-none dark:-rotate-90 dark:opacity-0" />
            <Moon className="absolute inset-0 h-5 w-5 rotate-90 opacity-0 transition-[opacity,transform] motion-reduce:transition-none dark:rotate-0 dark:opacity-100" />
          </span>
          <span className={safeShowLabel ? undefined : 'sr-only'}>{t('label')}</span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            if (isTheme(value)) setTheme(value)
          }}
        >
          {ThemeSchema.literals.map((option) => {
            const Icon = THEME_ICONS[option]
            return (
              <DropdownMenuRadioItem key={option} value={option}>
                <Icon className="mr-2 h-4 w-4" />
                <span>{t(option)}</span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
