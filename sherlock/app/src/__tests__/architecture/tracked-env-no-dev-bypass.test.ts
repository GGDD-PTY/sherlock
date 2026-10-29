// ============================================================================
// TRACKED ENV FILES - SIN BYPASS DE AUTH DE DESARROLLO
// ============================================================================
// ES: Ningún archivo .env TRACKEADO por git puede declarar BYPASS_AUTH truthy
//     ni CONVEX_ENV=dev. Esos flags habilitan el bypass de auth de desarrollo
//     (convex/_helpers/auth.dev.ts) y solo pueden vivir en env local no
//     trackeado o en el env del deployment dev de Convex — jamás en el repo.
// EN: No git-tracked .env file may enable the dev auth bypass.
// ============================================================================

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TRUTHY = new Set(['true', '1', 'yes', 'on'])

function getCleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) {
    delete env[key]
  }
  return env
}

function parseEnv(content: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const separator = normalized.indexOf('=')
    if (separator === -1) continue
    const key = normalized.slice(0, separator).trim()
    const value = normalized
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
    if (key) map.set(key, value)
  }
  return map
}

describe('tracked .env files never enable the dev auth bypass', () => {
  const gitEnv = getCleanGitEnv()
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: gitEnv,
  }).trim()

  const trackedEnvFiles = execFileSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: gitEnv,
  })
    .split('\n')
    .filter((file) => /(^|\/)\.env(\.|$)/.test(file))

  it('finds the tracked env surface (sanity)', () => {
    // Si git deja de reportar los .env trackeados, el test de abajo pasaría vacío.
    expect(trackedEnvFiles.length).toBeGreaterThan(0)
  })

  it('declares neither BYPASS_AUTH truthy nor CONVEX_ENV=dev', () => {
    const violations: string[] = []

    for (const file of trackedEnvFiles) {
      const env = parseEnv(readFileSync(join(repoRoot, file), 'utf8'))
      for (const key of ['BYPASS_AUTH', 'NEXT_PUBLIC_BYPASS_AUTH']) {
        const value = env.get(key)?.toLowerCase()
        if (value !== undefined && TRUTHY.has(value)) {
          violations.push(`${file}: ${key}=${value}`)
        }
      }
      const convexEnv = env.get('CONVEX_ENV')?.toLowerCase()
      if (convexEnv === 'dev') {
        violations.push(`${file}: CONVEX_ENV=dev`)
      }
    }

    expect(
      violations,
      `Archivos .env trackeados con bypass de auth habilitado: ${violations.join(', ')}`
    ).toEqual([])
  })
})
