// ============================================================================
// Candados de los scripts del loop manual (scripts/operator/vdr-*.mjs)
// ============================================================================
// Corre los scripts REALES en un subproceso y solo por sus caminos de rechazo,
// que son los que no tocan la red ni mueven `.env.local`. El valor está en el
// ORDEN: todos estos rechazos ocurren dentro de `parseArgs`, antes de que
// `resolveDeployment` aparte el `.env.local` o hable con Convex. Un rechazo que
// llegara tarde ya habría gastado una subida o dejado el archivo apartado.
// ============================================================================

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

const PULL = resolve(process.cwd(), 'scripts/operator/vdr-pull.mjs')
const PUSH = resolve(process.cwd(), 'scripts/operator/vdr-push.mjs')
const EXIT_REFUSED = 2

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: resolve(process.cwd()),
    encoding: 'utf8',
    // Sin CONVEX_DEPLOYMENT: si un rechazo se colara hasta la red, el proceso
    // fallaría distinto y estas pruebas dejarían de probar el orden.
    env: { ...process.env, CONVEX_DEPLOYMENT: '' },
  })
  return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' }
}

describe('vdr-pull.mjs', () => {
  it('sin --company no arranca', () => {
    const result = run(PULL, [])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/--company/)
  })

  it('rechaza un argumento desconocido', () => {
    const result = run(PULL, ['--company', 'x', '--turbo'])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/desconocido/i)
  })
})

describe('vdr-push.mjs', () => {
  it('sin --company no arranca', () => {
    const result = run(PUSH, ['--file', 'x.xlsx', '--folder', 'room_financial'])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/--company/)
  })

  it('sin --file no arranca', () => {
    const result = run(PUSH, ['--company', 'abc', '--folder', 'room_financial'])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/--file/)
  })

  it('rechaza una carpeta que no es del shell de la sala y nombra las válidas', () => {
    const result = run(PUSH, ['--company', 'abc', '--file', 'x.xlsx', '--folder', '3-financieros'])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/room_financial/)
  })

  it('rechaza un --slot que no es un kind de la suite y nombra los válidos', () => {
    const result = run(PUSH, [
      '--company',
      'abc',
      '--file',
      'x.xlsx',
      '--folder',
      'room_financial',
      '--slot',
      'MODELO',
    ])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/--slot MODELO/)
    expect(result.stderr).toMatch(/MGMT_PRESENTATION/)
  })

  // La nota la rechaza la mutation DESPUÉS de subir los bytes: sin este freno
  // local, una nota larga deja el blob escrito y la entrega a medias.
  it('rechaza una --note de más de 500 caracteres antes de subir nada', () => {
    const result = run(PUSH, [
      '--company',
      'abc',
      '--file',
      'x.xlsx',
      '--folder',
      'room_financial',
      '--note',
      'a'.repeat(501),
    ])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('La nota tiene 501 caracteres; el máximo es 500.')
  })

  // El candado que más importa: prod sin confirmación explícita muere antes de
  // apartar `.env.local` y antes de cualquier llamada de red.
  it('rechaza --deployment prod sin --yes', () => {
    const result = run(PUSH, [
      '--company',
      'abc',
      '--file',
      'x.xlsx',
      '--folder',
      'room_financial',
      '--deployment',
      'prod',
    ])
    expect(result.status).toBe(EXIT_REFUSED)
    expect(result.stderr).toMatch(/--yes/)
  })

  it('importar el módulo no corre main', async () => {
    const imported = await import(pathToFileURL(PUSH).href)
    expect(imported).toBeTypeOf('object')
  })
})

// ============================================================================
// El freno de egress del pull
// ============================================================================
// Cada blob que el pull vuelve a bajar puede consumir transferencia.
// `planFromManifest` es la
// decisión de NO pedir esos bytes: se prueba directo porque es la única parte
// del script que puede correr sin red.
describe('vdr-pull.mjs planFromManifest', () => {
  const SHA = 'a'.repeat(64)
  const DOCUMENT = {
    versionId: 'v1',
    sha256: SHA,
    byteSize: 1024,
  }
  const ROW = { versionId: 'v1', sha256: SHA, relativePath: 'room_financial/x.pdf' }
  // Los bytes locales son los de la sala: tamaño y digest coinciden.
  const LOCAL = { sizeOf: () => 1024, digestOf: () => SHA }

  async function load() {
    return (await import(pathToFileURL(PULL).href)) as {
      planFromManifest: (input: {
        documents: unknown[]
        previous: Map<string, unknown>
        sizeOf: (relativePath: string) => number | null
        digestOf: (relativePath: string) => string | null
        force?: boolean
      }) => { reuse: Map<string, string>; pending: unknown[] }
    }
  }

  it('reusa la versión que el manifiesto ya tiene en disco con los mismos bytes', async () => {
    const { planFromManifest } = await load()
    const plan = planFromManifest({
      documents: [DOCUMENT],
      previous: new Map([['v1', ROW]]),
      ...LOCAL,
    })
    expect(plan.pending).toEqual([])
    expect(plan.reuse.get('v1')).toBe('room_financial/x.pdf')
  })

  it('vuelve a bajar cuando el archivo del manifiesto ya no está', async () => {
    const { planFromManifest } = await load()
    const plan = planFromManifest({
      documents: [DOCUMENT],
      previous: new Map([['v1', ROW]]),
      sizeOf: () => null,
      digestOf: () => null,
    })
    expect(plan.pending).toEqual([DOCUMENT])
    expect(plan.reuse.size).toBe(0)
  })

  it('vuelve a bajar cuando el archivo local cambió de tamaño', async () => {
    const { planFromManifest } = await load()
    const plan = planFromManifest({
      documents: [DOCUMENT],
      previous: new Map([['v1', ROW]]),
      ...LOCAL,
      sizeOf: () => 12,
    })
    expect(plan.pending).toEqual([DOCUMENT])
  })

  // Un libro editado a mano puede conservar el tamaño exacto (una celda
  // cambiada en un xlsx). El manifiesto y el `stat` lo daban por bytes de la
  // sala y Mycroft corría sobre un insumo que el cliente nunca subió.
  it('vuelve a bajar cuando el archivo local tiene el mismo tamaño y otros bytes', async () => {
    const { planFromManifest } = await load()
    const plan = planFromManifest({
      documents: [DOCUMENT],
      previous: new Map([['v1', ROW]]),
      ...LOCAL,
      digestOf: () => 'b'.repeat(64),
    })
    expect(plan.pending).toEqual([DOCUMENT])
    expect(plan.reuse.size).toBe(0)
  })

  it('vuelve a bajar cuando el archivo local no se puede leer para hashear', async () => {
    const { planFromManifest } = await load()
    const plan = planFromManifest({
      documents: [DOCUMENT],
      previous: new Map([['v1', ROW]]),
      ...LOCAL,
      digestOf: () => null,
    })
    expect(plan.pending).toEqual([DOCUMENT])
  })

  // Una fila vieja guarda el digest en base64 y el servidor no lo pudo llevar
  // a hex: sin hex no hay bytes locales contra los que probarlo, así que se
  // vuelve a bajar en vez de darlo por bueno.
  it('vuelve a bajar cuando el digest remoto no se puede probar en hex', async () => {
    const { planFromManifest } = await load()
    const base64 = Buffer.from(SHA, 'hex').toString('base64')
    const document = { ...DOCUMENT, sha256: base64 }
    const plan = planFromManifest({
      documents: [document],
      previous: new Map([['v1', { ...ROW, sha256: base64 }]]),
      ...LOCAL,
    })
    expect(plan.pending).toEqual([document])
  })

  it('compara el digest remoto sin distinguir mayúsculas', async () => {
    const { planFromManifest } = await load()
    const upper = SHA.toUpperCase()
    const plan = planFromManifest({
      documents: [{ ...DOCUMENT, sha256: upper }],
      previous: new Map([['v1', { ...ROW, sha256: upper }]]),
      ...LOCAL,
    })
    expect(plan.pending).toEqual([])
  })

  // El manifiesto se indexa por versionId, no por sha: una versión nueva de un
  // documento que ya estaba baja sus bytes aunque el nombre no cambie.
  it('vuelve a bajar una versión que el manifiesto no conoce', async () => {
    const { planFromManifest } = await load()
    const plan = planFromManifest({
      documents: [{ ...DOCUMENT, versionId: 'v2', sha256: 'b'.repeat(64) }],
      previous: new Map([['v1', ROW]]),
      ...LOCAL,
    })
    expect(plan.pending).toHaveLength(1)
  })

  it('con --force no reusa nada', async () => {
    const { planFromManifest } = await load()
    const plan = planFromManifest({
      documents: [DOCUMENT],
      previous: new Map([['v1', ROW]]),
      ...LOCAL,
      force: true,
    })
    expect(plan.reuse.size).toBe(0)
    expect(plan.pending).toEqual([DOCUMENT])
  })

  it('hashea un archivo real en streaming y devuelve null si no existe', async () => {
    const { fileSha256 } = (await import(pathToFileURL(PULL).href)) as {
      fileSha256: (path: string) => string | null
    }
    const directory = mkdtempSync(join(tmpdir(), 'sherlock-vdr-pull-'))
    const file = join(directory, 'x.bin')
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 7)
    writeFileSync(file, bytes)
    expect(fileSha256(file)).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(fileSha256(join(directory, 'no-existe.bin'))).toBeNull()
    rmSync(directory, { recursive: true, force: true })
  })

  it('acepta --force como argumento', () => {
    const result = run(PULL, ['--company', 'x', '--force'])
    expect(result.stderr).not.toMatch(/desconocido/i)
  })
})
