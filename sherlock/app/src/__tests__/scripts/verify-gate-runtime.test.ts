import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertRuntimeVersions,
  gateRuntimeEnvironment,
  parseRuntimePins,
} from '../../../../../scripts/verify-gate-runtime.mjs'

describe('verify:gate runtime pins', () => {
  const expected = { node: '24.20.0', bun: '1.4.2' }

  it('reads exact versions from the committed project metadata', () => {
    expect(parseRuntimePins('24.20.0\n', '{"packageManager":"bun@1.4.2"}')).toEqual(expected)
  })

  it.each(['24', 'lts/*', '>=24.20.0'])('rejects a floating Node selector: %s', (node) => {
    expect(() => parseRuntimePins(node, '{"packageManager":"bun@1.4.2"}')).toThrow(/exacta/)
  })

  it('rejects a floating or missing package manager', () => {
    expect(() => parseRuntimePins('24.20.0', '{"packageManager":"bun@latest"}')).toThrow(/exacta/)
    expect(() => parseRuntimePins('24.20.0', '{}')).toThrow(/exacta/)
  })

  it.each([
    { node: '26.7.0', bun: '1.4.2' },
    { node: '24.20.0', bun: '1.3.14' },
    { node: '24.20.0', bun: 'unknown' },
  ])('rejects a runtime mismatch: %j', (actual) => {
    expect(() => assertRuntimeVersions(actual, expected)).toThrow(/mise x/)
  })

  it('accepts the pinned runtimes', () => {
    expect(() => assertRuntimeVersions(expected, expected)).not.toThrow()
  })

  it('puts the gate Bun and pinned Node before global tools for child shells', () => {
    const parent = { PATH: `/global/bun/bin${path.delimiter}/usr/bin`, KEEP: 'value' }
    const environment = gateRuntimeEnvironment(
      parent,
      '/tools/bun/1.4.2/bin/bun',
      '/tools/node/24.20.0'
    )

    expect(environment.PATH.split(path.delimiter)).toEqual([
      '/tools/bun/1.4.2/bin',
      '/tools/node/24.20.0/bin',
      '/global/bun/bin',
      '/usr/bin',
    ])
    expect(environment.KEEP).toBe('value')
    expect(parent.PATH).toBe(`/global/bun/bin${path.delimiter}/usr/bin`)
  })
})
