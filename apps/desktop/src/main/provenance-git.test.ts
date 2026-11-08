import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { SkillProvenance } from '@skillbuddy/core'
import { inspectGitSource } from './provenance-git'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

it('fetches and compares a real upstream while reporting local changes', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'skill-git-source-'))
  roots.push(root)
  const repo = join(root, 'repo')
  const upstream = join(root, 'upstream.git')
  const origin = join(root, 'origin.git')
  await fs.mkdir(repo)
  const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  run(root, 'init', '--bare', '-q', upstream)
  run(root, 'init', '--bare', '-q', origin)
  run(repo, 'init', '-q', '-b', 'main')
  run(repo, 'remote', 'add', 'upstream', upstream)
  run(repo, 'remote', 'add', 'origin', origin)
  await fs.writeFile(join(repo, 'SKILL.md'), 'first\n')
  run(repo, 'add', '.')
  run(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'first')
  const first = run(repo, 'rev-parse', 'HEAD')
  run(repo, 'push', '-q', 'upstream', 'HEAD:refs/heads/main')
  await fs.writeFile(join(repo, 'SKILL.md'), 'second\n')
  run(repo, 'add', '.')
  run(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'second')
  const second = run(repo, 'rev-parse', 'HEAD')
  run(repo, 'push', '-q', 'upstream', 'HEAD:refs/heads/main')
  run(repo, 'reset', '--keep', first)
  run(repo, 'update-ref', 'refs/remotes/upstream/main', first)
  run(repo, 'symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/main')
  const source: Extract<SkillProvenance, { kind: 'git' }> = { kind: 'git', upstream, origin, commit: first, dirty: false, managedPath: repo, manifestPath: join(root, 'manifest.json') }
  const result = await inspectGitSource(source, true)
  expect(result).toMatchObject({ commit: first, upstreamCommit: second, dirty: false, fetched: true })
  expect(result.diff).toContain('+second')
  await fs.writeFile(join(repo, 'SKILL.md'), 'local\n')
  expect(await inspectGitSource(source, false)).toMatchObject({ dirty: true, fetched: false })
  run(repo, 'remote', 'set-url', 'origin', join(root, 'other.git'))
  await expect(inspectGitSource(source, false)).rejects.toThrow('Git source remotes changed')
})
