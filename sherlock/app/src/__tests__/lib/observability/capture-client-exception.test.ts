// ============================================================================
// EXCEPCIONES DEL CLIENTE ANTES DE QUE EL SDK EXISTA
// ============================================================================
// La pantalla de error es lo primero que puede pasar y el SDK de PostHog es lo
// último que se carga (init tras `load` + idle, PR #507). Entre esos dos
// instantes está la ventana donde un error de hidratación de la landing se
// perdía: `captureClientException` importaba el SDK, veía `__loaded === false`
// y devolvía sin reportar nada. La cola es lo que cierra la ventana, y el sink
// lo registra el provider cuando termina el `init` — este módulo NUNCA importa
// `posthog-js`, porque hacerlo bajaría 70 KiB en medio del LCP para nada.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdkLoads = vi.hoisted(() => ({ count: 0 }))

// El contador va en un getter del namespace, no en la fabrica: vitest memoiza
// la fabrica por archivo, asi que contar invocaciones no detectaria un import
// posterior. Cualquier consumidor real destructura `default`, y eso si se ve.
vi.mock('posthog-js', () => ({
  get default() {
    sdkLoads.count += 1
    return { __loaded: false, captureException: vi.fn() }
  },
}))

async function freshModule() {
  vi.resetModules()
  return import('@/lib/observability/capture-client-exception')
}

// Un `import()` dinamico no resuelve en un solo microtask: sin este drenaje el
// contador de cargas del SDK se lee antes de que la fabrica del mock corra y la
// asercion pasa aunque el modulo SI haya importado `posthog-js`.
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function makeSink() {
  return { captureException: vi.fn() }
}

describe('captureClientException', () => {
  beforeEach(() => {
    sdkLoads.count = 0
    window.history.replaceState({}, '', '/es/')
  })

  afterEach(() => {
    vi.clearAllMocks()
    window.history.replaceState({}, '', '/')
  })

  it('entrega despues del init una excepcion capturada antes', async () => {
    const { captureClientException, registerExceptionSink } = await freshModule()
    const error = new Error('hydration blew up')

    captureClientException(error, 'abc123')
    await Promise.resolve()

    const sink = makeSink()
    registerExceptionSink(sink)
    await Promise.resolve()

    expect(sink.captureException).toHaveBeenCalledTimes(1)
    expect(sink.captureException).toHaveBeenCalledWith(error, {
      digest: 'abc123',
      locale: 'es',
      route: '/es/',
    })
  })

  it('nunca carga el sdk: ni al capturar sin sink ni al vaciar la cola', async () => {
    const { captureClientException, registerExceptionSink } = await freshModule()

    captureClientException(new Error('boom'))
    await settle()
    expect(sdkLoads.count).toBe(0)

    registerExceptionSink(makeSink())
    await settle()
    expect(sdkLoads.count).toBe(0)
    // El pin duro de esto es de codigo fuente y vive en
    // `architecture/landing-first-paint-contract.test.tsx`: aca solo se
    // comprueba que ningun camino de ejecucion toque el SDK.
  })

  it('con el sink ya registrado reporta de una', async () => {
    const { captureClientException, registerExceptionSink } = await freshModule()
    const sink = makeSink()
    registerExceptionSink(sink)

    const error = new Error('late boom')
    captureClientException(error)

    expect(sink.captureException).toHaveBeenCalledWith(error, { locale: 'es', route: '/es/' })
  })

  it('descarta un digest que no es un digest y guarda la ruta del momento del error', async () => {
    const { captureClientException, registerExceptionSink } = await freshModule()

    window.history.replaceState({}, '', '/en/ayuda')
    captureClientException(new Error('boom'), 'no valido; drop <this>')
    // La cola se vacia despues de navegar: la ruta guardada es la del error.
    window.history.replaceState({}, '', '/es/legal')

    const sink = makeSink()
    registerExceptionSink(sink)
    await Promise.resolve()

    // `/en/*` es una ruta histórica que responde 308: su segmento ya no nombra
    // un locale servido, así que la propiedad `locale` no viaja.
    expect(sink.captureException).toHaveBeenCalledWith(expect.any(Error), {
      route: '/en/ayuda',
    })
  })

  it('un sink que tira no tumba la pantalla de error ni pierde las siguientes', async () => {
    const { captureClientException, registerExceptionSink } = await freshModule()
    const sink = {
      captureException: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('sink down')
        })
        .mockImplementation(() => undefined),
    }

    captureClientException(new Error('first'))
    expect(() => registerExceptionSink(sink)).not.toThrow()
    await Promise.resolve()

    expect(() => captureClientException(new Error('second'))).not.toThrow()
    expect(sink.captureException).toHaveBeenCalledTimes(2)
  })

  it('acota la cola para que una tormenta de errores no se coma la memoria', async () => {
    const { captureClientException, registerExceptionSink, MAX_QUEUED_EXCEPTIONS } =
      await freshModule()

    for (let i = 0; i < MAX_QUEUED_EXCEPTIONS + 10; i += 1) {
      captureClientException(new Error(`boom ${i}`))
    }

    const sink = makeSink()
    registerExceptionSink(sink)
    await Promise.resolve()

    expect(sink.captureException).toHaveBeenCalledTimes(MAX_QUEUED_EXCEPTIONS)
    // Se conservan las mas nuevas: la primera que sobrevive es la numero 10.
    expect(sink.captureException.mock.calls[0]?.[0]).toMatchObject({ message: 'boom 10' })
  })
})
