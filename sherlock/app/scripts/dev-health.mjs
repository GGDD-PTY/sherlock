#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(scriptDir, '..')
const repoDir = path.resolve(appDir, '..', '..')
const requireFromScript = createRequire(import.meta.url)
const strict = process.argv.includes('--strict')

const excludedWatchDirs = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'test-results',
])

const supportedSegmentRuntimes = new Set(['nodejs', 'edge'])
const deprecatedSegmentRuntimes = new Set(['experimental-edge'])
const results = []

function addResult(status, title, details = []) {
  results.push({ status, title, details })
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function readTextIfExists(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8').trim() : null
}

function shell(command) {
  return execFileSync('bash', ['-lc', command], {
    cwd: appDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function parseVersion(raw) {
  const match = String(raw)
    .trim()
    .replace(/^v/, '')
    .match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)

  if (!match) {
    return null
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    raw: String(raw),
  }
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] > right[key]) return 1
    if (left[key] < right[key]) return -1
  }

  return 0
}

function satisfiesComparator(version, operator, target) {
  const comparison = compareVersions(version, target)

  switch (operator) {
    case '>':
      return comparison > 0
    case '>=':
      return comparison >= 0
    case '<':
      return comparison < 0
    case '<=':
      return comparison <= 0
    case '=':
      return comparison === 0
    default:
      return null
  }
}

function satisfiesRange(versionRaw, rangeRaw) {
  const version = parseVersion(versionRaw)
  const range = String(rangeRaw ?? '').trim()

  if (!version || !range) {
    return null
  }

  return range.split('||').some((rangePart) => {
    const comparators = rangePart.split(/\s+/).filter(Boolean)

    if (comparators.length === 0) {
      return true
    }

    return comparators.every((comparator) => {
      const match = comparator.match(/^(>=|<=|>|<|=)?v?(\d+(?:\.\d+){0,2})$/)

      if (!match) {
        return false
      }

      const target = parseVersion(match[2])
      const operator = match[1] ?? '='

      return target ? satisfiesComparator(version, operator, target) : false
    })
  })
}

function satisfiesNvmrc(versionRaw, nvmrcRaw) {
  const version = parseVersion(versionRaw)
  const value = String(nvmrcRaw ?? '')
    .trim()
    .replace(/^v/, '')

  if (!version || !value) {
    return null
  }

  if (value === 'node' || value.startsWith('lts/')) {
    return null
  }

  const parts = value.split('.').map(Number)

  if (parts.some(Number.isNaN)) {
    return null
  }

  if (parts.length === 1) {
    return version.major === parts[0]
  }

  if (parts.length === 2) {
    return version.major === parts[0] && version.minor === parts[1]
  }

  return version.major === parts[0] && version.minor === parts[1] && version.patch === parts[2]
}

function isPathInside(child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function checkNode() {
  const packageJson = readJson(path.join(appDir, 'package.json'))
  const nvmrc = readTextIfExists(path.join(appDir, '.nvmrc'))
  const nodeVersion = process.versions.node
  const details = [`active Node: v${nodeVersion}`, `node path: ${process.execPath}`]
  const failures = []
  const warnings = []

  if (packageJson.engines?.node) {
    const engineResult = satisfiesRange(nodeVersion, packageJson.engines.node)

    details.push(`package engine: ${packageJson.engines.node}`)

    if (engineResult === false) {
      failures.push(`active Node does not satisfy package.json engines.node`)
    } else if (engineResult === null) {
      warnings.push(`could not parse package.json engines.node: ${packageJson.engines.node}`)
    }
  }

  if (nvmrc) {
    const nvmResult = satisfiesNvmrc(nodeVersion, nvmrc)

    details.push(`.nvmrc: ${nvmrc}`)

    if (nvmResult === false) {
      failures.push(`active Node does not match .nvmrc`)
    } else if (nvmResult === null) {
      warnings.push(`could not parse .nvmrc value: ${nvmrc}`)
    }
  }

  if (process.versions.bun) {
    warnings.push(
      `preflight is running inside Bun ${process.versions.bun}; Next dev should still be launched through Node`
    )
  }

  if (failures.length > 0) {
    addResult('fail', 'Node version is not the project Node', [
      ...details,
      ...failures,
      `run: bash scripts/with-project-node.sh node scripts/dev-health.mjs`,
    ])
  } else if (warnings.length > 0) {
    addResult('warn', 'Node version check needs attention', [...details, ...warnings])
  } else {
    addResult('ok', 'Node version matches project expectations', details)
  }
}

function walkFiles(rootDir, visitor) {
  if (!existsSync(rootDir)) {
    return
  }

  const stack = [rootDir]

  while (stack.length > 0) {
    const currentDir = stack.pop()
    let entries

    try {
      entries = readdirSync(currentDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)

      if (entry.isDirectory()) {
        if (!excludedWatchDirs.has(entry.name)) {
          stack.push(fullPath)
        }
        continue
      }

      if (entry.isFile()) {
        visitor(fullPath)
      }
    }
  }
}

function scanRuntimeExports() {
  const appSourceDir = path.join(appDir, 'src', 'app')
  const runtimePattern = /export\s+const\s+runtime\s*=\s*(['"`])([^'"`]+)\1/g
  const findings = []

  walkFiles(appSourceDir, (filePath) => {
    if (!/\.(ts|tsx|js|jsx)$/.test(filePath)) {
      return
    }

    const source = readFileSync(filePath, 'utf8')
    let match

    while ((match = runtimePattern.exec(source)) !== null) {
      findings.push({
        filePath,
        runtime: match[2],
      })
    }
  })

  return findings
}

function checkNextRuntime() {
  const details = []
  const failures = []
  const warnings = []
  let nextPackagePath

  try {
    nextPackagePath = requireFromScript.resolve('next/package.json')
  } catch {
    nextPackagePath = null
  }

  if (!nextPackagePath || !existsSync(nextPackagePath)) {
    addResult('fail', 'Next dependency is not installed', [
      `missing: resolvable next/package.json from ${appDir}`,
      `run: bun install`,
    ])
    return
  }

  const nextPackage = readJson(nextPackagePath)

  details.push(`installed Next: ${nextPackage.version}`)

  if (nextPackage.engines?.node) {
    const nextEngineResult = satisfiesRange(process.versions.node, nextPackage.engines.node)

    details.push(`Next Node engine: ${nextPackage.engines.node}`)

    if (nextEngineResult === false) {
      failures.push(`active Node does not satisfy Next's own Node engine`)
    } else if (nextEngineResult === null) {
      warnings.push(`could not parse Next Node engine: ${nextPackage.engines.node}`)
    }
  }

  if (process.env.NEXT_RUNTIME) {
    if (!supportedSegmentRuntimes.has(process.env.NEXT_RUNTIME)) {
      failures.push(`NEXT_RUNTIME is set to unsupported value: ${process.env.NEXT_RUNTIME}`)
    } else {
      warnings.push(
        `NEXT_RUNTIME is already set to ${process.env.NEXT_RUNTIME}; normally leave it unset before next dev`
      )
    }
  }

  const runtimeExports = scanRuntimeExports()
  const invalidRuntimeExports = runtimeExports.filter(
    (finding) =>
      !supportedSegmentRuntimes.has(finding.runtime) &&
      !deprecatedSegmentRuntimes.has(finding.runtime)
  )
  const deprecatedRuntimeExports = runtimeExports.filter((finding) =>
    deprecatedSegmentRuntimes.has(finding.runtime)
  )

  if (runtimeExports.length === 0) {
    details.push('route runtime exports: none found')
  } else {
    details.push(`route runtime exports found: ${runtimeExports.length}`)
  }

  for (const finding of invalidRuntimeExports) {
    failures.push(
      `${path.relative(appDir, finding.filePath)} exports unsupported runtime "${finding.runtime}"`
    )
  }

  for (const finding of deprecatedRuntimeExports) {
    warnings.push(
      `${path.relative(appDir, finding.filePath)} exports deprecated runtime "${finding.runtime}"`
    )
  }

  if (failures.length > 0) {
    addResult('fail', 'Next runtime configuration is unsupported', [...details, ...failures])
  } else if (warnings.length > 0) {
    addResult('warn', 'Next runtime configuration has warnings', [...details, ...warnings])
  } else {
    addResult('ok', 'Next runtime configuration is supported', details)
  }
}

function getOpenFileLimit() {
  try {
    const output = shell('ulimit -n')

    if (output === 'unlimited') {
      return Number.POSITIVE_INFINITY
    }

    const parsed = Number(output)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

function countWatchEntries() {
  const counts = {
    directories: 0,
    files: 0,
    skippedErrors: 0,
    byTopLevel: new Map(),
  }

  const stack = [{ dir: appDir, topLevel: '.' }]

  while (stack.length > 0) {
    const current = stack.pop()
    let entries

    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      counts.skippedErrors += 1
      continue
    }

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name)
      const topLevel = current.topLevel === '.' ? entry.name : current.topLevel

      if (entry.isDirectory()) {
        if (excludedWatchDirs.has(entry.name)) {
          continue
        }

        counts.directories += 1
        counts.byTopLevel.set(topLevel, (counts.byTopLevel.get(topLevel) ?? 0) + 1)
        stack.push({ dir: fullPath, topLevel })
        continue
      }

      if (entry.isFile() || entry.isSymbolicLink()) {
        counts.files += 1
        counts.byTopLevel.set(topLevel, (counts.byTopLevel.get(topLevel) ?? 0) + 1)
      }
    }
  }

  return counts
}

function checkWatchRisk() {
  const counts = countWatchEntries()
  const totalEntries = counts.files + counts.directories
  const openFileLimit = getOpenFileLimit()
  const warnings = []
  const details = [
    `watchable entries scanned: ${totalEntries} (${counts.files} files, ${counts.directories} directories)`,
    `excluded directories: ${Array.from(excludedWatchDirs).sort().join(', ')}`,
  ]

  if (openFileLimit === Number.POSITIVE_INFINITY) {
    details.push('open-file limit: unlimited')
  } else if (openFileLimit === null) {
    warnings.push('could not read open-file limit with ulimit -n')
  } else {
    details.push(`open-file limit: ${openFileLimit}`)

    if (openFileLimit < 2048) {
      warnings.push('open-file limit is low for a large Next dev session')
    }

    if (totalEntries > Math.max(2000, openFileLimit * 0.75)) {
      warnings.push('watchable entry count is high relative to the current open-file limit')
    }
  }

  if (totalEntries > 12000) {
    warnings.push('watchable entry count is high even after excluding generated/vendor directories')
  }

  if (counts.skippedErrors > 0) {
    warnings.push(`skipped ${counts.skippedErrors} directories that could not be read`)
  }

  const topLevelCounts = Array.from(counts.byTopLevel.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([name, count]) => `${name}: ${count}`)

  if (topLevelCounts.length > 0) {
    details.push(`largest top-level counts: ${topLevelCounts.join('; ')}`)
  }

  if (warnings.length > 0) {
    addResult('warn', 'File-watch risk needs attention', [...details, ...warnings])
  } else {
    addResult('ok', 'File-watch risk looks normal', details)
  }
}

function readProcessCwd(pid) {
  try {
    const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const cwdLine = output.split('\n').find((line) => line.startsWith('n'))
    return cwdLine ? cwdLine.slice(1) : null
  } catch {
    return null
  }
}

function looksLikeNextProcess(command) {
  return (
    /\bnext\b\s+(dev|start)\b/.test(command) ||
    /node_modules\/next\/dist\/bin\/next\s+(dev|start)\b/.test(command) ||
    /\bnext-server\b/.test(command)
  )
}

function parseProcesses() {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
        return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null
      })
      .filter(Boolean)
  } catch {
    return null
  }
}

function checkLingeringNext() {
  const processes = parseProcesses()

  if (!processes) {
    addResult('warn', 'Could not inspect running processes', ['ps command failed'])
    return
  }

  const currentPid = process.pid
  const processByPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]))
  const launcherPids = new Set([currentPid])
  let parentPid = processByPid.get(currentPid)?.ppid

  while (parentPid && parentPid > 1 && !launcherPids.has(parentPid)) {
    launcherPids.add(parentPid)
    parentPid = processByPid.get(parentPid)?.ppid
  }

  const nextProcesses = processes
    .filter((processInfo) => !launcherPids.has(processInfo.pid))
    .filter((processInfo) => looksLikeNextProcess(processInfo.command))
    .map((processInfo) => ({
      ...processInfo,
      cwd: readProcessCwd(processInfo.pid),
    }))

  const repoProcesses = nextProcesses.filter((processInfo) => {
    return (
      processInfo.cwd &&
      (isPathInside(processInfo.cwd, appDir) || isPathInside(processInfo.cwd, repoDir))
    )
  })
  const unknownCwdProcesses = nextProcesses.filter((processInfo) => !processInfo.cwd)

  if (repoProcesses.length > 0) {
    addResult(
      'warn',
      'Lingering Next process found for this workspace',
      repoProcesses.map(
        (processInfo) =>
          `pid ${processInfo.pid}, cwd ${processInfo.cwd}, command: ${processInfo.command.slice(0, 140)}`
      )
    )
    return
  }

  if (unknownCwdProcesses.length > 0) {
    addResult(
      'warn',
      'Possible lingering Next process found',
      unknownCwdProcesses.map(
        (processInfo) =>
          `pid ${processInfo.pid}, cwd unavailable, command: ${processInfo.command.slice(0, 140)}`
      )
    )
    return
  }

  addResult('ok', 'No lingering Next processes detected for this workspace')
}

function printResults() {
  const labels = {
    fail: 'FAIL',
    ok: 'OK',
    warn: 'WARN',
  }

  console.log('Sherlock dev health preflight')
  console.log(`App: ${appDir}`)
  console.log('')

  for (const result of results) {
    console.log(`[${labels[result.status]}] ${result.title}`)

    for (const detail of result.details) {
      console.log(`  - ${detail}`)
    }
  }

  const failures = results.filter((result) => result.status === 'fail')
  const warnings = results.filter((result) => result.status === 'warn')

  console.log('')

  if (failures.length > 0) {
    console.error(`Preflight failed: ${failures.length} blocker(s), ${warnings.length} warning(s).`)
    process.exitCode = 1
    return
  }

  if (strict && warnings.length > 0) {
    console.error(`Preflight strict mode failed: ${warnings.length} warning(s).`)
    process.exitCode = 1
    return
  }

  console.log(`Preflight completed: ${warnings.length} warning(s).`)
}

checkNode()
checkNextRuntime()
checkWatchRisk()
checkLingeringNext()
printResults()
