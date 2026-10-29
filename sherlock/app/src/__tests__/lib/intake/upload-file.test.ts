import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isSafeStorageUploadUrl, uploadIntakeFile } from '@/lib/intake/upload-file'
import { MAX_CSV_UPLOAD_BYTES } from '@/lib/storage/upload-limits'
import { FakeXMLHttpRequest, installFakeXhr } from '../../utils/fake-xhr'

const UPLOAD_URL = 'https://test.convex.cloud/api/storage/upload'
const DOCUMENT = {
  id: 'intake_document_1',
  displayName: 'estados.pdf',
  declaredMimeType: 'application/pdf',
  byteSize: 7,
  inspectionStatus: 'CLEAN',
  claimable: true,
  createdAt: 1_780_000_000_000,
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function pdf(name = 'estados.pdf', content = 'estados'): File {
  const file = new File([content], name, { type: 'application/pdf' })
  // Configurable: tres casos vuelven a definir `arrayBuffer` para probar que
  // no se lee cuando la señal ya venía abortada.
  Object.defineProperty(file, 'arrayBuffer', {
    value: () => Promise.resolve(new TextEncoder().encode(content).buffer),
    configurable: true,
  })
  return file
}

// El intent y el registro van por fetch; los bytes por XHR. Un fetch falso
// por ruta deja al XHR falso como la única vía para los bytes.
function fetchByRoute(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const route = routes[String(input)]
    if (!route) return Promise.reject(new TypeError(`unexpected fetch ${String(input)}`))
    return Promise.resolve(route())
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('uploadIntakeFile', () => {
  beforeEach(() => {
    installFakeXhr()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports byte progress from the XHR and registers the stored blob', async () => {
    const fetchMock = fetchByRoute({
      '/api/intake/uploads': () =>
        jsonResponse(201, { intentId: 'intent_1', uploadUrl: UPLOAD_URL }),
      '/api/intake/uploads/register': () =>
        jsonResponse(200, { registered: true, document: DOCUMENT }),
    })
    FakeXMLHttpRequest.onSend = (xhr) => {
      xhr.progress(3, 7)
      xhr.progress(7, 7)
      xhr.respond(200, { storageId: 'storage_1' })
    }
    const onProgress = vi.fn()
    const file = pdf()

    const outcome = await uploadIntakeFile(file, {
      csrfToken: 'csrf-session',
      signal: new AbortController().signal,
      onProgress,
    })

    expect(outcome).toEqual({ status: 'received', document: DOCUMENT })
    expect(onProgress.mock.calls).toEqual([
      [0, 7],
      [3, 7],
      [7, 7],
      [7, 7],
    ])
    const [xhr] = FakeXMLHttpRequest.instances
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe(UPLOAD_URL)
    expect(xhr.headers['content-type']).toBe('application/pdf')
    expect(xhr.withCredentials).toBe(false)
    expect(xhr.body).toBe(file)
    const intentCall = fetchMock.mock.calls.find(([input]) => input === '/api/intake/uploads')
    expect(intentCall?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: expect.objectContaining({ 'x-intake-csrf': 'csrf-session' }),
    })
    expect(JSON.parse(String(intentCall?.[1]?.body))).toMatchObject({
      fileName: 'estados.pdf',
      declaredMimeType: 'application/pdf',
      declaredByteSize: 7,
      declaredSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    // Un primer intento nunca pide supersedir nada.
    expect(JSON.parse(String(intentCall?.[1]?.body))).not.toHaveProperty('supersedePending')
    const registerCall = fetchMock.mock.calls.find(
      ([input]) => input === '/api/intake/uploads/register'
    )
    expect(JSON.parse(String(registerCall?.[1]?.body))).toEqual({
      intentId: 'intent_1',
      storageId: 'storage_1',
    })
  })

  it('aborts the XHR in flight and never registers when the signal fires', async () => {
    const fetchMock = fetchByRoute({
      '/api/intake/uploads': () =>
        jsonResponse(201, { intentId: 'intent_1', uploadUrl: UPLOAD_URL }),
      '/api/intake/uploads/register': () =>
        jsonResponse(200, { registered: true, document: DOCUMENT }),
    })
    const controller = new AbortController()
    FakeXMLHttpRequest.onSend = (xhr) => {
      xhr.progress(2, 7)
      controller.abort()
    }

    const outcome = await uploadIntakeFile(pdf(), {
      csrfToken: 'csrf-session',
      signal: controller.signal,
    })

    expect(outcome).toEqual({ status: 'cancelled' })
    expect(FakeXMLHttpRequest.instances[0]?.aborted).toBe(true)
    expect(fetchMock.mock.calls.some(([input]) => input === '/api/intake/uploads/register')).toBe(
      false
    )
  })

  it('asks the server to supersede a pending intent only when the caller says so', async () => {
    const fetchMock = fetchByRoute({
      '/api/intake/uploads': () => jsonResponse(200, { document: DOCUMENT }),
    })

    await uploadIntakeFile(pdf(), {
      csrfToken: 'csrf-session',
      signal: new AbortController().signal,
      supersedePending: true,
    })

    const intentCall = fetchMock.mock.calls.find(([input]) => input === '/api/intake/uploads')
    expect(JSON.parse(String(intentCall?.[1]?.body))).toMatchObject({ supersedePending: true })
  })

  // Con `storageId` en mano el intent ya puede estar INSPECTING en el servidor:
  // cancelar ahí bloqueaba el archivo media hora. El registro corre entero y
  // su resultado manda.
  it('finishes the registration and reports received when the signal fires after the bytes landed', async () => {
    const controller = new AbortController()
    const fetchMock = fetchByRoute({
      '/api/intake/uploads': () =>
        jsonResponse(201, { intentId: 'intent_1', uploadUrl: UPLOAD_URL }),
      '/api/intake/uploads/register': () => {
        controller.abort()
        return jsonResponse(200, { registered: true, document: DOCUMENT })
      },
    })
    FakeXMLHttpRequest.onSend = (xhr) => {
      xhr.progress(7, 7)
      xhr.respond(200, { storageId: 'storage_1' })
    }
    const onProgress = vi.fn()

    const outcome = await uploadIntakeFile(pdf(), {
      csrfToken: 'csrf-session',
      signal: controller.signal,
      onProgress,
    })

    expect(outcome).toEqual({ status: 'received', document: DOCUMENT })
    expect(onProgress).toHaveBeenLastCalledWith(7, 7)
    const registerCall = fetchMock.mock.calls.find(
      ([input]) => input === '/api/intake/uploads/register'
    )
    expect(registerCall?.[1]).not.toHaveProperty('signal')
  })

  it('reports register, not cancelled, when the signal fires and the registration fails three times', async () => {
    const controller = new AbortController()
    const fetchMock = fetchByRoute({
      '/api/intake/uploads': () =>
        jsonResponse(201, { intentId: 'intent_1', uploadUrl: UPLOAD_URL }),
      '/api/intake/uploads/register': () => {
        controller.abort()
        return jsonResponse(503, { error: 'unavailable' })
      },
    })
    FakeXMLHttpRequest.onSend = (xhr) => xhr.respond(200, { storageId: 'storage_1' })

    const outcome = await uploadIntakeFile(pdf(), {
      csrfToken: 'csrf-session',
      signal: controller.signal,
    })

    expect(outcome).toEqual({ status: 'failed', reason: 'register' })
    expect(
      fetchMock.mock.calls.filter(([input]) => input === '/api/intake/uploads/register')
    ).toHaveLength(3)
  })

  it('returns cancelled without hashing or fetching when the signal is already aborted', async () => {
    const fetchMock = fetchByRoute({})
    const controller = new AbortController()
    controller.abort()
    const file = pdf()
    const arrayBuffer = vi.fn()
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer })

    const outcome = await uploadIntakeFile(file, {
      csrfToken: 'csrf-session',
      signal: controller.signal,
    })

    expect(outcome).toEqual({ status: 'cancelled' })
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(FakeXMLHttpRequest.instances).toHaveLength(0)
  })

  it('retries the registration up to three times on the same storageId', async () => {
    let registrations = 0
    const fetchMock = fetchByRoute({
      '/api/intake/uploads': () =>
        jsonResponse(201, { intentId: 'intent_1', uploadUrl: UPLOAD_URL }),
      '/api/intake/uploads/register': () => {
        registrations += 1
        return registrations < 3
          ? jsonResponse(503, { error: 'unavailable' })
          : jsonResponse(200, { registered: true, document: DOCUMENT })
      },
    })
    FakeXMLHttpRequest.onSend = (xhr) => xhr.respond(200, { storageId: 'storage_1' })

    const outcome = await uploadIntakeFile(pdf(), {
      csrfToken: 'csrf-session',
      signal: new AbortController().signal,
    })

    expect(outcome).toEqual({ status: 'received', document: DOCUMENT })
    const registerBodies = fetchMock.mock.calls
      .filter(([input]) => input === '/api/intake/uploads/register')
      .map(([, init]) => JSON.parse(String(init?.body)))
    expect(registerBodies).toHaveLength(3)
    expect(new Set(registerBodies.map((body) => body.storageId))).toEqual(new Set(['storage_1']))
    expect(FakeXMLHttpRequest.instances).toHaveLength(1)
  })

  it('fails with reason register after the third failed registration', async () => {
    const fetchMock = fetchByRoute({
      '/api/intake/uploads': () =>
        jsonResponse(201, { intentId: 'intent_1', uploadUrl: UPLOAD_URL }),
      '/api/intake/uploads/register': () => jsonResponse(503, { error: 'unavailable' }),
    })
    FakeXMLHttpRequest.onSend = (xhr) => xhr.respond(200, { storageId: 'storage_1' })

    const outcome = await uploadIntakeFile(pdf(), {
      csrfToken: 'csrf-session',
      signal: new AbortController().signal,
    })

    expect(outcome).toEqual({ status: 'failed', reason: 'register' })
    expect(
      fetchMock.mock.calls.filter(([input]) => input === '/api/intake/uploads/register')
    ).toHaveLength(3)
  })

  // El `retryable` del registro cubre UNA condición: un registro que llegó al
  // servidor y no confirmó el documento. Un fallo de red del mismo POST se
  // reporta de una vez, igual que antes del `for` a mano.
  it('reporta network cuando el POST del registro tira, y no lo repite', async () => {
    let registrations = 0
    fetchByRoute({
      '/api/intake/uploads': () =>
        jsonResponse(201, { intentId: 'intent_1', uploadUrl: UPLOAD_URL }),
      '/api/intake/uploads/register': () => {
        registrations += 1
        throw new TypeError('Failed to fetch')
      },
    })
    FakeXMLHttpRequest.onSend = (xhr) => xhr.respond(200, { storageId: 'storage_1' })

    const outcome = await uploadIntakeFile(pdf(), {
      csrfToken: 'csrf-session',
      signal: new AbortController().signal,
    })

    expect(outcome).toEqual({ status: 'failed', reason: 'network' })
    expect(registrations).toBe(1)
  })

  it('treats an intent that already carries the document as received without sending bytes', async () => {
    fetchByRoute({
      '/api/intake/uploads': () => jsonResponse(200, { document: DOCUMENT }),
    })
    const onProgress = vi.fn()

    const outcome = await uploadIntakeFile(pdf(), {
      csrfToken: 'csrf-session',
      signal: new AbortController().signal,
      onProgress,
    })

    expect(outcome).toEqual({ status: 'received', document: DOCUMENT })
    expect(onProgress).toHaveBeenLastCalledWith(7, 7)
    expect(FakeXMLHttpRequest.instances).toHaveLength(0)
  })

  it('retries a 500 intent and still delivers the file', async () => {
    const intentQueue = [
      jsonResponse(500, { error: 'compile' }),
      jsonResponse(500, { error: 'compile' }),
      jsonResponse(201, { intentId: 'intent_1', uploadUrl: UPLOAD_URL }),
    ]
    const fetchMock = fetchByRoute({
      '/api/intake/uploads': () => intentQueue.shift() as Response,
      '/api/intake/uploads/register': () =>
        jsonResponse(200, { registered: true, document: DOCUMENT }),
    })
    FakeXMLHttpRequest.onSend = (xhr) => xhr.respond(200, { storageId: 'storage_1' })

    const outcome = await uploadIntakeFile(pdf(), {
      csrfToken: 'csrf-session',
      signal: new AbortController().signal,
    })

    expect(outcome).toEqual({ status: 'received', document: DOCUMENT })
    expect(intentQueue).toHaveLength(0)
    expect(fetchMock.mock.calls.filter(([input]) => input === '/api/intake/uploads')).toHaveLength(
      3
    )
  })

  it('fails with reason intent after three 500s on the intent POST', async () => {
    const fetchMock = fetchByRoute({
      '/api/intake/uploads': () => jsonResponse(500, { error: 'compile' }),
    })

    const outcome = await uploadIntakeFile(pdf(), {
      csrfToken: 'csrf-session',
      signal: new AbortController().signal,
    })

    expect(outcome).toEqual({ status: 'failed', reason: 'intent' })
    expect(fetchMock.mock.calls.filter(([input]) => input === '/api/intake/uploads')).toHaveLength(
      3
    )
    expect(FakeXMLHttpRequest.instances).toHaveLength(0)
  })

  it.each([
    ['rejected intent', () => jsonResponse(503, { error: 'unavailable' })],
    ['intent without intentId', () => jsonResponse(201, { uploadUrl: UPLOAD_URL })],
    [
      'upload URL outside Convex storage',
      () => jsonResponse(201, { intentId: 'intent_1', uploadUrl: 'https://storage.example/x' }),
    ],
  ])('fails with reason intent on %s and never opens an XHR', async (_label, intent) => {
    fetchByRoute({ '/api/intake/uploads': intent })

    const outcome = await uploadIntakeFile(pdf(), {
      csrfToken: 'csrf-session',
      signal: new AbortController().signal,
    })

    expect(outcome).toEqual({ status: 'failed', reason: 'intent' })
    expect(FakeXMLHttpRequest.instances).toHaveLength(0)
  })

  it('fails with reason bytes when the storage answers without a storageId', async () => {
    const fetchMock = fetchByRoute({
      '/api/intake/uploads': () =>
        jsonResponse(201, { intentId: 'intent_1', uploadUrl: UPLOAD_URL }),
    })
    FakeXMLHttpRequest.onSend = (xhr) => xhr.respond(500, { error: 'storage down' })

    const outcome = await uploadIntakeFile(pdf(), {
      csrfToken: 'csrf-session',
      signal: new AbortController().signal,
    })

    expect(outcome).toEqual({ status: 'failed', reason: 'bytes' })
    expect(fetchMock.mock.calls.some(([input]) => input === '/api/intake/uploads/register')).toBe(
      false
    )
  })

  it('fails with reason network when the XHR errors out', async () => {
    fetchByRoute({
      '/api/intake/uploads': () =>
        jsonResponse(201, { intentId: 'intent_1', uploadUrl: UPLOAD_URL }),
    })
    FakeXMLHttpRequest.onSend = (xhr) => xhr.fail()

    const outcome = await uploadIntakeFile(pdf(), {
      csrfToken: 'csrf-session',
      signal: new AbortController().signal,
    })

    expect(outcome).toEqual({ status: 'failed', reason: 'network' })
  })

  it('fails with reason network when the intent fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
    )

    const outcome = await uploadIntakeFile(pdf(), {
      csrfToken: 'csrf-session',
      signal: new AbortController().signal,
    })

    expect(outcome).toEqual({ status: 'failed', reason: 'network' })
  })

  it('rejects an unsupported type before hashing or any request', async () => {
    const fetchMock = fetchByRoute({})
    const file = new File(['png'], 'captura.png', { type: 'image/png' })
    const arrayBuffer = vi.fn()
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer })

    const outcome = await uploadIntakeFile(file, {
      csrfToken: 'csrf-session',
      signal: new AbortController().signal,
    })

    expect(outcome).toEqual({ status: 'failed', reason: 'type' })
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a CSV above its per-format ceiling before hashing or any request', async () => {
    const fetchMock = fetchByRoute({})
    const file = new File(['balance'], 'balance.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'size', { value: MAX_CSV_UPLOAD_BYTES + 1 })
    const arrayBuffer = vi.fn()
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer })

    const outcome = await uploadIntakeFile(file, {
      csrfToken: 'csrf-session',
      signal: new AbortController().signal,
    })

    expect(outcome).toEqual({ status: 'failed', reason: 'size' })
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts the http upload URL of a local Convex outside production, like the API does', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210')
    vi.stubEnv('NODE_ENV', 'test')
    try {
      fetchByRoute({
        '/api/intake/uploads': () =>
          jsonResponse(201, {
            intentId: 'intent_local',
            uploadUrl: 'http://127.0.0.1:3210/api/storage/upload',
          }),
        '/api/intake/uploads/register': () =>
          jsonResponse(200, { registered: true, document: DOCUMENT }),
      })
      FakeXMLHttpRequest.onSend = (xhr) => xhr.respond(200, { storageId: 'storage_local' })

      const outcome = await uploadIntakeFile(pdf(), {
        csrfToken: 'csrf-session',
        signal: new AbortController().signal,
      })

      expect(outcome).toEqual({ status: 'received', document: DOCUMENT })
      expect(FakeXMLHttpRequest.instances[0]?.url).toBe('http://127.0.0.1:3210/api/storage/upload')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

// Misma regla que `validUploadUrl` en `/api/intake/uploads`: el origin de
// `NEXT_PUBLIC_CONVEX_URL` (https, o http fuera de producción) o un
// `*.convex.cloud` / `*.convex.site` en https; nunca credenciales ni fragmento.
describe('isSafeStorageUploadUrl', () => {
  const local = { NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210', NODE_ENV: 'development' }
  const cloud = {
    NEXT_PUBLIC_CONVEX_URL: 'https://brainy-emu-822.convex.cloud',
    NODE_ENV: 'production',
  }

  it.each([
    [
      'configured http origin outside production',
      'http://127.0.0.1:3210/api/storage/upload',
      local,
    ],
    [
      'configured https origin in production',
      'https://brainy-emu-822.convex.cloud/api/storage/upload',
      cloud,
    ],
    [
      'another Convex cloud host over https',
      'https://other-deployment.convex.cloud/api/storage/upload',
      cloud,
    ],
    [
      'a Convex site host over https',
      'https://other-deployment.convex.site/api/storage/upload',
      cloud,
    ],
    [
      'a Convex cloud host when no origin is configured',
      'https://test.convex.cloud/api/storage/upload',
      {},
    ],
  ])('accepts %s', (_label, url, env) => {
    expect(isSafeStorageUploadUrl(url, env)).toBe(true)
  })

  it.each([
    [
      'the configured http origin in production',
      'http://127.0.0.1:3210/api/storage/upload',
      { ...local, NODE_ENV: 'production' },
    ],
    ['a different port on the configured host', 'http://127.0.0.1:3211/api/storage/upload', local],
    ['an http Convex cloud host', 'http://other-deployment.convex.cloud/api/storage/upload', cloud],
    ['a host outside Convex', 'https://storage.example/upload', cloud],
    ['a look-alike host', 'https://convex.cloud.example/upload', cloud],
    [
      'embedded credentials on the configured origin',
      'https://user:fixture-a2e332fa@example.com/upload',
      cloud,
    ],
    ['a fragment on the configured origin', 'https://brainy-emu-822.convex.cloud/upload#x', cloud],
    ['an unparsable value', 'not a url', cloud],
    ['a non-string', 42, cloud],
  ])('rejects %s', (_label, url, env) => {
    expect(isSafeStorageUploadUrl(url, env)).toBe(false)
  })

  it('reads NEXT_PUBLIC_CONVEX_URL and NODE_ENV from process.env by default', () => {
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210')
    vi.stubEnv('NODE_ENV', 'test')
    try {
      expect(isSafeStorageUploadUrl('http://127.0.0.1:3210/api/storage/upload')).toBe(true)
      expect(isSafeStorageUploadUrl('http://localhost:3210/api/storage/upload')).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
