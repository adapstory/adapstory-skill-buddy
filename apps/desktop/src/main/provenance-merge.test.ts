import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SkillProvenance } from '@skillbuddy/core'
import { getPendingGitPublication, mergeGitSource, retryGitPublication, saveGitSkill } from './provenance-git'

const roots: string[] = []
vi.setConfig({ testTimeout: 20_000 })
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'skill-merge-'))
  roots.push(root)
  const parent = join(root, 'parent')
  const seed = join(root, 'seed')
  const upstream = join(root, 'upstream.git')
  const childOrigin = join(root, 'child.git')
  const parentOrigin = join(root, 'parent.git')
  await Promise.all([fs.mkdir(parent), fs.mkdir(seed)])
  for (const remote of [upstream, childOrigin, parentOrigin]) {
    git(root, 'init', '--bare', '-q', remote)
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  }
  git(seed, 'init', '-q', '-b', 'main')
  git(seed, 'config', 'user.name', 'Test')
  git(seed, 'config', 'user.email', 'test@example.com')
  await fs.writeFile(join(seed, 'SKILL.md'), '---\nname: source-skill\ndescription: Before\ncustomField: preserve-me\n---\n\nbase body\n')
  await fs.writeFile(join(seed, 'README.md'), 'unchanged\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-qm', 'base')
  git(seed, 'remote', 'add', 'upstream', upstream)
  git(seed, 'push', '-q', upstream, 'HEAD:refs/heads/main')
  git(seed, 'push', '-q', childOrigin, 'HEAD:refs/heads/main')
  git(parent, 'init', '-q', '-b', 'main')
  git(parent, 'config', 'user.name', 'Test')
  git(parent, 'config', 'user.email', 'test@example.com')
  git(parent, 'remote', 'add', 'origin', parentOrigin)
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childOrigin, 'vendor/source')
  const repo = join(parent, 'vendor', 'source')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'remote', 'add', 'upstream', upstream)
  git(repo, 'fetch', '-q', 'upstream')
  git(repo, 'symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/main')
  const manifest = join(parent, 'skills', '.manifests', 'source.json')
  await fs.mkdir(join(parent, 'skills', '.manifests'), { recursive: true })
  const commit = git(repo, 'rev-parse', 'HEAD')
  await fs.writeFile(manifest, JSON.stringify({ currentCommit: commit, managedOrigin: childOrigin, upstream, managedPath: 'vendor/source', installations: [{ managedPath: 'vendor/source' }] }) + '\n')
  git(parent, 'add', '.')
  git(parent, 'commit', '-qm', 'parent')
  git(parent, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  const source: Extract<SkillProvenance, { kind: 'git' }> = {
    kind: 'git', origin: childOrigin, upstream, commit, dirty: false, managedPath: repo, manifestPath: manifest,
  }
  return { root, parent, seed, repo, upstream, childOrigin, parentOrigin, manifest, source }
}

async function updateUpstream(f: Awaited<ReturnType<typeof fixture>>, content: string) {
  await fs.writeFile(join(f.seed, 'SKILL.md'), content)
  git(f.seed, 'add', 'SKILL.md')
  git(f.seed, 'commit', '-qm', 'upstream update')
  git(f.seed, 'push', '-q', 'upstream', 'HEAD:refs/heads/main')
  return git(f.seed, 'rev-parse', 'HEAD')
}

it('publishes a clean merge before its parent pointer and metadata', async () => {
  const f = await fixture()
  const expected = await updateUpstream(f, 'upstream\n')
  const result = await mergeGitSource(f.source, 'merge')
  expect(result).toMatchObject({ state: 'published', commit: expected })
  expect(git(f.childOrigin, 'rev-parse', 'refs/heads/main')).toBe(expected)
  expect(git(f.parentOrigin, 'rev-parse', 'refs/heads/main')).toBe(git(f.parent, 'rev-parse', 'HEAD'))
  expect(JSON.parse(await fs.readFile(f.manifest, 'utf8'))).toMatchObject({ currentCommit: expected, snapshotCommit: f.source.commit })
  expect(git(f.parent, 'status', '--porcelain')).toBe('')
})

it('keeps conflicts for the user and completes after resolution', async () => {
  const f = await fixture()
  await fs.writeFile(join(f.repo, 'SKILL.md'), 'local\n')
  git(f.repo, 'add', 'SKILL.md')
  git(f.repo, 'commit', '-qm', 'local')
  git(f.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  const local = git(f.repo, 'rev-parse', 'HEAD')
  await fs.writeFile(f.manifest, JSON.stringify({ currentCommit: local, managedOrigin: f.childOrigin, upstream: f.upstream, managedPath: 'vendor/source' }) + '\n')
  git(f.parent, 'add', 'vendor/source', 'skills/.manifests/source.json')
  git(f.parent, 'commit', '-qm', 'local source')
  git(f.parent, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  await updateUpstream(f, 'upstream\n')
  expect(await mergeGitSource(f.source, 'merge')).toEqual({ state: 'conflict', conflicts: ['SKILL.md'] })
  expect(git(f.repo, 'rev-parse', '--verify', 'MERGE_HEAD')).toBeTruthy()
  await fs.writeFile(join(f.repo, 'SKILL.md'), 'resolved\n')
  git(f.repo, 'add', 'SKILL.md')
  await fs.writeFile(join(f.repo, 'README.md'), 'unrelated\n')
  git(f.repo, 'add', 'README.md')
  await expect(mergeGitSource(f.source, 'finish')).rejects.toThrow('Source has changes unrelated to the merge')
  await fs.writeFile(join(f.repo, 'README.md'), 'unchanged\n')
  git(f.repo, 'add', 'README.md')
  await fs.writeFile(join(f.repo, 'SKILL.md'), 'resolved but unstaged\n')
  await expect(mergeGitSource(f.source, 'finish')).rejects.toThrow('Source has unstaged changes')
  await fs.writeFile(join(f.repo, 'SKILL.md'), 'resolved\n')
  git(f.repo, 'add', 'SKILL.md')
  const result = await mergeGitSource(f.source, 'finish')
  expect(result.state).toBe('published')
  expect(await fs.readFile(join(f.repo, 'SKILL.md'), 'utf8')).toBe('resolved\n')
  expect(git(f.parent, 'status', '--porcelain')).toBe('')
})

it('rejects unrelated parent changes before changing the source', async () => {
  const f = await fixture()
  await updateUpstream(f, 'upstream\n')
  await fs.writeFile(join(f.parent, 'unrelated.txt'), 'unrelated')
  await expect(mergeGitSource(f.source, 'merge')).rejects.toThrow('Parent repository has unrelated changes')
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.source.commit)
})

it.runIf(process.platform !== 'win32')('keeps the local commit and does not publish the parent when child push is rejected', async () => {
  const f = await fixture()
  await updateUpstream(f, 'upstream\n')
  const parentBefore = git(f.parent, 'rev-parse', 'HEAD')
  const hook = join(f.childOrigin, 'hooks', 'pre-receive')
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await expect(mergeGitSource(f.source, 'merge')).rejects.toThrow('retry publication')
  expect(git(f.repo, 'rev-parse', 'HEAD')).not.toBe(f.source.commit)
  expect(git(f.childOrigin, 'rev-parse', 'refs/heads/main')).toBe(f.source.commit)
  expect(git(f.parent, 'rev-parse', 'HEAD')).toBe(parentBefore)
  expect(git(f.parentOrigin, 'rev-parse', 'refs/heads/main')).toBe(parentBefore)
})

it.runIf(process.platform !== 'win32')('does not publish a parent pointer changed after the child push', async () => {
  const f = await fixture()
  await updateUpstream(f, 'upstream\n')
  const parentBefore = git(f.parent, 'rev-parse', 'HEAD')
  const hook = join(f.childOrigin, 'hooks', 'post-receive')
  await fs.writeFile(hook, `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE\ngit -C '${f.repo}' update-ref refs/heads/main '${f.source.commit}'\n`, { mode: 0o755 })
  await expect(mergeGitSource(f.source, 'merge')).rejects.toThrow('retry publication')
  expect(git(f.parentOrigin, 'rev-parse', 'refs/heads/main')).toBe(parentBefore)
  expect(git(f.childOrigin, 'rev-parse', 'refs/heads/main')).not.toBe(f.source.commit)
})

it('saves only the selected SKILL.md and publishes child before its parent pointer', async () => {
  const f = await fixture()
  const expected = f.source.commit
  const originalResources = await fs.readFile(join(f.repo, 'README.md'), 'utf8')
  const result = await saveGitSkill(f.source, join(f.repo, 'SKILL.md'), expected, {
    description: 'After', version: '2.0.0', tags: ['managed', 'edit'], content: '# New body',
  })
  expect(result.state).toBe('published')
  if (result.state !== 'published') throw new Error('Expected a published edit')
  expect(git(f.childOrigin, 'rev-parse', 'refs/heads/main')).toBe(result.commit)
  expect(git(f.parentOrigin, 'rev-parse', 'refs/heads/main')).toBe(result.parentCommit)
  expect(git(f.parent, 'rev-parse', `${result.parentCommit}:vendor/source`)).toBe(result.commit)
  expect(JSON.parse(await git(f.parent, 'show', `${result.parentCommit}:skills/.manifests/source.json`))).toMatchObject({ currentCommit: result.commit, snapshotCommit: expected })
  const saved = await fs.readFile(join(f.repo, 'SKILL.md'), 'utf8')
  expect(saved).toContain('customField: preserve-me')
  expect(saved).toContain('description: After')
  expect(saved).toContain('version: 2.0.0')
  expect(saved).toContain('tags:')
  expect(saved).toContain('# New body')
  expect(await fs.readFile(join(f.repo, 'README.md'), 'utf8')).toBe(originalResources)
  expect(git(f.repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('SKILL.md')
  expect(git(f.parent, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('skills/.manifests/source.json\nvendor/source')
})

it('rejects stale editor commits and preserves source files', async () => {
  const f = await fixture()
  await expect(saveGitSkill(f.source, join(f.repo, 'SKILL.md'), '0'.repeat(40), {
    description: 'After', version: undefined, tags: [], content: '# New body',
  })).rejects.toThrow('changed since it was opened')
  expect(await fs.readFile(join(f.repo, 'SKILL.md'), 'utf8')).toContain('base body')
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.source.commit)
  expect(git(f.childOrigin, 'rev-parse', 'refs/heads/main')).toBe(f.source.commit)
})

it.runIf(process.platform !== 'win32')('rejects a symlinked SKILL.md and edits outside the declared checkout', async () => {
  const f = await fixture()
  const link = join(f.repo, 'linked-SKILL.md')
  await fs.symlink(join(f.repo, 'SKILL.md'), link)
  await expect(saveGitSkill(f.source, link, f.source.commit, {
    description: 'After', version: undefined, tags: [], content: '# New body',
  })).rejects.toThrow('regular file')
  const outside = join(f.root, 'SKILL.md')
  await fs.writeFile(outside, 'outside')
  await expect(saveGitSkill(f.source, outside, f.source.commit, {
    description: 'After', version: undefined, tags: [], content: '# New body',
  })).rejects.toThrow('outside the managed source')
  expect(await fs.readFile(join(f.repo, 'SKILL.md'), 'utf8')).toContain('base body')
  expect(await fs.readFile(outside, 'utf8')).toBe('outside')
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.source.commit)
})

it('rejects a dirty checkout before editing the selected skill', async () => {
  const f = await fixture()
  await fs.writeFile(join(f.repo, 'README.md'), 'external change\n')
  await expect(saveGitSkill(f.source, join(f.repo, 'SKILL.md'), f.source.commit, {
    description: 'After', version: undefined, tags: [], content: '# New body',
  })).rejects.toThrow('local changes or an unfinished merge')
  expect(await fs.readFile(join(f.repo, 'SKILL.md'), 'utf8')).toContain('base body')
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.source.commit)
})

it.runIf(process.platform !== 'win32')('keeps an edit commit locally and leaves the parent unchanged when child push fails', async () => {
  const f = await fixture()
  const parentBefore = git(f.parent, 'rev-parse', 'HEAD')
  await fs.writeFile(join(f.childOrigin, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await expect(saveGitSkill(f.source, join(f.repo, 'SKILL.md'), f.source.commit, {
    description: 'After', version: undefined, tags: [], content: '# New body',
  })).rejects.toThrow('retry publication')
  expect(git(f.repo, 'rev-parse', 'HEAD')).not.toBe(f.source.commit)
  expect(await fs.readFile(join(f.repo, 'SKILL.md'), 'utf8')).toContain('# New body')
  expect(git(f.childOrigin, 'rev-parse', 'refs/heads/main')).toBe(f.source.commit)
  expect(git(f.parent, 'rev-parse', 'HEAD')).toBe(parentBefore)
  expect(git(f.parentOrigin, 'rev-parse', 'refs/heads/main')).toBe(parentBefore)
})

it.runIf(process.platform !== 'win32')('keeps a published child and local parent commit when parent push fails', async () => {
  const f = await fixture()
  const parentBefore = git(f.parent, 'rev-parse', 'HEAD')
  await fs.writeFile(join(f.parentOrigin, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await expect(saveGitSkill(f.source, join(f.repo, 'SKILL.md'), f.source.commit, {
    description: 'After', version: undefined, tags: [], content: '# New body',
  })).rejects.toThrow('retry publication')
  const child = git(f.childOrigin, 'rev-parse', 'refs/heads/main')
  expect(child).not.toBe(f.source.commit)
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(child)
  expect(git(f.parent, 'rev-parse', 'HEAD')).not.toBe(parentBefore)
  expect(git(f.parentOrigin, 'rev-parse', 'refs/heads/main')).toBe(parentBefore)
  expect(git(f.parent, 'rev-parse', 'HEAD:vendor/source')).toBe(child)
  expect(JSON.parse(git(f.parent, 'show', 'HEAD:skills/.manifests/source.json'))).toMatchObject({ currentCommit: child })
  expect(await getPendingGitPublication(f.source)).toBe(true)
  await fs.rm(join(f.parentOrigin, 'hooks', 'pre-receive'))
  const retried = await retryGitPublication(f.source)
  expect(retried).toMatchObject({ state: 'published', commit: child, parentCommit: git(f.parent, 'rev-parse', 'HEAD') })
  expect(git(f.parentOrigin, 'rev-parse', 'refs/heads/main')).toBe(git(f.parent, 'rev-parse', 'HEAD'))
})

it.runIf(process.platform !== 'win32')('retries a failed child push from a durable receipt after restart', async () => {
  const f = await fixture()
  const hook = join(f.childOrigin, 'hooks', 'pre-receive')
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await expect(saveGitSkill(f.source, join(f.repo, 'SKILL.md'), f.source.commit, {
    description: 'After', version: undefined, tags: [], content: '# Edited',
  })).rejects.toThrow('retry publication')
  expect(await getPendingGitPublication(f.source)).toBe(true)
  const child = git(f.repo, 'rev-parse', 'HEAD')
  expect(git(f.childOrigin, 'rev-parse', 'refs/heads/main')).toBe(f.source.commit)
  expect(git(f.parent, 'rev-parse', 'HEAD')).toBe(git(f.parentOrigin, 'rev-parse', 'refs/heads/main'))

  await fs.rm(hook)
  const result = await retryGitPublication(f.source)
  expect(result).toMatchObject({ state: 'published', commit: child })
  expect(git(f.childOrigin, 'rev-parse', 'refs/heads/main')).toBe(child)
  expect(git(f.parentOrigin, 'rev-parse', 'refs/heads/main')).toBe(git(f.parent, 'rev-parse', 'HEAD'))
  expect(await getPendingGitPublication(f.source)).toBe(false)
})

it.runIf(process.platform !== 'win32')('does not publish the child when the parent became dirty before retry', async () => {
  const f = await fixture()
  const hook = join(f.childOrigin, 'hooks', 'pre-receive')
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await expect(saveGitSkill(f.source, join(f.repo, 'SKILL.md'), f.source.commit, {
    description: 'After', version: undefined, tags: [], content: '# New',
  })).rejects.toThrow('retry publication')
  await fs.rm(hook)
  await fs.writeFile(join(f.parent, 'unrelated.txt'), 'external work')
  await expect(retryGitPublication(f.source)).rejects.toThrow('Parent has changes outside')
  expect(git(f.childOrigin, 'rev-parse', 'refs/heads/main')).toBe(f.source.commit)
})

it.runIf(process.platform !== 'win32')('does not publish the child when the parent remote advanced before retry', async () => {
  const f = await fixture()
  const hook = join(f.childOrigin, 'hooks', 'pre-receive')
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await expect(saveGitSkill(f.source, join(f.repo, 'SKILL.md'), f.source.commit, {
    description: 'After', version: undefined, tags: [], content: '# New',
  })).rejects.toThrow('retry publication')
  await fs.rm(hook)
  const emptyTree = git(f.parentOrigin, 'mktree')
  const base = git(f.parentOrigin, 'rev-parse', 'refs/heads/main')
  const advanced = git(f.parentOrigin, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit-tree', emptyTree, '-p', base, '-m', 'external')
  git(f.parentOrigin, 'update-ref', 'refs/heads/main', advanced)
  await expect(retryGitPublication(f.source)).rejects.toThrow('Parent remote has advanced')
  expect(git(f.childOrigin, 'rev-parse', 'refs/heads/main')).toBe(f.source.commit)
})

it.runIf(process.platform !== 'win32')('continues when a child push outcome is uncertain but the remote has the exact receipt commit', async () => {
  const f = await fixture()
  const hook = join(f.childOrigin, 'hooks', 'pre-receive')
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await expect(saveGitSkill(f.source, join(f.repo, 'SKILL.md'), f.source.commit, {
    description: 'After', version: undefined, tags: [], content: '# Edited',
  })).rejects.toThrow('retry publication')
  await fs.rm(hook)
  const child = git(f.repo, 'rev-parse', 'HEAD')
  git(f.repo, 'push', 'origin', `${child}:refs/heads/main`)
  const result = await retryGitPublication(f.source)
  expect(result).toMatchObject({ state: 'published', commit: child })
  expect(git(f.parent, 'rev-parse', 'HEAD:vendor/source')).toBe(child)
})

it.runIf(process.platform !== 'win32')('refuses a retry through a different effective push URL', async () => {
  const f = await fixture()
  const hook = join(f.childOrigin, 'hooks', 'pre-receive')
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await expect(saveGitSkill(f.source, join(f.repo, 'SKILL.md'), f.source.commit, {
    description: 'After', version: undefined, tags: [], content: '# Edited',
  })).rejects.toThrow('retry publication')
  const other = join(f.root, 'wrong-push-url.git')
  git(f.root, 'init', '--bare', '-q', other)
  git(f.repo, 'config', 'remote.origin.pushurl', other)
  await expect(retryGitPublication(f.source)).rejects.toThrow('fetch and push destinations differ')
  await expect(fs.stat(join(other, 'refs', 'heads', 'main'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.runIf(process.platform !== 'win32')('retries a merge publication from its durable receipt', async () => {
  const f = await fixture()
  const upstreamCommit = await updateUpstream(f, 'upstream\n')
  await fs.writeFile(join(f.childOrigin, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await expect(mergeGitSource(f.source, 'merge')).rejects.toThrow('retry publication')
  expect(await getPendingGitPublication(f.source)).toBe(true)
  await fs.rm(join(f.childOrigin, 'hooks', 'pre-receive'))
  const retried = await retryGitPublication(f.source)
  expect(retried).toMatchObject({ state: 'published' })
  expect(git(f.childOrigin, 'rev-parse', 'refs/heads/main')).toBe(retried.state === 'published' ? retried.commit : '')
  expect(git(f.parentOrigin, 'rev-parse', 'refs/heads/main')).toBe(retried.state === 'published' ? retried.parentCommit : '')
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(upstreamCommit)
})

it.runIf(process.platform !== 'win32')('does not advance the parent when the child remote moved beyond a pending commit', async () => {
  const f = await fixture()
  const parentBefore = git(f.parent, 'rev-parse', 'HEAD')
  await fs.writeFile(join(f.childOrigin, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await expect(saveGitSkill(f.source, join(f.repo, 'SKILL.md'), f.source.commit, {
    description: 'After', version: undefined, tags: [], content: '# Edited',
  })).rejects.toThrow('retry publication')
  await fs.rm(join(f.childOrigin, 'hooks', 'pre-receive'))
  git(f.seed, 'remote', 'add', 'origin', f.childOrigin)
  await fs.writeFile(join(f.seed, 'unrelated.txt'), 'external\n')
  git(f.seed, 'add', 'unrelated.txt')
  git(f.seed, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'external update')
  git(f.seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  await expect(retryGitPublication(f.source)).rejects.toThrow('Child remote has advanced')
  expect(git(f.parent, 'rev-parse', 'HEAD')).toBe(parentBefore)
  expect(git(f.parentOrigin, 'rev-parse', 'refs/heads/main')).toBe(parentBefore)
})
