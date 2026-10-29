// ============================================================================
// Candados de scripts/operator/convex-usage.mjs
// ============================================================================
// Corre el script REAL en un subproceso y solo por sus caminos de rechazo,
// que son los que no tocan la red ni mueven `.env.local`. El valor está en el
// ORDEN: todos estos rechazos ocurren dentro de `parseArgs`, antes de que
// `resolveDeployment` aparte el `.env.local` o hable con Convex.
// ============================================================================

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

const SCRIPT = resolve(process.cwd(), 'scripts/operator/convex-usage.mjs')
const EXIT_REFUSED = 2

function run(args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: resolve(process.cwd()),
    encoding: 'utf8',
    env: { ...process.env, CONVEX_DEPLOYMENT: '' },
  })
  return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' }
}

describe('convex-usage.mjs', () => {
  it('rechaza un argumento desconocido', () => {
    const result = run(['--turbo'])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/desconocido/i)
  })

  it('rechaza un --target que no es dev|prod', () => {
    const result = run(['--target', 'staging'])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/--target/)
  })

  it('rechaza --target sin valor', () => {
    const result = run(['--target'])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/--target/)
  })

  it('imprime 5000+ cuando la bitácora viene con countCapped', async () => {
    const { formatLog } = await import(pathToFileURL(SCRIPT).href)
    expect(
      formatLog('accessLogs', {
        count: 5000,
        countCapped: true,
        oldestAt: 1,
        oldestAgeDays: 10,
      })
    ).toBe('accessLogs 5000+ (10d)')
    expect(
      formatLog('accessLogs', {
        count: 3,
        countCapped: false,
        oldestAt: 1,
        oldestAgeDays: 2,
      })
    ).toBe('accessLogs 3 (2d)')
  })

  // El medidor no puede contar los documentAccessLogs legacy sin companyId (el
  // índice no los lista y no se toca schema.ts): la única mitigación es que el
  // CLI lo diga. Si el reporte trae notas y el CLI no las imprime, el operador
  // lee un total corto creyéndolo completo.
  it('imprime las notas del reporte, no las traga', async () => {
    const { formatNotes } = await import(pathToFileURL(SCRIPT).href)
    expect(formatNotes(['documentAccessLogs sin companyId no entran'])).toEqual([
      'nota: documentAccessLogs sin companyId no entran',
    ])
    expect(formatNotes(undefined)).toEqual([])
  })
})
