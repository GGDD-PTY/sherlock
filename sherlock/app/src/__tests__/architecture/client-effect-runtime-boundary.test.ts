import fs from 'node:fs'
import path from 'node:path'

import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

const APP_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const SRC_ROOT = path.join(APP_ROOT, 'src')

// La directiva, no la palabra: `'use client'` también aparece dentro de
// comentarios que explican quién importa un módulo de servidor
// (`lib/intake/config.ts`, `lib/intake/demo-mode.ts`), y esos no son cliente.
const USE_CLIENT_DIRECTIVE = /^\s*['"]use client['"];?\s*$/m
const SERVER_ONLY_IMPORT = /\bimport\s+['"]server-only['"]/
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/
const BARE_RUN = /\bEffect\.run(?:Promise|Sync|Fork|PromiseExit|SyncExit)\s*\(/g

function posixRel(file: string): string {
  return path.relative(APP_ROOT, file).split(path.sep).join('/')
}

function filesUnder(root: string, accepts: (file: string) => boolean): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(file, accepts))
    else if (accepts(file)) files.push(file)
  }
  return files
}

const SHELL_STREET_FOLDERS = [
  'notifications',
  'settings',
  'onboarding',
  'vdr-guest',
  'mycroft',
  'ayuda',
  'roadmap',
  'hierarchy',
  'errors',
  'analytics',
  'layout',
  'ui',
  'providers',
  'showcase',
  'shared',
  'lazy',
] as const

function isShellStreetSource(file: string): boolean {
  const rel = path.relative(APP_ROOT, file)
  return !rel.includes('/__tests__/') && (file.endsWith('.ts') || file.endsWith('.tsx'))
}

function shellStreetSources(): string[] {
  return SHELL_STREET_FOLDERS.flatMap((folder) =>
    filesUnder(path.join(SRC_ROOT, 'components', folder), isShellStreetSource)
  )
}

function isBoundarySource(file: string): boolean {
  const rel = posixRel(file)
  if (rel.includes('/__tests__/')) return false
  if (TEST_FILE.test(rel)) return false
  if (!file.endsWith('.ts') && !file.endsWith('.tsx')) return false
  const source = fs.readFileSync(file, 'utf8')
  if (SERVER_ONLY_IMPORT.test(source)) return false
  const inHooksOrComponents = rel.startsWith('src/components/') || rel.startsWith('src/hooks/')
  return inHooksOrComponents || USE_CLIENT_DIRECTIVE.test(source)
}

// Excepciones temporales: archivos que el candado alcanza antes de que su
// calle los migre. La calle dueña los saca al migrar. Hoy no queda ninguna.
const TEMPORARY_BARE_RUN_EXCEPTIONS: readonly string[] = []

const TEMPORARY_BARE_RUN_EXCEPTION_SET = new Set<string>(TEMPORARY_BARE_RUN_EXCEPTIONS)

describe('client Effect runtime boundary', () => {
  // Un `Effect.run*` pelado corre sobre el runtime por defecto de Effect, que
  // lleva el defaultLogger: en el navegador un `Effect.log*` sale por
  // `console.log` sin nivel y sin pasar por el logger de Sherlock. El runtime
  // de cliente (`lib/effect/client-runtime.ts`) es la única costura que monta
  // esa capa, así que un archivo de cliente corre por sus helpers.
  it.effect('runs client programs through the client runtime, never bare', () =>
    Effect.sync(() => {
      const clients = filesUnder(SRC_ROOT, isBoundarySource)

      const violations = clients
        .map((file) => {
          const rel = posixRel(file)
          const source = fs.readFileSync(file, 'utf8')
          BARE_RUN.lastIndex = 0
          const hits = source.match(BARE_RUN) ?? []
          return { file: rel, hits: hits.length }
        })
        .filter((entry) => entry.hits > 0)
        .filter((entry) => !TEMPORARY_BARE_RUN_EXCEPTION_SET.has(entry.file))
        .map((entry) => `${entry.file} (${entry.hits.toString()})`)

      const staleExceptions = TEMPORARY_BARE_RUN_EXCEPTIONS.filter((rel) => {
        const file = path.join(APP_ROOT, rel)
        if (!fs.existsSync(file)) return true
        BARE_RUN.lastIndex = 0
        return (fs.readFileSync(file, 'utf8').match(BARE_RUN) ?? []).length === 0
      })

      // El mensaje dice el arreglo, no solo el archivo: quien rompa esto tiene
      // que saber a qué helper mover la llamada.
      assert.deepStrictEqual(
        violations,
        [],
        'Effect.run* pelado en archivos con `use client` o en src/components y src/hooks. ' +
          'Usa los helpers de `@/lib/effect/client-runtime`: runPromise → runClientEffect, ' +
          'runPromiseExit → runClientEffectExit, runFork → runClientFork, ' +
          'runSync → runClientSync, runSyncExit → runClientSyncExit.'
      )
      assert.deepStrictEqual(
        staleExceptions,
        [],
        'Excepción temporal sin Effect.run* pelado: sácala, la calle dueña ya migró.'
      )
      // Sin este piso, borrar la directiva de todos lados dejaría el candado en
      // verde sin probar nada.
      assert.isAtLeast(clients.length, 100)
    })
  )

  // La calle cliente-shell incluye módulos de cliente que no llevan la
  // directiva (helpers importados por un `'use client'`). El candado de
  // arriba no los ve; este sí, en las carpetas de esta calle.
  it.effect(
    'runs shell-street programs through the client runtime even without the directive',
    () =>
      Effect.sync(() => {
        const files = shellStreetSources()
        const violations = files
          .map((file) => {
            const hits = fs.readFileSync(file, 'utf8').match(BARE_RUN) ?? []
            return { file: path.relative(APP_ROOT, file), hits: hits.length }
          })
          .filter((entry) => entry.hits > 0)
          .map((entry) => `${entry.file} (${entry.hits.toString()})`)

        assert.deepStrictEqual(
          violations,
          [],
          'Effect.run* pelado en components de cliente-shell. ' +
            'Usa los helpers de `@/lib/effect/client-runtime`.'
        )
        assert.isAtLeast(files.length, 40)
      })
  )

  // El runtime de cliente es una costura, no un patrón que se copia: quien
  // necesite otra capa la agrega ahí, no monta un `ManagedRuntime` suyo.
  it.effect('keeps the client runtime seam in a single file', () =>
    Effect.sync(() => {
      const seams = filesUnder(SRC_ROOT, (file) => file.endsWith('.ts') || file.endsWith('.tsx'))
        .filter((file) => !posixRel(file).includes('/__tests__/'))
        .filter((file) => /ManagedRuntime\.make\s*\(/.test(fs.readFileSync(file, 'utf8')))
        .map((file) => posixRel(file))

      assert.deepStrictEqual(seams.toSorted(), [
        'src/lib/effect/client-runtime.ts',
        'src/lib/effect/runtime.ts',
      ])
    })
  )
})
