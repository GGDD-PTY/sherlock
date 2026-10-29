import { spawn } from 'node:child_process'
import { open } from 'node:fs/promises'

export async function runGateCommand(command, env, repoRoot, logPath) {
  const log = logPath ? await open(logPath, 'w') : null
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('sh', ['-e', '-c', command], {
        cwd: repoRoot,
        stdio: log ? ['ignore', log.fd, log.fd] : 'inherit',
        env: { ...process.env, ...env },
      })
      child.on('error', reject)
      child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    })
  } finally {
    await log?.close()
  }
}
