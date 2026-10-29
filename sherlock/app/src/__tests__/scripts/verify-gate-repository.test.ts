import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = resolve(process.cwd(), '../../scripts/verify-gate-repository.mjs')

type RepositoryState = { gitSha: string; status: string }
type RepositoryModule = {
  readRepositoryState: (repoRoot: string) => Promise<RepositoryState>
  assertCommittedRepository: (state: RepositoryState, expectedSha: string) => void
}

let repository: RepositoryModule
let repoRoot: string
let originalSha: string

function git(...args: string[]): string {
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) {
    if (name.startsWith('GIT_')) delete environment[name]
  }
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Gate fixture',
      '-c',
      'user.email=fixture-48a1278d@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: repoRoot, env: environment, encoding: 'utf8' }
  ).trim()
}

beforeAll(async () => {
  repository = await import(pathToFileURL(SCRIPT).href)
})

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'sherlock-gate-repository-'))
  git('init', '--quiet', '--template=')
  await writeFile(join(repoRoot, 'source.txt'), 'committed source\n')
  await writeFile(join(repoRoot, '.gitignore'), 'generated.log\n')
  git('add', 'source.txt', '.gitignore')
  git('commit', '--quiet', '-m', 'fixture baseline')
  originalSha = git('rev-parse', 'HEAD')
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

describe('verify:gate committed repository', () => {
  it('accepts the exact commit when the index and working tree are clean', async () => {
    const state = await repository.readRepositoryState(repoRoot)

    expect(state).toEqual({ gitSha: originalSha, status: '' })
    expect(() => repository.assertCommittedRepository(state, originalSha)).not.toThrow()
  })

  it.each(['modified', 'staged', 'untracked', 'deleted'] as const)(
    'rejects %s files before a gate can run',
    async (change) => {
      if (change === 'untracked') {
        git('config', 'status.showUntrackedFiles', 'no')
        await writeFile(join(repoRoot, 'new-source.txt'), 'untracked source\n')
      } else if (change === 'deleted') {
        await rm(join(repoRoot, 'source.txt'))
      } else {
        await writeFile(join(repoRoot, 'source.txt'), 'changed source\n')
        if (change === 'staged') git('add', 'source.txt')
      }

      const state = await repository.readRepositoryState(repoRoot)

      expect(state.gitSha).toBe(originalSha)
      expect(state.status).not.toBe('')
      expect(() => repository.assertCommittedRepository(state, originalSha)).toThrow(
        /cambios pendientes/
      )
    }
  )

  it('rejects edits made after the initial check even when HEAD does not change', async () => {
    const initial = await repository.readRepositoryState(repoRoot)
    repository.assertCommittedRepository(initial, originalSha)

    await writeFile(join(repoRoot, 'source.txt'), 'changed during a gate step\n')
    const final = await repository.readRepositoryState(repoRoot)

    expect(final.gitSha).toBe(initial.gitSha)
    expect(() => repository.assertCommittedRepository(final, originalSha)).toThrow(
      /cambios pendientes/
    )
  })

  it('rejects a different commit even if its working tree is clean', async () => {
    const initial = await repository.readRepositoryState(repoRoot)
    repository.assertCommittedRepository(initial, originalSha)

    await writeFile(join(repoRoot, 'source.txt'), 'next commit\n')
    git('add', 'source.txt')
    git('commit', '--quiet', '-m', 'fixture next commit')
    const final = await repository.readRepositoryState(repoRoot)

    expect(final.status).toBe('')
    expect(final.gitSha).not.toBe(originalSha)
    expect(() => repository.assertCommittedRepository(final, originalSha)).toThrow(/HEAD cambió/)
  })

  it('allows ignored build outputs without treating them as committed source', async () => {
    await writeFile(join(repoRoot, 'generated.log'), 'local build output\n')
    const state = await repository.readRepositoryState(repoRoot)

    expect(state.status).toBe('')
    expect(() => repository.assertCommittedRepository(state, originalSha)).not.toThrow()
  })
})
