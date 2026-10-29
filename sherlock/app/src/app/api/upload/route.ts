// Assets públicos (avatars, logos). Los documentos confidenciales van por
// /api/documents/upload: metadatos VDR, política de acceso, auditoría y grants.

import { createHash } from 'crypto'
import { Effect } from 'effect'
import { NextRequest } from 'next/server'
import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { rejectInvalidOrigin } from '@/lib/api/csrf'
import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { apiError, apiSuccess, getOrCreateRequestId, withRequestIdHeader } from '@/lib/api/response'
import { requireApiAuth } from '@/lib/api/with-auth'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import {
  checkRateLimitDistributed,
  createRateLimitResponse,
  getClientIp,
  RATE_LIMIT_PRESETS,
} from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/logger'
import { type StorageBucket, validateFile, VALID_BUCKETS } from '@/lib/storage'
import { isGenericUploadBucket } from '@/lib/storage/generic-upload-buckets'

const log = createLogger('API:Upload')
const ROUTE = '/api/upload'

const postUpload = Effect.fn('Upload.POST')(function* (request: NextRequest, requestId: string) {
  const csrfError = rejectInvalidOrigin(request)
  if (csrfError) return yield* respond(withRequestIdHeader(csrfError, requestId))

  const clientIp = getClientIp(request)
  const rateLimitResult = yield* routePromise('upload.rateLimit', () =>
    checkRateLimitDistributed(`upload:${clientIp}`, RATE_LIMIT_PRESETS.upload)
  )

  if (!rateLimitResult.success) {
    log.warn('Rate limit exceeded', { clientIp })
    return yield* respond(withRequestIdHeader(createRateLimitResponse(rateLimitResult), requestId))
  }

  const { user, error: authError } = yield* routePromise('upload.authenticate', () =>
    requireApiAuth()
  )
  if (authError) return yield* respond(withRequestIdHeader(authError, requestId))
  if (!user.profileId) {
    return yield* respond(apiError(requestId, 404, { error: 'Perfil no encontrado' }))
  }

  const formData = yield* routePromise('upload.formData', () => request.formData())
  const file = formData.get('file') as File | null
  const bucket = formData.get('bucket') as StorageBucket | null

  if (!file) {
    return yield* respond(apiError(requestId, 400, { error: 'No se recibió ningún archivo' }))
  }

  if (!bucket || !VALID_BUCKETS.includes(bucket)) {
    return yield* respond(
      apiError(requestId, 400, { error: 'Bucket inválido. Debe ser: avatars o logos' })
    )
  }

  if (!isGenericUploadBucket(bucket)) {
    return yield* respond(
      apiError(requestId, 400, {
        error:
          'Los documentos confidenciales deben subirse por /api/documents/upload para aplicar política VDR y auditoría.',
      })
    )
  }

  const validation = validateFile(file, bucket)
  if (!validation.valid) {
    return yield* respond(apiError(requestId, 400, { error: validation.error }))
  }

  const convexAuth = yield* routePromise('upload.convex.authenticate', () =>
    getAuthenticatedConvex()
  )
  if (!convexAuth || (!convexAuth.isAuthenticated && !DEV_AUTH_ENABLED)) {
    return yield* respond(
      apiError(
        requestId,
        500,
        { error: 'Error de autenticación con el almacenamiento' },
        { route: ROUTE }
      )
    )
  }

  const convexClient = convexAuth.client

  // Demo auth does not have a Convex JWT. Keep logo/avatar uploads usable
  // locally without pretending a production storage write happened.
  if (DEV_AUTH_ENABLED && !convexAuth.isAuthenticated) {
    const bytes = yield* routePromise('upload.demo.readFile', () => file.arrayBuffer())
    const dataUrl = `data:${file.type};base64,${Buffer.from(bytes).toString('base64')}`

    return apiSuccess(
      {
        success: true,
        demo: true,
        url: dataUrl,
        size: file.size,
      },
      requestId
    )
  }

  const bytes = yield* routePromise('upload.sha256.readFile', () => file.arrayBuffer())
  const declaredSha256 = createHash('sha256').update(Buffer.from(bytes)).digest('hex')
  const assetIntent = yield* routePromise('upload.issueAssetIntent', () =>
    convexClient.mutation(api.documents.issueAssetUploadIntent, {
      purpose: bucket === 'avatars' ? 'AVATAR' : 'LOGO',
      declaredMimeType: file.type,
      declaredByteSize: file.size,
      declaredSha256,
    })
  )

  const uploadResponse = yield* routePromise('upload.storeBlob', () =>
    fetch(assetIntent.uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    })
  )

  if (!uploadResponse.ok) {
    // Solo el status: el body crudo del proveedor no se registra ni se devuelve.
    log.error('Error uploading to Convex Storage', { status: uploadResponse.status, bucket })
    return yield* respond(
      apiError(requestId, 500, { error: 'Error al subir archivo' }, { route: ROUTE })
    )
  }

  const { storageId } = yield* routePromise('upload.readReceipt', () => uploadResponse.json())

  const resolution = yield* routePromise('upload.resolveAsset', () =>
    convexClient.action(api.documents.resolveAssetUpload, {
      intentId: assetIntent.intentId,
      storageId: storageId as Id<'_storage'>,
    })
  )
  if (!resolution.resolved) {
    return yield* respond(
      apiError(requestId, 400, { error: 'El archivo no superó las verificaciones de seguridad' })
    )
  }

  log.info('File uploaded to Convex Storage', {
    bucket,
    size: file.size,
    type: file.type,
    userId: user.id,
  })

  return apiSuccess(
    {
      success: true,
      url: resolution.url,
      size: file.size,
    },
    requestId
  )
})

export function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  return runRouteEffect(request, ROUTE, postUpload(request, requestId), {
    internalErrorMessage: 'Error interno del servidor',
    requestId,
  })
}
