// El pre-push salta la build cuando cada SHA empujado tiene un recibo verde de
// verify:local. El script se importa desde el ROOT y se prueba contra un
// directorio temporal de recibos, nunca contra ~/Developer/sherlock-handoffs.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = resolve(process.cwd(), '../../scripts/verify-receipt-check.mjs')
const GREEN = 'a'.repeat(40)
const RED = 'b'.repeat(40)
const UNKNOWN = 'c'.repeat(40)

type Checker = {
  missingReceipts: (shas: string[], dir: string) => Promise<string[]>
}

let dir: string
let checker: Checker

async function receipt(name: string, body: unknown) {
  await writeFile(join(dir, name), `${JSON.stringify(body)}\n`, 'utf8')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verify-receipts-'))
  checker = (await import(pathToFileURL(SCRIPT).href)) as Checker
  await receipt('verify-local-20260902T013807Z-aaaaaaaaaaaa.json', {
    schemaVersion: 1,
    status: 'pass',
    gitSha: GREEN,
    steps: [{ name: 'production build', status: 'pass' }],
  })
  await receipt('verify-local-failure-20260901T114837Z-bbbbbbbbbbbb.json', {
    schemaVersion: 1,
    status: 'fail',
    gitSha: RED,
    steps: [{ name: 'production build', status: 'pass' }],
  })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('verify-receipt-check', () => {
  it('acepta un SHA con recibo verde', async () => {
    await expect(checker.missingReceipts([GREEN], dir)).resolves.toEqual([])
  })

  it('rechaza un SHA cuyo recibo está en rojo aunque un paso diga pass', async () => {
    await expect(checker.missingReceipts([RED], dir)).resolves.toEqual([RED])
  })

  it('rechaza un SHA sin recibo y nombra al que falta', async () => {
    await expect(checker.missingReceipts([GREEN, UNKNOWN], dir)).resolves.toEqual([UNKNOWN])
  })

  it('ignora recibos ilegibles y directorios ausentes', async () => {
    await writeFile(join(dir, 'verify-local-broken.json'), '{not json', 'utf8')
    await expect(checker.missingReceipts([GREEN], dir)).resolves.toEqual([])
    await expect(checker.missingReceipts([GREEN], join(dir, 'nope'))).resolves.toEqual([GREEN])
  })
})
