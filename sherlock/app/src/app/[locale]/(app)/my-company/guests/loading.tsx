import { RoomScreenLoading } from '@/components/company/RoomScreenLoading'

// La pantalla que se está cargando, para que el esqueleto la nombre.
const SCREEN = 'guests' as const

export default function GuestsRouteLoading() {
  return <RoomScreenLoading key={SCREEN} screen={SCREEN} />
}
