import { isIP } from 'node:net'

import { Cause, Effect, Result } from 'effect'
import { NextRequest, NextResponse } from 'next/server'
import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { apiError, getOrCreateRequestId, withRequestIdHeader } from '@/lib/api/response'
import { requireApiAuth } from '@/lib/api/with-auth'
import { getAuthenticatedConvex, type AuthenticatedConvexClient } from '@/lib/convex-auth'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import {
  checkRateLimitDistributed,
  createRateLimitResponse,
  getClientIp,
  RATE_LIMIT_PRESETS,
} from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/logger'
import { createProxiedDownloadResponse } from '@/lib/documents/proxy-delivery'
import { buildContentDisposition } from '@/lib/documents/content-disposition'
import {
  convertOoxmlToPdf,
  type RenditionSourceKind,
} from '@/lib/documents/renditions/ooxml-to-pdf'
import { createDocumentDeliveryProof } from '@/../convex/_documents/deliveryProof'
import {
  isDeniedDocumentAccess,
  type DeniedDocumentAccess,
} from '@/../convex/_documents/accessResult'

const log = createLogger('API:Documents:Access')
const ROUTE = '/api/documents/access/[grantId]'

interface RouteContext {
  params: Promise<{ grantId: string }>
}

type DocumentAccessAction = 'VIEW' | 'DOWNLOAD'

type DownloadGrantResult =
  | string
  | DeniedDocumentAccess
  | {
      downloadUrl?: string | null
      fileName?: string | null
      fileType?: string | null
      documentId?: string | null
      action?: DocumentAccessAction | null
    }

interface NormalizedDownloadGrant {
  downloadUrl: string
  fileName?: string | null
  fileType?: string | null
  documentId?: string | null
  action?: DocumentAccessAction | null
}

function normalizeDownloadGrantResult(
  result: Exclude<DownloadGrantResult, DeniedDocumentAccess> | null
): NormalizedDownloadGrant | null {
  if (!result) {
    return null
  }

  if (typeof result === 'string') {
    return { downloadUrl: result }
  }

  if (!result.downloadUrl) {
    return null
  }

  return {
    downloadUrl: result.downloadUrl,
    fileName: result.fileName,
    fileType: result.fileType,
    documentId: result.documentId,
    action: result.action ?? null,
  }
}

// La disposición la manda el GRANT, no la URL. Si el grant se emitió con
// intención VIEW la entrega es inline; si se emitió como DOWNLOAD es attachment
// aunque la URL pida `disposition=inline`. El query param solo sobrevive como
// respaldo para grants emitidos antes de este cambio (TTL 5 min), que no traen
// `action`. No es una frontera de seguridad —los bytes son los mismos— pero
// alinea el header con lo que quedó auditado.
function resolveDeliveryDisposition(
  download: NormalizedDownloadGrant,
  requestedInline: boolean
): 'attachment' | 'inline' {
  if (download.action === 'VIEW') {
    return 'inline'
  }
  if (download.action === 'DOWNLOAD') {
    return 'attachment'
  }

  return requestedInline ? 'inline' : 'attachment'
}

// El rastro de auditoría de descargas del VDR (documentAccessLogs + securityEvents
// de bulk-download) no puede depender de un header que el cliente pueda escribir. Se
// prefiere el header de plataforma (Vercel reescribe `x-vercel-forwarded-for` y descarta
// el entrante), y si solo hay `x-forwarded-for` se toma el elemento MÁS A LA DERECHA —
// el hop más cercano al edge — nunca el `[0]`, que es justo el que inyecta el cliente.
function getDocumentAccessIp(request: NextRequest): string | undefined {
  const candidates = [
    request.headers.get('x-vercel-forwarded-for')?.split(',').pop()?.trim(),
    request.headers.get('x-real-ip')?.trim(),
    request.headers.get('x-forwarded-for')?.split(',').pop()?.trim(),
  ]
  return candidates.find((candidate): candidate is string => Boolean(candidate && isIP(candidate)))
}

function getDocumentAccessUserAgent(request: NextRequest): string | undefined {
  const value = request.headers
    .get('user-agent')
    ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
  return value ? value.slice(0, 512) : undefined
}

// Rendition PDF (PPTX / DOCX). El original se conserva y se sigue
// entregando por esta misma ruta; la rendition es una VISTA producida a partir
// de los mismos bytes, bajo el MISMO grant de un solo uso y con la misma
// bitácora. No hay URL pública, no hay iframe de terceros, no hay tabla nueva:
// se genera en el servidor al momento de la vista. El día que el pipeline de
// entregables persista renditions (`deliverables.attachRendition`), este
// adaptador es el productor natural de esos bytes.
const RENDITION_KINDS: Record<string, RenditionSourceKind> = {
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  pptx: 'pptx',
  docx: 'docx',
}

function resolveRenditionKind(download: NormalizedDownloadGrant): RenditionSourceKind | null {
  const declared = download.fileType?.split(';')[0]?.trim().toLowerCase()
  if (declared && RENDITION_KINDS[declared]) return RENDITION_KINDS[declared]

  const extension = download.fileName?.toLowerCase().split('.').pop()
  return extension && RENDITION_KINDS[extension] ? RENDITION_KINDS[extension] : null
}

async function createPdfRenditionResponse(
  download: NormalizedDownloadGrant
): Promise<NextResponse | null> {
  const kind = resolveRenditionKind(download)
  if (!kind) return null

  const sourceResponse = await fetch(download.downloadUrl, { cache: 'no-store' })
  if (!sourceResponse.ok) {
    throw new Error(`Storage fetch failed with status ${sourceResponse.status}`)
  }

  const pdf = await convertOoxmlToPdf(kind, await sourceResponse.arrayBuffer())
  const body = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Disposition': buildContentDisposition('inline', download.fileName, 'documento.pdf', {
        extension: 'pdf',
      }),
      'Content-Type': 'application/pdf',
      'X-Content-Type-Options': 'nosniff',
      'X-Sherlock-Document-Protection': 'rendition',
    },
  })
}

const releaseFailedDelivery = Effect.fn('DocumentsAccess.releaseFailedDelivery')(function* (
  convexClient: AuthenticatedConvexClient['client'],
  deliverySecret: string,
  grantId: string,
  token: string,
  proofProfileId: string
) {
  const releaseIssuedAt = Date.now()
  const releaseProof = yield* routePromise('documents.access.release.createProof', () =>
    createDocumentDeliveryProof(deliverySecret, {
      grantId,
      token,
      profileId: proofProfileId,
      issuedAt: releaseIssuedAt,
    })
  )
  yield* routePromise('documents.access.release.mutate', () =>
    convexClient.mutation(api.documents.releaseFailedDelivery, {
      grantId: grantId as Id<'documentAccessGrants'>,
      token,
      releaseIssuedAt,
      releaseProof,
    })
  )
})

const getDocumentAccess = Effect.fn('DocumentsAccess.GET')(function* (
  request: NextRequest,
  context: RouteContext,
  requestId: string
) {
  const clientIp = getClientIp(request)
  const rateLimitResult = yield* routePromise('documents.access.rateLimit', () =>
    checkRateLimitDistributed(`documents:access:${clientIp}`, RATE_LIMIT_PRESETS.api)
  )
  if (!rateLimitResult.success) {
    log.warn('Rate limit exceeded')
    return yield* respond(withRequestIdHeader(createRateLimitResponse(rateLimitResult), requestId))
  }

  const { user, error: authError } = yield* routePromise('documents.access.authenticate', () =>
    requireApiAuth()
  )
  if (authError) return yield* respond(withRequestIdHeader(authError, requestId))

  const { grantId } = yield* routePromise('documents.access.params', () => context.params)
  const token = request.nextUrl.searchParams.get('token')
  // Respaldo heredado: hoy la disposición la fija el grant (ver más abajo).
  const requestedInline = request.nextUrl.searchParams.get('disposition') === 'inline'
  const ipAddress = getDocumentAccessIp(request)

  if (!token) {
    return yield* respond(apiError(requestId, 400, { error: 'Token de acceso faltante' }))
  }

  const deliverySecret = process.env.STORAGE_SECRET
  if (!deliverySecret) {
    log.error('Document delivery proof configuration missing')
    return yield* respond(
      apiError(
        requestId,
        500,
        { error: 'No se pudo verificar la entrega documental' },
        { route: ROUTE }
      )
    )
  }

  if (!user.profileId) {
    log.warn('Authenticated user missing document profile')
    return yield* respond(apiError(requestId, 403, { error: 'Acceso denegado' }))
  }

  const convexAuth = yield* routePromise('documents.access.convex.authenticate', () =>
    getAuthenticatedConvex()
  )
  // Under dev-auth the client carries no token on purpose: Convex resolves the
  // dev identity itself (BYPASS_AUTH + CONVEX_ENV=dev), same as documents/[id].
  if (!convexAuth?.client || (!convexAuth.isAuthenticated && !DEV_AUTH_ENABLED)) {
    log.warn('Authenticated Convex client unavailable for document access')
    return yield* respond(
      apiError(
        requestId,
        500,
        { error: 'No se pudo verificar la sesión documental' },
        { route: ROUTE }
      )
    )
  }

  // The dev-auth cookie carries a synthetic profile id; Convex verifies the
  // proof against the profile it resolves itself, so the proof has to be
  // signed with that one. Outside dev-auth both ids are the same WorkOS profile.
  const proofProfileId = DEV_AUTH_ENABLED
    ? ((yield* routePromise('documents.access.getCurrentProfileId', () =>
        convexAuth.client.query(api.users.getCurrentProfileId, {})
      )).profileId as string)
    : user.profileId

  const deliveryIssuedAt = Date.now()
  const deliveryProof = yield* routePromise('documents.access.createDeliveryProof', () =>
    createDocumentDeliveryProof(deliverySecret, {
      grantId,
      token,
      profileId: proofProfileId,
      issuedAt: deliveryIssuedAt,
    })
  )

  const downloadResult = (yield* routePromise('documents.access.consumeGrant', () =>
    convexAuth.client.mutation(api.documents.consumeDownloadGrant, {
      grantId: grantId as Id<'documentAccessGrants'>,
      token,
      deliveryIssuedAt,
      deliveryProof,
      ipAddress,
      userAgent: getDocumentAccessUserAgent(request),
    })
  )) as DownloadGrantResult | null

  // La mutation ya NO lanza en la rama deny — devolver el resultado
  // estructurado es lo que permite que la fila DENIED de auditoría commitee
  // (un throw en Convex revierte la transacción completa). Aquí se traduce a
  // 403 con mensaje genérico; el código queda en el log del servidor.
  if (isDeniedDocumentAccess(downloadResult)) {
    log.warn('Document access denied by policy', { code: downloadResult.code })
    return yield* respond(apiError(requestId, 403, { error: 'Acceso denegado' }))
  }

  const download = normalizeDownloadGrantResult(downloadResult)
  if (!download) {
    return yield* respond(apiError(requestId, 404, { error: 'Archivo no disponible' }))
  }

  const disposition = resolveDeliveryDisposition(download, requestedInline)

  // El grant ya se quemó (single-use) pero los bytes todavía no salieron.
  // Si la preparación falla de aquí en adelante, se libera el consumo para
  // que el reintento inmediato funcione en vez de acumular grants y filas
  // DENIED/entregadas que empujan al usuario hacia la alarma de extracción.
  // Best-effort: si la liberación misma falla, el 500 original se mantiene.

  // La rendition se pide explícitamente (`?rendition=pdf`) y solo aplica a los
  // formatos que el conversor cubre; para todo lo demás el flujo sigue igual.
  // Solo `inline` (ver dentro de la sala): una descarga (`attachment`) debe
  // seguir al bloque de estampado de abajo — sin este gate, ?rendition=pdf
  // sacaría de la sala un PDF convertido sin marca.
  if (disposition === 'inline' && request.nextUrl.searchParams.get('rendition') === 'pdf') {
    const renditionResult = yield* routePromise('documents.access.createPdfRendition', () =>
      createPdfRenditionResponse(download)
    ).pipe(
      Effect.match({
        onSuccess: (response) => ({ ok: true as const, response }),
        onFailure: (failure) => ({ ok: false as const, error: failure.cause }),
      })
    )
    if (renditionResult.ok) {
      if (renditionResult.response) {
        // La respuesta binaria es un valor exitoso, no un error JSON de control.
        return withRequestIdHeader(renditionResult.response, requestId)
      }
    } else {
      // Una rendition fallida NO cancela la entrega: el visor recibe el
      // original y decide (el conversor también corre en el cliente).
      log.warn('PDF rendition failed; falling back to the original bytes', {
        errorType:
          renditionResult.error instanceof Error ? renditionResult.error.name : 'UnknownError',
      })
    }
  }

  // Decisión [F] 2026-09-04 — sin sello. Ver y descargar entregan los bytes
  // originales; la evidencia es el grant de un solo uso y la bitácora de acceso.
  const proxyResult = yield* routePromise('documents.access.proxyDownload', () =>
    createProxiedDownloadResponse(download, disposition)
  ).pipe(
    Effect.match({
      onSuccess: (response) => ({ ok: true as const, response }),
      onFailure: (failure) => ({ ok: false as const, error: failure.cause }),
    })
  )
  if (proxyResult.ok) {
    // La respuesta binaria protegida permanece en el canal de éxito del Effect.
    return withRequestIdHeader(proxyResult.response, requestId)
  }

  log.error('Protected document proxy failed', {
    errorType: proxyResult.error instanceof Error ? proxyResult.error.name : 'UnknownError',
  })
  yield* releaseFailedDelivery(
    convexAuth.client,
    deliverySecret,
    grantId,
    token,
    proofProfileId
  ).pipe(
    Effect.catch((failure) => {
      log.error('Failed delivery release failed', {
        errorType: failure.cause instanceof Error ? failure.cause.name : 'UnknownError',
      })
      return Effect.sync(() => {})
    })
  )
  return yield* respond(
    apiError(
      requestId,
      500,
      { error: 'No se pudo preparar el documento protegido' },
      { route: ROUTE }
    )
  )
})

function getDocumentAccessEffect(request: NextRequest, context: RouteContext, requestId: string) {
  return getDocumentAccess(request, context, requestId).pipe(
    Effect.catchCause((cause) => {
      const typedFailure = Cause.findError(cause)
      if (Result.isSuccess(typedFailure) && typedFailure.success._tag === 'RouteResponse') {
        return Effect.fail(typedFailure.success)
      }

      const error =
        Result.isSuccess(typedFailure) && typedFailure.success._tag === 'RouteOperationError'
          ? typedFailure.success.cause
          : Cause.prettyErrors(cause)[0]
      const internalMessage = error instanceof Error ? error.message : 'Acceso denegado'
      const status = /no encontrado|no disponible/i.test(internalMessage) ? 404 : 403
      log.warn('Document access denied', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      })
      const clientMessage = status === 404 ? 'Documento no encontrado' : 'Acceso denegado'
      return Effect.succeed(apiError(requestId, status, { error: clientMessage }))
    })
  )
}

export function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  return runRouteEffect(request, ROUTE, getDocumentAccessEffect(request, context, requestId), {
    requestId,
  })
}
