#!/usr/bin/env node
// Exit 0 when every SHA given on argv has a green verify:local receipt in
// ~/Developer/sherlock-handoffs/verify-receipts (override: VERIFY_RECEIPTS_DIR).
// The pre-push hook uses it to skip the production build that verify:local
// already ran on that exact commit.
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_RECEIPTS_DIR = path.join(
  homedir(),
  'Developer',
  'sherlock-handoffs',
  'verify-receipts'
)

export async function greenReceiptShas(receiptsDir) {
  let names
  try {
    names = await readdir(receiptsDir)
  } catch {
    return new Set()
  }
  const green = new Set()
  for (const name of names) {
    if (!name.startsWith('verify-local-') || !name.endsWith('.json')) continue
    let receipt
    try {
      receipt = JSON.parse(await readFile(path.join(receiptsDir, name), 'utf8'))
    } catch {
      continue
    }
    if (receipt?.schemaVersion === 1 && receipt.status === 'pass' && typeof receipt.gitSha === 'string') {
      green.add(receipt.gitSha)
    }
  }
  return green
}

export async function missingReceipts(shas, receiptsDir = DEFAULT_RECEIPTS_DIR) {
  const green = await greenReceiptShas(receiptsDir)
  return shas.filter((sha) => !green.has(sha))
}

async function main(argv) {
  const shas = argv.filter((sha) => /^[0-9a-f]{40}$/.test(sha))
  if (shas.length === 0) {
    console.error('verify-receipt-check: no full SHA given')
    return 2
  }
  const dir = process.env.VERIFY_RECEIPTS_DIR || DEFAULT_RECEIPTS_DIR
  const missing = await missingReceipts(shas, dir)
  if (missing.length > 0) {
    console.error(`verify-receipt-check: no green receipt for ${missing.join(', ')}`)
    return 1
  }
  console.log(`verify-receipt-check: green receipt for ${shas.join(', ')}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)))
}
