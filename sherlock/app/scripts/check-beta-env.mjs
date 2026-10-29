#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  RATE_LIMIT_OPT_OUT,
  REDIS_RATE_LIMIT_PRODUCTION_ENV,
  REQUIRED_PRODUCTION_APP_ENV,
  VDR_MCP_PRODUCTION_ENV,
} from './production-env-manifest.mjs'

const root = process.cwd()
// .env.example y .env.template están trackeados en git: son los únicos archivos
// que existen siempre (también en CI, donde los .env reales no se checkean), y
// pueden portar flags peligrosos o nombres NEXT_PUBLIC_* secret-bearing que
// alguien copiará tal cual. Escanearlos mantiene el gate no-vacuo en CI.
const envFiles = [
  '.env',
  '.env.local',
  '.env.preview',
  '.env.preview.local',
  '.env.production',
  '.env.production.local',
  '.env.example',
  '.env.template',
]

const truthyValues = new Set(['1', 'true', 'yes', 'on'])
const betaBlockingTruthies = new Set([
  'BYPASS_AUTH',
  'NEXT_PUBLIC_BYPASS_AUTH',
  'NEXT_PUBLIC_DEV_AUTH_ENABLED',
])
const allowedPublicCredentialNames = new Set(['NEXT_PUBLIC_POSTHOG_KEY'])

function parseEnv(content) {
  const entries = []
  const map = new Map()

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const separator = normalized.indexOf('=')
    if (separator === -1) continue

    const key = normalized.slice(0, separator).trim()
    const value = normalized
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
    if (key) {
      entries.push({ key, value })
      map.set(key, value)
    }
  }

  return { entries, map }
}

const args = new Set(process.argv.slice(2))
const strictProd = args.has('--strict-prod')
const findings = []
let strictProdEnvFilesSeen = 0
let scannedFiles = 0

function isProductionEnvFile(envFile) {
  return envFile === '.env.production' || envFile === '.env.production.local'
}

function containsLegacyProductDomain(value) {
  return /(^|[.@/:])d[u]go\.(lat|capital)(?=$|[/:?@"\s>])/i.test(value)
}

for (const envFile of envFiles) {
  const fullPath = join(root, envFile)
  if (!existsSync(fullPath)) continue

  const { entries, map } = parseEnv(readFileSync(fullPath, 'utf8'))
  scannedFiles += 1
  const productionEnvFile = isProductionEnvFile(envFile)
  // Solo .env.local queda exento: es el único env file que ambos .vercelignore
  // excluyen del tarball del deploy manual. Todo lo demás — incluido .env, que
  // Next carga en build y runtime y SÍ viaja en el tarball — es deployable. El
  // discriminador es esa exclusión de deploy, no el gitignore (.env.production.local
  // también está gitignoreado y aun así debe fallar con flags de bypass).
  const deployableEnvFile = envFile !== '.env.local'

  for (const { key, value } of entries) {
    const lowerValue = value.toLowerCase()

    if (deployableEnvFile && betaBlockingTruthies.has(key) && truthyValues.has(lowerValue)) {
      findings.push({
        file: basename(envFile),
        key,
        reason: 'beta-blocking bypass or mock flag is enabled',
      })
    }

    if (
      key.startsWith('NEXT_PUBLIC_') &&
      !allowedPublicCredentialNames.has(key) &&
      /(SECRET|TOKEN|PRIVATE|PASSWORD|WEBHOOK|API_KEY|KEY)$/i.test(key)
    ) {
      findings.push({
        file: basename(envFile),
        key,
        reason: 'public browser-exposed variable name looks secret-bearing',
      })
    }

    if (
      ['NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_WORKOS_REDIRECT_URI'].includes(key) &&
      containsLegacyProductDomain(value)
    ) {
      findings.push({
        file: basename(envFile),
        key,
        reason: 'legacy product domain is not allowed for Sherlock beta',
      })
    }
  }

  if (strictProd && productionEnvFile) {
    strictProdEnvFilesSeen += 1
    for (const { key, reason } of REQUIRED_PRODUCTION_APP_ENV) {
      const value = map.get(key)
      if (!value || !value.trim()) {
        findings.push({
          file: basename(envFile),
          key,
          reason: `missing required prod key (${reason})`,
        })
      }
    }
    const conditionalLanes = [['VDR_MCP_ENABLED', 'VDR MCP', VDR_MCP_PRODUCTION_ENV]]
    for (const [flag, label, requiredKeys] of conditionalLanes) {
      const enabled = map.get(flag)
      if (enabled && enabled !== 'true' && enabled !== 'false') {
        findings.push({
          file: basename(envFile),
          key: flag,
          reason: 'must be exactly true or false',
        })
      }
      if (enabled !== 'true') continue
      for (const { key, reason } of requiredKeys) {
        const value = map.get(key)
        if (!value || !value.trim()) {
          findings.push({
            file: basename(envFile),
            key,
            reason: `missing enabled ${label} key (${reason})`,
          })
        }
      }
    }
    if (map.get(RATE_LIMIT_OPT_OUT.key)?.trim() !== RATE_LIMIT_OPT_OUT.value) {
      for (const { key, reason } of REDIS_RATE_LIMIT_PRODUCTION_ENV) {
        const value = map.get(key)
        if (!value || !value.trim()) {
          findings.push({
            file: basename(envFile),
            key,
            reason: `required unless ${RATE_LIMIT_OPT_OUT.key}=${RATE_LIMIT_OPT_OUT.value} (${reason})`,
          })
        }
      }
    }
  }
}

if (strictProd && strictProdEnvFilesSeen === 0) {
  findings.push({
    file: '.env.production*',
    key: 'STRICT_PROD_ENV_FILE',
    reason: 'no production env file found; strict prod cannot prove required prod keys',
  })
}

if (findings.length > 0) {
  console.error(
    strictProd
      ? 'Private beta env check failed (strict prod). Values are intentionally redacted.'
      : 'Private beta env check failed. Values are intentionally redacted.'
  )
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.key} (${finding.reason})`)
  }
  process.exit(1)
}

if (scannedFiles === 0) {
  // Con .env.example/.env.template trackeados esto no debería ocurrir nunca en un
  // checkout de git; si ocurre, el gate no examinó nada y un "pass" sería vacuo.
  console.warn(
    'WARNING: 0 env files scanned — the beta env gate examined nothing and this pass is vacuous.'
  )
}

console.log(
  strictProd
    ? `Private beta env check passed (strict prod, ${scannedFiles} env file(s) scanned). No blocking flags; required prod keys present.`
    : `Private beta env check passed (${scannedFiles} env file(s) scanned). No beta-blocking env flags found.`
)
