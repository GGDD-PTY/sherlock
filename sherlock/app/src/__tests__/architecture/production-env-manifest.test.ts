import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

// Conditionally-required lanes deliberately NOT in the production manifest.
// Every entry must explain why a missing key cannot 500 a real production
// deploy; anything else conditionally required belongs in the manifest.
// Each entry names the env.ts gate expression that keeps the key out of a
// default production deploy, so an exclusion cannot silently widen.
const MANIFEST_EXCLUSIONS: Record<string, { gate: string; reason: string }> = {
  INTAKE_SERVER_SECRET: {
    gate: 'INTAKE_DEMO_MODE_ENABLED',
    reason:
      'opt-in demo lane: required only when INTAKE_DEMO_MODE=true; validate-prod-setup enforces the pair and the Convex mirror whenever the mode is on',
  },
  INTAKE_SERVER_AUDIENCE: {
    gate: 'INTAKE_DEMO_MODE_ENABLED',
    reason: 'same opt-in demo lane as INTAKE_SERVER_SECRET',
  },
}

// Every `{ name: '...', required: <expr>, ... }` block in env.ts, plus the
// mapped OAuth-scope block. The `required` expression is kept verbatim so the
// test can distinguish literal `false` (never required) from every conditional
// spelling (required in at least one production configuration).
function envVarEntries(source: string): { name: string; required: string }[] {
  const entries = [...source.matchAll(/\{\s*name:\s*'([^']+)',\s*required:\s*([^,]+),/g)].map(
    (match) => ({ name: match[1], required: match[2].trim() })
  )
  // Every mapped scope block, not just the first: a second surface adding its
  // own `...[...].map((name): EnvVar => ...)` must not slip past this parser.
  const mapped = source.matchAll(
    /\.\.\.\[([\s\S]*?)\]\.map\(\(name\): EnvVar => \(\{[\s\S]*?required:\s*([A-Za-z_!][A-Za-z0-9_]*)/g
  )
  for (const block of mapped) {
    entries.push(
      ...[...block[1].matchAll(/'([^']+)'/g)].map((match) => ({
        name: match[1],
        required: block[2],
      }))
    )
  }
  return entries
}

function manifestKeys(source: string): string[] {
  return [...source.matchAll(/key:\s*'([^']+)'/g)].map((match) => match[1])
}

describe('production environment manifest', () => {
  it('covers every runtime variable production can require', () => {
    const entries = envVarEntries(read('src/lib/env.ts'))
    const deployedKeys = new Set(manifestKeys(read('scripts/production-env-manifest.mjs')))

    // Sanity: the parser saw the real surface, not an empty match. The floor
    // sits under today's count (30 after the 2026-09-06 bridge cut removed the
    // model-run block); the named keys below are the real proof.
    expect(entries.length).toBeGreaterThan(20)
    const names = entries.map((entry) => entry.name)
    expect(names).toContain('WORKOS_API_KEY')
    expect(names).toContain('MCP_OAUTH_ISSUER')
    expect(names, 'the parser must see the provider-supported VDR OAuth scope').toContain(
      'VDR_MCP_OAUTH_SCOPE_BASE'
    )
    expect(names).toContain('UPSTASH_REDIS_REST_URL')
    expect(names).toContain('NEXT_PUBLIC_CONVEX_URL')

    const uncovered = entries
      .filter(({ required }) => required !== 'false')
      .filter(({ name }) => !deployedKeys.has(name) && !(name in MANIFEST_EXCLUSIONS))
      .map(({ name }) => name)
    expect(uncovered).toEqual([])
  })

  it('keeps the exclusion list honest', () => {
    const entries = new Map(
      envVarEntries(read('src/lib/env.ts')).map((entry) => [entry.name, entry.required])
    )
    for (const [name, exclusion] of Object.entries(MANIFEST_EXCLUSIONS)) {
      expect(entries.get(name), `${name} must stay gated by ${exclusion.gate}`).toBe(exclusion.gate)
    }
  })

  it('is the single required-key source for all production preflights', () => {
    for (const path of [
      'scripts/check-beta-env.mjs',
      'scripts/check-vercel-env.mjs',
      'scripts/validate-prod-setup.mjs',
    ]) {
      const source = read(path)
      expect(source).toContain("from './production-env-manifest.mjs'")
      expect(source).toContain('REQUIRED_PRODUCTION_APP_ENV')
      expect(source).toContain('VDR_MCP_PRODUCTION_ENV')
      expect(source).toContain('REDIS_RATE_LIMIT_PRODUCTION_ENV')
    }
  })
})
