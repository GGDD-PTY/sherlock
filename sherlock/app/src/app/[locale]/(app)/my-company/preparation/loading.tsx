import { RoomScreenLoading } from '@/components/company/RoomScreenLoading'

// La pantalla que se está cargando, para que el esqueleto la nombre.
const SCREEN = 'preparation' as const

export default function PreparationRouteLoading() {
  return <RoomScreenLoading key={SCREEN} screen={SCREEN} />
}
