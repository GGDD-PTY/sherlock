import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export async function readRepositoryState(repoRoot) {
  const { stdout: gitSha } = await execute('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repoRoot,
  })
  const { stdout: status } = await execute(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'],
    { cwd: repoRoot }
  )
  return { gitSha: gitSha.trim(), status }
}

export function assertCommittedRepository(state, expectedSha) {
  if (state.gitSha !== expectedSha) {
    throw new Error(`HEAD cambió durante verify:gate: ${expectedSha} -> ${state.gitSha}`)
  }
  if (state.status !== '') {
    throw new Error(
      'verify:gate exige un commit sin cambios pendientes: hay archivos modificados, ' +
        'staged o sin seguimiento. Consulta git status --short.'
    )
  }
}
