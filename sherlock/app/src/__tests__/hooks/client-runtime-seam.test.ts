import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const read = (file: string) => readFileSync(join(process.cwd(), 'src/hooks', file), 'utf8')

describe('client hooks run through the client Effect runtime', () => {
  it.each(['useWorkOSAuth.ts', 'useNotifications.ts', 'useDevAuth.ts'] as const)(
    '%s imports runClientEffect and not the server runtime',
    (file) => {
      const source = read(file)

      expect(source).toContain("from '@/lib/effect/client-runtime'")
      expect(source).toContain('runClientEffect')
      expect(source).not.toContain("from '@/lib/effect/runtime'")
      expect(source).not.toContain('runServerEffect')
      expect(source).not.toMatch(/\bEffect\.run(?:Promise|Sync|Fork|PromiseExit|SyncExit)\s*\(/)
    }
  )

  it('does not mock the server runtime from the hook tests', () => {
    const workos = readFileSync(
      join(process.cwd(), 'src/__tests__/hooks/useWorkOSAuth.test.ts'),
      'utf8'
    )
    const notifications = readFileSync(
      join(process.cwd(), 'src/__tests__/hooks/useNotifications.test.ts'),
      'utf8'
    )

    expect(workos).not.toContain('lib/effect/runtime')
    expect(notifications).not.toContain('lib/effect/runtime')
  })
})
