import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const MANAGED_ENV = [
  'BYPASS_AUTH',
  'E2E_BASE_URL',
  'NEXT_PUBLIC_BYPASS_AUTH',
  'NEXT_PUBLIC_CONVEX_URL',
  'NEXT_DISABLE_REMOTE_FONTS',
  'E2E_DEV_AUTH_USE_SEEDED_CONVEX',
  'E2E_LOAD_DOTENV_LOCAL',
] as const

const originalEnv = new Map(MANAGED_ENV.map((name) => [name, process.env[name]]))
const originalCwd = process.cwd()
const fixtureDirectories: string[] = []

function configureDevAuthImport() {
  process.env.BYPASS_AUTH = 'true'
  process.env.NEXT_PUBLIC_BYPASS_AUTH = 'true'
}

function useDotenvFixture(contents: string) {
  const directory = mkdtempSync(path.join(tmpdir(), 'sherlock-e2e-env-'))
  fixtureDirectories.push(directory)
  writeFileSync(path.join(directory, '.env.local'), contents, 'utf8')
  process.chdir(directory)
}

afterEach(() => {
  process.chdir(originalCwd)
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  for (const name of MANAGED_ENV) {
    const value = originalEnv.get(name)
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
  vi.resetModules()
})

describe('Playwright dev-auth fixture isolation', () => {
  it('overrides a seeded Convex URL after loading it from .env.local', async () => {
    configureDevAuthImport()
    // dotenv no pisa variables ya presentes: un E2E_BASE_URL del runner daría
    // un rojo falso, así que se limpia antes de cargar el fixture.
    delete process.env.E2E_BASE_URL
    delete process.env.NEXT_PUBLIC_CONVEX_URL
    delete process.env.E2E_DEV_AUTH_USE_SEEDED_CONVEX
    delete process.env.E2E_LOAD_DOTENV_LOCAL
    useDotenvFixture(
      [
        'NEXT_PUBLIC_CONVEX_URL=https://seeded-samplehydro.convex.cloud',
        'E2E_BASE_URL=http://dotenv-fixture.local',
      ].join('\n')
    )

    await import('../../../playwright.config')

    expect(process.env.E2E_BASE_URL).toBe('http://dotenv-fixture.local')
    expect(process.env.NEXT_PUBLIC_CONVEX_URL).toBe('https://placeholder.convex.cloud')
  })

  it('preserves the seeded SAMPLE_HYDRO lane only through the explicit opt-in', async () => {
    configureDevAuthImport()
    process.env.E2E_LOAD_DOTENV_LOCAL = 'false'
    process.env.NEXT_PUBLIC_CONVEX_URL = 'https://seeded-samplehydro.convex.cloud'
    process.env.E2E_DEV_AUTH_USE_SEEDED_CONVEX = 'true'

    await import('../../../playwright.config')

    expect(process.env.NEXT_PUBLIC_CONVEX_URL).toBe('https://seeded-samplehydro.convex.cloud')
  })

  it('preserves a real Convex URL without dev-auth even when the opt-in is absent', async () => {
    process.env.BYPASS_AUTH = 'false'
    process.env.NEXT_PUBLIC_BYPASS_AUTH = 'false'
    process.env.E2E_LOAD_DOTENV_LOCAL = 'false'
    process.env.NEXT_PUBLIC_CONVEX_URL = 'https://real-environment.convex.cloud'
    delete process.env.E2E_DEV_AUTH_USE_SEEDED_CONVEX

    await import('../../../playwright.config')

    expect(process.env.NEXT_PUBLIC_CONVEX_URL).toBe('https://real-environment.convex.cloud')
  })
})
