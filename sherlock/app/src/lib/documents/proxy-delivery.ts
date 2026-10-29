import { Effect, Schema } from 'effect'
import { NextResponse } from 'next/server'

import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'
import { buildContentDisposition } from './content-disposition'

type NormalizedDownloadGrant = {
  downloadUrl: string
  fileName?: string | null
  fileType?: string | null
}

// Tipos permitidos en el upload del VDR (src/app/api/documents/upload/route.ts).
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
}

// ES: El mismo mapa al revés, para ponerle extensión al nombre de la descarga.
// El nombre que viaja en el grant es `documentVersions.displayName`, que es el
// TÍTULO del documento y no el archivo: los uploaders de la sala lo guardan sin
// extensión (`useCompanyVdr.ts`, «Nombre sin extensión»), así que el modelo del
// cliente salía como «Modelo financiero v1» pelado y el sistema operativo no
// sabía con qué abrirlo (dry run CALESA 2026-09-04, H5). Se deriva del tipo ya
// resuelto para `Content-Type` y no del nombre, así que también alcanza a los
// documentos que ya están en la sala.
// EN: the grant carries the document title, not a file name; the extension
// comes from the resolved content type.
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSION_CONTENT_TYPES).map(([extension, contentType]) => [
    contentType,
    extension,
  ])
)

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/

function resolveDownloadContentType(download: NormalizedDownloadGrant): string {
  const declared = download.fileType?.split(';')[0]?.trim().toLowerCase()

  if (declared && MIME_PATTERN.test(declared)) {
    return declared
  }

  if (declared && EXTENSION_CONTENT_TYPES[declared]) {
    return EXTENSION_CONTENT_TYPES[declared]
  }

  const extension = download.fileName?.toLowerCase().split('.').pop()
  if (extension && EXTENSION_CONTENT_TYPES[extension]) {
    return EXTENSION_CONTENT_TYPES[extension]
  }

  return 'application/octet-stream'
}

// ES: Nunca devolvemos al navegador la URL que produce `ctx.storage.getUrl` — es una URL
// pública de Convex Storage, sin auth y sin expiración: un 3xx hacia ella deja el archivo
// accesible para siempre a cualquiera con el link, fuera del gate NDA/grant y sin quedar
// registrado en documentAccessLogs. El archivo se sirve proxeado desde esta ruta.
// EN: proxy the bytes; the Convex storage URL is permanent and unauthenticated.

// El blob viaja por `externalCall`: un solo lugar decide timeout y reintentos
// del storage, en vez de un fetch pelado que se cuelga sin techo. El cuerpo
// sale en streaming hacia el navegador DESPUÉS de que el efecto termina, así
// que el fetch no recibe el signal del efecto: el timeout cubre la respuesta,
// no la descarga completa.
class ProxyDeliveryError extends Schema.TaggedError<ProxyDeliveryError>()('ProxyDeliveryError', {
  message: Schema.String,
}) {}

const fetchDocumentBytes = Effect.fn('ProxyDelivery.fetchDocumentBytes')(function* (
  downloadUrl: string
) {
  const sourceResponse = yield* externalCall({
    service: 'ConvexStorage',
    operation: 'proxyDelivery.download',
    run: () => fetch(downloadUrl, { cache: 'no-store' }),
  }).pipe(Effect.mapError((error) => new ProxyDeliveryError({ message: error.message })))

  if (!sourceResponse.ok || !sourceResponse.body) {
    return yield* new ProxyDeliveryError({
      message: `Storage fetch failed with status ${sourceResponse.status}`,
    })
  }

  return sourceResponse
})

const buildProxiedDownloadResponse = Effect.fn('ProxyDelivery.buildResponse')(function* (
  download: NormalizedDownloadGrant,
  disposition: 'attachment' | 'inline'
) {
  const sourceResponse = yield* fetchDocumentBytes(download.downloadUrl)

  return yield* Effect.sync(() => {
    const contentType = resolveDownloadContentType(download)
    const headers = new Headers({
      'Cache-Control': 'private, no-store',
      // RFC 6266: respaldo ASCII en `filename=` + nombre real (acentos/eñes) en
      // `filename*=UTF-8''...` para los navegadores modernos.
      'Content-Disposition': buildContentDisposition(disposition, download.fileName, 'documento', {
        extension: CONTENT_TYPE_EXTENSIONS[contentType],
      }),
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'X-Sherlock-Document-Protection': 'proxied',
    })

    // `fetch` entrega el cuerpo ya descomprimido pero conserva las cabeceras del
    // origen: si Convex lo sirvio con gzip, ese Content-Length es el tamano
    // comprimido y el navegador cortaria el archivo de texto a esa altura.
    const contentLength = sourceResponse.headers.get('content-length')
    if (contentLength && !sourceResponse.headers.get('content-encoding')) {
      headers.set('Content-Length', contentLength)
    }

    return new NextResponse(sourceResponse.body, { status: 200, headers })
  })
})

// La ruta de grants clasifica esta falla por `error.name` en su bitácora: el
// borde devuelve el mismo `Error` de siempre en vez del error tipado interno.
export async function createProxiedDownloadResponse(
  download: NormalizedDownloadGrant,
  disposition: 'attachment' | 'inline' = 'attachment'
): Promise<NextResponse> {
  const outcome = await runServerEffect(
    buildProxiedDownloadResponse(download, disposition).pipe(
      Effect.match({
        onSuccess: (response) => ({ ok: true as const, response }),
        onFailure: (error) => ({ ok: false as const, message: error.message }),
      })
    )
  )
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.response
}
