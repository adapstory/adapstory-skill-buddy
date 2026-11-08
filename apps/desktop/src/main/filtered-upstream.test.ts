import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncFilteredUpstream } from './filtered-upstream'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function git(cwd: string | undefined, ...args: string[]): string {
  return execFileSync('git', cwd ? ['-C', cwd, ...args] : args, { encoding: 'utf8' }).trim()
}

async function fixture(targetSubmodule = false) {
  const root = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-filtered-upstream-'))
  roots.push(root)
  const source = join(root, 'source')
  const origin = join(root, 'origin.git')
  const target = join(root, 'managed')
  await fs.mkdir(source)
  git(undefined, 'init', '--quiet', '--bare', '--initial-branch=main', origin)
  git(undefined, 'init', '--quiet', '--initial-branch=main', source)
  git(source, 'config', 'user.name', 'Fixture')
  git(source, 'config', 'user.email', 'fixture@example.invalid')
  if (!targetSubmodule) {
    await fs.mkdir(target)
    git(undefined, 'init', '--quiet', '--initial-branch=main', target)
  }
  const repositories = targetSubmodule ? [source] : [source, target]
  for (const repo of repositories) {
    git(repo, 'config', 'user.name', 'Fixture')
    git(repo, 'config', 'user.email', 'fixture@example.invalid')
  }
  git(source, 'remote', 'add', 'origin', origin)
  await fs.mkdir(join(source, 'frontend-design'))
  await fs.mkdir(join(source, 'restricted'))
  await fs.writeFile(join(source, 'frontend-design', 'SKILL.md'), '# Frontend design v1\n')
  await fs.writeFile(join(source, 'restricted', 'private.txt'), 'restricted fixture data\n')
  await commit(source, 'initial skill')
  git(source, 'push', '--quiet', '--set-upstream', 'origin', 'main')
  if (targetSubmodule) {
    const targetRemote = join(root, 'target.git')
    const seed = join(root, 'target-seed')
    const parent = join(root, 'parent')
    await fs.mkdir(seed)
    await fs.mkdir(parent)
    git(undefined, 'init', '--quiet', '--bare', '--initial-branch=main', targetRemote)
    git(undefined, 'init', '--quiet', '--initial-branch=main', seed)
    git(seed, 'config', 'user.name', 'Fixture')
    git(seed, 'config', 'user.email', 'fixture@example.invalid')
    await fs.writeFile(join(seed, 'README.md'), 'managed repository\n')
    await commit(seed, 'managed root')
    git(seed, 'remote', 'add', 'origin', targetRemote)
    git(seed, 'push', '--quiet', '--set-upstream', 'origin', 'main')
    git(undefined, 'init', '--quiet', '--initial-branch=main', parent)
    git(parent, 'config', 'user.name', 'Fixture')
    git(parent, 'config', 'user.email', 'fixture@example.invalid')
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', targetRemote, 'managed')
    git(join(parent, 'managed'), 'remote', 'add', 'upstream', origin)
    git(parent, 'add', '--all')
    await commit(parent, 'register managed submodule')
    return { root, source, origin, target: join(parent, 'managed') }
  }
  git(target, 'remote', 'add', 'upstream', origin)
  await fs.writeFile(join(target, 'README.md'), 'managed repository\n')
  await commit(target, 'managed root')
  return { root, source, origin, target }
}

async function commit(repo: string, message: string): Promise<string> {
  git(repo, 'add', '--all')
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

async function updateSource(source: string, origin: string, paths: Record<string, string>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(paths)) {
    const fullPath = join(source, path)
    await fs.mkdir(join(fullPath, '..'), { recursive: true })
    await fs.writeFile(fullPath, content)
  }
  const commitSha = await commit(source, message)
  git(source, 'push', '--quiet', 'origin', 'main')
  return commitSha
}

function sync(sourceCheckoutPath: string, managedRepositoryPath: string, trustedOrigin: string) {
  return syncFilteredUpstream({ sourceCheckoutPath, managedRepositoryPath, trustedOrigin })
}

describe('filtered upstream adapter', () => {
  it('maps only the two frontend-design paths and repeats deterministically', async () => {
    const { source, origin, target } = await fixture(true)
    expect((await fs.lstat(join(target, '.git'))).isFile()).toBe(true)
    const firstSource = git(source, 'rev-parse', 'HEAD')
    const targetOrigin = git(target, 'rev-parse', 'refs/remotes/origin/main')

    const first = await sync(source, target, origin)
    expect(first).toEqual({ sourceCommit: firstSource, filteredCommit: expect.any(String), updated: true })
    expect(first.filteredCommit).not.toBe(first.sourceCommit)
    expect(git(target, 'rev-parse', 'refs/remotes/upstream/main')).toBe(first.filteredCommit)
    expect(git(target, 'rev-parse', 'refs/remotes/origin/main')).toBe(targetOrigin)

    const refs = git(target, 'for-each-ref', '--format=%(refname)').split('\n')
    expect(refs.sort()).toEqual([
      'refs/heads/main', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/upstream/main',
    ])
    const paths = git(target, 'ls-tree', '-r', '--name-only', 'refs/remotes/upstream/main').split('\n')
    expect(paths).toEqual(['frontend-design/SKILL.md'])
    expect(() => git(target, 'cat-file', '-e', firstSource)).toThrow()

    const repeated = await sync(source, target, origin)
    expect(repeated).toEqual({ ...first, updated: false })

    const unrelatedSource = await updateSource(source, origin, {
      'restricted/private.txt': 'restricted fixture data changed\n',
    }, 'unrelated only')
    const unrelated = await sync(source, target, origin)
    expect(unrelated).toEqual({ sourceCommit: unrelatedSource, filteredCommit: first.filteredCommit, updated: false })

    await fs.mkdir(join(source, 'skills', 'frontend-design'), { recursive: true })
    git(source, 'mv', 'frontend-design/SKILL.md', 'skills/frontend-design/SKILL.md')
    await fs.writeFile(join(source, 'skills/frontend-design/SKILL.md'), '# Frontend design v2\n')
    const movedSource = await commit(source, 'move and update skill')
    git(source, 'push', '--quiet', 'origin', 'main')
    const moved = await sync(source, target, origin)
    expect(moved.sourceCommit).toBe(movedSource)
    expect(moved.updated).toBe(true)
    expect(await isAncestor(target, first.filteredCommit, moved.filteredCommit)).toBe(true)
    expect(git(target, 'ls-tree', '-r', '--name-only', 'refs/remotes/upstream/main')).toBe('skills/frontend-design/SKILL.md')

    const stable = await sync(source, target, origin)
    expect(stable).toEqual({ ...moved, updated: false })
    expect(git(target, 'for-each-ref', '--format=%(refname)').split('\n').sort()).toEqual([
      'refs/heads/main', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/upstream/main',
    ])

    const gitDir = git(target, 'rev-parse', '--absolute-git-dir')
    const mapping = (await fs.readFile(join(gitDir, 'skillbuddy', 'filtered-upstream', 'sha-mapping.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((line): unknown => JSON.parse(line))
    expect(mapping).toContainEqual({ origin, sourceCommit: firstSource, filteredCommit: first.filteredCommit })
    expect(mapping).toContainEqual({ origin, sourceCommit: movedSource, filteredCommit: moved.filteredCommit })
  }, 15000)

  it('refuses dirty source trees and an upstream rewrite without moving the filtered ref', async () => {
    const { source, origin, target, root } = await fixture()
    const initial = await sync(source, target, origin)
    const editedPath = join(source, 'frontend-design', 'SKILL.md')
    await fs.writeFile(editedPath, '# uncommitted\n')
    await expect(sync(source, target, origin)).rejects.toThrow('source checkout has local changes')
    await fs.writeFile(editedPath, '# Frontend design v1\n')

    const replacement = join(root, 'replacement')
    await fs.mkdir(replacement)
    git(undefined, 'init', '--quiet', '--initial-branch=main', replacement)
    git(replacement, 'config', 'user.name', 'Fixture')
    git(replacement, 'config', 'user.email', 'fixture@example.invalid')
    await fs.mkdir(join(replacement, 'frontend-design'))
    await fs.writeFile(join(replacement, 'frontend-design', 'SKILL.md'), '# rewritten root\n')
    await commit(replacement, 'rewritten root')
    git(replacement, 'remote', 'add', 'origin', origin)
    git(replacement, 'push', '--quiet', '--force', 'origin', 'main')

    await expect(sync(source, target, origin)).rejects.toThrow('fetch verified source main failed')
    expect(git(target, 'rev-parse', 'refs/remotes/upstream/main')).toBe(initial.filteredCommit)
  })

  it('refuses a non-descendant existing upstream ref and preserves it', async () => {
    const { source, origin, target } = await fixture()
    const targetBase = git(target, 'rev-parse', 'HEAD')
    git(target, 'update-ref', 'refs/remotes/upstream/main', targetBase)

    await expect(sync(source, target, origin)).rejects.toThrow('history conflicts')
    expect(git(target, 'rev-parse', 'refs/remotes/upstream/main')).toBe(targetBase)
    expect(git(target, 'for-each-ref', '--format=%(refname)').split('\n').sort()).toEqual([
      'refs/heads/main', 'refs/remotes/upstream/main',
    ])
  })

  it.skipIf(process.platform === 'win32')('pins the captured source SHA and rejects an A→B→C ref race', async () => {
    const { root, source, origin, target } = await fixture()
    const sourceA = git(source, 'rev-parse', 'HEAD')
    const alternate = join(root, 'alternate')
    git(undefined, 'clone', '--quiet', origin, alternate)
    git(alternate, 'config', 'user.name', 'Fixture')
    git(alternate, 'config', 'user.email', 'fixture@example.invalid')

    await fs.writeFile(join(alternate, 'frontend-design', 'SKILL.md'), '# Frontend design v2\n')
    const sourceB = await commit(alternate, 'race B: skill change')
    git(alternate, 'push', '--quiet', 'origin', `HEAD:refs/heads/race-b`)
    await fs.writeFile(join(alternate, 'frontend-design', 'SKILL.md'), '# Frontend design v1\n')
    const sourceC = await commit(alternate, 'race C: restore original tree')
    git(alternate, 'push', '--quiet', 'origin', `HEAD:refs/heads/race-c`)

    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const wrapperDir = join(root, 'git-wrapper')
    const marker = join(root, 'race-triggered')
    await fs.mkdir(wrapperDir)
    const wrapper = join(wrapperDir, 'git')
    await fs.writeFile(wrapper, `#!/bin/sh
if [ "$3" = "fast-export" ] && [ ! -e "$RACE_MARKER" ]; then
  : > "$RACE_MARKER" || exit 90
  "$REAL_GIT" -C "$RACE_BARE" update-ref refs/heads/main "$RACE_B" "$RACE_A" || exit 91
  "$REAL_GIT" -C "$RACE_BARE" update-ref refs/heads/main "$RACE_C" "$RACE_B" || exit 92
  "$REAL_GIT" -C "$RACE_SOURCE" fetch --no-tags origin refs/heads/main:refs/remotes/origin/main || exit 93
fi
exec "$REAL_GIT" "$@"
`)
    await fs.chmod(wrapper, 0o755)

    const oldEnv = new Map<string, string | undefined>([
      ['PATH', process.env.PATH], ['REAL_GIT', process.env.REAL_GIT], ['RACE_MARKER', process.env.RACE_MARKER],
      ['RACE_BARE', process.env.RACE_BARE], ['RACE_SOURCE', process.env.RACE_SOURCE], ['RACE_A', process.env.RACE_A],
      ['RACE_B', process.env.RACE_B], ['RACE_C', process.env.RACE_C],
    ])
    try {
      process.env.PATH = `${wrapperDir}:${process.env.PATH ?? ''}`
      process.env.REAL_GIT = realGit
      process.env.RACE_MARKER = marker
      process.env.RACE_BARE = origin
      process.env.RACE_SOURCE = source
      process.env.RACE_A = sourceA
      process.env.RACE_B = sourceB
      process.env.RACE_C = sourceC

      await expect(sync(source, target, origin)).rejects.toThrow('origin/main changed during filtered export')
      expect(git(target, 'for-each-ref', '--format=%(refname)', 'refs/remotes/upstream/')).toBe('')
      expect(git(target, 'for-each-ref', '--format=%(refname)', 'refs/skillbuddy/filtered-upstream-staging/')).toBe('')
      expect(git(source, 'for-each-ref', '--format=%(refname)', 'refs/skillbuddy/filtered-upstream-source/')).toBe('')
      expect(git(source, 'rev-parse', 'refs/remotes/origin/main')).toBe(sourceC)
    } finally {
      for (const [key, value] of oldEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    git(repo, 'merge-base', '--is-ancestor', ancestor, descendant)
    return true
  } catch {
    return false
  }
}
