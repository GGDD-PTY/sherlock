// @vitest-environment node
// ============================================================================
// CONVEX HTTP ROUTER — webhook de Resend y bytes de invitado
// ============================================================================
// Entorno `node`: la ruta de invitados responde con el Blob de `ctx.storage.get`
// y el `Response` de jsdom serializa ese cuerpo a "[object Blob]" en vez de a
// los bytes, así que la aserción sobre el PDF sería falsa bajo jsdom.
//
// Firma svix calculada a mano (HMAC-SHA256 sobre `${id}.${timestamp}.${body}`
// con el secreto base64 detrás de `whsec_`) para no depender del paquete svix.
// ============================================================================

import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from '../../../convex/http'
import {
  decodeCompanyGuestDocumentMetadata,
  GUEST_DOCUMENT_METADATA_HEADER,
} from '../../../convex/_guests/documentDelivery'
import { resend } from '../../../convex/email'
import { convexHandler } from '../utils/convex-test-utils'

vi.mock('../../../convex/_generated/api', () => ({
  api: {},
  internal: {
    notifications: { _recordEmailFailure: 'notifications:_recordEmailFailure' },
    guestAccess: {
      authorizeCompanyGuestDocument: 'guestAccess:authorizeCompanyGuestDocument',
    },
  },
  components: { resend: { lib: { handleEmailEvent: 'resend/lib:handleEmailEvent' } } },
}))

const SECRET_BYTES = Buffer.from('sherlock-resend-webhook-test-secret')
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`
const DELIVERED_EVENT = {
  type: 'email.delivered',
  created_at: '2026-09-02T19:44:00.000Z',
  data: {
    created_at: '2026-09-02T19:43:58.000Z',
    email_id: '31a0b175-59c8-4b5b-880c-bdf53dbb2237',
    from: 'Sherlock <fixture-0e5eb7f8@example.com>',
    to: ['fixture-4622a879@example.com'],
    subject: 'Nuevos documentos en la sala',
  },
}
const BODY = JSON.stringify(DELIVERED_EVENT)

type WebhookCtx = { runMutation: ReturnType<typeof vi.fn> }
type WebhookHandler = (ctx: WebhookCtx, request: Request) => Promise<Response>

function webhookHandler(): WebhookHandler {
  const route = http.lookup('/resend-webhook', 'POST')
  if (!route) throw new Error('POST /resend-webhook is not routed')
  return convexHandler(route[0]) as unknown as WebhookHandler
}

function signedHeaders(secretBytes = SECRET_BYTES, msgId = 'msg_test_1') {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = createHmac('sha256', secretBytes)
    .update(`${msgId}.${timestamp}.${BODY}`)
    .digest('base64')
  return {
    'content-type': 'application/json',
    'svix-id': msgId,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signature}`,
  }
}

function webhookRequest(headers: Record<string, string>) {
  return new Request('https://brainy-emu-822.convex.site/resend-webhook', {
    method: 'POST',
    headers,
    body: BODY,
  })
}

describe('convex/http.ts — /resend-webhook', () => {
  let ctx: WebhookCtx
  const originalSecret = resend.config.webhookSecret

  beforeEach(() => {
    ctx = { runMutation: vi.fn().mockResolvedValue(null) }
    resend.config.webhookSecret = SECRET
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    resend.config.webhookSecret = originalSecret
    vi.restoreAllMocks()
  })

  it('routes only the two POST entrypoints the deployment publishes', () => {
    expect(
      http
        .getRoutes()
        .map(([path, method]) => `${method} ${path}`)
        .sort()
    ).toEqual(['POST /resend-webhook', 'POST /vdr/guest/document'])
    expect(http.lookup('/resend-webhook', 'GET')).toBeNull()
  })

  it('fails closed with 503 when RESEND_WEBHOOK_SECRET is missing', async () => {
    resend.config.webhookSecret = ''

    const response = await webhookHandler()(ctx, webhookRequest(signedHeaders()))

    expect(response.status).toBe(503)
    expect(ctx.runMutation).not.toHaveBeenCalled()
  })

  it('rejects a payload signed with another secret with 400', async () => {
    const forged = signedHeaders(Buffer.from('another-secret'))

    const response = await webhookHandler()(ctx, webhookRequest(forged))

    expect(response.status).toBe(400)
    expect(ctx.runMutation).not.toHaveBeenCalled()
  })

  it('rejects a payload without svix headers with 400', async () => {
    const response = await webhookHandler()(
      ctx,
      webhookRequest({ 'content-type': 'application/json' })
    )

    expect(response.status).toBe(400)
    expect(ctx.runMutation).not.toHaveBeenCalled()
  })

  it('forwards a correctly signed event to the Resend component and answers 201', async () => {
    const response = await webhookHandler()(ctx, webhookRequest(signedHeaders()))

    expect(response.status).toBe(201)
    expect(ctx.runMutation).toHaveBeenCalledTimes(1)
    expect(ctx.runMutation).toHaveBeenCalledWith('resend/lib:handleEmailEvent', {
      event: DELIVERED_EVENT,
    })
  })
})

// ============================================================================
// ENTREGA DE BYTES A INVITADOS
// ============================================================================
// La URL de `ctx.storage.getUrl` es permanente y sin auth: si sale de Convex,
// sobrevive al NDA, a la sesión y a la revocación. Esta ruta existe para que
// nunca se cree: la mutation interna autoriza y devuelve un `storageId`, y el
// httpAction resuelve el Blob aquí adentro.
// ============================================================================

type DocumentCtx = {
  runMutation: ReturnType<typeof vi.fn>
  storage: { get: ReturnType<typeof vi.fn> }
}
type DocumentHandler = (ctx: DocumentCtx, request: Request) => Promise<Response>

const AUTHORIZED = {
  storageId: 'storage_selected',
  documentId: 'doc_selected',
  versionId: 'version_selected',
  invitationId: 'invitation_1',
  guestLabel: 'g***t@example.com',
  fileName: 'Estados financieros.pdf',
}

function documentHandler(): DocumentHandler {
  const route = http.lookup('/vdr/guest/document', 'POST')
  if (!route) throw new Error('POST /vdr/guest/document is not routed')
  return convexHandler(route[0]) as unknown as DocumentHandler
}

function documentRequest(body: unknown) {
  return new Request('https://brainy-emu-822.convex.site/vdr/guest/document', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const VIEW_ARGS = {
  sessionToken: 's'.repeat(64),
  documentId: 'doc_selected',
  serverIssuedAt: 1_790_000_000_000,
  serverProof: 'p'.repeat(43),
}

describe('convex/http.ts — /vdr/guest/document', () => {
  let ctx: DocumentCtx

  beforeEach(() => {
    ctx = {
      runMutation: vi.fn().mockResolvedValue(AUTHORIZED),
      storage: { get: vi.fn().mockResolvedValue(new Blob(['%PDF-1.7 bytes'])) },
    }
  })

  it('returns the stored bytes and the document metadata, never a storage URL', async () => {
    const response = await documentHandler()(ctx, documentRequest(VIEW_ARGS))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('%PDF-1.7 bytes')
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(
      decodeCompanyGuestDocumentMetadata(response.headers.get(GUEST_DOCUMENT_METADATA_HEADER))
    ).toEqual({
      documentId: 'doc_selected',
      versionId: 'version_selected',
      invitationId: 'invitation_1',
      guestLabel: 'g***t@example.com',
      fileName: 'Estados financieros.pdf',
    })
    expect(ctx.runMutation).toHaveBeenCalledWith(
      'guestAccess:authorizeCompanyGuestDocument',
      VIEW_ARGS
    )
    expect(ctx.storage.get).toHaveBeenCalledWith('storage_selected')
  })

  it('rejects a malformed body before authorizing anything', async () => {
    for (const body of [
      'not json',
      { ...VIEW_ARGS, sessionToken: 42 },
      { ...VIEW_ARGS, serverIssuedAt: '1790000000000' },
      { documentId: 'doc_selected' },
    ]) {
      expect((await documentHandler()(ctx, documentRequest(body))).status).toBe(400)
    }
    expect(ctx.runMutation).not.toHaveBeenCalled()
    expect(ctx.storage.get).not.toHaveBeenCalled()
  })

  it('answers 403 without leaking the denial reason when authorization fails', async () => {
    ctx.runMutation.mockRejectedValue(new Error('No tienes permiso para abrir este documento.'))

    const response = await documentHandler()(ctx, documentRequest(VIEW_ARGS))

    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('permiso')
    expect(ctx.storage.get).not.toHaveBeenCalled()
  })

  it('answers 404 when the authorized version has no stored blob', async () => {
    ctx.storage.get.mockResolvedValue(null)

    expect((await documentHandler()(ctx, documentRequest(VIEW_ARGS))).status).toBe(404)
  })
})
