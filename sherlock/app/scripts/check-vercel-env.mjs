#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

import {
  INTAKE_PRODUCTION_ENV,
  RATE_LIMIT_OPT_OUT,
  REDIS_RATE_LIMIT_PRODUCTION_ENV,
  REQUIRED_PRODUCTION_APP_ENV,
  VDR_MCP_PRODUCTION_ENV,
} from './production-env-manifest.mjs'

const environmentArg = process.argv.find((arg) => arg.startsWith('--environment='))
const environment = environmentArg?.slice('--environment='.length) || 'production'
const expectVdrMcp = process.argv.includes('--vdr-mcp-enabled')
const expectIntake = process.argv.includes('--intake-enabled')
const forbiddenProductionKeys = new Set([
  'BYPASS_AUTH',
  'NEXT_PUBLIC_BYPASS_AUTH',
  'NEXT_PUBLIC_DEV_AUTH_ENABLED',
])
const result = spawnSync('vercel', ['env', 'ls', environment, '--json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  timeout: 60_000,
})

if (result.status !== 0) {
  console.error(`Unable to list Vercel ${environment} environment metadata.`)
  process.exit(1)
}

let payload
try {
  payload = JSON.parse(result.stdout)
} catch {
  console.error(`Vercel ${environment} environment metadata was not valid JSON.`)
  process.exit(1)
}

if (!payload || !Array.isArray(payload.envs)) {
  console.error(`Vercel ${environment} environment metadata did not contain an env list.`)
  process.exit(1)
}

const configuredEntries = payload.envs.filter(
  (entry) =>
    entry &&
    typeof entry.key === 'string' &&
    Array.isArray(entry.target) &&
    entry.target.includes(environment)
)
const configuredKeys = new Set(configuredEntries.map((entry) => entry.key))
const writeOnlyKeys = new Set(
  configuredEntries.filter((entry) => entry.type === 'sensitive').map((entry) => entry.key)
)
const findings = []

const requiredEnv = [
  ...new Map(
    [
      ...REQUIRED_PRODUCTION_APP_ENV,
      ...(expectVdrMcp ? VDR_MCP_PRODUCTION_ENV : []),
      ...(expectIntake ? INTAKE_PRODUCTION_ENV : []),
    ].map((entry) => [entry.key, entry])
  ).values(),
]
for (const { key } of requiredEnv) {
  if (!configuredKeys.has(key)) findings.push(`${key}: missing from Vercel ${environment}`)
}
const missingRedisKeys = REDIS_RATE_LIMIT_PRODUCTION_ENV.filter(
  ({ key }) => !configuredKeys.has(key)
)
if (missingRedisKeys.length > 0 && !configuredKeys.has(RATE_LIMIT_OPT_OUT.key)) {
  for (const { key } of missingRedisKeys) {
    findings.push(
      `${key}: missing from Vercel ${environment} (required unless ${RATE_LIMIT_OPT_OUT.key}=${RATE_LIMIT_OPT_OUT.value}; metadata is value-blind, so the opt-out key itself must be configured)`
    )
  }
}
if (environment === 'production') {
  for (const key of forbiddenProductionKeys) {
    if (configuredKeys.has(key)) findings.push(`${key}: forbidden in Vercel production`)
  }
}

if (findings.length > 0) {
  console.error(`Vercel ${environment} env metadata check failed. Values remain redacted.`)
  for (const finding of findings) console.error(`- ${finding}`)
  process.exit(1)
}

console.log(
  `Vercel ${environment} env metadata passed (${configuredKeys.size} configured keys; values not validated).`
)
if (writeOnlyKeys.size > 0) {
  console.log(`UNKNOWN: ${writeOnlyKeys.size} write-only values — verify in Vercel.`)
}
