import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')
const SOURCE_ROOTS = ['src/app', 'src/components', 'src/hooks', 'src/lib', 'src/stores']
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs'])

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(absolute)
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [absolute] : []
  })
}

describe('deliverable renderer dependency boundary', () => {
  const appPackage = JSON.parse(
    fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')
  ) as Record<string, Record<string, string>>
  const sources = SOURCE_ROOTS.flatMap((root) => sourceFiles(path.join(APP_ROOT, root)))

  it('keeps Mermaid and the report viewer outside the app dependency graph', () => {
    expect(appPackage.dependencies?.mermaid).toBeUndefined()
    expect(appPackage.devDependencies?.mermaid).toBeUndefined()

    for (const file of sources) {
      const source = fs.readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/(?:from\s+|import\()['"]mermaid(?:['"]|\/)/)
      expect(source, file).not.toContain('repo-full-state-viewer')
    }
  })
})
