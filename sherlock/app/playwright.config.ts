// ============================================================================
// PLAYWRIGHT CONFIGURATION
// ============================================================================
// Configuración para tests E2E de Sherlock
// Corre tests en Chromium headless por defecto
// ============================================================================

import { defineConfig, devices } from '@playwright/test'
import path from 'path'
import dotenv from 'dotenv'
import { defaultLocale } from './src/i18n/config'

// ===== CARGAR .ENV.LOCAL PARA TESTS =====
// ES: Playwright no carga .env.local automáticamente.
// EN: Playwright does not load .env.local automatically.
if (process.env.E2E_LOAD_DOTENV_LOCAL !== 'false') {
  dotenv.config({ path: path.join(process.cwd(), '.env.local') })
}

// ===== E2E SERVER PORT / BASE URL =====
// Avoid port conflicts with other local dev servers.
const E2E_PORT = Number(process.env.E2E_PORT ?? 3015)
const E2E_BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${E2E_PORT}`
process.env.E2E_BASE_URL = E2E_BASE_URL
const E2E_READY_URL = process.env.E2E_READY_URL ?? `${E2E_BASE_URL}/${defaultLocale}`
const E2E_DRIVER = process.env.E2E_DRIVER ?? 'playwright'
const IS_AGENT_BROWSER_DRIVER = E2E_DRIVER === 'agent-browser'
const USE_MANUAL_E2E_SERVER = process.env.PLAYWRIGHT_REUSE_SERVER === 'true'
const NEXT_DISABLE_REMOTE_FONTS = process.env.NEXT_DISABLE_REMOTE_FONTS ?? 'true'
process.env.NEXT_DISABLE_REMOTE_FONTS = NEXT_DISABLE_REMOTE_FONTS

// ===== GANCHOS DE TIEMPO DEL VISOR XLSX =====
// `data-xlsx-phase` / `data-xlsx-marks` existen para `xlsx-viewer-phases.spec.ts`
// y no se publican en produccion. Se prende aqui, antes de que Playwright
// levante el servidor, para que el proceso hijo lo herede.
process.env.NEXT_PUBLIC_XLSX_PHASE_MARKS = process.env.NEXT_PUBLIC_XLSX_PHASE_MARKS ?? 'true'

// ===== ACTIVE SUITE / DEMO AUTH FLAG =====
const IS_DEMO_AUTH =
  process.env.BYPASS_AUTH === 'true' || process.env.NEXT_PUBLIC_BYPASS_AUTH === 'true'
const USE_SEEDED_DEV_AUTH_CONVEX = process.env.E2E_DEV_AUTH_USE_SEEDED_CONVEX === 'true'

// Automated dev-auth journeys must resolve the deterministic browser-local
// fixture even when .env.local points at a seeded development deployment.
// Opt in explicitly when the test is intentionally exercising the seeded SAMPLE_HYDRO room.
if (IS_DEMO_AUTH && !USE_SEEDED_DEV_AUTH_CONVEX) {
  process.env.NEXT_PUBLIC_CONVEX_URL = 'https://placeholder.convex.cloud'
}

const E2E_SERVER_MODE = process.env.E2E_SERVER_MODE ?? (IS_DEMO_AUTH ? 'dev' : 'start')
const SHOULD_SERIALIZE_DEV_SERVER = E2E_SERVER_MODE === 'dev'

// Keep Chromium as the general suite. Firefox and WebKit are focused adapters
// for the sell-side intake and protected guest-room contracts so ordinary `playwright test` runs do not
// multiply every repository journey or execute Chromium-only specs elsewhere.
const VDR_CROSS_BROWSER_TESTS = [
  '**/intake-temporary-journey.spec.ts',
  '**/intake-deliverables-journey.spec.ts',
  '**/vdr-guest.spec.ts',
]

export default defineConfig({
  // ===== DIRECTORIO DE TESTS =====
  testDir: './e2e',

  // ===== CONFIGURACIÓN GENERAL =====
  timeout: 60 * 1000,
  // CI runners under load need more than Playwright's 5s default for dialogs/tabs
  // to mount.
  expect: { timeout: 10 * 1000 },
  // Next dev writes shared cache manifests under .next/dev. Keep dev-server
  // smoke runs serialized so parallel workers do not race that generated state.
  //
  // CI parallelism note: because E2E_SERVER_MODE=dev (demo/bypass-auth runs)
  // forces SHOULD_SERIALIZE_DEV_SERVER=true, `workers` below collapses to 1
  // for every CI E2E job regardless of the CLI --workers flag. CI still gets
  // parallelism, but it comes from the GitHub Actions job matrix (see
  // e2e-journeys' `strategy.matrix.shard: [a, b, c, d]` in .github/workflows/ci.yml)
  // — separate jobs/runners each running their own single-worker Playwright
  // process — not from Playwright workers within one job.
  //
  // The `--workers=1` CLI flag CI appends to the `test:e2e:*` bun scripts is
  // redundant with this config. The explicit `--project=chromium` remains
  // intentional because this file also defines focused Firefox/WebKit VDR
  // projects. Both flags must still actually reach Playwright:
  // those scripts wrap `playwright test` in `sh -c '... "$@"' _`, where the
  // trailing `_` and the `"$@"` reference are load-bearing — without them,
  // `sh -c 'script'` (no positional-parameter reference) silently drops any
  // CLI args bun/npm appends after `--`, per POSIX `sh -c cmd [name [arg...]]`.
  fullyParallel: !IS_AGENT_BROWSER_DRIVER && !SHOULD_SERIALIZE_DEV_SERVER,
  forbidOnly: !!process.env.CI, // Falla en CI si hay .only()
  retries: process.env.CI ? 2 : 0, // Reintentos solo en CI
  workers:
    IS_AGENT_BROWSER_DRIVER || SHOULD_SERIALIZE_DEV_SERVER ? 1 : process.env.CI ? 1 : undefined,

  // ===== REPORTES =====
  reporter: [
    ['html', { open: 'never' }], // Reporte HTML
    ['list'], // Lista en terminal
    ['json', { outputFile: 'test-results/playwright/results.json' }],
  ],

  // ===== CONFIGURACIÓN COMPARTIDA =====
  use: {
    // URL base del servidor de desarrollo
    baseURL: E2E_BASE_URL,

    // Capturar trace solo cuando falla
    trace: 'on-first-retry',

    // Screenshots solo cuando falla
    screenshot: 'only-on-failure',

    // Viewport estándar
    viewport: { width: 1280, height: 720 },
  },

  // ===== PROYECTOS (BROWSERS) =====
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // These switches are Chromium-specific. Keeping them on this project
        // avoids passing unsupported launch flags to Firefox and WebKit.
        launchOptions: {
          // --disable-dev-shm-usage: hosted CI containers (Buildkite) mount a
          // tiny /dev/shm; heavy pages crash the renderer without it.
          args: [
            '--no-proxy-server',
            '--host-resolver-rules=MAP localhost 127.0.0.1',
            '--disable-dev-shm-usage',
          ],
        },
      },
    },
    {
      name: 'firefox',
      testMatch: VDR_CROSS_BROWSER_TESTS,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      testMatch: VDR_CROSS_BROWSER_TESTS,
      use: { ...devices['Desktop Safari'] },
    },
  ],

  ...(USE_MANUAL_E2E_SERVER
    ? {}
    : {
        // ===== SERVIDOR DE DESARROLLO =====
        // Inicia el servidor antes de correr los tests
        // NOTA: En desarrollo local, asume que el servidor ya está corriendo
        webServer: {
          command:
            E2E_SERVER_MODE === 'dev'
              ? // Los visores del VDR necesitan `public/mog/` y `public/pdfjs/`,
                // que genera el build de assets. `next dev` no corre la cadena de
                // `bun run build`, así que se invoca aquí (es idempotente: si la
                // salida está al día no reconstruye nada).
                `NEXT_DISABLE_REMOTE_FONTS=${NEXT_DISABLE_REMOTE_FONTS} bash scripts/with-project-node.sh sh -c 'node scripts/build-viewer-assets.mjs && node scripts/dev-health.mjs && next dev --webpack -p ${E2E_PORT}'`
              : `NEXT_DISABLE_REMOTE_FONTS=${NEXT_DISABLE_REMOTE_FONTS} bun run build && bun x next start -p ${E2E_PORT}`,
          url: E2E_READY_URL,
          timeout: E2E_SERVER_MODE === 'dev' ? 180 * 1000 : 300 * 1000,
        },
      }),
})
