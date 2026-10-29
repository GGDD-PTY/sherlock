import { Effect } from 'effect'
import { NextResponse } from 'next/server'
import {
  GUEST_DOCUMENT_CONTENT_TYPE,
  type CompanyGuestDocumentMetadata,
} from '@/../convex/_guests/documentDelivery'
import { withRequestIdHeader } from '@/lib/api/response'
import { runServerEffect } from '@/lib/effect/runtime'
import { buildContentDisposition } from './content-disposition'

// ES: Los bytes ya vienen del httpAction del deployment, autorizados y
// registrados. Aquí se decide cómo salen hacia el navegador del invitado.
//
// El invitado es una contraparte externa y el visor le entrega los bytes al
// navegador. Salen sin sello ([F] 2026-09-04): la evidencia es la invitación
// que los autorizó y la bitácora; las cabeceras le niegan al documento
// cualquier contexto de incrustación o de caché compartida.
// EN: the guest's copy leaves unstamped, isolated and uncacheable.
const buildGuestDocumentResponse = Effect.fn('GuestDelivery.buildResponse')(function* (
  bytes: ArrayBuffer,
  metadata: CompanyGuestDocumentMetadata,
  requestId: string
) {
  return yield* Effect.sync(() => {
    const response = withRequestIdHeader(new NextResponse(bytes, { status: 200 }), requestId)

    response.headers.set('Cache-Control', 'private, no-store')
    response.headers.set(
      'Content-Disposition',
      buildContentDisposition('inline', metadata.fileName, 'documento.pdf', { extension: 'pdf' })
    )
    response.headers.set('Content-Type', GUEST_DOCUMENT_CONTENT_TYPE)
    response.headers.set('X-Content-Type-Options', 'nosniff')
    // El documento no otorga nada: sin subrecursos, en origen opaco y sin poder
    // ser incrustado. `frame-ancestors` es lo que respetan los navegadores
    // modernos; `X-Frame-Options` queda como respaldo de los viejos.
    response.headers.set(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; sandbox"
    )
    response.headers.set('X-Frame-Options', 'DENY')

    return response
  })
})

export function createGuestDocumentResponse(
  bytes: ArrayBuffer,
  metadata: CompanyGuestDocumentMetadata,
  requestId: string
): Promise<NextResponse> {
  return runServerEffect(buildGuestDocumentResponse(bytes, metadata, requestId))
}
