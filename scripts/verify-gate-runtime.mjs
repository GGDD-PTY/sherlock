import path from 'node:path'

export function parseRuntimePins(nodeSource, packageSource) {
  const node = nodeSource.trim()
  const packageManager = JSON.parse(packageSource).packageManager
  if (!/^\d+\.\d+\.\d+$/.test(node)) {
    throw new Error('.nvmrc debe fijar una versión exacta de Node')
  }
  if (typeof packageManager !== 'string' || !/^bun@\d+\.\d+\.\d+$/.test(packageManager)) {
    throw new Error('packageManager debe fijar una versión exacta de Bun')
  }
  return { node, bun: packageManager.slice('bun@'.length) }
}

export function assertRuntimeVersions(actual, expected) {
  if (actual.bun !== expected.bun || actual.node !== expected.node) {
    throw new Error(
      `verify:gate exige Bun ${expected.bun} y Node ${expected.node}; ` +
        `recibió Bun ${actual.bun} y Node ${actual.node}. Usa mise x -- bun run verify:gate.`
    )
  }
}

export function gateRuntimeEnvironment(parentEnvironment, bunExecutable, nodeInstall) {
  return {
    ...parentEnvironment,
    PATH: [
      path.dirname(bunExecutable),
      path.join(nodeInstall, 'bin'),
      parentEnvironment.PATH ?? '',
    ].join(path.delimiter),
  }
}
