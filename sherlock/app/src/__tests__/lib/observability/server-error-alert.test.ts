// ============================================================================
// ALERTA DE 5xx — redacción del payload y no-bloqueo del camino de respuesta
// ============================================================================
// Tres contratos: (1) del proceso sólo sale plantilla de ruta, método, status,
// nombre del error y 120 caracteres de mensaje — nada de ids, correos, tokens
// ni query strings; (2) nada que venga del cliente puede CANCELAR el aviso;
// (3) `reportServerErrorToTeam` devuelve void, nunca tira, y sólo agenda en
// producción de verdad y con el canal Convex configurado.
//
// Todo el entorno se fija con `vi.stubEnv` en cada test. Bun inyecta
// `.env.local` en `process.env` cuando la suite corre en local, así que un test
// que dependa del entorno heredado pasa en la máquina y falla en el runner.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SERVER_ERROR_ALERT_MAX_MESSAGE_LENGTH,
  SERVER_ERROR_ALERT_WINDOW_MS,
  scrubAlertMessage,
} from '@/../convex/_notifications/serverErrorAlertRedaction'

const afterMock = vi.fn((task: () => Promise<unknown>) => {
  void task
})

vi.mock('next/server', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('next/server')
  return { ...actual, after: (task: () => Promise<unknown>) => afterMock(task) }
})

async function load() {
  return await import('@/lib/observability/server-error-alert')
}

/** Producción de verdad: los dos gates encendidos y el canal configurado. */
function stubProductionLane() {
  vi.stubEnv('VERCEL_ENV', 'production')
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://example.convex.cloud')
  vi.stubEnv('CONVEX_DEPLOY_KEY', 'prod:example|deadbeef')
}

describe('buildServerErrorAlertPayload — redacción', () => {
  beforeEach(() => {
    vi.resetModules()
    afterMock.mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('deja intacta una plantilla de ruta de Next', async () => {
    const { buildServerErrorAlertPayload } = await load()

    const payload = buildServerErrorAlertPayload({
      error: new TypeError('boom'),
      requestId: 'request-1',
      status: 500,
      route: '/[locale]/vdr/[dealId]',
      method: 'get',
    })

    expect(payload).toMatchObject({
      route: '/[locale]/vdr/[dealId]',
      errorName: 'TypeError',
      status: 500,
      message: 'boom',
      requestId: 'request-1',
      method: 'GET',
      synthetic: false,
    })
  })

  it('tacha los segmentos que parecen identificadores de un path real', async () => {
    const { buildServerErrorAlertPayload, SERVER_ERROR_ALERT_REDACTED_SEGMENT } = await load()

    const payload = buildServerErrorAlertPayload({
      error: new Error('x'),
      requestId: 'request-2',
      status: 500,
      route: '/es/vdr/jd7f2k9a1b3c4d5e6f7g8h9j0k/documents/1234567',
    })

    expect(payload?.route).toBe(
      `/es/vdr/${SERVER_ERROR_ALERT_REDACTED_SEGMENT}/documents/${SERVER_ERROR_ALERT_REDACTED_SEGMENT}`
    )
    expect(payload?.route).not.toContain('jd7f2k9a1b3c4d5e6f7g8h9j0k')
  })

  it('descarta query string, fragmento y rutas que no empiezan en /', async () => {
    const { buildServerErrorAlertPayload, SERVER_ERROR_ALERT_UNKNOWN_ROUTE } = await load()

    const withQuery = buildServerErrorAlertPayload({
      error: new Error('x'),
      requestId: 'r',
      status: 500,
      route: '/api/vdr/export?email=privado@example.com#token',
    })
    expect(withQuery?.route).toBe('/api/vdr/export')

    const bogus = buildServerErrorAlertPayload({
      error: new Error('x'),
      requestId: 'r',
      status: 500,
      route: 'https://www.sherlock.capital/es/vdr',
    })
    expect(bogus?.route).toBe(SERVER_ERROR_ALERT_UNKNOWN_ROUTE)
  })

  it('tacha correos y tokens largos del mensaje', async () => {
    const { buildServerErrorAlertPayload } = await load()

    const message = `no se pudo notificar a fixture-83534f34@example.com con el token ${'a1b2c3d4'.repeat(6)} ${'x'.repeat(400)}`
    const payload = buildServerErrorAlertPayload({
      error: new Error(message),
      requestId: 'r',
      status: 500,
      route: '/api/x',
    })

    expect(payload?.message).not.toContain('fixture-83534f34@example.com')
    expect(payload?.message).not.toContain('a1b2c3d4a1b2c3d4')
    expect(payload?.message).toContain('[correo]')
    expect(payload?.message).toContain('[token]')
    expect(payload?.message.length).toBeLessThanOrEqual(SERVER_ERROR_ALERT_MAX_MESSAGE_LENGTH)
  })

  // PII. Un mensaje de error es texto libre: puede traer el nombre del dueño de
  // la sala, su cédula y su teléfono porque alguien interpoló datos del request
  // al construirlo. No hay detector fiable de nombres propios, así que la
  // defensa es ACOTAR: identificadores tachados, 120 caracteres y una huella
  // para correlacionar con PostHog, que es donde vive el mensaje entero.
  it('tacha cédula panameña, teléfono y corridas de dígitos del mensaje', async () => {
    const { buildServerErrorAlertPayload } = await load()

    const payload = buildServerErrorAlertPayload({
      error: new Error(
        'no hay sala para Ana Robles, cédula 8-123-456, PE-12-345, tel 6123-4567, RUC 1550821-1-704893'
      ),
      requestId: 'r',
      status: 500,
      route: '/api/vdr/export',
    })

    expect(payload?.message).not.toContain('8-123-456')
    expect(payload?.message).not.toContain('PE-12-345')
    expect(payload?.message).not.toContain('6123-4567')
    expect(payload?.message).not.toContain('1550821')
  })

  // La cédula panameña tiene más formas que `8-123-456`: el panameño nacido en
  // el exterior y el extranjero residente llevan prefijo de letras
  // (`PE-`, `E-`, `N-`) y el naturalizado las lleva EN MEDIO (`8-NT-1-123`).
  // Acotar el grupo del medio a cuatro dígitos dejaba pasar `E-8-12345` entero.
  it.each([
    ['8-123-4567', 'natural con serie larga'],
    ['PE-12-3456', 'panameño nacido en el exterior'],
    ['E-8-12345', 'extranjero residente'],
    ['N-19-1234', 'naturalizado con prefijo'],
    ['8-NT-1-123', 'naturalizado con letras en medio'],
    ['8-AV-1-234', 'con infijo AV'],
  ])('tacha la cédula %s (%s) entera', async (cedula) => {
    const { buildServerErrorAlertPayload } = await load()

    const payload = buildServerErrorAlertPayload({
      error: new Error(`no hay perfil para la cédula ${cedula}`),
      requestId: 'r',
      status: 500,
      route: '/api/x',
    })

    expect(payload?.message).toBe('no hay perfil para la cédula [dato]')
  })

  // Un nombre suelto no tiene patrón, pero el CAMPO que lo lleva sí. Se taja el
  // valor y se conserva la etiqueta: `nombre` sigue diciendo qué se rompió.
  it.each([
    ['nombre: Ana Robles', 'nombre: [dato]'],
    ['signatoryName="Ana Robles"', 'signatoryName: [dato]'],
    ["contacto='Ana Robles'", 'contacto: [dato]'],
    ['titular: Ana Robles', 'titular: [dato]'],
  ])('tacha el valor de %s sin perder la etiqueta', async (input, expected) => {
    const { buildServerErrorAlertPayload } = await load()

    const payload = buildServerErrorAlertPayload({
      error: new Error(input),
      requestId: 'r',
      status: 500,
      route: '/api/x',
    })

    expect(payload?.message).toBe(expected)
  })

  // Un error construido con `JSON.stringify` trae la clave ENTRE COMILLAS, que
  // es como de verdad sale un payload al mensaje. Sin eso, la cédula salía
  // tachada y el nombre del firmante viajaba entero al correo del equipo.
  it('tacha el valor aunque la clave venga entre comillas de JSON', async () => {
    const { buildServerErrorAlertPayload } = await load()

    const payload = buildServerErrorAlertPayload({
      error: new Error(JSON.stringify({ signatoryName: 'Ana Robles', cedula: '8-123-4567' })),
      requestId: 'r',
      status: 500,
      route: '/api/x',
    })

    expect(payload?.message).not.toContain('Ana Robles')
    expect(payload?.message).not.toContain('8-123-4567')
    expect(payload?.message).toContain('signatoryName: [dato]')
  })

  // Valores de persona de 150 y 250 caracteres exactos: el primero cabe en el
  // tope del patrón (200) y el segundo lo desborda a propósito.
  const NAME_VALUE_150 = 'Ana Robles '.repeat(14).slice(0, 150)
  const NAME_VALUE_250 = 'Ana Robles '.repeat(23).slice(0, 250)

  // El mismo texto se taja DOS veces: el proceso antes de mandarlo y Convex
  // antes de persistirlo y de encolar el correo. Si el segundo pase no devuelve
  // exactamente lo mismo, el marcador se deforma (`[dato]]`, `[dato]]]`) y la
  // huella del lado app deja de casar con la del lado Convex.
  it.each([
    'nombre: Ana Robles',
    'signatoryName="Ana Robles"',
    "contacto='Ana Robles'",
    '{"signatoryName":"Ana Robles","cedula":"8-123-4567"}',
    'no hay sala para Ana Robles, cédula 8-123-4567, tel 6123-4567, fixture-bf0661a0@example.com',
    `usuario: fixture-bf0661a0@example.com con el token ${'a1b2c3d4'.repeat(6)}`,
    'filename: reporte.pdf',
    // 150 caracteres de valor entrecomillado: cabe entero en el tope del
    // patrón, así que la primera pasada lo taja completo.
    `signatoryName="${NAME_VALUE_150}"`,
    // 250 no cabe: la primera pasada deja cola sin tachar y es la segunda la
    // que la absorbe. Sin buscar el punto fijo, el texto seguía moviéndose y
    // la huella del lado app dejaba de casar con la de Convex.
    `nombre: ${NAME_VALUE_250}`,
  ])('tajar dos veces %s deja el mismo texto', (message) => {
    const unaVez = scrubAlertMessage(message)

    expect(scrubAlertMessage(unaVez)).toBe(unaVez)
  })

  // Sobre-tachar el diagnóstico sería cambiar una fuga por una alerta inútil:
  // lo que no es dato de persona tiene que sobrevivir intacto.
  it.each([
    'filename: reporte.pdf',
    'errorName: TypeError',
    'ConvexError: sala no encontrada',
    'content-type invalido: application/pdf',
  ])('deja intacto %s', async (input) => {
    const { buildServerErrorAlertPayload } = await load()

    const payload = buildServerErrorAlertPayload({
      error: new Error(input),
      requestId: 'r',
      status: 500,
      route: '/api/x',
    })

    expect(payload?.message).toBe(input)
  })

  it('corta el mensaje en 120 caracteres', async () => {
    const { buildServerErrorAlertPayload } = await load()

    expect(SERVER_ERROR_ALERT_MAX_MESSAGE_LENGTH).toBe(120)
    const payload = buildServerErrorAlertPayload({
      error: new Error('y'.repeat(400)),
      requestId: 'r',
      status: 500,
      route: '/api/x',
    })

    expect(payload?.message.length).toBeLessThanOrEqual(120)
  })

  // La huella se calcula sobre el mensaje YA tachado: dos 5xx con el mismo
  // texto comparten huella aunque el corte los deje iguales, y nadie puede
  // invertirla para recuperar la cédula que ya no está.
  it('lleva una huella estable del mensaje tachado', async () => {
    const { buildServerErrorAlertPayload } = await load()

    const of = (message: string) =>
      buildServerErrorAlertPayload({
        error: new Error(message),
        requestId: 'r',
        status: 500,
        route: '/api/x',
      })?.digest

    expect(of('boom')).toMatch(/^[0-9a-f]{8}$/)
    expect(of('boom')).toBe(of('boom'))
    expect(of('boom')).not.toBe(of('otra cosa'))
    expect(of('cédula 8-123-456')).toBe(of('cédula 9-999-999'))
  })

  it('no lleva stack, headers ni cookies aunque el error los traiga', async () => {
    const { buildServerErrorAlertPayload } = await load()

    const error = new Error('fallo')
    error.stack = 'Error: fallo\n    at handler (/app/src/app/api/x/route.ts:1:1)'
    const payload = buildServerErrorAlertPayload({
      error,
      requestId: 'r',
      status: 500,
      route: '/api/x',
    })

    expect(Object.keys(payload ?? {}).sort()).toEqual([
      'digest',
      'errorName',
      'message',
      'requestId',
      'route',
      'status',
      'synthetic',
    ])
  })

  it('no avisa por un 4xx', async () => {
    const { buildServerErrorAlertPayload } = await load()

    expect(
      buildServerErrorAlertPayload({ error: new Error('x'), requestId: 'r', status: 403 })
    ).toBeNull()
  })

  // Un `x-request-id` del cliente que se queda en nada al sanitizar no puede
  // apagar la alarma: sería un interruptor remoto para silenciar los 5xx.
  it.each(['@', '   ', '///', '\u{1F600}'])(
    'genera un requestId propio cuando el cliente manda %j y no cancela el aviso',
    async (clientRequestId) => {
      const { buildServerErrorAlertPayload } = await load()

      const payload = buildServerErrorAlertPayload({
        error: new Error('boom'),
        requestId: clientRequestId,
        status: 500,
        route: '/api/x',
      })

      expect(payload).not.toBeNull()
      expect(payload?.requestId).toMatch(/^alert-\d+-[a-z0-9]+$/)
      expect(payload?.message).toBe('boom')
    }
  )

  it('un requestId vacío tampoco cancela el aviso', async () => {
    const { buildServerErrorAlertPayload } = await load()

    const payload = buildServerErrorAlertPayload({
      error: new Error('x'),
      requestId: '',
      status: 500,
    })

    expect(payload).not.toBeNull()
    expect(payload?.requestId).toMatch(/^alert-/)
  })

  // ==========================================================================
  // LAS COTAS DE LA REDACCIÓN SON EL SCHEMA DEL PAYLOAD
  // ==========================================================================
  // La regla 3 del encabezado del módulo («nunca viaja el request») era una
  // promesa que firmaba esta función y que nada verificaba. Ahora las cotas
  // —200 de ruta, 64 del nombre, 120 del mensaje, el patrón del requestId, el
  // rango 5xx— son `Schema.check` y el payload se construye con `make`: una
  // redacción que deje pasar algo más largo o con otra forma se cae acá, no en
  // el correo del equipo.
  it('mantiene las cotas del payload con una ruta, un nombre y un requestId hostiles', async () => {
    const { buildServerErrorAlertPayload } = await load()

    const hostile = new Error('x'.repeat(5_000))
    hostile.name = 'Tipo raro <con espacios> y ñ'.repeat(10)

    const payload = buildServerErrorAlertPayload({
      error: hostile,
      requestId: `  ${'ñ'.repeat(400)}peticion`,
      status: 503,
      route: `/es/${'segmento/'.repeat(400)}?token=secreto`,
      method: 'delete',
    })

    expect(payload).toMatchObject({ status: 503, method: 'DELETE', synthetic: false })
    expect(payload?.route.length).toBeLessThanOrEqual(200)
    expect(payload?.route.startsWith('/')).toBe(true)
    expect(payload?.errorName).toMatch(/^[A-Za-z0-9_.$-]{1,64}$/)
    expect(payload?.message.length).toBeLessThanOrEqual(120)
    expect(payload?.requestId).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/)
  })

  it('una ruta que no empieza en / sale como la ruta desconocida, no como texto libre', async () => {
    const { buildServerErrorAlertPayload, SERVER_ERROR_ALERT_UNKNOWN_ROUTE } = await load()

    const payload = buildServerErrorAlertPayload({
      error: new Error('x'),
      requestId: 'r',
      status: 500,
      route: 'https://sherlock.capital/es/vdr/sampleenergy',
    })

    expect(payload?.route).toBe(SERVER_ERROR_ALERT_UNKNOWN_ROUTE)
  })

  it('marca el probe sintético y acepta un método válido nada más', async () => {
    const { buildServerErrorAlertPayload } = await load()

    const probe = buildServerErrorAlertPayload({
      error: new Error('x'),
      requestId: 'r',
      status: 500,
      route: '/api/observability/probe',
      method: 'POST',
      synthetic: true,
    })
    expect(probe?.synthetic).toBe(true)
    expect(probe?.method).toBe('POST')

    const bogusMethod = buildServerErrorAlertPayload({
      error: new Error('x'),
      requestId: 'r',
      status: 500,
      method: 'GET /es/vdr/abc',
    })
    expect(bogusMethod?.method).toBeUndefined()
  })
})

describe('reportServerErrorToTeam — nunca bloquea ni tira', () => {
  beforeEach(() => {
    vi.resetModules()
    afterMock.mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.doUnmock('@/lib/convex/admin-client')
  })

  it('agenda el trabajo con after() y devuelve void de inmediato en producción', async () => {
    stubProductionLane()
    const { reportServerErrorToTeam } = await load()

    const returned = reportServerErrorToTeam({
      error: new Error('x'),
      requestId: 'r',
      status: 500,
      route: '/api/x',
    })

    expect(returned).toBeUndefined()
    expect(afterMock).toHaveBeenCalledOnce()
  })

  // El gate de producción: un 500 de preview, de `next dev` o de la suite no
  // puede escribir en Convex ni mandarle correo a los ADMIN de verdad.
  it.each([
    ['preview de Vercel', { VERCEL_ENV: 'preview', NODE_ENV: 'production' }],
    ['un servidor local', { VERCEL_ENV: '', NODE_ENV: 'production' }],
    ['next dev en el deployment de prod', { VERCEL_ENV: 'production', NODE_ENV: 'development' }],
    ['la suite de tests', { VERCEL_ENV: 'production', NODE_ENV: 'test' }],
  ])('no agenda nada desde %s aunque el canal esté configurado', async (_label, overrides) => {
    stubProductionLane()
    for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value)
    const { reportServerErrorToTeam } = await load()

    expect(
      reportServerErrorToTeam({ error: new Error('x'), requestId: 'r', status: 500 })
    ).toBeUndefined()
    expect(afterMock).not.toHaveBeenCalled()
  })

  it.each([
    ['sin NEXT_PUBLIC_CONVEX_URL', { NEXT_PUBLIC_CONVEX_URL: '' }],
    ['sin CONVEX_DEPLOY_KEY', { CONVEX_DEPLOY_KEY: '' }],
  ])('no agenda nada %s', async (_label, overrides) => {
    stubProductionLane()
    for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value)
    const { reportServerErrorToTeam } = await load()

    expect(
      reportServerErrorToTeam({ error: new Error('x'), requestId: 'r', status: 500 })
    ).toBeUndefined()
    expect(afterMock).not.toHaveBeenCalled()
  })

  it('se traga el fallo de after() sin propagarlo al camino de la respuesta', async () => {
    stubProductionLane()
    // Fuera de una request el fallback corre la tarea como promesa flotante: el
    // cliente admin se anula y se espera a que la tarea lo consulte, para que no
    // quede nada pendiente cuando el test siguiente resetee los módulos.
    const getConvexAdminClient = vi.fn(() => null)
    vi.doMock('@/lib/convex/admin-client', () => ({ getConvexAdminClient }))
    afterMock.mockImplementationOnce(() => {
      throw new Error('after() was called outside a request scope')
    })
    const { reportServerErrorToTeam } = await load()

    expect(() =>
      reportServerErrorToTeam({ error: new Error('x'), requestId: 'r', status: 500 })
    ).not.toThrow()

    await vi.waitFor(() => expect(getConvexAdminClient).toHaveBeenCalled())
  })
})

describe('deliverServerErrorAlert', () => {
  beforeEach(() => {
    vi.resetModules()
    // El cliente admin va mockeado, pero el entorno se fija igual: así el test
    // no depende de lo que Bun inyecte desde `.env.local` en local.
    stubProductionLane()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.doUnmock('@/lib/convex/admin-client')
  })

  it('manda el payload redactado a la mutación interna de Convex', async () => {
    const mutation = vi.fn().mockResolvedValue(null)
    vi.doMock('@/lib/convex/admin-client', () => ({
      getConvexAdminClient: () => ({ mutation, query: vi.fn(), setAdminAuth: vi.fn() }),
    }))
    const { deliverServerErrorAlert } = await load()

    await expect(
      deliverServerErrorAlert({
        route: '/api/x',
        errorName: 'TypeError',
        status: 500,
        message: 'boom',
        digest: 'a3f9c1d2',
        requestId: 'request-9',
        method: 'POST',
        synthetic: false,
        repeats: 1,
      })
    ).resolves.toBe(true)

    expect(mutation).toHaveBeenCalledOnce()
    expect(mutation.mock.calls[0]?.[1]).toEqual({
      route: '/api/x',
      errorName: 'TypeError',
      status: 500,
      message: 'boom',
      digest: 'a3f9c1d2',
      requestId: 'request-9',
      method: 'POST',
      synthetic: false,
      repeats: 1,
    })
  })

  it('devuelve false sin tirar cuando no hay cliente admin', async () => {
    vi.doMock('@/lib/convex/admin-client', () => ({ getConvexAdminClient: () => null }))
    const { deliverServerErrorAlert } = await load()

    await expect(
      deliverServerErrorAlert({
        route: '/api/x',
        errorName: 'Error',
        status: 500,
        message: 'x',
        digest: 'a3f9c1d2',
        requestId: 'r',
        synthetic: false,
        repeats: 1,
      })
    ).resolves.toBe(false)
  })

  it('devuelve false sin tirar cuando Convex rechaza la mutación', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.doMock('@/lib/convex/admin-client', () => ({
      getConvexAdminClient: () => ({
        mutation: vi.fn().mockRejectedValue(new Error('permission denied for deployment xyz')),
        query: vi.fn(),
        setAdminAuth: vi.fn(),
      }),
    }))
    const { deliverServerErrorAlert } = await load()

    await expect(
      deliverServerErrorAlert({
        route: '/api/x',
        errorName: 'Error',
        status: 500,
        message: 'x',
        digest: 'a3f9c1d2',
        requestId: 'r',
        synthetic: false,
        repeats: 1,
      })
    ).resolves.toBe(false)

    // Sólo el nombre del error: el mensaje de Convex puede nombrar el deployment.
    expect(warn.mock.calls[0]?.[1]).toBe('Error')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('deployment xyz')
    warn.mockRestore()
  })
})

// ============================================================================
// LA VENTANA CORTA LAS ESCRITURAS, NO SÓLO EL CORREO
// ============================================================================
// El dedupe de Convex ya evitaba el segundo correo, pero cada 5xx seguía
// costando una mutación con deploy key. Un 5xx público y barato (un cuerpo
// malformado que revienta un handler) llega miles de veces por minuto: la
// ventana tiene que cortarse en el proceso, antes del round trip.
// ============================================================================
describe('reportServerErrorToTeam — la ventana corta las escrituras', () => {
  const NOW = Date.UTC(2026, 8, 3, 12, 0, 0)
  const mutation = vi.fn().mockResolvedValue(null)

  async function loadWithConvex() {
    vi.doMock('@/lib/convex/admin-client', () => ({
      getConvexAdminClient: () => ({ mutation, query: vi.fn(), setAdminAuth: vi.fn() }),
    }))
    return await load()
  }

  async function drainScheduled(): Promise<void> {
    for (const [task] of afterMock.mock.calls) await task()
  }

  beforeEach(() => {
    vi.resetModules()
    afterMock.mockClear()
    mutation.mockClear()
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    stubProductionLane()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.doUnmock('@/lib/convex/admin-client')
  })

  it('cincuenta 5xx de la misma llave dentro de la ventana escriben una sola vez', async () => {
    const { reportServerErrorToTeam } = await loadWithConvex()

    for (let index = 0; index < 50; index += 1) {
      vi.setSystemTime(NOW + index * 1_000)
      reportServerErrorToTeam({
        error: new TypeError('boom'),
        requestId: `request-${index}`,
        status: 500,
        route: '/api/intake/claim',
      })
    }
    await drainScheduled()

    expect(afterMock).toHaveBeenCalledOnce()
    expect(mutation).toHaveBeenCalledOnce()
    expect(mutation.mock.calls[0]?.[1]).toMatchObject({ requestId: 'request-0', repeats: 1 })
  })

  it('la primera entrega de la ventana siguiente arrastra lo que se silenció', async () => {
    const { reportServerErrorToTeam } = await loadWithConvex()
    const input = {
      error: new TypeError('boom'),
      status: 500,
      route: '/api/intake/claim',
    }

    for (let index = 0; index < 4; index += 1) {
      vi.setSystemTime(NOW + index * 1_000)
      reportServerErrorToTeam({ ...input, requestId: `request-${index}` })
    }
    vi.setSystemTime(NOW + SERVER_ERROR_ALERT_WINDOW_MS)
    reportServerErrorToTeam({ ...input, requestId: 'request-nueva-ventana' })
    await drainScheduled()

    expect(mutation).toHaveBeenCalledTimes(2)
    expect(mutation.mock.calls[1]?.[1]).toMatchObject({
      requestId: 'request-nueva-ventana',
      repeats: 4,
    })
  })

  it('dos llaves distintas son dos incidentes y las dos escriben', async () => {
    const { reportServerErrorToTeam } = await loadWithConvex()

    reportServerErrorToTeam({
      error: new TypeError('boom'),
      requestId: 'r-1',
      status: 500,
      route: '/api/intake/claim',
    })
    reportServerErrorToTeam({
      error: new RangeError('boom'),
      requestId: 'r-2',
      status: 500,
      route: '/api/intake/claim',
    })
    reportServerErrorToTeam({
      error: new TypeError('boom'),
      requestId: 'r-3',
      status: 500,
      route: '/api/vdr/export',
    })
    await drainScheduled()

    expect(mutation).toHaveBeenCalledTimes(3)
  })

  // El probe es una acción de operador: dispararlo dos veces seguidas tiene que
  // dejar sus dos filas de auditoría, aunque el correo lo agrupe Convex.
  it('nunca silencia el probe sintético', async () => {
    const { reportServerErrorToTeam } = await loadWithConvex()

    for (let index = 0; index < 3; index += 1) {
      vi.setSystemTime(NOW + index * 1_000)
      reportServerErrorToTeam({
        error: new Error('probe'),
        requestId: `probe-${index}`,
        status: 500,
        route: '/api/observability/probe',
        synthetic: true,
      })
    }
    await drainScheduled()

    expect(mutation).toHaveBeenCalledTimes(3)
  })
})
