#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'

const target = process.env.STAGING_E2E_BASE_URL?.trim()

if (!target) {
  console.error(
    'Missing STAGING_E2E_BASE_URL. Example: STAGING_E2E_BASE_URL=https://staging.example.com bun run test:e2e:staging:smoke'
  )
  process.exit(1)
}

let origin
try {
  const parsed = new URL(target)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('expected http or https URL')
  }
  origin = parsed.origin
} catch (error) {
  console.error(
    `Invalid STAGING_E2E_BASE_URL: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exit(1)
}

const env = {
  ...process.env,
  E2E_LOAD_DOTENV_LOCAL: 'false',
  PLAYWRIGHT_REUSE_SERVER: 'true',
  E2E_BASE_URL: origin,
  E2E_READY_URL: process.env.E2E_READY_URL || `${origin}/es`,
  BYPASS_AUTH: 'false',
  NEXT_PUBLIC_BYPASS_AUTH: 'false',
  NEXT_PUBLIC_DEV_AUTH_ENABLED: 'false',
  E2E_SERVER_MODE: 'start',
}

// staging.example.com está detrás de Vercel Deployment Protection. La spec
// manda `VERCEL_AUTOMATION_BYPASS_SECRET` como `x-vercel-protection-bypass`
// cuando existe; sin él, un deployment protegido responde el login de Vercel y
// la suite falla. Se avisa sin imprimir el valor.
if (!process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()) {
  console.warn(
    'VERCEL_AUTOMATION_BYPASS_SECRET is not set: a deployment behind Vercel Deployment Protection will answer its login page and the smoke will fail.'
  )
}

const preflight = spawnSync(
  'bash',
  ['scripts/with-project-node.sh', 'tsx', 'scripts/e2e-browser-preflight.ts'],
  {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  }
)

if (preflight.status !== 0) {
  process.exit(preflight.status ?? 1)
}

// Playwright escribe test-results/ y playwright-report/ en el cwd. Un fallo
// copia los headers al call log. Esas carpetas se borran al salir, en éxito
// y en fallo: es lo que dice el comentario de staging-smoke.spec.ts.
let playwrightStatus = 1
try {
  const playwright = spawnSync(
    'bash',
    [
      'scripts/with-project-node.sh',
      'playwright',
      'test',
      'e2e/reliability/staging-smoke.spec.ts',
      ...process.argv.slice(2),
    ],
    {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    }
  )
  playwrightStatus = playwright.status ?? 1
} finally {
  for (const directory of ['test-results', 'playwright-report']) {
    rmSync(directory, { recursive: true, force: true })
  }
}

process.exit(playwrightStatus)
