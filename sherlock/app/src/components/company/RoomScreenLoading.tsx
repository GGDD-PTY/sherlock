import { Schema } from 'effect'
import { useTranslations } from 'next-intl'

import { Skeleton } from '@/components/ui/skeleton'
import { PAGE_IDENTITY_CLASS, ROOM_SCREEN_CONTAINER_CLASS } from './CompanyRoomHeader'
import { ROOM_SCREEN_LABEL_KEY, type RoomScreen } from './roomScreens'

const LoadingSlotSchema = Schema.Literals(['nav', 'body'])
const [NAV_SLOT, BODY_SLOT] = LoadingSlotSchema.literals
const LOADING_SLOT_CLASS = {
  nav: 'h-9 w-96 max-w-full motion-reduce:animate-none',
  body: 'mt-6 h-96 motion-reduce:animate-none',
} as const satisfies Record<typeof LoadingSlotSchema.Type, string>

// Misma identidad y misma silueta que las pantallas de la sala: h1 sans, barra
// y un bloque de contenido. Sin tarjetas de stats.
//
// El h1 nombra la pantalla que está cargando, no la sala entera: un esqueleto
// que decía «Data Room» en las cuatro pantallas no le contaba a nadie a dónde
// iba ([F] 2026-09-17, hallazgos del E2E). El nombre sale del mismo catálogo
// que la barra de secciones, así que no hay copy nuevo ni una segunda verdad.
export function RoomScreenLoading({ screen }: { screen: RoomScreen }) {
  const t = useTranslations('roomWorkspace.nav')

  return (
    <div
      className={`${ROOM_SCREEN_CONTAINER_CLASS} py-4`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 data-page-identity className={PAGE_IDENTITY_CLASS}>
          {t(ROOM_SCREEN_LABEL_KEY[screen])}
        </h1>
        <Skeleton className={LOADING_SLOT_CLASS[NAV_SLOT]} />
      </div>
      <Skeleton className={LOADING_SLOT_CLASS[BODY_SLOT]} />
    </div>
  )
}
