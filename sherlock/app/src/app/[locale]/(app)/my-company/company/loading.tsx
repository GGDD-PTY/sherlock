import { RoomScreenLoading } from '@/components/company/RoomScreenLoading'

// La pantalla que se está cargando, para que el esqueleto la nombre.
const SCREEN = 'company' as const

export default function CompanyRouteLoading() {
  return <RoomScreenLoading key={SCREEN} screen={SCREEN} />
}
