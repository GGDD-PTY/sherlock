import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { executeGateSteps } from './verify-gate-execution.mjs'
import { runGateCommand } from './verify-gate-command.mjs'

const steps = ['install', 'lint', 'test'].map((name) => ({ name, command: name }))
const deferred = () => Promise.withResolvers()

test('waits for install, then starts independent checks together and drains failures', async () => {
  const install = deferred()
  const lint = deferred()
  const tests = deferred()
  const allStarted = deferred()
  const events = []
  let finished = false
  const execution = executeGateSteps(steps, {
    checkRepository: async () => {},
    run: async (step) => {
      events.push(step.name)
      if (events.length === 3) allStarted.resolve()
      return { exitCode: await ({ install, lint, test: tests }[step.name].promise) }
    },
  }).then((results) => { finished = true; return results })
  await new Promise(setImmediate)
  assert.deepEqual(events, ['install'])
  install.resolve(0)
  await allStarted.promise
  assert.deepEqual(events, ['install', 'lint', 'test'])
  lint.resolve(1)
  await new Promise(setImmediate)
  assert.equal(finished, false)
  tests.resolve(0)
  assert.deepEqual((await execution).map((result) => result.status), ['pass', 'fail', 'pass'])
})

test('does not start checks after a failed installation', async () => {
  const calls = []
  const results = await executeGateSteps(steps, {
    checkRepository: async () => {},
    run: async (step) => { calls.push(step.name); return { exitCode: 1 } },
  })
  assert.deepEqual(calls, ['install'])
  assert.equal(results[0].status, 'fail')
})

test('records repository changes and drains other running checks', async () => {
  let changed = false
  const results = await executeGateSteps(steps, {
    checkRepository: async () => { if (changed) throw new Error('HEAD changed') },
    run: async (step) => {
      if (step.name === 'lint') changed = true
      return { exitCode: 0 }
    },
  })
  assert.equal(results.length, 3)
  assert.equal(results[1].status, 'fail')
  assert.equal(results[1].failure, 'HEAD changed')
  assert.equal(results[2].status, 'fail')
})

test('writes separate stdout and stderr logs and propagates shell failures', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gate-logs-'))
  try {
    const first = path.join(directory, 'first.log')
    const second = path.join(directory, 'second.log')
    const exits = await Promise.all([
      runGateCommand('printf first; printf error >&2; false; printf unreachable', {}, directory, first),
      runGateCommand('printf "$GATE_VALUE"', { GATE_VALUE: 'second' }, directory, second),
    ])
    assert.deepEqual(exits, [1, 0])
    assert.equal(await readFile(first, 'utf8'), 'firsterror')
    assert.equal(await readFile(second, 'utf8'), 'second')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('drains another check after a runner throws', async () => {
  const slow = deferred()
  const started = deferred()
  let finished = false
  const execution = executeGateSteps(steps, {
    checkRepository: async () => {},
    run: async (step) => {
      if (step.name === 'lint') throw new Error('could not spawn')
      if (step.name === 'test') { started.resolve(); await slow.promise }
      return { exitCode: 0 }
    },
  }).then((results) => { finished = true; return results })
  await started.promise
  await new Promise(setImmediate)
  assert.equal(finished, false)
  slow.resolve()
  const results = await execution
  assert.equal(results[1].failure, 'could not spawn')
  assert.equal(results[2].status, 'pass')
})
