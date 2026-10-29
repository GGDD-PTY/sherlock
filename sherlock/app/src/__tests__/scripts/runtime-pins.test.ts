import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

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
  )('%s uses the project Node and Bun pins', (workflowFile) => {
    const workflow = read(`.github/workflows/${workflowFile}`)

    expect(workflow).toContain(`node-version: '${EXPECTED_NODE}'`)
    expect(workflow).toContain(`bun-version: '${EXPECTED_BUN}'`)
    expect(workflow).not.toMatch(/^\s*BUN_VERSION:/m)
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
