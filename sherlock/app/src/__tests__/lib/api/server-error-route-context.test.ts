// ============================================================================
// UN 5xx SIN RUTA ES UN AVISO CIEGO
// ============================================================================
// `apiError()` sólo sabe la ruta si el call site se la pasa. Sin ella el aviso
// sale como `/unknown`, y como la llave de dedupe es (ruta, nombre del error),
// todos los 5xx del sitio que compartan nombre caen en la MISMA ventana: el
// segundo incidente, de otro handler, se agrupa con el primero y no despierta a
// nadie. Los helpers compartidos que pueden responder 5xx llevan la ruta como
// parámetro obligatorio para que el compilador encuentre al que se olvide.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

type CapturedException = { requestId: string; status: number; route?: string }

const captureServerException = vi.fn(async (_input: CapturedException) => true)

vi.mock('@/lib/observability/posthog-server-exception', () => ({
  captureServerException: (input: CapturedException) => captureServerException(input),
  wasServerExceptionCaptured: () => false,
}))

describe('los 5xx compartidos nombran la ruta que se rompió', () => {
  beforeEach(() => {
    captureServerException.mockClear()
  })

  it('el 503 de intake viaja con la ruta del handler', async () => {
    const { intakeTemporarilyUnavailable } = await import('@/lib/intake/api')

    intakeTemporarilyUnavailable('request-1', '/api/intake/session')

    expect(captureServerException).toHaveBeenCalledOnce()
    expect(captureServerException.mock.calls[0]?.[0]).toMatchObject({
      requestId: 'request-1',
      status: 503,
      route: '/api/intake/session',
    })
  })

  it('un 4xx sigue sin reportar nada', async () => {
    const { intakeUnauthorized } = await import('@/lib/intake/api')

    intakeUnauthorized('request-2')

    expect(captureServerException).not.toHaveBeenCalled()
  })
})
