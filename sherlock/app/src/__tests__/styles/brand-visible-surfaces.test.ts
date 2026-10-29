import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const visibleSurfaceFiles = [
  'src/app/[locale]/layout.tsx',
  'src/app/robots.ts',
  'src/app/sitemap.ts',
  'src/app/[locale]/(public)/ayuda/page.tsx',
  'src/app/[locale]/(public)/privacy/page.tsx',
  'src/app/[locale]/(public)/terms/page.tsx',
  'src/app/[locale]/dev-login/layout.tsx',
  'src/app/[locale]/(public)/sign-in/[[...sign-in]]/page.tsx',
  'src/app/[locale]/sign-up/[[...sign-up]]/page.tsx',
  'src/app/[locale]/(app)/admin/page.tsx',
  'src/components/onboarding/WorkspaceProvisioning.tsx',
]

function readAppFile(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

const legacyBrandPattern = /D[Uu][Gg][Oo]|d[u][g]o\.capital|Casa Gede|CASA GEDE/g
const legacyBrandAnyCasePattern = /D[Uu][Gg][Oo]|d[u][g]o/g

describe('Sherlock visible brand surfaces', () => {
  it('does not leak legacy product/Casa Gede branding in selected visible surfaces', () => {
    const offenders = visibleSurfaceFiles.flatMap((file) => {
      const content = readAppFile(file)
      const matches = [...content.matchAll(legacyBrandPattern)]

      return matches.map((match) => `${file}: ${match[0]}`)
    })

    expect(offenders).toEqual([])
  })

  it('does not keep legacy product naming in active runtime, script, public, or e2e files', () => {
    const roots = ['src', 'convex', 'scripts', 'public', 'e2e']
    const files = roots.flatMap((root) => collectTextFiles(root))

    const offenders = files.flatMap((file) => {
      const content = readAppFile(file)
      const matches = [...content.matchAll(legacyBrandAnyCasePattern)]

      return matches.map((match) => `${file}: ${match[0]}`)
    })

    expect(offenders).toEqual([])
  })
})

function collectTextFiles(path: string): string[] {
  const fullPath = join(process.cwd(), path)
  const stats = statSync(fullPath)

  if (stats.isDirectory()) {
    return readdirSync(fullPath).flatMap((entry) => {
      if (
        ['.next', 'node_modules', 'coverage', 'playwright-report', 'test-results'].includes(entry)
      ) {
        return []
      }
      return collectTextFiles(join(path, entry))
    })
  }

  if (!/\.(cjs|css|html|js|json|mjs|svg|ts|tsx)$/.test(path)) {
    return []
  }

  return [path]
}
