import { RoomScreenLoading } from '@/components/company/RoomScreenLoading'

// La pantalla que se está cargando, para que el esqueleto la nombre.
const SCREEN = 'team' as const

export default function TeamRouteLoading() {
  return <RoomScreenLoading key={SCREEN} screen={SCREEN} />
}
