// Los boundaries de error reportan a PostHog por el sink que registra el
// provider tras el `init`, no importando `posthog-js` ellos mismos: el SDK son
// ~70 KiB y bajarlo desde una pantalla de error, en plena ventana del LCP, no
// reporta nada igual (sin `init` el cliente no captura). Ver
// `src/lib/observability/capture-client-exception.ts` y PR #507.
//
// Adjudicación (docs/test-governance.md): STALE_TEST. La conducta que este
// archivo fija — digest saneado, locale, ruta, y que la pantalla siga en pie —
// no cambió; lo que cambió es por dónde sale el evento. Antes se mockeaba
// `posthog-js` para espiar la entrega; ahora se registra un sink, que es la
// frontera real. Se agrega el caso que faltaba: la excepción que ocurre ANTES
// del init tiene que llegar igual.

import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  registerExceptionSink,
  type ClientExceptionSink,
} from '@/lib/observability/capture-client-exception'

const sink = vi.hoisted(() => ({ captureException: vi.fn() })) as ClientExceptionSink & {
  captureException: ReturnType<typeof vi.fn>
}

describe('error boundaries report the exception to PostHog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sink.captureException.mockImplementation(() => undefined)
    registerExceptionSink(sink)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    // La cola es estado de modulo: un caso que deja el sink en null le pasaria
    // su excepcion al siguiente. Un sink de descarte la vacia entre tests.
    registerExceptionSink({ captureException: () => undefined })
    registerExceptionSink(null)
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/')
  })

  it('reports the route error with its digest, locale and route', async () => {
    window.history.replaceState({}, '', '/es/pricing?email=private@example.com#secret')
    const ErrorPage = (await import('@/app/[locale]/error')).default
    const error = Object.assign(new Error('route boom'), { digest: 'abc123' })

    render(<ErrorPage error={error} reset={() => undefined} />)

    await waitFor(() => expect(sink.captureException).toHaveBeenCalledOnce())
    expect(sink.captureException).toHaveBeenCalledWith(error, {
      digest: 'abc123',
      locale: 'es',
      route: '/es/pricing',
    })
  })

  it('reports the global error with its digest, locale and route', async () => {
    window.history.replaceState({}, '', '/es/my-company/documents')
    const GlobalError = (await import('@/app/global-error')).default
    const error = Object.assign(new Error('global boom'), { digest: 'def456' })

    render(<GlobalError error={error} reset={() => undefined} />)

    await waitFor(() => expect(sink.captureException).toHaveBeenCalledOnce())
    expect(sink.captureException).toHaveBeenCalledWith(error, {
      digest: 'def456',
      locale: 'es',
      route: '/es/my-company/documents',
    })
  })

  it('drops an unusable digest instead of shipping it', async () => {
    window.history.replaceState({}, '', '/es/pricing')
    const ErrorPage = (await import('@/app/[locale]/error')).default
    const error = Object.assign(new Error('route boom'), { digest: 'not a digest!' })

    render(<ErrorPage error={error} reset={() => undefined} />)

    await waitFor(() => expect(sink.captureException).toHaveBeenCalledOnce())
    expect(sink.captureException).toHaveBeenCalledWith(error, {
      locale: 'es',
      route: '/es/pricing',
    })
  })

  it('delivers an exception thrown before the SDK finished initializing', async () => {
    // La landing rompe en hidratación: el init espera `load` + idle y todavía
    // no corrió, así que no hay sink. El evento no puede perderse.
    registerExceptionSink(null)
    window.history.replaceState({}, '', '/es/')
    const ErrorPage = (await import('@/app/[locale]/error')).default
    const error = Object.assign(new Error('hydration boom'), { digest: 'mno345' })

    const { container } = render(<ErrorPage error={error} reset={() => undefined} />)

    await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull())
    expect(sink.captureException).not.toHaveBeenCalled()

    registerExceptionSink(sink)

    await waitFor(() => expect(sink.captureException).toHaveBeenCalledOnce())
    expect(sink.captureException).toHaveBeenCalledWith(error, {
      digest: 'mno345',
      locale: 'es',
      route: '/es/',
    })
  })

  it('keeps rendering when the PostHog SDK never loaded', async () => {
    registerExceptionSink(null)
    window.history.replaceState({}, '', '/es/pricing')
    const ErrorPage = (await import('@/app/[locale]/error')).default

    const { container } = render(
      <ErrorPage
        error={Object.assign(new Error('unloaded'), { digest: 'ghi789' })}
        reset={() => undefined}
      />
    )

    await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull())
    expect(sink.captureException).not.toHaveBeenCalled()
  })

  it('keeps rendering when capture itself throws', async () => {
    sink.captureException.mockImplementation(() => {
      throw new Error('capture exploded')
    })
    window.history.replaceState({}, '', '/es/pricing')
    const ErrorPage = (await import('@/app/[locale]/error')).default

    const { container } = render(
      <ErrorPage
        error={Object.assign(new Error('boom'), { digest: 'jkl012' })}
        reset={() => undefined}
      />
    )

    await waitFor(() => expect(sink.captureException).toHaveBeenCalledOnce())
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })
})
