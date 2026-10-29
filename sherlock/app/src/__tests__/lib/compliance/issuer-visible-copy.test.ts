import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const appRoot = process.cwd()

function read(relativePath: string) {
  return readFileSync(join(appRoot, relativePath), 'utf8')
}

function walkValues(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (node && typeof node === 'object') {
    return Object.values(node as Record<string, unknown>).flatMap(walkValues)
  }
  return []
}

describe('issuer/emisor user-visible copy veto', () => {
  it('keeps i18n values free of regulated issuer language', () => {
    // Identifiers and i18n keys may still say issuerPipeline / ISSUER_OWNER.
    // User-visible values may not: [F] 2026-08-14, "empresa" / "company" only.
    const vetoed = /\b(emisor|emisora|issuer)\b/i

    const file = 'src/messages/es.json'
    const offenders = walkValues(JSON.parse(read(file))).filter((value) => vetoed.test(value))
    expect(offenders, `${file} contains user-visible issuer/emisor copy`).toEqual([])
  })
})
