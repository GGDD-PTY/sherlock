import { Effect } from 'effect'
import { NextRequest } from 'next/server'
import { respond, routePromise, runRouteEffect } from '@/lib/api/effect-route'
import { apiError, apiSuccess, getOrCreateRequestId, withRequestIdHeader } from '@/lib/api/response'
import { requireApiAuthWithRole } from '@/lib/api/with-auth'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { getConvexAdminClient } from '@/lib/convex/admin-client'
import { rejectInvalidOrigin } from '@/lib/api/csrf'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { api } from '@/../convex/_generated/api'
import { Id } from '@/../convex/_generated/dataModel'
import { isValidConvexId, toConvexId } from '@/lib/validations'
import {
  checkRateLimitDistributed,
  createRateLimitResponse,
  getClientIp,
  RATE_LIMIT_PRESETS,
} from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/logger'
import { getDemoCompanyFromPublicList } from '@/lib/dev-auth/demo-company'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from '@/lib/storage/upload-limits'
import {
  detectFileSignature,
  inspectCsvFile,
  inspectOfficeFile,
  inspectZipSafety,
  matchesDeclaredMimeType,
} from '@/../convex/_documents/fileInspection'
import {
  requiresConfiguredScanner,
  scanFileWithConfiguredGateway,
} from '@/../convex/_documents/scanner'

const log = createLogger('API:Documents:Upload')
const ROUTE = '/api/documents/upload'

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
]

// Límite efectivo de subida: acotado por la plataforma (Vercel corta el body
// en ~4.5MB con un 413 antes de que esta ruta corra). Mantener el mismo techo
// aquí hace que dev se comporte igual que producción. Los uploaders de
// documentos del producto ya migraron a la subida directa navegador→Convex
// Storage (useDirectVdrUpload + registerDirectUpload, techo real de 50MB);
// esta ruta queda como carril /api con su techo honesto de 4MB.
const MAX_FILE_SIZE = MAX_UPLOAD_BYTES

async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function deleteUploadedStorageFile(
  convexAdmin: ReturnType<typeof getConvexAdminClient>,
  storageId: Id<'_storage'>
): Promise<boolean> {
  if (!convexAdmin) return false

  try {
    const result = await convexAdmin.mutation('_documents/mutations:deleteStorageFileInternal', {
      storageId,
    })
    const deleted =
      typeof result === 'object' &&
      result !== null &&
      (result as { deleted?: unknown }).deleted === true
    if (deleted) {
      log.info('Cleaned up orphaned Convex Storage file after metadata failure')
    } else {
      log.warn('Storage cleanup requires reconciliation')
    }
    return deleted
  } catch (cleanupError) {
    log.error('Failed to clean up Convex Storage file after metadata failure', {
      errorType: cleanupError instanceof Error ? cleanupError.name : 'UnknownError',
    })
    return false
  }
}

const TRANSIENT_RETRY_DELAYS_MS = [150, 450] as const

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
  )
}

function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  if (/unauthor|forbidden|permiso|rate.?limit|too many|invalid|validation|security/.test(message)) {
    return false
  }
  return /network|fetch|timeout|connection|temporar|unavailable|server error/.test(message)
}

async function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeoutId)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function retryBeforeCommit<T>(
  operation: () => Promise<T>,
  maxAttempts: number,
  signal: AbortSignal
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (
        isAbortError(error, signal) ||
        !isRetryableProviderError(error) ||
        attempt === maxAttempts
      ) {
        throw error
      }
      await waitForRetry(
        TRANSIENT_RETRY_DELAYS_MS[Math.min(attempt - 1, TRANSIENT_RETRY_DELAYS_MS.length - 1)],
        signal
      )
    }
  }
  throw lastError
}

function canceledUploadResponse(requestId: string, reconciliationRequired = false) {
  return apiError(requestId, 499, {
    error: 'Carga cancelada',
    ...(reconciliationRequired ? { reconciliationRequired: true } : {}),
  })
}

const postDocumentUpload = Effect.fn('DocumentsUpload.POST')(function* (
  request: NextRequest,
  requestId: string
) {
  if (request.signal.aborted) return yield* respond(canceledUploadResponse(requestId))

  const csrfError = rejectInvalidOrigin(request)
  if (csrfError) return yield* respond(withRequestIdHeader(csrfError, requestId))

  const clientIp = getClientIp(request)
  const rateLimitResult = yield* routePromise('documents.upload.rateLimit', () =>
    checkRateLimitDistributed(`documents:upload:${clientIp}`, RATE_LIMIT_PRESETS.upload)
  )
  if (!rateLimitResult.success) {
    log.warn('Rate limit exceeded', { clientIp })
    return yield* respond(withRequestIdHeader(createRateLimitResponse(rateLimitResult), requestId))
  }

  // Solo COMPANY, por la frontera de auth de las API (perfil activo y rol
  // desde Convex). ADMIN queda fuera de este carril legacy /api: aquí no se
  // verifica step-up reciente ni se consume la capability VDR de un solo uso
  // (requireAdminVdrCapability) que exige todo write administrativo del VDR,
  // así que permitirlo evadiría esa compuerta de aprobación. Las subidas
  // administrativas usan el flujo directo navegador→Convex Storage
  // (issueDirectUploadIntent + inspectAndRegisterDirectUpload), que sí liga
  // una capability admin antes de escribir.
  const auth = yield* routePromise('documents.upload.authenticate', () =>
    requireApiAuthWithRole(['COMPANY'])
  )
  if (auth.error) return yield* respond(withRequestIdHeader(auth.error, requestId))
  const user = auth.user
  const profileId = user.profileId
  if (!profileId) {
    return yield* respond(apiError(requestId, 404, { error: 'Perfil no encontrado' }))
  }

  const formData = yield* routePromise('documents.upload.formData', () => request.formData())
  const file = formData.get('file') as File
  const companyId = formData.get('companyId') as string
  const name = formData.get('name') as string
  const accessLevel = formData.get('accessLevel') as string
  const classification = formData.get('classification') as string | null
  const folder = formData.get('folder') as string

  if (!file || !companyId || !name) {
    return yield* respond(apiError(requestId, 400, { error: 'Faltan parámetros requeridos' }))
  }

  if (!isValidConvexId(companyId)) {
    return yield* respond(apiError(requestId, 400, { error: 'ID de empresa inválido' }))
  }
  const targetCompanyId = toConvexId<'companies'>(companyId)

  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return yield* respond(
      apiError(requestId, 400, {
        error: 'Tipo de archivo no permitido. Usa PDF, Excel, Word, PowerPoint o CSV.',
      })
    )
  }

  if (file.size > MAX_FILE_SIZE) {
    return yield* respond(
      apiError(requestId, 400, { error: `Archivo demasiado grande. Máximo ${MAX_UPLOAD_MB}MB.` })
    )
  }

  const signatureBytes = new Uint8Array(
    yield* routePromise('documents.upload.readSignature', () => file.slice(0, 16).arrayBuffer())
  )
  const fileSignature = detectFileSignature(signatureBytes)
  if (!matchesDeclaredMimeType(file.type, fileSignature)) {
    return yield* respond(
      apiError(requestId, 400, {
        error: 'El contenido del archivo no coincide con el tipo declarado.',
      })
    )
  }
  if (fileSignature === 'ZIP') {
    const zipSafety = yield* routePromise('documents.upload.inspectZip', () =>
      inspectZipSafety(file)
    )
    if (!zipSafety.safe) {
      return yield* respond(
        apiError(requestId, 400, { error: 'El archivo no superó las verificaciones de seguridad.' })
      )
    }
  }
  if (file.type === 'text/csv') {
    const csv = yield* routePromise('documents.upload.inspectCsv', () => inspectCsvFile(file))
    if (!csv.safe) {
      return yield* respond(
        apiError(requestId, 400, {
          error: 'El archivo CSV no tiene la forma de una tabla delimitada válida.',
        })
      )
    }
  } else if (file.type !== 'application/pdf') {
    const officeFileIsValid = yield* routePromise('documents.upload.inspectOffice', () =>
      inspectOfficeFile(file, file.type)
    )
    if (!officeFileIsValid) {
      return yield* respond(
        apiError(requestId, 400, {
          error: 'El contenido del archivo no coincide con el formato Office declarado.',
        })
      )
    }
  }

  const allowedAccessLevels = ['PUBLIC', 'NDA_REQUIRED', 'PRIVATE'] as const
  type AccessLevel = (typeof allowedAccessLevels)[number]
  const validatedAccessLevel: AccessLevel = allowedAccessLevels.includes(accessLevel as AccessLevel)
    ? (accessLevel as AccessLevel)
    : 'NDA_REQUIRED'

  const allowedClassifications = [
    'PUBLIC_TEASER',
    'CONFIDENTIAL',
    'RESTRICTED',
    'LEGAL',
    'KYC_SENSITIVE',
  ] as const
  type DocumentClassification = (typeof allowedClassifications)[number]
  const validatedClassification =
    classification && allowedClassifications.includes(classification as DocumentClassification)
      ? (classification as DocumentClassification)
      : undefined

  const convexAuth = yield* routePromise('documents.upload.convex.authenticate', () =>
    getAuthenticatedConvex()
  )
  if (!convexAuth || (!convexAuth.isAuthenticated && !DEV_AUTH_ENABLED)) {
    log.warn('Failed to get authenticated Convex client for upload')
    return yield* respond(
      apiError(
        requestId,
        500,
        { error: 'Error de autenticación con el almacenamiento' },
        { route: ROUTE }
      )
    )
  }

  const convexAdmin = getConvexAdminClient()
  if (!convexAdmin && !DEV_AUTH_ENABLED) {
    log.error('Convex admin client unavailable for validated document creation')
    return yield* respond(
      apiError(
        requestId,
        500,
        { error: 'Error de configuración del almacenamiento' },
        { route: ROUTE }
      )
    )
  }

  // Siempre corre: ADMIN ya fue rechazado arriba, así que todo caller que
  // llega aquí debe ser el dueño de la empresa destino.
  const userCompany = DEV_AUTH_ENABLED
    ? yield* routePromise('documents.upload.getDemoCompany', () =>
        getDemoCompanyFromPublicList(profileId)
      )
    : convexAuth.isAuthenticated
      ? yield* routePromise('documents.upload.getCompanyByOwner', () =>
          convexAuth.client.query(api.companies.getCompanyByOwner, {
            ownerId: profileId,
          })
        )
      : null

  if (!userCompany || userCompany._id !== targetCompanyId) {
    log.warn('Unauthorized access attempt', {
      userId: profileId,
      targetCompanyId: companyId,
    })
    return yield* respond(
      apiError(requestId, 403, { error: 'No tienes permiso para subir documentos a esta empresa' })
    )
  }

  // Demo auth does not have a Convex JWT. Keep the demo VDR journey usable
  // without pretending a production storage write happened.
  if (DEV_AUTH_ENABLED && !convexAuth.isAuthenticated) {
    return apiSuccess(
      {
        success: true,
        message: 'Documento registrado en modo demo',
        documentId: `demo-doc-${Date.now().toString(36)}`,
      },
      requestId
    )
  }

  // El scanner recibe solo bytes + hash; no enviamos nombre, empresa ni
  // identidad. Fuera de CONVEX_ENV=dev explícito, su ausencia o error
  // bloquea antes de publicar.
  const fileSha256 = yield* routePromise('documents.upload.sha256', () => sha256Hex(file))
  const scan = yield* routePromise('documents.upload.scan', () =>
    scanFileWithConfiguredGateway(file, fileSha256)
  )
  if (scan.status === 'INFECTED') {
    return yield* respond(
      apiError(requestId, 400, { error: 'El archivo no superó las verificaciones de seguridad.' })
    )
  }
  if (
    scan.status === 'ERROR' ||
    (scan.status === 'NOT_CONFIGURED' && requiresConfiguredScanner(process.env))
  ) {
    return yield* respond(
      apiError(
        requestId,
        503,
        { error: 'La verificación de seguridad no está disponible. Intenta de nuevo.' },
        { route: ROUTE }
      )
    )
  }

  // Emitir una URL no almacena bytes; un retry transitorio es seguro.
  const uploadUrlResult = yield* routePromise('documents.upload.generateUploadUrl', () =>
    retryBeforeCommit(
      async () => {
        const issuedUrl = await convexAdmin!.mutation(
          '_documents/storage:generateUploadUrlInternal',
          {}
        )
        if (typeof issuedUrl !== 'string') {
          throw new Error('Invalid storage upload URL')
        }
        return issuedUrl
      },
      2,
      request.signal
    )
  ).pipe(
    Effect.match({
      onSuccess: (uploadUrl) => ({ ok: true as const, uploadUrl }),
      onFailure: (failure) => ({ ok: false as const, error: failure.cause }),
    })
  )
  if (!uploadUrlResult.ok) {
    if (isAbortError(uploadUrlResult.error, request.signal)) {
      return yield* respond(canceledUploadResponse(requestId))
    }
    log.error('Failed to prepare document storage upload')
    return yield* respond(
      apiError(requestId, 503, { error: 'Error al preparar el almacenamiento' }, { route: ROUTE })
    )
  }

  // Deliberadamente un solo POST: si se pierde la respuesta, repetir el
  // blob podría crear un duplicado. El cliente recibe reconciliación.
  const uploadResult = yield* routePromise('documents.upload.storeBlob', () =>
    fetch(uploadUrlResult.uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
      signal: request.signal,
    })
  ).pipe(
    Effect.match({
      onSuccess: (response) => ({ ok: true as const, response }),
      onFailure: (failure) => ({ ok: false as const, error: failure.cause }),
    })
  )
  if (!uploadResult.ok) {
    const canceled = isAbortError(uploadResult.error, request.signal)
    log.warn('Document storage upload ended without provider confirmation', { canceled })
    if (canceled) return yield* respond(canceledUploadResponse(requestId, true))
    return yield* respond(
      apiError(
        requestId,
        502,
        { error: 'Error al subir archivo al almacenamiento', reconciliationRequired: true },
        { route: ROUTE }
      )
    )
  }
  const uploadResponse = uploadResult.response

  if (!uploadResponse.ok) {
    // No se registra ni devuelve el body crudo del proveedor.
    log.error('Error uploading to Convex Storage', { status: uploadResponse.status })
    return yield* respond(
      apiError(
        requestId,
        502,
        { error: 'Error al subir archivo al almacenamiento' },
        { route: ROUTE }
      )
    )
  }

  const payload = yield* routePromise<unknown>('documents.upload.readReceipt', () =>
    uploadResponse.json()
  ).pipe(
    Effect.match({
      onSuccess: (value) => value,
      onFailure: () => null,
    })
  )
  const storageId =
    payload && typeof payload === 'object'
      ? (payload as { storageId?: unknown }).storageId
      : undefined
  if (typeof storageId !== 'string' || storageId.length === 0) {
    log.error('Storage provider returned an invalid upload receipt')
    return yield* respond(
      apiError(
        requestId,
        502,
        {
          error: 'No se pudo confirmar la carga en el almacenamiento',
          reconciliationRequired: true,
        },
        { route: ROUTE }
      )
    )
  }

  log.info('File uploaded to Convex Storage', {
    storageId,
    companyId,
    userId: profileId,
  })

  const typedStorageId = storageId as Id<'_storage'>
  if (request.signal.aborted) {
    const cleaned = yield* routePromise('documents.upload.cleanupCanceledBlob', () =>
      deleteUploadedStorageFile(convexAdmin, typedStorageId)
    )
    return yield* respond(canceledUploadResponse(requestId, !cleaned))
  }
  const registrationArgs = {
    companyId: targetCompanyId,
    uploaderProfileId: profileId,
    uploaderRole: user.role,
    uploaderProviderUserId: user.id,
    name: name,
    fileType: file.type || file.name.split('.').pop() || 'unknown',
    fileSize: file.size,
    accessLevel: validatedAccessLevel,
    classification: validatedClassification,
    folder: folder || 'General',
    storageId: typedStorageId,
    signatureKind: fileSignature,
    malwareScanStatus: scan.status,
    ...(scan.status === 'CLEAN'
      ? {
          scannerEngine: scan.engine,
          scannerScanId: scan.scanId,
          scannerDefinitionVersion: scan.definitionVersion,
          scannedAt: scan.scannedAt,
        }
      : {}),
  } as const
  // Reintentos solo del registro, siempre con el mismo storageId. La
  // internalMutation devuelve el documento existente si el commit previo
  // prosperó pero la respuesta se perdió.
  const registrationResult = yield* routePromise('documents.upload.registerMetadata', () =>
    retryBeforeCommit(
      () =>
        convexAdmin!.mutation('_documents/mutations:createFromValidatedUpload', registrationArgs),
      3,
      request.signal
    )
  ).pipe(
    Effect.match({
      onSuccess: (documentId) => ({ ok: true as const, documentId }),
      onFailure: (failure) => ({ ok: false as const, error: failure.cause }),
    })
  )
  if (!registrationResult.ok) {
    const cleaned = yield* routePromise('documents.upload.cleanupMetadataFailure', () =>
      deleteUploadedStorageFile(convexAdmin, typedStorageId)
    )
    if (isAbortError(registrationResult.error, request.signal)) {
      return yield* respond(canceledUploadResponse(requestId, !cleaned))
    }
    log.error('Document metadata registration failed after storage commit')
    return yield* respond(
      apiError(
        requestId,
        500,
        {
          error: 'Error interno del servidor al procesar el archivo',
          ...(cleaned ? {} : { reconciliationRequired: true }),
        },
        { route: ROUTE }
      )
    )
  }

  return apiSuccess(
    {
      success: true,
      message: 'Documento subido y registrado exitosamente',
      documentId: registrationResult.documentId,
    },
    requestId
  )
})

export function POST(request: NextRequest): Promise<Response> {
  const requestId = getOrCreateRequestId(request)
  return runRouteEffect(request, ROUTE, postDocumentUpload(request, requestId), {
    internalErrorMessage: 'Error interno del servidor al procesar el archivo',
    requestId,
  })
}
