import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'

const REPO_ROOT = path.resolve(process.cwd(), '../..')
const EXPECTED_NODE = '24.22.1'
const EXPECTED_BUN = '1.4.2'

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function readJson(relativePath: string) {
  return JSON.parse(read(relativePath))
}

describe('project runtime pins', () => {
  it('keeps package metadata, nvm and mise on one Node and Bun pair', () => {
    const rootPackage = readJson('package.json')
    const appPackage = readJson('sherlock/app/package.json')
    const nvmrc = read('sherlock/app/.nvmrc').trim()
    const mise = read('mise.toml')

    expect(rootPackage.packageManager).toBe(`bun@${EXPECTED_BUN}`)
    expect(appPackage.packageManager).toBe(rootPackage.packageManager)
    expect(rootPackage.engines.node).toBe(`>=${EXPECTED_NODE} <25.0.0`)
    expect(appPackage.engines.node).toBe(rootPackage.engines.node)
    expect(nvmrc).toBe(EXPECTED_NODE)
    expect(mise).toMatch(new RegExp(`^bun = "${EXPECTED_BUN.replaceAll('.', '\\.')}"$`, 'm'))
    expect(mise).toMatch(new RegExp(`^node = "${EXPECTED_NODE.replaceAll('.', '\\.')}"$`, 'm'))
  })

  it.each(
    readdirSync(path.join(REPO_ROOT, '.github/workflows')).filter((file) => /\.ya?ml$/.test(file))
  )('%s pins the project runtimes when its jobs use Bun', (workflowFile) => {
    const source = read(`.github/workflows/${workflowFile}`)
    const step = z.object({
      uses: z.string().optional(),
      run: z.string().optional(),
      with: z.record(z.string(), z.unknown()).optional(),
    })
    const workflow = z
      .object({
        jobs: z.record(z.string(), z.object({ steps: z.array(step) })),
      })
      .parse(parse(source))

    for (const job of Object.values(workflow.jobs)) {
      const node = job.steps.find((entry) => entry.uses?.startsWith('actions/setup-node@'))
      const bun = job.steps.find((entry) => entry.uses?.startsWith('oven-sh/setup-bun@'))
      if (job.steps.some((entry) => /\b(?:node|bun)\b/.test(entry.run ?? ''))) {
        expect(node, `${workflowFile} must install the project Node runtime`).toBeDefined()
      }
      if (job.steps.some((entry) => /\bbun\b/.test(entry.run ?? ''))) {
        expect(bun, `${workflowFile} must install the project Bun runtime`).toBeDefined()
      }
      if (node) expect(node.with?.['node-version']).toBe(EXPECTED_NODE)
      if (bun) expect(bun.with?.['bun-version']).toBe(EXPECTED_BUN)
    }
    expect(source).not.toMatch(/^\s*BUN_VERSION:/m)
  })

  it('resolves the local Node wrapper from the project pin', () => {
    const wrapper = read('sherlock/app/scripts/with-project-node.sh')

    expect(wrapper).toContain('$APP_DIR/.nvmrc')
    expect(wrapper).toContain('process.versions.node === process.argv[1]')
    expect(wrapper).toContain('exec "$@"')
    expect(wrapper).not.toContain('22.22.3')
    expect(wrapper).not.toContain('1.3.6')
  })
})
