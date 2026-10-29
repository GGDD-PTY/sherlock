// ============================================================================
// E2E — PREFLIGHT DE NAVEGADOR
// ============================================================================
// Lanzar Chromium es IO externo y el navegador es un recurso que hay que
// cerrar: `externalCall` acota el lanzamiento y le pone tipo al fallo, y
// `acquireRelease` cierra el navegador aunque el scope muera por interrupción
// (antes el `finally` sí corría, pero solo si nadie mataba el proceso primero).
// ============================================================================

import { type Browser, chromium } from '@playwright/test'
import { Duration, Effect } from 'effect'

import type { ExternalServiceError } from '@/lib/effect/errors'
import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'

// Descargar y arrancar Chromium en frío pasa de largo los 8 s por defecto, y
// un lanzamiento bloqueado por el sandbox falla igual la segunda vez: sin
// reintentos.
const LAUNCH_TIMEOUT = Duration.minutes(2)

const SANDBOX_LAUNCH_MARKERS = [
  'MachPortRendezvousServer',
  'bootstrap_check_in',
  'Permission denied (1100)',
  'Target page, context or browser has been closed',
]

const browserResource = Effect.acquireRelease(
  externalCall({
    service: 'Playwright',
    operation: 'chromium.launch',
    run: () => chromium.launch({ headless: true }),
    timeout: LAUNCH_TIMEOUT,
    retries: 0,
  }),
  (browser: Browser) => Effect.promise(() => browser.close().catch(() => {}))
)

const preflight = Effect.fn('e2eBrowserPreflight')(function* () {
  if (process.env.E2E_BROWSER_PREFLIGHT_SKIP === 'true') {
    console.log('[e2e-preflight] skipped via E2E_BROWSER_PREFLIGHT_SKIP=true')
    return
  }

  yield* browserResource
  console.log('[e2e-preflight] browser launch succeeded')
})

function reportLaunchFailure(error: ExternalServiceError): void {
  const message = error.message

  if (SANDBOX_LAUNCH_MARKERS.some((marker) => message.includes(marker))) {
    console.error(
      [
        '[e2e-preflight] browser launch is blocked by the current macOS sandbox/runtime.',
        'Playwright E2E cannot run in this environment until browser launch is allowed.',
        'Use a non-sandboxed machine/runner, or set E2E_BROWSER_PREFLIGHT_SKIP=true only if you know browser launch works there.',
      ].join('\n')
    )
    process.exit(1)
  }

  console.error('[e2e-preflight] unexpected browser launch failure:')
  console.error(message)
  process.exit(1)
}

void runServerEffect(
  Effect.scoped(preflight()).pipe(
    Effect.catchTag('ExternalServiceError', (error) =>
      Effect.sync(() => reportLaunchFailure(error))
    )
  )
)
