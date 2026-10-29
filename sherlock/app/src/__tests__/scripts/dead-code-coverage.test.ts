import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

const REPO_ROOT = resolve(process.cwd(), '../..')
const KNIP_CLI = join(REPO_ROOT, 'node_modules/knip/bin/knip.js')
const symbolSchema = z.object({ name: z.string() }).passthrough()
const reportSchema = z.object({
  issues: z.array(
    z
      .object({
        file: z.string(),
        files: z.array(symbolSchema).optional(),
        exports: z.array(symbolSchema).optional(),
        types: z.array(symbolSchema).optional(),
        nsExports: z.array(symbolSchema).optional(),
        nsTypes: z.array(symbolSchema).optional(),
        dependencies: z.array(symbolSchema).optional(),
        unlisted: z.array(symbolSchema).optional(),
        unresolved: z.array(symbolSchema).optional(),
      })
      .passthrough()
  ),
})

const directories: string[] = []

async function fixtureFile(root: string, path: string, contents: string) {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents)
}

async function inspectFixture(injectDeadCode: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'sherlock-dead-code-coverage-'))
  directories.push(root)
  const workspaces = ['sherlock/app', 'sherlock/app/mog-sidecar']
  await fixtureFile(
    root,
    'package.json',
    JSON.stringify({
      name: 'coverage-fixture',
      private: true,
      workspaces,
      dependencies: injectDeadCode ? { 'unused-fixture-dependency': '1.0.0' } : {},
    })
  )
  await fixtureFile(
    root,
    'knip.config.ts',
    await readFile(join(REPO_ROOT, 'knip.config.ts'), 'utf8')
  )
  for (const workspace of workspaces) {
    await fixtureFile(
      root,
      `${workspace}/package.json`,
      JSON.stringify({
        name: workspace.replaceAll('/', '-'),
        private: true,
      })
    )
  }

  const extra = injectDeadCode
    ? '\nexport const orphanExport = 2;\nexport type OrphanType = string;\n'
    : ''
  await fixtureFile(
    root,
    'scripts/verify-gate.mjs',
    "import { used } from './used.ts'; console.log(used);\n"
  )
  await fixtureFile(root, 'scripts/used.ts', `export const used = 1;${extra}`)
  await fixtureFile(
    root,
    'sherlock/app/convex/entry.ts',
    "import * as helper from './_helpers/used'; export const result = helper.used;\n"
  )
  await fixtureFile(root, 'sherlock/app/convex/_helpers/used.ts', `export const used = 1;${extra}`)
  await fixtureFile(
    root,
    'sherlock/app/mog-sidecar/src/main.js',
    "import { used } from './used.js'; console.log(used);\n"
  )
  await fixtureFile(root, 'sherlock/app/mog-sidecar/src/used.js', 'export const used = 1;\n')

  if (injectDeadCode) {
    for (const path of [
      'scripts/orphan.mts',
      'sherlock/app/src/orphan.ts',
      'sherlock/app/convex/_helpers/orphan.ts',
      'sherlock/app/e2e/orphan-helper.ts',
      'sherlock/app/mog-sidecar/src/orphan.js',
    ]) {
      await fixtureFile(root, path, 'export const unused = 1;\n')
    }
    await fixtureFile(
      root,
      'scripts/verify-gate.mjs',
      "import { used } from './used.ts'; import './missing-module'; " +
        "import 'undeclared-fixture-package'; console.log(used);\n"
    )
  }

  const manifest = z
    .object({ scripts: z.object({ 'dead-code': z.string() }) })
    .parse(JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')))
  const [executable, ...gateArguments] = manifest.scripts['dead-code'].trim().split(/\s+/)
  if (executable !== 'knip') throw new Error('The dead-code gate must invoke Knip directly')
  const result = spawnSync(process.execPath, [KNIP_CLI, ...gateArguments, '--reporter', 'json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  })
  if (result.error) throw result.error
  const jsonLine = result.stdout.split('\n').find((line) => line.startsWith('{"issues"'))
  if (!jsonLine) throw new Error(`Knip did not return its report: ${result.stderr}`)
  return { status: result.status, report: reportSchema.parse(JSON.parse(jsonLine)) }
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('dead-code monorepo coverage', () => {
  it('accepts connected source in all workspaces with the actual shared configuration', async () => {
    const result = await inspectFixture(false)
    expect(result.status).toBe(0)
    expect(result.report.issues).toEqual([])
  })

  it('rejects orphan files, exports, types and imports across every active area', async () => {
    const result = await inspectFixture(true)
    const { issues } = result.report
    expect(result.status).toBe(1)
    expect(issues.flatMap((issue) => (issue.files ?? []).map((file) => file.name))).toEqual(
      expect.arrayContaining([
        'scripts/orphan.mts',
        'sherlock/app/src/orphan.ts',
        'sherlock/app/convex/_helpers/orphan.ts',
        'sherlock/app/e2e/orphan-helper.ts',
        'sherlock/app/mog-sidecar/src/orphan.js',
      ])
    )
    expect(issues.find((issue) => issue.file === 'scripts/used.ts')?.exports).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'orphanExport' })])
    )
    expect(issues.find((issue) => issue.file === 'scripts/used.ts')?.types).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'OrphanType' })])
    )
    const namespaced = issues.find((issue) => issue.file.endsWith('/_helpers/used.ts'))
    expect([...(namespaced?.exports ?? []), ...(namespaced?.nsExports ?? [])]).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'orphanExport' })])
    )
    expect([...(namespaced?.types ?? []), ...(namespaced?.nsTypes ?? [])]).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'OrphanType' })])
    )
    expect(issues.flatMap((issue) => issue.dependencies ?? [])).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'unused-fixture-dependency' })])
    )
    expect(issues.flatMap((issue) => issue.unlisted ?? [])).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'undeclared-fixture-package' })])
    )
    expect(issues.flatMap((issue) => issue.unresolved ?? [])).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: './missing-module' })])
    )
  })
})
