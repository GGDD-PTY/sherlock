import { randomUUID } from 'node:crypto'

import { Effect } from 'effect'
import { NextRequest } from 'next/server'

import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { apiError, getOrCreateRequestId, withRequestIdHeader } from '@/lib/api/response'
import { requireAdminApiStepUp, requireApiAuthWithRole } from '@/lib/api/with-auth'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { UnexpectedAppError } from '@/lib/effect/errors'
import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'
import { buildContentDisposition } from '@/lib/documents/content-disposition'
import { createLogger } from '@/lib/logger'
import { isValidConvexId, toConvexId } from '@/lib/validations'
import {
  checkRateLimitDistributed,
  createRateLimitResponse,
  getClientIp,
  RATE_LIMIT_PRESETS,
} from '@/lib/utils/rate-limit'
import { VDR_SHELL_FOLDER_VALUES } from '@/lib/vdr/document-taxonomy'
import {
  buildZipEntryPath,
  createRoomZipStream,
  isExportOverCap,
  sumExportableBytes,
  type RoomZipEntry,
} from '@/lib/vdr/zip-export'

const ROUTE = '/api/vdr/export'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const log = createLogger('API:VDR:EXPORT')

type ExportableDocument = {
  documentId: Id<'documents'>
  name: string
  folder: string
  byteSize: number
  storageUrl: string
  versionId: Id<'documentVersions'>
}

type ExportPayload = {
  companyId: Id<'companies'>
  companyName: string
  documents: ExportableDocument[]
}

function readConvexError(error: unknown): { code?: string } {
  if (!error || typeof error !== 'object') return {}
  const data = (error as { data?: { code?: string } }).data
  return typeof data?.code === 'string' ? { code: data.code } : {}
}

function convexStatus(code: string | undefined): number {
  switch (code) {
    case 'AUTH_NOT_AUTHENTICATED':
      return 401
    case 'AUTHZ_UNAUTHORIZED':
    case 'AUTHZ_NOT_OWNER':
    case 'AUTHZ_ROLE_REQUIRED':
      return 403
    case 'VALIDATION_FAILED':
    case 'VALIDATION_INVALID_INPUT':
      return 400
    case 'NOT_FOUND':
    case 'COMPANY_NOT_FOUND':
      return 404
    case 'RATE_LIMIT_EXCEEDED':
      return 429
    default:
      return 500
  }
}

function convexClientError(requestId: string, error: unknown): Response {
  const { code } = readConvexError(error)
  const status = convexStatus(code)
  const message =
    status === 401
      ? 'No autorizado'
      : status === 403
        ? 'No tienes permiso para exportar esta sala'
        : status === 400
          ? 'Solicitud inválida'
          : status === 404
            ? 'Empresa no encontrada'
            : status === 429
              ? 'Demasiadas solicitudes'
              : 'No se pudo preparar el zip'
  return apiError(
    requestId,
    status,
    { error: message, code: code ?? 'INTERNAL_ERROR' },
    { error, route: ROUTE }
  )
}

const getRoomExport = Effect.fn('VdrExport.GET')(function* (
  request: NextRequest,
  requestId: string
) {
  const ip = getClientIp(request)
  const rateLimitResult = yield* routePromise('VdrExport.rateLimit', () =>
    checkRateLimitDistributed(`vdr-export:${ip}`, RATE_LIMIT_PRESETS.api)
  )
  // Rate-limit, auth y step-up devuelven respuestas de helpers compartidos:
  // se envuelven para que salgan con requestId, `no-store` y `nosniff` como
  // cualquier otro error de la ruta, sin reescribir su codigo estable.
  if (!rateLimitResult.success) {
    return yield* respond(withRequestIdHeader(createRateLimitResponse(rateLimitResult), requestId))
  }

  const auth = yield* routePromise('VdrExport.auth', () =>
    requireApiAuthWithRole(['COMPANY', 'ADMIN'])
  )
  if (auth.error) return yield* respond(withRequestIdHeader(auth.error, requestId))
  const stepUpError = yield* routePromise('VdrExport.stepUp', () =>
    requireAdminApiStepUp(auth.user)
  )
  if (stepUpError) return yield* respond(withRequestIdHeader(stepUpError, requestId))

  const search = request.nextUrl.searchParams
  const rawCompanyId = search.get('companyId')
  const rawFolder = search.get('folder')
  // El sitio sirve un solo idioma: el `locale` de la query ya no elige nada.
  const locale = 'es' as const

  if (auth.user.role === 'ADMIN' && (!rawCompanyId || !isValidConvexId(rawCompanyId))) {
    return yield* respond(
      apiError(requestId, 400, {
        error: 'Falta el identificador de la empresa.',
        code: 'VALIDATION_FAILED',
      })
    )
  }

  if (rawCompanyId && !isValidConvexId(rawCompanyId)) {
    return yield* respond(
      apiError(requestId, 400, {
        error: 'Solicitud inválida',
        code: 'VALIDATION_FAILED',
      })
    )
  }

  if (rawFolder && !VDR_SHELL_FOLDER_VALUES.includes(rawFolder)) {
    return yield* respond(
      apiError(requestId, 400, {
        error: 'Solicitud inválida',
        code: 'VALIDATION_FAILED',
      })
    )
  }

  const convexAuth = yield* routePromise('VdrExport.convexAuth', () => getAuthenticatedConvex())
  if (!convexAuth?.client || !convexAuth.isAuthenticated) {
    log.warn('Authenticated Convex client unavailable for room export', {
      userId: auth.user.id,
    })
    return yield* respond(
      apiError(
        requestId,
        500,
        { error: 'No se pudo verificar la sesión documental', code: 'INTERNAL_ERROR' },
        { route: ROUTE }
      )
    )
  }

  const payload = yield* routePromise('VdrExport.listDocuments', () =>
    convexAuth.client.query(api.vdrExport.listExportableDocuments, {
      ...(rawCompanyId ? { companyId: toConvexId<'companies'>(rawCompanyId) } : {}),
      ...(rawFolder ? { folder: rawFolder } : {}),
    })
  ).pipe(
    Effect.map((value) => value as ExportPayload),
    Effect.catch((queryError) => {
      log.error('Room export query failed', {
        errorType:
          queryError.cause instanceof Error ? queryError.cause.name : typeof queryError.cause,
      })
      return respond(convexClientError(requestId, queryError.cause))
    })
  )

  if (!payload.documents.length) {
    return yield* respond(
      apiError(requestId, 404, {
        error: 'No hay documentos publicados para exportar.',
        code: 'NOT_FOUND',
      })
    )
  }

  const totalBytes = sumExportableBytes(payload.documents)
  if (isExportOverCap(totalBytes)) {
    return yield* respond(
      apiError(requestId, 413, {
        error: 'La sala supera el límite de 250 MB.',
        code: 'PAYLOAD_TOO_LARGE',
      })
    )
  }

  const usedPaths = new Set<string>()
  const entries: RoomZipEntry[] = payload.documents.map((document) => ({
    path: buildZipEntryPath(document.folder, document.name, locale, usedPaths),
    open: () =>
      runServerEffect(
        externalCall({
          service: 'ConvexStorage',
          operation: 'roomExport.download',
          timeout: '15 seconds',
          retries: 2,
          run: (signal) => fetch(document.storageUrl, { signal }),
        }).pipe(
          Effect.flatMap((blobResponse) => {
            if (blobResponse.ok && blobResponse.body) return Effect.succeed(blobResponse.body)
            // Omitir el documento dejaria una sala incompleta con cara de 200:
            // el fallo escala y aborta el stream.
            return Effect.fail(
              new UnexpectedAppError({
                operation: 'VdrExport.download',
                message: `ROOM_EXPORT_BLOB_UNAVAILABLE_${blobResponse.status}`,
              })
            )
          })
        )
      ),
  }))

  const exportId = randomUUID()

  // El audit va ANTES del primer byte y falla cerrado: una vez abierto el
  // stream la respuesta ya no puede retractarse, asi que no hay momento
  // posterior en que negar la descarga siga siendo posible. Su rate-limit
  // tambien vive aca, y por eso tiene que poder decir que no.
  yield* routePromise('VdrExport.recordAudit', () =>
    convexAuth.client.mutation(api.vdrExport.recordRoomExport, {
      companyId: payload.companyId,
      exportId,
      ...(rawFolder ? { folder: rawFolder } : {}),
      documentIds: payload.documents.map((document) => document.documentId),
    })
  ).pipe(
    Effect.catch((auditError) => {
      log.error('Room export audit failed', {
        requestId,
        errorType:
          auditError.cause instanceof Error ? auditError.cause.name : typeof auditError.cause,
      })
      return respond(convexClientError(requestId, auditError.cause))
    })
  )

  const archive = createRoomZipStream(entries, (streamError) => {
    log.error('Room export stream aborted', {
      requestId,
      exportId,
      errorType: streamError instanceof Error ? streamError.name : typeof streamError,
    })
  })

  const response = withRequestIdHeader(
    new Response(archive, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': buildContentDisposition(
          'attachment',
          `sala-${payload.companyName}.zip`,
          'sala.zip',
          { extension: 'zip' }
        ),
      },
    }),
    requestId
  )
  response.headers.set('Cache-Control', 'private, no-store')
  return response
})

export function GET(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  return runRouteEffect(request, ROUTE, getRoomExport(request, requestId), {
    requestId,
    internalErrorMessage: 'No se pudo preparar el zip',
  })
}
