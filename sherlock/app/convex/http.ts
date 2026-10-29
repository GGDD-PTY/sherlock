// ============================================================================
// HTTP — rutas públicas del deployment de Convex (`https://<deployment>.convex.site`)
// ============================================================================
// Resend firma cada evento (svix) con RESEND_WEBHOOK_SECRET. El componente
// verifica la firma, avanza `emails.status` (delivered, bounced, complained…)
// y registra la fila en `deliveryEvents`. Sin secreto la ruta contesta 503:
// un evento sin verificar no se acepta nunca.
//
// `/vdr/guest/document` entrega los bytes de un PDF a un invitado de sala de
// empresa. Vive aquí porque una mutation no puede leer un archivo: sólo un
// action alcanza `ctx.storage.get`. La alternativa —devolver la URL de
// `ctx.storage.getUrl`— acuña un enlace permanente y sin auth que sobrevive al
// NDA, a la sesión y a la revocación, así que no se acuña.
// ============================================================================

import { httpRouter } from 'convex/server'
import { Schema } from 'effect'

import { httpAction } from './_generated/server'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { resend } from './email'
import {
  encodeCompanyGuestDocumentMetadata,
  GUEST_DOCUMENT_CONTENT_TYPE,
  GUEST_DOCUMENT_METADATA_HEADER,
} from './_guests/documentDelivery'

const http = httpRouter()

http.route({
  path: '/resend-webhook',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    if (!resend.config.webhookSecret) {
      console.error('[EMAIL] RESEND_WEBHOOK_SECRET is not set; rejecting Resend webhook.')
      return new Response(null, { status: 503 })
    }

    try {
      return await resend.handleResendEventWebhook(ctx, request)
    } catch (error) {
      if (error instanceof Error && error.name === 'WebhookVerificationError') {
        return new Response(null, { status: 400 })
      }
      throw error
    }
  }),
})

// El cuerpo llega de un invitado sin sesión, así que su forma se declara y se
// verifica de una vez en vez de destriparlo campo por campo detrás de un
// `as Record<string, unknown>`. Un cuerpo que no calce no produce un objeto a
// medias: produce `null`, y la ruta contesta 400.
const CompanyGuestDocumentRequest = Schema.Struct({
  sessionToken: Schema.String,
  documentId: Schema.String,
  serverIssuedAt: Schema.Number,
  serverProof: Schema.String,
})
const isCompanyGuestDocumentRequest = Schema.is(CompanyGuestDocumentRequest)

async function readCompanyGuestDocumentRequest(
  request: Request
): Promise<typeof CompanyGuestDocumentRequest.Type | null> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return null
  }
  return isCompanyGuestDocumentRequest(body) ? body : null
}

http.route({
  path: '/vdr/guest/document',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const args = await readCompanyGuestDocumentRequest(request)
    if (!args) return new Response(null, { status: 400 })

    let authorized
    try {
      authorized = await ctx.runMutation(internal.guestAccess.authorizeCompanyGuestDocument, {
        ...args,
        // El validador `v.id('documents')` de la mutation rechaza cualquier id
        // que no sea de esa tabla; aquí sólo se cruza la frontera del tipo.
        documentId: args.documentId as Id<'documents'>,
      })
    } catch {
      // El motivo del rechazo queda en el log de la mutation, nunca en la respuesta.
      return new Response(null, { status: 403 })
    }

    const blob = await ctx.storage.get(authorized.storageId)
    if (!blob) return new Response(null, { status: 404 })

    return new Response(blob, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': GUEST_DOCUMENT_CONTENT_TYPE,
        [GUEST_DOCUMENT_METADATA_HEADER]: encodeCompanyGuestDocumentMetadata({
          documentId: authorized.documentId,
          versionId: authorized.versionId,
          invitationId: authorized.invitationId,
          guestLabel: authorized.guestLabel,
          fileName: authorized.fileName,
        }),
      },
    })
  }),
})

export default http
