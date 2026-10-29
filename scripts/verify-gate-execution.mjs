// The first workflow command installs dependencies. Remaining PR checks are independent.
export async function executeGateSteps(steps, { run, checkRepository, report = () => {} }) {
  async function execute(step, offset) {
    const started = performance.now()
    const result = { index: offset + 1, name: step.name, command: step.command }
    try {
      await checkRepository()
      report('start', result)
      const execution = await run(step, offset)
      Object.assign(result, execution)
      await checkRepository()
      result.status = execution.exitCode === 0 ? 'pass' : 'fail'
    } catch (error) {
      result.status = 'fail'
      result.failure = error instanceof Error ? error.message : String(error)
    }
    result.durationMs = Math.round(performance.now() - started)
    report('finish', result)
    return result
  }

  if (steps.length === 0) return []
  const install = await execute(steps[0], 0)
  if (install.status !== 'pass') return [install]
  // Each task catches its own failure; Promise.all drains every started check.
  const checks = await Promise.all(steps.slice(1).map((step, index) => execute(step, index + 1)))
  return [install, ...checks]
}
