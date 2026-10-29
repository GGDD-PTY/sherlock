// ============================================================================
// BANCO DE PRUEBAS DE LOS VISORES DEL VDR (solo dev/E2E)
// ============================================================================
// Monta <DocumentViewer/> con los parametros de la URL para que el journey
// `e2e/vdr-viewers.spec.ts` pueda ejercitar cada renderer con archivos reales
// sin depender de Convex ni del shell del VDR.
//
// Fail-closed en dos capas: `src/proxy.ts` solo reconoce el segmento cuando
// `NODE_ENV !== 'production'` Y dev-auth esta encendido, y esta pagina repite
// la condicion con `notFound()`. En produccion la ruta no existe.
// ============================================================================

import { Schema } from 'effect'
import { notFound } from 'next/navigation'

import { ViewerBenchClient } from './ViewerBenchClient'

export const dynamic = 'force-dynamic'

function isEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED === 'true'
  )
}

// Cada parámetro del banco llega del query string y puede venir repetido, o sea
// como arreglo. `Schema.Union` nombra las dos formas que Next produce; todo lo
// demás se descarta en vez de adivinarse.
const BenchParamSchema = Schema.Union([Schema.String, Schema.Array(Schema.String)])

const decodeBenchParam = Schema.decodeUnknownOption(BenchParamSchema)

function first(
  params: Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const decoded = decodeBenchParam(params[key])
  if (decoded._tag === 'None') return
  return typeof decoded.value === 'string' ? decoded.value : decoded.value[0]
}

export default async function ViewerBenchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if (!isEnabled()) notFound()

  const params = await searchParams

  return (
    <ViewerBenchClient
      fileName={first(params, 'fileName') ?? 'documento'}
      mimeType={first(params, 'mimeType') ?? ''}
      viewUrl={first(params, 'viewUrl') ?? ''}
      sheet={first(params, 'sheet')}
      range={first(params, 'range')}
      page={first(params, 'page')}
      retryViewUrl={first(params, 'retryViewUrl')}
    />
  )
}
