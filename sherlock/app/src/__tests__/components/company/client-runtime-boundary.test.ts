import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const APP_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const BARE_RUN = /\bEffect\.run(?:Promise|Sync|Fork|PromiseExit|SyncExit)\s*\(/

const ROOTS = [
  'src/components/company',
  'src/components/documents',
  'src/lib/documents',
  'src/lib/vdr',
  'src/hooks/useDirectVdrUpload.ts',
]

function filesUnder(root: string): string[] {
  const abs = path.join(APP_ROOT, root)
  const stat = fs.statSync(abs)
  if (stat.isFile()) return [abs]

  const out: string[] = []
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const file = path.join(abs, entry.name)
    if (entry.isDirectory()) {
      out.push(...filesUnder(path.relative(APP_ROOT, file)))
      continue
    }
    if (file.endsWith('.ts') || file.endsWith('.tsx')) out.push(file)
  }
  return out
}

describe('sala client Effect runtime', () => {
  it('runs browser sala programs through the client runtime, never bare Effect.run*', () => {
    const violations = ROOTS.flatMap(filesUnder)
      .filter((file) => BARE_RUN.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(APP_ROOT, file))
      .toSorted()

    expect(violations).toEqual([])
  })
})
