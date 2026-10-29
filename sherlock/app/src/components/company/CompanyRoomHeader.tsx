'use client'

import type { ReactNode } from 'react'
import { Schema } from 'effect'

import { CompanyRoomSectionNav } from './CompanyRoomSections'
import type { RoomScreen } from './roomScreens'

// El h1 es la línea pequeña en sans; el titular visual de cada pantalla es el
// nombre de la empresa (portada del shell) o el título Fraunces del panel.
export const PAGE_IDENTITY_CLASS =
  'text-foreground font-sans text-lg leading-tight font-medium tracking-normal'

export const ROOM_SCREEN_CONTAINER_CLASS = 'mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8'

const IdentityLocaleSchema = Schema.Literals(['es'])
const IDENTITY_LOCALE = IdentityLocaleSchema.literals[0]
const pageIdentityCopy = { es: { title: 'Data Room' } } as const satisfies Record<
  typeof IdentityLocaleSchema.Type,
  { title: string }
>

/** Cabecera común de las pantallas de la sala: identidad, controles y barra. */
export function CompanyRoomHeader({
  screens,
  children,
}: {
  screens: readonly RoomScreen[]
  /** Controles contextuales (selector de sala, aviso de demo). */
  children?: ReactNode
}) {
  return (
    <header className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 pb-2">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <h1 data-page-identity data-replay-ui="true" className={PAGE_IDENTITY_CLASS}>
          {pageIdentityCopy[IDENTITY_LOCALE].title}
        </h1>
        {children}
      </div>
      {/* El equipo, desde /admin, ve todo en una página: sin pantallas no hay barra. */}
      {screens.length > 0 ? <CompanyRoomSectionNav screens={screens} /> : null}
    </header>
  )
}

/** Marco de una pantalla que no es el shell: contenedor compartido, cabecera y contenido. */
export function RoomScreenFrame({
  screens,
  children,
}: {
  screens: readonly RoomScreen[]
  children: ReactNode
}) {
  return (
    <div className="bg-background">
      <div className={`${ROOM_SCREEN_CONTAINER_CLASS} py-4`}>
        <CompanyRoomHeader screens={screens} />
        <div className="mt-4 min-w-0">{children}</div>
      </div>
    </div>
  )
}
