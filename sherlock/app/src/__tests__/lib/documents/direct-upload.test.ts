// ============================================================================
// performDirectVdrUpload — NÚCLEO PURO DE LA SUBIDA DIRECTA
// ============================================================================
// Camino directo navegador → Convex Storage (decisión 6,
// DESIGN-ONBOARDING-VDR-2026-07-31): validar client-side contra el techo
// directo (50MB), pedir la URL presignada, POST del archivo DIRECTO a
// *.convex.cloud (jamás por una ruta Next en Vercel) y registrar la metadata.
//
// Contrato bajo prueba:
// - el techo client-side evita subir >50MB para que el servidor los rechace
// - el POST va a la URL presignada con el archivo como body, nunca a /api
// - todo fallo se normaliza a un código estable (jamás el error crudo del
//   proveedor) y el rechazo estructurado del servidor se propaga tal cual
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  performDirectVdrUpload,
  type DirectVdrUploadDeps,
  type DirectVdrUploadInput,
} from '@/lib/documents/direct-upload'
import {
  MAX_CSV_UPLOAD_BYTES,
  MAX_DIRECT_UPLOAD_BYTES,
} from '../../../../convex/_documents/uploadLimits'

const UPLOAD_URL = 'https://happy-animal-123.convex.cloud/api/storage/upload?token=abc'
const FILE_SHA256 = '374708fff7719dd5979ec875d56cd2286f6d3cf7ec317a3b25632aab28ec37bb'

function makeFile(size = 1024, type = 'application/pdf', name = 'pitch-deck.pdf'): File {
  const file = new File([new Uint8Array(16)], name, { type })
  // No asignamos 50MB reales: el tamaño reportado es lo único que se valida.
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function makeInput(file: File): DirectVdrUploadInput {
  return {
    file,
    companyId: 'company_1',
    name: 'Pitch deck',
    accessLevel: 'NDA_REQUIRED',
    classification: 'CONFIDENTIAL',
    folder: 'other',
  }
}

function makeDeps(overrides: Partial<DirectVdrUploadDeps> = {}): DirectVdrUploadDeps {
  return {
    issueUploadIntent: vi.fn().mockResolvedValue({
      intentId: 'intent_1',
      uploadUrl: UPLOAD_URL,
      expiresAt: Date.now() + 60_000,
    }),
    abandonUploadIntent: vi.fn().mockResolvedValue({ aborted: true }),
    registerDirectUpload: vi.fn().mockResolvedValue('document_1'),
    fetchFn: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ storageId: 'storage_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ),
    ...overrides,
  }
}

describe('performDirectVdrUpload — camino feliz', () => {
  it('sube el archivo a la URL presignada y registra la metadata con el storageId', async () => {
    const deps = makeDeps()
    const file = makeFile(10 * 1024 * 1024)

    const result = await performDirectVdrUpload(deps, makeInput(file))

    expect(result).toEqual({ ok: true, documentId: 'document_1' })
    expect(deps.issueUploadIntent).toHaveBeenCalledWith({
      companyId: 'company_1',
      fileName: 'pitch-deck.pdf',
      declaredMimeType: 'application/pdf',
      declaredByteSize: 10 * 1024 * 1024,
      declaredSha256: '374708fff7719dd5979ec875d56cd2286f6d3cf7ec317a3b25632aab28ec37bb',
      name: 'Pitch deck',
      accessLevel: 'NDA_REQUIRED',
      classification: 'CONFIDENTIAL',
      folder: 'other',
    })
    expect(deps.fetchFn).toHaveBeenCalledWith(UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: file,
    })
    expect(deps.registerDirectUpload).toHaveBeenCalledWith({
      intentId: 'intent_1',
      storageId: 'storage_1',
    })
  })

  it('acepta archivos de más de 4MB — la razón de ser del camino directo', async () => {
    const deps = makeDeps()

    const result = await performDirectVdrUpload(deps, makeInput(makeFile(30 * 1024 * 1024)))

    expect(result.ok).toBe(true)
  })
})

describe('performDirectVdrUpload — techo client-side', () => {
  it('rechaza por encima de 50MB sin pedir URL ni subir nada', async () => {
    const deps = makeDeps()

    const result = await performDirectVdrUpload(
      deps,
      makeInput(makeFile(MAX_DIRECT_UPLOAD_BYTES + 1))
    )

    expect(result).toEqual({ ok: false, code: 'FILE_TOO_LARGE' })
    expect(deps.issueUploadIntent).not.toHaveBeenCalled()
    expect(deps.fetchFn).not.toHaveBeenCalled()
    expect(deps.registerDirectUpload).not.toHaveBeenCalled()
  })

  it('acepta exactamente el techo (límite inclusivo, igual que el servidor)', async () => {
    const deps = makeDeps()

    const result = await performDirectVdrUpload(deps, makeInput(makeFile(MAX_DIRECT_UPLOAD_BYTES)))

    expect(result.ok).toBe(true)
  })

  it.each([
    ['CSV at 20 MB', makeFile(MAX_CSV_UPLOAD_BYTES, 'text/csv', 'balance.csv'), true],
    ['CSV at 20 MB + 1', makeFile(MAX_CSV_UPLOAD_BYTES + 1, 'text/csv', 'balance.csv'), false],
    ['PDF at 20 MB + 1', makeFile(MAX_CSV_UPLOAD_BYTES + 1), true],
  ])('applies the per-format cap before intent or upload: %s', async (_label, file, accepted) => {
    const deps = makeDeps()

    const result = await performDirectVdrUpload(deps, makeInput(file))

    if (accepted) {
      expect(result.ok).toBe(true)
      expect(deps.issueUploadIntent).toHaveBeenCalledTimes(1)
      expect(deps.fetchFn).toHaveBeenCalledTimes(1)
    } else {
      expect(result).toEqual({ ok: false, code: 'FILE_TOO_LARGE' })
      expect(deps.issueUploadIntent).not.toHaveBeenCalled()
      expect(deps.fetchFn).not.toHaveBeenCalled()
      expect(deps.registerDirectUpload).not.toHaveBeenCalled()
    }
  })
})

describe('performDirectVdrUpload — Content-Type del POST directo', () => {
  it('infiere el Content-Type de la extensión cuando File.type viene vacío', async () => {
    // File.type sale del mapa MIME del OS/navegador y puede venir vacío para
    // Office/PDF válidos; POSTear vacío haría que el servidor rechace y
    // deje los bytes aislados para reconciliación atribuible.
    const deps = makeDeps()
    const file = makeFile(1024, '', 'valuation-model.docx')

    const result = await performDirectVdrUpload(deps, makeInput(file))

    expect(result).toEqual({ ok: true, documentId: 'document_1' })
    expect(deps.fetchFn).toHaveBeenCalledWith(UPLOAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      body: file,
    })
  })

  it('falla rápido con INVALID_FILE_TYPE si no hay File.type ni extensión conocida', async () => {
    const deps = makeDeps()

    const result = await performDirectVdrUpload(deps, makeInput(makeFile(1024, '', 'README')))

    expect(result).toEqual({ ok: false, code: 'INVALID_FILE_TYPE' })
    expect(deps.issueUploadIntent).not.toHaveBeenCalled()
    expect(deps.fetchFn).not.toHaveBeenCalled()
    expect(deps.registerDirectUpload).not.toHaveBeenCalled()
  })

  it('respeta el File.type declarado cuando existe — sin re-inferir de la extensión', async () => {
    const deps = makeDeps()
    const file = makeFile(1024, 'application/pdf', 'sin-extension')

    const result = await performDirectVdrUpload(deps, makeInput(file))

    expect(result.ok).toBe(true)
    expect(deps.fetchFn).toHaveBeenCalledWith(
      UPLOAD_URL,
      expect.objectContaining({ headers: { 'Content-Type': 'application/pdf' } })
    )
  })
})

describe('performDirectVdrUpload — SHA-256 previo al intent', () => {
  it('falla cerrado sin emitir autoridad cuando Web Crypto no puede calcular la huella', async () => {
    const deps = makeDeps({
      calculateSha256: vi.fn().mockRejectedValue(new Error('crypto provider detail')),
    })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({ ok: false, code: 'FILE_HASH_FAILED' })
    expect(JSON.stringify(result)).not.toContain('provider')
    expect(deps.issueUploadIntent).not.toHaveBeenCalled()
    expect(deps.fetchFn).not.toHaveBeenCalled()
  })

  it('conserva PREPARING y cancela antes de emitir el intent si aborta durante el hash', async () => {
    const controller = new AbortController()
    const events: unknown[] = []
    const calculateSha256 = vi.fn().mockImplementation(async (_file, signal) => {
      expect(signal).toBe(controller.signal)
      controller.abort()
      throw new DOMException('hash canceled', 'AbortError')
    })
    const deps = makeDeps({ calculateSha256 })

    const result = await performDirectVdrUpload(deps, {
      ...makeInput(makeFile()),
      signal: controller.signal,
      onProgress: (progress) => events.push(progress),
    })

    expect(result).toEqual({ ok: false, code: 'UPLOAD_ABORTED' })
    expect(events).toEqual([
      { stage: 'PREPARING', attempt: 1, maxAttempts: 2 },
      { stage: 'CANCELED', attempt: 1, maxAttempts: 1 },
    ])
    expect(deps.issueUploadIntent).not.toHaveBeenCalled()
    expect(deps.fetchFn).not.toHaveBeenCalled()
  })
})

describe('performDirectVdrUpload — fallas del storage', () => {
  it('refuses a non-Convex upload destination before sending file bytes', async () => {
    const deps = makeDeps({
      issueUploadIntent: vi.fn().mockResolvedValue({
        intentId: 'intent_1',
        uploadUrl: 'https://attacker.example/upload',
        expiresAt: Date.now() + 60_000,
      }),
    })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({ ok: false, code: 'STORAGE_UPLOAD_FAILED' })
    expect(deps.fetchFn).not.toHaveBeenCalled()
    expect(deps.registerDirectUpload).not.toHaveBeenCalled()
  })

  // `bun run dev:local`: el backend en 127.0.0.1:3210 firma URLs http en
  // loopback. Se aceptan SOLO fuera de producción y SOLO si son el origin
  // exacto de NEXT_PUBLIC_CONVEX_URL; cualquier otro http sigue rechazado.
  describe('URL de subida del backend local', () => {
    const LOCAL_UPLOAD_URL = 'http://127.0.0.1:3210/api/storage/upload?token=abc'

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    function localDeps(uploadUrl = LOCAL_UPLOAD_URL) {
      return makeDeps({
        issueUploadIntent: vi.fn().mockResolvedValue({
          intentId: 'intent_1',
          uploadUrl,
          expiresAt: Date.now() + 60_000,
        }),
      })
    }

    it('acepta el origin configurado en loopback fuera de producción', async () => {
      vi.stubEnv('NODE_ENV', 'development')
      vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210')
      const deps = localDeps()

      const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

      expect(result).toEqual({ ok: true, documentId: 'document_1' })
      expect(deps.fetchFn).toHaveBeenCalledWith(LOCAL_UPLOAD_URL, expect.anything())
    })

    it('la rechaza en producción aunque esté configurada', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210')
      const deps = localDeps()

      const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

      expect(result).toEqual({ ok: false, code: 'STORAGE_UPLOAD_FAILED' })
      expect(deps.fetchFn).not.toHaveBeenCalled()
    })

    it.each([
      ['otro origin http', 'http://127.0.0.1:9999/api/storage/upload?token=abc'],
      ['un host de la red', 'http://192.168.1.10:3210/api/storage/upload?token=abc'],
    ])('rechaza %s aunque sea dev', async (_, uploadUrl) => {
      vi.stubEnv('NODE_ENV', 'development')
      vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210')
      const deps = localDeps(uploadUrl)

      const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

      expect(result).toEqual({ ok: false, code: 'STORAGE_UPLOAD_FAILED' })
      expect(deps.fetchFn).not.toHaveBeenCalled()
    })
  })

  it('normaliza una respuesta no-ok del storage a STORAGE_UPLOAD_FAILED sin registrar', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue(new Response('upstream error', { status: 500 })),
    })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({ ok: false, code: 'STORAGE_UPLOAD_FAILED' })
    expect(deps.registerDirectUpload).not.toHaveBeenCalled()
  })

  it('normaliza un payload sin storageId a STORAGE_UPLOAD_FAILED', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ unexpected: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      ),
    })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({
      ok: false,
      code: 'STORAGE_UPLOAD_FAILED',
      reconciliationRequired: true,
      fileSha256: FILE_SHA256,
      storageCommitted: true,
    })
    expect(deps.registerDirectUpload).not.toHaveBeenCalled()
  })

  it('marca storage confirmado para reconciliación si el recibo 2xx no es JSON válido', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })),
    })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({
      ok: false,
      code: 'STORAGE_UPLOAD_FAILED',
      reconciliationRequired: true,
      fileSha256: FILE_SHA256,
      storageCommitted: true,
    })
    expect(deps.fetchFn).toHaveBeenCalledTimes(1)
    expect(deps.registerDirectUpload).not.toHaveBeenCalled()
  })

  it('normaliza una falla de red a STORAGE_UPLOAD_FAILED — jamás el error crudo', async () => {
    const deps = makeDeps({
      fetchFn: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({
      ok: false,
      code: 'STORAGE_UPLOAD_FAILED',
      reconciliationRequired: true,
      fileSha256: FILE_SHA256,
    })
    expect(deps.registerDirectUpload).not.toHaveBeenCalled()
  })
})

describe('performDirectVdrUpload — fallas del registro', () => {
  it('propagates an expired terminal intent without leaking backend details', async () => {
    const deps = makeDeps({
      registerDirectUpload: vi.fn().mockResolvedValue({
        registered: false,
        code: 'UPLOAD_INTENT_EXPIRED',
        internal: 'must not escape',
      }),
    })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({
      ok: false,
      code: 'UPLOAD_INTENT_EXPIRED',
      reconciliationRequired: true,
      fileSha256: FILE_SHA256,
      storageCommitted: true,
    })
    expect(JSON.stringify(result)).not.toContain('internal')
  })

  it('propaga el rechazo estructurado del servidor (blob demasiado grande)', async () => {
    const deps = makeDeps({
      registerDirectUpload: vi
        .fn()
        .mockResolvedValue({ registered: false, code: 'FILE_TOO_LARGE' }),
    })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({
      ok: false,
      code: 'FILE_TOO_LARGE',
      reconciliationRequired: true,
      fileSha256: FILE_SHA256,
      storageCommitted: true,
    })
  })

  it('propaga el rechazo estructurado del servidor (tipo no permitido)', async () => {
    const deps = makeDeps({
      registerDirectUpload: vi
        .fn()
        .mockResolvedValue({ registered: false, code: 'INVALID_FILE_TYPE' }),
    })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({
      ok: false,
      code: 'INVALID_FILE_TYPE',
      reconciliationRequired: true,
      fileSha256: FILE_SHA256,
      storageCommitted: true,
    })
  })

  it('no propaga un código de rechazo fuera del union — normaliza a REGISTRATION_FAILED', async () => {
    // El type guard solo acepta los literales de DIRECT_UPLOAD_REJECTION_CODES:
    // un código nuevo/inesperado no debe colarse al mapeo de copy de la UI.
    const deps = makeDeps({
      registerDirectUpload: vi
        .fn()
        .mockResolvedValue({ registered: false, code: 'UNEXPECTED_NEW_CODE' }),
    })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({
      ok: false,
      code: 'REGISTRATION_FAILED',
      reconciliationRequired: true,
      fileSha256: FILE_SHA256,
      storageCommitted: true,
    })
  })

  it('normaliza un throw de la mutation (authz/rate limit) a REGISTRATION_FAILED', async () => {
    const deps = makeDeps({
      registerDirectUpload: vi.fn().mockRejectedValue(new Error('Solo el dueño puede subir')),
    })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({
      ok: false,
      code: 'REGISTRATION_FAILED',
      reconciliationRequired: true,
      fileSha256: FILE_SHA256,
      storageCommitted: true,
    })
  })

  it('normaliza un resultado sin documentId a REGISTRATION_FAILED', async () => {
    const deps = makeDeps({
      registerDirectUpload: vi.fn().mockResolvedValue(null),
    })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({
      ok: false,
      code: 'REGISTRATION_FAILED',
      reconciliationRequired: true,
      fileSha256: FILE_SHA256,
      storageCommitted: true,
    })
  })
})

describe('performDirectVdrUpload — resiliencia e idempotencia', () => {
  it('returns an authoritative consumed document without posting bytes from a new caller', async () => {
    const deps = makeDeps({
      issueUploadIntent: vi.fn().mockResolvedValue({
        registered: true,
        documentId: 'document_existing',
      }),
    })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({ ok: true, documentId: 'document_existing' })
    expect(deps.fetchFn).not.toHaveBeenCalled()
    expect(deps.registerDirectUpload).not.toHaveBeenCalled()
  })

  it.each(['FILE_TOO_LARGE', 'INVALID_FILE_TYPE'] as const)(
    'returns pre-storage terminal %s without reconciliation metadata',
    async (code) => {
      const deps = makeDeps({
        issueUploadIntent: vi.fn().mockResolvedValue({ registered: false, code }),
      })

      const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

      expect(result).toEqual({ ok: false, code })
      expect(result).not.toHaveProperty('reconciliationRequired')
      expect(result).not.toHaveProperty('fileSha256')
      expect(deps.fetchFn).not.toHaveBeenCalled()
      expect(deps.registerDirectUpload).not.toHaveBeenCalled()
    }
  )

  it.each([
    'UPLOAD_INTENT_ACTIVE',
    'UPLOAD_INTENT_UNCERTAIN',
    'UPLOAD_INTENT_EXPIRED',
    'UPLOAD_INTENT_REJECTED',
    'UPLOAD_INTENT_MISMATCH',
  ] as const)(
    'blocks an independent caller on durable %s without leaking locators or posting bytes',
    async (code) => {
      const deps = makeDeps({
        issueUploadIntent: vi.fn().mockResolvedValue({ registered: false, code }),
      })

      const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

      expect(result).toEqual({
        ok: false,
        code,
        reconciliationRequired: true,
        fileSha256: FILE_SHA256,
      })
      expect(deps.fetchFn).not.toHaveBeenCalled()
      expect(deps.registerDirectUpload).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain('storage_')
    }
  )

  it('reintenta la emisión de URL tras un fallo transitorio, antes de almacenar bytes', async () => {
    const waitFn = vi.fn().mockResolvedValue(undefined)
    const issueUploadIntent = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce({
        intentId: 'intent_1',
        uploadUrl: UPLOAD_URL,
        expiresAt: Date.now() + 60_000,
      })
    const deps = makeDeps({ issueUploadIntent, waitFn })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({ ok: true, documentId: 'document_1' })
    expect(issueUploadIntent).toHaveBeenCalledTimes(2)
    expect(waitFn).toHaveBeenCalledWith(100, undefined)
    expect(deps.fetchFn).toHaveBeenCalledTimes(1)
  })

  it('jamás reintenta el POST del blob cuando la respuesta de red es incierta', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch: provider details'))
    const deps = makeDeps({ fetchFn })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({
      ok: false,
      code: 'STORAGE_UPLOAD_FAILED',
      reconciliationRequired: true,
      fileSha256: FILE_SHA256,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('provider details')
    expect(deps.registerDirectUpload).not.toHaveBeenCalled()
  })

  it('reintenta el registro con exactamente el mismo storageId y no vuelve a subir bytes', async () => {
    const waitFn = vi.fn().mockResolvedValue(undefined)
    const registerDirectUpload = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network timeout'))
      .mockResolvedValueOnce('document_1')
    const deps = makeDeps({ registerDirectUpload, waitFn })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({ ok: true, documentId: 'document_1' })
    expect(deps.fetchFn).toHaveBeenCalledTimes(1)
    expect(registerDirectUpload).toHaveBeenCalledTimes(2)
    expect(registerDirectUpload.mock.calls[0]?.[0]).toEqual(registerDirectUpload.mock.calls[1]?.[0])
    expect(registerDirectUpload.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ storageId: 'storage_1' })
    )
    expect(waitFn).toHaveBeenCalledWith(100, undefined)
  })

  it('no reintenta fallos de autorización ni expone su error crudo', async () => {
    const waitFn = vi.fn().mockResolvedValue(undefined)
    const registerDirectUpload = vi
      .fn()
      .mockRejectedValue(new Error('Forbidden: internal policy ref 99'))
    const deps = makeDeps({ registerDirectUpload, waitFn })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({
      ok: false,
      code: 'REGISTRATION_FAILED',
      reconciliationRequired: true,
      fileSha256: FILE_SHA256,
      storageCommitted: true,
    })
    expect(registerDirectUpload).toHaveBeenCalledTimes(1)
    expect(waitFn).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('internal policy')
  })

  it('marca el blob confirmado para reconciliación al agotar reintentos de registro', async () => {
    const registerDirectUpload = vi.fn().mockRejectedValue(new TypeError('network unavailable'))
    const deps = makeDeps({
      registerDirectUpload,
      waitFn: vi.fn().mockResolvedValue(undefined),
    })

    const result = await performDirectVdrUpload(deps, makeInput(makeFile()))

    expect(result).toEqual({
      ok: false,
      code: 'REGISTRATION_FAILED',
      reconciliationRequired: true,
      fileSha256: FILE_SHA256,
      storageCommitted: true,
    })
    expect(registerDirectUpload).toHaveBeenCalledTimes(3)
    expect(deps.fetchFn).toHaveBeenCalledTimes(1)
  })

  it('cancela antes de pedir URL cuando el AbortSignal ya está abortado', async () => {
    const controller = new AbortController()
    controller.abort()
    const deps = makeDeps()

    const result = await performDirectVdrUpload(deps, {
      ...makeInput(makeFile()),
      signal: controller.signal,
    })

    expect(result).toEqual({ ok: false, code: 'UPLOAD_ABORTED' })
    expect(deps.issueUploadIntent).not.toHaveBeenCalled()
    expect(deps.fetchFn).not.toHaveBeenCalled()
  })

  it('cancela de forma segura si el signal aborta después del intent pero antes del POST', async () => {
    const controller = new AbortController()
    const issueUploadIntent = vi.fn().mockImplementation(async () => {
      controller.abort()
      return {
        intentId: 'intent_1',
        uploadUrl: UPLOAD_URL,
        expiresAt: Date.now() + 60_000,
      }
    })
    const deps = makeDeps({ issueUploadIntent })

    const result = await performDirectVdrUpload(deps, {
      ...makeInput(makeFile()),
      signal: controller.signal,
    })

    expect(result).toEqual({ ok: false, code: 'UPLOAD_ABORTED' })
    expect(issueUploadIntent).toHaveBeenCalledTimes(1)
    expect(deps.abandonUploadIntent).toHaveBeenCalledWith({ intentId: 'intent_1' })
    expect(deps.fetchFn).not.toHaveBeenCalled()
    expect(deps.registerDirectUpload).not.toHaveBeenCalled()
  })

  it('fails closed when pre-byte abandon cannot be confirmed by the backend', async () => {
    const controller = new AbortController()
    const deps = makeDeps({
      issueUploadIntent: vi.fn().mockImplementation(async () => {
        controller.abort()
        return {
          intentId: 'intent_1',
          uploadUrl: UPLOAD_URL,
          expiresAt: Date.now() + 60_000,
        }
      }),
      abandonUploadIntent: vi.fn().mockResolvedValue({
        aborted: false,
        code: 'UPLOAD_INTENT_UNCERTAIN',
      }),
    })

    const result = await performDirectVdrUpload(deps, {
      ...makeInput(makeFile()),
      signal: controller.signal,
    })

    expect(result).toEqual({
      ok: false,
      code: 'UPLOAD_INTENT_UNCERTAIN',
      reconciliationRequired: true,
      fileSha256: FILE_SHA256,
    })
    expect(deps.fetchFn).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('intent_1')
  })

  it('propaga el AbortSignal al fetch y declara el outcome incierto al cancelar durante el POST', async () => {
    const controller = new AbortController()
    const fetchFn = vi.fn().mockImplementation(async (_url, init) => {
      expect(init.signal).toBe(controller.signal)
      controller.abort()
      throw new DOMException('provider aborted details', 'AbortError')
    })
    const deps = makeDeps({ fetchFn })

    const result = await performDirectVdrUpload(deps, {
      ...makeInput(makeFile()),
      signal: controller.signal,
    })

    expect(result).toEqual({
      ok: false,
      code: 'UPLOAD_ABORTED',
      reconciliationRequired: true,
      fileSha256: FILE_SHA256,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(deps.registerDirectUpload).not.toHaveBeenCalled()
  })

  it('reporta etapas y reintentos sin inventar porcentaje de bytes', async () => {
    const events: unknown[] = []
    const deps = makeDeps({
      registerDirectUpload: vi
        .fn()
        .mockRejectedValueOnce(new TypeError('network timeout'))
        .mockResolvedValueOnce('document_1'),
      waitFn: vi.fn().mockResolvedValue(undefined),
    })

    await performDirectVdrUpload(deps, {
      ...makeInput(makeFile()),
      onProgress: (progress) => events.push(progress),
    })

    expect(events).toEqual([
      { stage: 'PREPARING', attempt: 1, maxAttempts: 2 },
      { stage: 'UPLOADING', attempt: 1, maxAttempts: 1 },
      { stage: 'REGISTERING', attempt: 1, maxAttempts: 3 },
      { stage: 'REGISTERING', attempt: 2, maxAttempts: 3 },
      { stage: 'COMPLETE', attempt: 2, maxAttempts: 3 },
    ])
    expect(JSON.stringify(events)).not.toContain('percent')
  })
})

describe('performDirectVdrUpload — CSV como fuente de primera clase', () => {
  it('infiere text/csv de la extensión cuando File.type viene vacío', async () => {
    const deps = makeDeps()
    const file = makeFile(2_048, '', 'balance-comprobacion-fy24.csv')

    const result = await performDirectVdrUpload(deps, makeInput(file))

    expect(result).toEqual({ ok: true, documentId: 'document_1' })
    expect(deps.fetchFn).toHaveBeenCalledWith(
      UPLOAD_URL,
      expect.objectContaining({ headers: { 'Content-Type': 'text/csv' } })
    )
  })

  it.each(['application/vnd.ms-excel', 'application/csv', 'text/plain'])(
    'normaliza el alias %s que el navegador reporta para un .csv a text/csv',
    async (reported) => {
      const deps = makeDeps()
      const file = makeFile(2_048, reported, 'balance-comprobacion-fy24.csv')

      const result = await performDirectVdrUpload(deps, makeInput(file))

      expect(result.ok).toBe(true)
      expect(deps.fetchFn).toHaveBeenCalledWith(
        UPLOAD_URL,
        expect.objectContaining({ headers: { 'Content-Type': 'text/csv' } })
      )
    }
  )
})
