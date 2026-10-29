// El runner de staging tiene que borrar test-results/ y playwright-report/
// cuando Playwright sale, en éxito y en fallo. Un fallo copia los headers
// (incluido el bypass) al call log, y el comentario de la spec dice que esas
// carpetas no quedan en disco.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = resolve(process.cwd(), 'scripts/run-staging-smoke.mjs')

function writeFakeBash(binDir: string, playwrightStatus: number) {
  const bashPath = join(binDir, 'bash')
  writeFileSync(
    bashPath,
    `#!/bin/sh
case " $* " in
  *e2e-browser-preflight.ts*) exit 0 ;;
  *playwright*)
    mkdir -p test-results playwright-report
    printf 'call log\\n' > test-results/call-log.txt
    printf 'report\\n' > playwright-report/index.html
    printf 'ran\\n' > playwright-ran
    exit ${playwrightStatus}
    ;;
esac
exit 1
`
  )
  chmodSync(bashPath, 0o755)
}

describe('run-staging-smoke', () => {
  let tempDir: string | undefined

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it.each([
    ['éxito', 0],
    ['fallo', 1],
  ] as const)(
    'borra test-results y playwright-report cuando playwright termina en %s',
    (_outcome, status) => {
      tempDir = mkdtempSync(join(tmpdir(), 'sherlock-staging-smoke-'))
      const binDir = join(tempDir, 'bin')
      mkdirSync(binDir)
      writeFakeBash(binDir, status)

      const env = {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        STAGING_E2E_BASE_URL: 'https://staging.example.test',
        VERCEL_AUTOMATION_BYPASS_SECRET: undefined,
      } as NodeJS.ProcessEnv

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: tempDir,
        env,
        encoding: 'utf8',
      })

      expect(existsSync(join(tempDir, 'playwright-ran'))).toBe(true)
      expect(result.status).toBe(status)
      expect(existsSync(join(tempDir, 'test-results'))).toBe(false)
      expect(existsSync(join(tempDir, 'playwright-report'))).toBe(false)
    }
  )
})
