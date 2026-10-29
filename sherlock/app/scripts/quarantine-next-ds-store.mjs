import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

const appDir = process.cwd()
const nextServerDir = path.join(appDir, '.next', 'server')
const quarantineDir = path.join(appDir, '.next', 'ds-store-quarantine')
const ignoredDirs = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  'coverage',
  'node_modules',
  'playwright-report',
  'test-results',
])

quarantineDsStoreFiles(appDir, appDir)

if (existsSync(nextServerDir)) {
  quarantineDsStoreFiles(nextServerDir, nextServerDir)
}

function quarantineDsStoreFiles(dir, rootDir) {
  for (const entry of readdirSync(dir)) {
    const source = path.join(dir, entry)

    if (entry === '.DS_Store') {
      mkdirSync(quarantineDir, { recursive: true })
      const rootLabel = rootDir === appDir ? 'app' : 'next-server'
      const relativeDir = path.relative(rootDir, dir).replaceAll(path.sep, '__') || 'root'
      const target = path.join(quarantineDir, `${relativeDir}-${Date.now()}.DS_Store`)
      const labeledTarget = path.join(quarantineDir, `${rootLabel}-${path.basename(target)}`)
      renameSync(source, target)
      renameSync(target, labeledTarget)
      continue
    }

    if (statSync(source).isDirectory() && !ignoredDirs.has(entry)) {
      quarantineDsStoreFiles(source, rootDir)
    }
  }
}
