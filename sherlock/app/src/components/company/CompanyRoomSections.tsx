'use client'

import { useEffect, useRef } from 'react'
import { MessageSquareText, Send } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Schema } from 'effect'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Link, usePathname } from '@/i18n/navigation'
import {
  ROOM_SCREEN_LABEL_KEY,
  ROOM_SCREEN_PATH,
  roomScreenFromPathname,
  type RoomScreen,
} from './roomScreens'

// Mismo catálogo que `roomScreens.ts`. Un valor que no es pantalla no se
// enlaza: la barra no puede inventar una ruta.
const NavScreenSchema = Schema.Literals(['documents', 'company', 'preparation', 'team', 'guests'])
const isNavScreen = Schema.is(NavScreenSchema)

// La sala es un conjunto de pantallas, una por intención (docs/design-system-vdr.md).
// La barra enlaza rutas del catálogo `roomScreens`; la activa sale del pathname.
export function CompanyRoomSectionNav({ screens }: { screens: readonly RoomScreen[] }) {
  const t = useTranslations('roomWorkspace')
  const active = roomScreenFromPathname(usePathname())
  const visible = screens.filter(isNavScreen)
  const itemRefs = useRef(new Map<RoomScreen, HTMLLIElement>())

  useEffect(() => {
    if (!active) return
    const el = itemRefs.current.get(active)
    if (!el || typeof el.scrollIntoView !== 'function') return
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({
      inline: 'nearest',
      block: 'nearest',
      behavior: reduceMotion ? 'auto' : 'smooth',
    })
  }, [active])

  return (
    <nav aria-label={t('nav.label')} className="min-w-0 flex-1">
      <ul className="bg-sidebar text-sidebar-foreground flex min-h-9 items-center gap-1 overflow-x-auto rounded-md px-1">
        {visible.map((screen) => (
          <li
            key={screen}
            className="shrink-0"
            ref={(node) => {
              if (node) itemRefs.current.set(screen, node)
              else itemRefs.current.delete(screen)
            }}
          >
            <Link
              href={ROOM_SCREEN_PATH[screen]}
              aria-current={active === screen ? 'page' : undefined}
              className="focus-visible:ring-ring hover:bg-sidebar-accent aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground block rounded-sm px-2.5 py-1.5 text-sm font-medium outline-none focus-visible:ring-2"
            >
              {t(`nav.${ROOM_SCREEN_LABEL_KEY[screen]}`)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

// Sin consumidor desde AU-06: el botón salió del toolbar y el panel se queda para cuando haya
// asistente ([F] 2026-09-13 18:00). `@public` evita que knip lo reporte como export muerto.
/** @public */
export function CompanyRoomAssistantScaffold() {
  const t = useTranslations('roomWorkspace.assistant')
  return (
    <div className="flex min-h-full flex-col p-4">
      <div className="flex items-start gap-3">
        <MessageSquareText className="text-primary mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold">{t('unavailableTitle')}</p>
          <p className="text-muted-foreground mt-1 text-sm leading-6">
            {t('unavailableDescription')}
          </p>
          <Link
            href={ROOM_SCREEN_PATH.team}
            className="text-primary focus-visible:ring-ring mt-3 inline-block rounded-sm text-sm font-semibold underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
          >
            {t('contactTeam')}
          </Link>
        </div>
      </div>
      <div className="mt-auto pt-6">
        <label htmlFor="room-assistant-composer" className="text-sm font-medium">
          {t('messageLabel')}
        </label>
        <Textarea
          id="room-assistant-composer"
          className="mt-2 min-h-24 resize-none"
          placeholder={t('placeholder')}
          disabled
        />
        <Button type="button" className="mt-3 w-full" disabled>
          <Send className="mr-2 h-4 w-4" aria-hidden="true" />
          {t('send')}
        </Button>
      </div>
    </div>
  )
}
