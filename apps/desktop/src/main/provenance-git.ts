import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { updateSkillDocument } from '@skillbuddy/core'
import { syncFilteredUpstream } from './filtered-upstream'
import type { Skill, SkillProvenance } from '@skillbuddy/core'
import type { GitSourceInfo, GitSourceOperationResult } from '#shared/ipc'

const execFileAsync = promisify(execFile)
type GitProvenance = Extract<SkillProvenance, { kind: 'git' }>
let mutationActive = false

async function gitAt(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
  })
  return result.stdout
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  return (await gitAt(cwd, ...args)).trim()
}

function assertSafeRemoteUrl(value: string): void {
  if (!value || /[\r\n]/u.test(value)) throw new Error('Git remote URL is invalid')
  try {
    const url = new URL(value)
    if ((url.protocol !== 'https:' && url.protocol !== 'ssh:') || url.password || url.search || url.hash ||
        (url.protocol === 'https:' && url.username) ||
        (url.protocol === 'ssh:' && url.username && !/^[a-zA-Z0-9._-]+$/u.test(decodeURIComponent(url.username)))) {
      throw new Error('Git remote URL is not safe for publication')
    }
    return
  } catch (error) {
    if (error instanceof Error && error.message === 'Git remote URL is not safe for publication') throw error
  }
  if (/^git@[^/:]+:[^?#]+$/u.test(value) || isAbsolute(value)) return
  throw new Error('Git remote URL is not safe for publication')
}

async function remoteUrls(repo: string, remote: string): Promise<{ fetch: string; push: string }> {
  const [origin, originPush] = await Promise.all([
    gitText(repo, 'remote', 'get-url', '--all', remote),
    gitText(repo, 'remote', 'get-url', '--push', '--all', remote),
  ])
  if (origin.includes('\n') || originPush !== origin) throw new Error(`Git ${remote} fetch and push destinations differ`)
  assertSafeRemoteUrl(origin)
  return { fetch: origin, push: originPush }
}

async function verifyRemotes(source: GitProvenance): Promise<{ origin: string; upstream: string }> {
  const [origin, upstream] = await Promise.all([
    remoteUrls(source.managedPath, 'origin'), remoteUrls(source.managedPath, 'upstream'),
  ])
  if (origin.fetch !== source.origin || upstream.fetch !== source.upstream) {
    throw new Error('Git source remotes changed; scan again')
  }
  return { origin: origin.push, upstream: upstream.push }
}

type PendingPublication = {
  schemaVersion: 1
  operationId: string
  kind: 'save' | 'merge'
  repo: string
  parent: string
  gitlink: string
  manifest: string
  sourceOrigin: string
  sourceUpstream: string
  parentRemoteHash: string
  childBase: string
  childCommit: string
  parentBase: string
  skillPath?: string
  skillBlob?: string
  mergeTarget?: string
  parentCommit?: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function remoteIdentity(repo: string, remote: string): Promise<{ url: string; hash: string }> {
  const { fetch, push } = await remoteUrls(repo, remote)
  if (fetch !== push) throw new Error(`Git ${remote} push URL differs from its verified source`)
  return { url: fetch, hash: sha256(fetch) }
}

async function receiptPath(repo: string): Promise<string> {
  const gitDir = await fs.realpath(await gitText(repo, 'rev-parse', '--absolute-git-dir'))
  return join(gitDir, 'skillbuddy', 'pending-publications', `${sha256(await fs.realpath(repo))}.json`)
}

async function acquirePublicationLock(repo: string): Promise<() => Promise<void>> {
  const path = (await receiptPath(repo)).replace(/\.json$/u, '.lock')
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const owner = JSON.stringify({ token, pid: process.pid, hostname: hostname() })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(path, owner, { flag: 'wx', mode: 0o600 })
      return async () => {
        if (await fs.readFile(path, 'utf8').catch(() => '') === owner) await fs.rm(path, { force: true })
      }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      const staleRaw = await fs.readFile(path, 'utf8').catch(() => '')
      let stale: unknown
      try { stale = JSON.parse(staleRaw) } catch { throw new Error('Git publication lock is invalid; refusing concurrent writes') }
      if (!isRecord(stale) || stale.hostname !== hostname() || typeof stale.pid !== 'number' || !Number.isInteger(stale.pid)) {
        throw new Error('Git publication is locked by another process or host')
      }
      try {
        process.kill(stale.pid, 0)
        throw new Error('Git publication is already running in another SkillBuddy process')
      } catch (probeError) {
        if (probeError instanceof Error && 'code' in probeError && probeError.code === 'ESRCH') {
          if (await fs.readFile(path, 'utf8').catch(() => '') !== staleRaw) throw new Error('Git publication lock changed concurrently')
          await fs.rm(path)
          continue
        }
        throw probeError
      }
    }
  }
  throw new Error('Could not acquire Git publication lock')
}

async function readReceipt(path: string): Promise<PendingPublication | null> {
  const entry = await fs.lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  })
  if (!entry) return null
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Pending Git publication receipt is not a regular file')
  const raw = await fs.readFile(path, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  })
  if (raw === null) return null
  const value: unknown = JSON.parse(raw)
  if (!isPendingPublication(value)) {
    throw new Error('Pending Git publication receipt is invalid; refusing to publish')
  }
  return value
}

function isPendingPublication(value: unknown): value is PendingPublication {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.operationId !== 'string' ||
      (value.kind !== 'save' && value.kind !== 'merge') || typeof value.repo !== 'string' ||
      typeof value.parent !== 'string' || typeof value.gitlink !== 'string' || typeof value.manifest !== 'string' ||
      typeof value.sourceOrigin !== 'string' || typeof value.sourceUpstream !== 'string' ||
      typeof value.parentRemoteHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.parentRemoteHash) ||
      typeof value.childBase !== 'string' || !/^[0-9a-f]{40}$/.test(value.childBase) ||
      typeof value.childCommit !== 'string' || !/^[0-9a-f]{40}$/.test(value.childCommit) ||
      typeof value.parentBase !== 'string' || !/^[0-9a-f]{40}$/.test(value.parentBase) ||
      (value.parentCommit !== undefined && (typeof value.parentCommit !== 'string' || !/^[0-9a-f]{40}$/.test(value.parentCommit))) ||
      (value.kind === 'save' && (typeof value.skillPath !== 'string' || typeof value.skillBlob !== 'string' || !/^[0-9a-f]{40,64}$/.test(value.skillBlob))) ||
      (value.kind === 'merge' && (typeof value.mergeTarget !== 'string' || !/^[0-9a-f]{40}$/.test(value.mergeTarget)))) {
    return false
  }
  return true
}

async function writeReceipt(path: string, receipt: PendingPublication): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    const existing = await readReceipt(path)
    if (existing && existing.operationId !== receipt.operationId) throw new Error('Another Git publication receipt already exists')
    if (existing) await fs.rename(temporary, path)
    else await fs.link(temporary, path)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function assertNoPendingReceipt(repo: string): Promise<void> {
  if (await readReceipt(await receiptPath(repo))) throw new Error('A previous Git publication is pending; retry it first')
}

async function commitFiles(repo: string, commit: string): Promise<string[]> {
  return (await gitAt(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit))
    .split('\0').filter(Boolean).sort()
}

async function verifyReceiptChild(receipt: PendingPublication): Promise<void> {
  const parents = (await gitText(receipt.repo, 'show', '-s', '--format=%P', receipt.childCommit)).split(' ').filter(Boolean)
  if (receipt.kind === 'save') {
    if (parents.length !== 1 || parents[0] !== receipt.childBase || !receipt.skillPath || !receipt.skillBlob ||
        JSON.stringify(await commitFiles(receipt.repo, receipt.childCommit)) !== JSON.stringify([receipt.skillPath]) ||
        sha256(await gitAt(receipt.repo, 'show', `${receipt.childCommit}:${receipt.skillPath}`)) !== receipt.skillBlob) {
      throw new Error('Pending child commit does not match its SkillBuddy receipt')
    }
    return
  }
  if (!receipt.mergeTarget) throw new Error('Pending merge receipt is incomplete')
  if (receipt.childCommit === receipt.mergeTarget) {
    try {
      await gitText(receipt.repo, 'merge-base', '--is-ancestor', receipt.childBase, receipt.mergeTarget)
    } catch {
      throw new Error('Pending fast-forward does not descend from its base')
    }
  } else if (parents.length !== 2 || parents[0] !== receipt.childBase || parents[1] !== receipt.mergeTarget) {
    throw new Error('Pending merge commit does not match its receipt')
  }
}

async function assertPendingParentStatus(receipt: PendingPublication, allowStaged = false): Promise<void> {
  const entries = (await gitAt(receipt.parent, 'status', '--porcelain=v1', '-z', '--untracked-files=normal')).split('\0').filter(Boolean)
  for (const entry of entries) {
    const path = entry.slice(3)
    if (path !== receipt.gitlink && path !== receipt.manifest) throw new Error('Parent has changes outside the pending Git publication')
    const status = entry.slice(0, 2)
    if (status !== ' M' && !(allowStaged && status === 'M ')) {
      throw new Error('Parent has unsafe pending changes')
    }
  }
}

async function verifyParentCommit(receipt: PendingPublication, commit: string): Promise<void> {
  const parents = (await gitText(receipt.parent, 'show', '-s', '--format=%P', commit)).split(' ').filter(Boolean)
  const files = await commitFiles(receipt.parent, commit)
  if (parents.length !== 1 || parents[0] !== receipt.parentBase ||
      JSON.stringify(files) !== JSON.stringify([receipt.manifest, receipt.gitlink].sort()) ||
      await gitText(receipt.parent, 'rev-parse', `${commit}:${receipt.gitlink}`) !== receipt.childCommit) {
    throw new Error('Pending parent commit does not match its SkillBuddy receipt')
  }
  const metadata: unknown = JSON.parse(await gitAt(receipt.parent, 'show', `${commit}:${receipt.manifest}`))
  const baseRaw = await gitAt(receipt.parent, 'show', `${receipt.parentBase}:${receipt.manifest}`)
  const baseMetadata: unknown = JSON.parse(baseRaw)
  if (!isRecord(metadata) || !isRecord(baseMetadata) || baseMetadata.currentCommit !== receipt.childBase) {
    throw new Error('Pending parent metadata does not match its child commit')
  }
  const expected: Record<string, unknown> = { ...baseMetadata, currentCommit: receipt.childCommit }
  if (!('snapshotCommit' in expected)) expected.snapshotCommit = receipt.childBase
  if (await gitAt(receipt.parent, 'show', `${commit}:${receipt.manifest}`) !== `${JSON.stringify(expected, null, 2)}\n`) {
    throw new Error('Pending parent manifest contains changes outside the expected pointer update')
  }
}

async function publishFromReceipt(receipt: PendingPublication): Promise<GitSourceOperationResult> {
  const [repo, parent] = await Promise.all([fs.realpath(receipt.repo), fs.realpath(receipt.parent)])
  const manifestFile = resolve(parent, receipt.manifest)
  if (repo !== receipt.repo || parent !== receipt.parent || !isWithin(parent, repo) ||
      !receipt.manifest.startsWith(`skills${sep}.manifests${sep}`) || !isWithin(parent, manifestFile) ||
      await fs.realpath(dirname(manifestFile)) !== dirname(manifestFile) || await fs.realpath(manifestFile) !== manifestFile) {
    throw new Error('Pending Git publication paths changed; refusing to publish')
  }
  const manifestEntry = await fs.lstat(manifestFile)
  if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink()) throw new Error('Pending source metadata is not a regular file')
  const [childBranch, parentBranch, childHead, parentHead, childRemoteConfig, upstreamConfig, parentRemote] = await Promise.all([
    gitText(repo, 'branch', '--show-current'), gitText(parent, 'branch', '--show-current'),
    gitText(repo, 'rev-parse', 'HEAD'), gitText(parent, 'rev-parse', 'HEAD'),
    remoteUrls(repo, 'origin'), remoteUrls(repo, 'upstream'), remoteIdentity(parent, 'origin'),
  ])
  if (childBranch !== 'main' || parentBranch !== 'main' || childRemoteConfig.fetch !== receipt.sourceOrigin ||
      childRemoteConfig.push !== receipt.sourceOrigin || upstreamConfig.fetch !== receipt.sourceUpstream ||
      upstreamConfig.push !== receipt.sourceUpstream || parentRemote.hash !== receipt.parentRemoteHash) {
    throw new Error('Pending Git publication source or branch changed; refusing to publish')
  }
  await verifyReceiptChild(receipt)
  if (childHead !== receipt.childCommit) throw new Error('Pending child commit is no longer checked out')
  const childStatus = await gitText(repo, 'status', '--porcelain=v1', '--untracked-files=normal')
  if (childStatus) throw new Error('Child has changes outside the pending Git publication')
  await assertPendingParentStatus(receipt)
  if (receipt.parentCommit) {
    if (parentHead !== receipt.parentCommit || await gitText(parent, 'status', '--porcelain=v1', '--untracked-files=normal')) {
      throw new Error('Parent has changes outside the pending committed publication')
    }
    await verifyParentCommit(receipt, receipt.parentCommit)
  } else if (parentHead !== receipt.parentBase) {
    await verifyParentCommit(receipt, parentHead)
  } else {
    const baseRaw = await gitAt(parent, 'show', `${receipt.parentBase}:${receipt.manifest}`)
    const base: unknown = JSON.parse(baseRaw)
    if (!isRecord(base) || base.currentCommit !== receipt.childBase) throw new Error('Parent base manifest does not match the pending child')
    const updated: Record<string, unknown> = { ...base, currentCommit: receipt.childCommit }
    if (!('snapshotCommit' in updated)) updated.snapshotCommit = receipt.childBase
    const currentRaw = await fs.readFile(manifestFile, 'utf8')
    if (currentRaw !== baseRaw && currentRaw !== `${JSON.stringify(updated, null, 2)}\n`) throw new Error('Parent manifest has unrelated changes')
  }
  const initialParentRemote = await remoteMain(parent, parentRemote.url)
  const expectedParent = receipt.parentCommit ?? (parentHead === receipt.parentBase ? undefined : parentHead)
  if (initialParentRemote !== receipt.parentBase && initialParentRemote !== expectedParent) {
    throw new Error('Parent remote has advanced; pending child was not published')
  }
  const childRemote = await remoteMain(repo, childRemoteConfig.push)
  if (childRemote === receipt.childBase) {
    await gitText(repo, 'push', childRemoteConfig.push, `${receipt.childCommit}:refs/heads/main`)
  } else if (childRemote !== receipt.childCommit) {
    throw new Error('Child remote has advanced; pending commit was not published')
  }
  if (await remoteMain(repo, childRemoteConfig.push) !== receipt.childCommit) throw new Error('Published child revision could not be verified')
  await gitText(repo, 'fetch', '--no-tags', childRemoteConfig.push, 'refs/heads/main:refs/remotes/origin/main')
  if (await remoteMain(repo, childRemoteConfig.push) !== receipt.childCommit ||
      await gitText(repo, 'rev-parse', 'refs/remotes/origin/main') !== receipt.childCommit) {
    throw new Error('Child remote changed before parent publication')
  }

  await assertPendingParentStatus(receipt)
  if (!receipt.parentCommit && parentHead !== receipt.parentBase) {
    await verifyParentCommit(receipt, parentHead)
    receipt.parentCommit = parentHead
    await writeReceipt(await receiptPath(repo), receipt)
  }
  if (receipt.parentCommit) {
    if (await gitText(parent, 'status', '--porcelain=v1', '--untracked-files=normal')) {
      throw new Error('Parent has local changes outside the pending committed publication')
    }
    await verifyParentCommit(receipt, receipt.parentCommit)
  } else {
    if (parentHead !== receipt.parentBase) throw new Error('Parent changed before its pending pointer was committed')
    const baseRaw = await gitAt(parent, 'show', `${receipt.parentBase}:${receipt.manifest}`)
    const base: unknown = JSON.parse(baseRaw)
    if (!isRecord(base) || base.currentCommit !== receipt.childBase) throw new Error('Parent base manifest does not match the pending child')
    const updated: Record<string, unknown> = { ...base, currentCommit: receipt.childCommit }
    if (!('snapshotCommit' in updated)) updated.snapshotCommit = receipt.childBase
    const updatedRaw = `${JSON.stringify(updated, null, 2)}\n`
    const currentRaw = await fs.readFile(resolve(parent, receipt.manifest), 'utf8')
    if (currentRaw !== baseRaw && currentRaw !== updatedRaw) throw new Error('Parent manifest has unrelated changes')
    if (currentRaw !== updatedRaw) {
      const temp = `${resolve(parent, receipt.manifest)}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temp, updatedRaw, { flag: 'wx', mode: 0o600 })
        if (await fs.readFile(resolve(parent, receipt.manifest), 'utf8') !== currentRaw) throw new Error('Parent manifest changed concurrently')
        await fs.rename(temp, resolve(parent, receipt.manifest))
      } finally {
        await fs.rm(temp, { force: true })
      }
    }
    await gitText(parent, 'add', '--', receipt.gitlink, receipt.manifest)
    await assertPendingParentStatus(receipt, true)
    const stagedLink = await gitText(parent, 'ls-files', '--stage', '--', receipt.gitlink)
    if (!stagedLink.startsWith(`160000 ${receipt.childCommit} 0\t`)) throw new Error('Parent staged a different child pointer')
    const staged = (await gitAt(parent, 'diff', '--cached', '--name-only', '-z')).split('\0').filter(Boolean).sort()
    if (JSON.stringify(staged) !== JSON.stringify([receipt.manifest, receipt.gitlink].sort())) {
      throw new Error('Parent commit includes changes outside the pending publication')
    }
    await gitText(parent, 'commit', '-m', 'Publish managed skill pointer')
    receipt.parentCommit = await gitText(parent, 'rev-parse', 'HEAD')
    await verifyParentCommit(receipt, receipt.parentCommit)
    await writeReceipt(await receiptPath(repo), receipt)
  }
  if (await gitText(parent, 'rev-parse', 'HEAD') !== receipt.parentCommit) throw new Error('Pending parent commit is no longer checked out')
  const parentRemoteHead = await remoteMain(parent, parentRemote.url)
  if (parentRemoteHead === receipt.parentBase) {
    await gitText(parent, 'push', '--recurse-submodules=check', parentRemote.url, `${receipt.parentCommit}:refs/heads/main`)
  } else if (parentRemoteHead !== receipt.parentCommit) {
    throw new Error('Parent remote has advanced; child pointer was not published')
  }
  if (await remoteMain(parent, parentRemote.url) !== receipt.parentCommit) throw new Error('Published parent revision could not be verified')
  await fs.rm(await receiptPath(repo), { force: true })
  return { state: 'published', commit: receipt.childCommit, parentCommit: receipt.parentCommit }
}

/** Whether a receipt exists for a previously attempted managed publication. */
export async function getPendingGitPublication(source: GitProvenance): Promise<boolean> {
  const repo = await fs.realpath(source.managedPath)
  const receipt = await readReceipt(await receiptPath(repo))
  if (!receipt) return false
  if (receipt.repo !== repo || receipt.sourceOrigin !== source.origin || receipt.sourceUpstream !== source.upstream) {
    throw new Error('Pending Git publication belongs to a different source')
  }
  return true
}

/** Retry only a publication backed by a verified durable receipt from this application. */
export async function retryGitPublication(source: GitProvenance): Promise<GitSourceOperationResult> {
  if (mutationActive) throw new Error('A Git source operation is already running')
  mutationActive = true
  let release: (() => Promise<void>) | undefined
  try {
    const repo = await fs.realpath(source.managedPath)
    release = await acquirePublicationLock(repo)
    await verifyRemotes(source)
    const path = await receiptPath(repo)
    const receipt = await readReceipt(path)
    if (!receipt || receipt.repo !== repo || receipt.sourceOrigin !== source.origin || receipt.sourceUpstream !== source.upstream) {
      throw new Error('There is no verified pending Git publication for this source')
    }
    return await publishFromReceipt(receipt)
  } finally {
    await release?.()
    mutationActive = false
  }
}

async function upstreamRef(repo: string): Promise<string> {
  const ref = await gitText(repo, 'symbolic-ref', '--quiet', 'refs/remotes/upstream/HEAD').catch(() => '')
  if (!ref.startsWith('refs/remotes/upstream/')) throw new Error('Upstream default branch is unknown')
  return ref
}

async function fetchSkillUpstream(source: GitProvenance, ref: string): Promise<string | undefined> {
  if (source.upstreamFilter === 'anthropic-frontend-design-v1') {
    if (source.upstream !== 'https://github.com/anthropics/skills.git' || ref !== 'refs/remotes/upstream/main') {
      throw new Error('Filtered source configuration changed; refusing upstream fetch')
    }
    const result = await syncFilteredUpstream({
      sourceCheckoutPath: join(dirname(source.managedPath), 'anthropic-skills'),
      managedRepositoryPath: source.managedPath,
    })
    return result.sourceCommit
  }
  if (source.upstream === 'https://github.com/anthropics/skills.git') {
    throw new Error('Anthropic skills history requires a verified filtered upstream')
  }
  const branch = ref.slice('refs/remotes/upstream/'.length)
  await gitText(source.managedPath, 'fetch', '--no-tags', 'upstream', `+refs/heads/${branch}:${ref}`)
  return undefined
}

async function remoteMain(repo: string, destination: string): Promise<string> {
  const output = await gitText(repo, 'ls-remote', '--heads', destination, 'refs/heads/main')
  const match = /^([0-9a-f]{40})\s+refs\/heads\/main$/.exec(output)
  if (!match?.[1]) throw new Error('Remote main could not be verified')
  return match[1]
}

async function conflictFiles(repo: string): Promise<string[]> {
  return (await gitAt(repo, 'diff', '--name-only', '--diff-filter=U', '-z')).split('\0').filter(Boolean)
}

/** A renderer may open only a path Git currently reports as conflicted. */
export async function resolveConflictPath(source: GitProvenance, file: string): Promise<string> {
  await verifyRemotes(source)
  const repo = await fs.realpath(source.managedPath)
  if (!(await mergeInProgress(repo)) || !(await conflictFiles(repo)).includes(file)) {
    throw new Error('File is not a current merge conflict')
  }
  const target = resolve(repo, file)
  const path = relative(repo, target)
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Conflict path is outside the source')
  const realParent = await fs.realpath(dirname(target))
  const parentPath = relative(repo, realParent)
  if (parentPath === '..' || parentPath.startsWith(`..${sep}`) || isAbsolute(parentPath)) throw new Error('Conflict path is outside the source')
  const entry = await fs.lstat(target).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  })
  if (entry?.isSymbolicLink()) throw new Error('Cannot open a symbolic link as a conflict file')
  if (entry && !entry.isFile()) throw new Error('Conflict path is not a file')
  return target
}

async function mergeInProgress(repo: string): Promise<boolean> {
  const path = await gitText(repo, 'rev-parse', '--git-path', 'MERGE_HEAD')
  try {
    await fs.access(resolve(repo, path))
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function assertParentClean(parent: string, gitlink: string, allowGitlink: boolean): Promise<void> {
  const entries = (await gitAt(parent, 'status', '--porcelain=v1', '-z', '--untracked-files=normal')).split('\0').filter(Boolean)
  if (entries.some((entry) => !(allowGitlink && entry === ` M ${gitlink}`))) {
    throw new Error('Parent repository has unrelated changes')
  }
}

/** Inspect a source already verified against a scanned installation and its manifest. */
export async function inspectGitSource(
  provenance: GitProvenance,
  fetchUpstream: boolean,
): Promise<GitSourceInfo> {
  if (mutationActive) throw new Error('A Git source operation is already running')
  mutationActive = true
  try {
    const git = (...args: string[]) => gitText(provenance.managedPath, ...args)
    await verifyRemotes(provenance)
    const ref = await upstreamRef(provenance.managedPath)
    const upstreamOriginalCommit = fetchUpstream ? await fetchSkillUpstream(provenance, ref) : undefined
    const [commit, upstreamCommit, status, diff, conflicts, merging] = await Promise.all([
      git('rev-parse', 'HEAD'),
      git('rev-parse', '--verify', `${ref}^{commit}`),
      git('status', '--porcelain', '--untracked-files=normal'),
      git('diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', ref, '--'),
      conflictFiles(provenance.managedPath),
      mergeInProgress(provenance.managedPath),
    ])
    return { commit, upstreamCommit, upstreamOriginalCommit, dirty: status.length > 0, diff, fetched: fetchUpstream, conflicts, merging }
  } finally {
    mutationActive = false
  }
}

/** Merge only a verified, clean source and publish the child before its parent pointer. */
export async function mergeGitSource(
  source: GitProvenance,
  action: 'merge' | 'finish',
): Promise<GitSourceOperationResult> {
  if (mutationActive) throw new Error('A Git source operation is already running')
  mutationActive = true
  let release: (() => Promise<void>) | undefined
  try {
    const repo = await fs.realpath(source.managedPath)
    release = await acquirePublicationLock(repo)
    const sourceRemotes = await verifyRemotes(source)
    const parent = await gitText(repo, 'rev-parse', '--show-superproject-working-tree')
    if (!parent || await gitText(parent, 'rev-parse', '--show-toplevel') !== parent) {
      throw new Error('Managed source is not a Git submodule')
    }
    const gitlink = relative(parent, repo)
    const manifestEntry = await fs.lstat(source.manifestPath)
    if (!manifestEntry.isFile()) throw new Error('Managed source metadata is not a regular file')
    const manifestPath = await fs.realpath(source.manifestPath)
    const manifest = relative(parent, manifestPath)
    if (!gitlink || gitlink === '..' || gitlink.startsWith(`..${sep}`) || isAbsolute(gitlink) ||
        !manifest.startsWith(`skills${sep}.manifests${sep}`) || isAbsolute(manifest)) {
      throw new Error('Managed source paths are outside the parent repository')
    }
    const entry = await gitText(parent, 'ls-files', '--stage', '--', gitlink)
    const linkMatch = /^160000 ([0-9a-f]{40}) 0\t/.exec(entry)
    if (!linkMatch?.[1]) throw new Error('Managed source is not a tracked submodule')
    await gitText(parent, 'ls-files', '--error-unmatch', '--', manifest)
    const originalManifest = await fs.readFile(manifestPath, 'utf8')
    const parsedManifest: unknown = JSON.parse(originalManifest)
    if (!isRecord(parsedManifest) || parsedManifest.managedOrigin !== source.origin ||
        parsedManifest.upstream !== source.upstream || parsedManifest.upstreamFilter !== source.upstreamFilter || typeof parsedManifest.managedPath !== 'string' ||
        await fs.realpath(resolve(parent, parsedManifest.managedPath)) !== repo) {
      throw new Error('Source metadata changed; scan again')
    }
    const [childBranch, parentBranch, childBefore, parentBefore] = await Promise.all([
      gitText(repo, 'branch', '--show-current'), gitText(parent, 'branch', '--show-current'),
      gitText(repo, 'rev-parse', 'HEAD'), gitText(parent, 'rev-parse', 'HEAD'),
    ])
    if (childBranch !== 'main' || parentBranch !== 'main') throw new Error('Both repositories must be on main')
    if (linkMatch[1] !== childBefore) throw new Error('Parent pointer does not match the source revision')
    if (parsedManifest.currentCommit !== childBefore) throw new Error('Source metadata does not match the source revision')
    await assertNoPendingReceipt(repo)
    const parentRemote = await remoteIdentity(parent, 'origin')
    await assertParentClean(parent, gitlink, action === 'finish')
    if (await remoteMain(parent, parentRemote.url) !== parentBefore) throw new Error('Parent main has unpublished or remote changes')
    if (await remoteMain(repo, sourceRemotes.origin) !== childBefore) throw new Error('Source main has unpublished or remote changes')
    const merging = await mergeInProgress(repo)
    let mergeTarget: string
    if (action === 'merge') {
      if (merging || await gitText(repo, 'status', '--porcelain', '--untracked-files=normal')) {
        throw new Error('Source repository has local changes or an unfinished merge')
      }
      const ref = await upstreamRef(repo)
      await fetchSkillUpstream(source, ref)
      mergeTarget = await gitText(repo, 'rev-parse', '--verify', `${ref}^{commit}`)
      try {
        await gitText(repo, 'merge', '--no-edit', mergeTarget)
      } catch (cause) {
        const conflicts = await conflictFiles(repo)
        if (conflicts.length && await mergeInProgress(repo)) return { state: 'conflict', conflicts }
        throw new Error('Git merge failed', { cause })
      }
    } else {
      if (!merging) throw new Error('There is no merge to finish')
      mergeTarget = await gitText(repo, 'rev-parse', '--verify', 'MERGE_HEAD^{commit}')
      const conflicts = await conflictFiles(repo)
      if (conflicts.length) return { state: 'conflict', conflicts }
      const status = await gitAt(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=normal')
      if (status.split('\0').some((entry) => entry.startsWith('?? '))) {
        throw new Error('Source repository has untracked files')
      }
      const base = await gitText(repo, 'merge-base', 'HEAD', 'MERGE_HEAD')
      const allowed = new Set((await gitAt(repo, 'diff', '--name-only', '-z', base, 'MERGE_HEAD', '--')).split('\0').filter(Boolean))
      const unstaged = (await gitAt(repo, 'diff', '--name-only', '-z', '--')).split('\0').filter(Boolean)
      if (unstaged.length) throw new Error('Source has unstaged changes; stage the merge resolution')
      const changed = (await gitAt(repo, 'diff', '--name-only', '-z', '--cached', '--')).split('\0').filter(Boolean)
      if (changed.some((path) => !allowed.has(path))) throw new Error('Source has changes unrelated to the merge')
      await gitText(repo, 'commit', '--no-edit')
    }
    const childAfter = await gitText(repo, 'rev-parse', 'HEAD')
    if (await gitText(repo, 'status', '--porcelain', '--untracked-files=normal')) {
      throw new Error('Source changed during merge; local result was kept')
    }
    if (childAfter === childBefore) return { state: 'unchanged' }
    if (childAfter !== mergeTarget) {
      const parents = (await gitText(repo, 'show', '-s', '--format=%P', childAfter)).split(' ')
      if (parents.length !== 2 || parents[0] !== childBefore || parents[1] !== mergeTarget) {
        throw new Error('Source revision changed during merge; local result was kept')
      }
    }
    await assertParentClean(parent, gitlink, true)
    if (await fs.readFile(manifestPath, 'utf8') !== originalManifest) {
      throw new Error('Source metadata changed during merge; local result was kept')
    }
    const receipt: PendingPublication = {
      schemaVersion: 1,
      operationId: randomUUID(),
      kind: 'merge',
      repo,
      parent,
      gitlink,
      manifest,
      sourceOrigin: source.origin,
      sourceUpstream: source.upstream,
      parentRemoteHash: parentRemote.hash,
      childBase: childBefore,
      childCommit: childAfter,
      parentBase: parentBefore,
      mergeTarget,
    }
    await writeReceipt(await receiptPath(repo), receipt)
    try {
      return await publishFromReceipt(receipt)
    } catch (cause) {
      throw new Error('Git merge was committed locally; retry publication to finish it', { cause })
    }
  } finally {
    await release?.()
    mutationActive = false
  }
}

/** Save only one managed SKILL.md, then publish the child before its parent pointer. */
export async function saveGitSkill(
  source: GitProvenance,
  skillFilePath: string,
  expectedCommit: string,
  edit: Pick<Skill, 'description' | 'version' | 'tags' | 'content'>,
): Promise<GitSourceOperationResult> {
  if (mutationActive) throw new Error('A Git source operation is already running')
  mutationActive = true
  let release: (() => Promise<void>) | undefined
  try {
    if (!isAbsolute(skillFilePath) || resolve(skillFilePath) !== skillFilePath || !/^[0-9a-f]{40}$/.test(expectedCommit)) {
      throw new Error('Invalid managed skill edit request')
    }
    const repo = await fs.realpath(source.managedPath)
    release = await acquirePublicationLock(repo)
    const sourceRemotes = await verifyRemotes(source)
    const parent = await gitText(repo, 'rev-parse', '--show-superproject-working-tree')
    if (!parent || await gitText(parent, 'rev-parse', '--show-toplevel') !== parent) {
      throw new Error('Managed source is not a Git submodule')
    }
    const gitlink = relative(parent, repo)
    const metadataEntry = await fs.lstat(source.manifestPath)
    if (!metadataEntry.isFile()) throw new Error('Managed source metadata is not a regular file')
    const manifestPath = await fs.realpath(source.manifestPath)
    const manifest = relative(parent, manifestPath)
    if (!gitlink || gitlink === '..' || gitlink.startsWith(`..${sep}`) || isAbsolute(gitlink) ||
        !manifest.startsWith(`skills${sep}.manifests${sep}`) || isAbsolute(manifest)) {
      throw new Error('Managed source paths are outside the parent repository')
    }
    const indexEntry = await gitText(parent, 'ls-files', '--stage', '--', gitlink)
    const linkMatch = /^160000 ([0-9a-f]{40}) 0\t/.exec(indexEntry)
    if (!linkMatch?.[1]) throw new Error('Managed source is not a tracked submodule')
    await gitText(parent, 'ls-files', '--error-unmatch', '--', manifest)
    const originalManifest = await fs.readFile(manifestPath, 'utf8')
    const metadata: unknown = JSON.parse(originalManifest)
    if (!isRecord(metadata) || metadata.managedOrigin !== source.origin || metadata.upstream !== source.upstream ||
        typeof metadata.managedPath !== 'string' || await fs.realpath(resolve(parent, metadata.managedPath)) !== repo ||
        !Array.isArray(metadata.installations)) {
      throw new Error('Source metadata changed; scan again')
    }
    const [childBranch, parentBranch, childBefore, parentBefore] = await Promise.all([
      gitText(repo, 'branch', '--show-current'), gitText(parent, 'branch', '--show-current'),
      gitText(repo, 'rev-parse', 'HEAD'), gitText(parent, 'rev-parse', 'HEAD'),
    ])
    if (childBranch !== 'main' || parentBranch !== 'main') throw new Error('Both repositories must be on main')
    if (childBefore !== expectedCommit || linkMatch[1] !== childBefore || metadata.currentCommit !== childBefore) {
      throw new Error('Managed skill changed since it was opened; reload before saving')
    }
    await assertNoPendingReceipt(repo)
    const parentRemote = await remoteIdentity(parent, 'origin')
    if (await remoteMain(parent, parentRemote.url) !== parentBefore) throw new Error('Parent main has unpublished or remote changes')
    if (await remoteMain(repo, sourceRemotes.origin) !== childBefore) throw new Error('Source main has unpublished or remote changes')
    const fileEntry = await fs.lstat(skillFilePath)
    if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) throw new Error('Managed SKILL.md must be a regular file')
    const file = await fs.realpath(skillFilePath)
    const skillDirectory = dirname(file)
    if (basename(file) !== 'SKILL.md' || !isWithin(repo, file) || file === repo) {
      throw new Error('Skill file is outside the managed source')
    }
    const managedInstallations = await Promise.all(metadata.installations.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.managedPath !== 'string') return []
      return [fs.realpath(resolve(parent, entry.managedPath)).then((path) => isWithin(repo, path) ? path : '').catch(() => '')]
    }))
    if (!managedInstallations.includes(skillDirectory)) throw new Error('Skill file is not a declared managed installation')
    const skillRelative = relative(repo, file)
    await gitText(repo, 'ls-files', '--error-unmatch', '--', skillRelative)
    const originalRaw = await fs.readFile(file, 'utf8')
    const committedRaw = await gitAt(repo, 'show', `${childBefore}:${skillRelative}`)
    if (originalRaw !== committedRaw) throw new Error('Skill file changed outside SkillBuddy; reload before saving')
    if (await gitText(repo, 'status', '--porcelain=v1', '--untracked-files=normal') || await mergeInProgress(repo)) {
      throw new Error('Source repository has local changes or an unfinished merge')
    }
    await assertParentClean(parent, gitlink, false)
    const updatedRaw = updateSkillDocument(originalRaw, edit)
    if (updatedRaw === originalRaw) return { state: 'unchanged' }
    if (await fs.readFile(file, 'utf8') !== originalRaw) throw new Error('Skill file changed during save; reload before saving')
    const temporarySkill = join(skillDirectory, `.skillbuddy-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporarySkill, updatedRaw, { encoding: 'utf8', flag: 'wx', mode: fileEntry.mode })
      if (await fs.readFile(file, 'utf8') !== originalRaw) throw new Error('Skill file changed during save; reload before saving')
      await fs.rename(temporarySkill, file)
    } finally {
      await fs.rm(temporarySkill, { force: true })
    }

    try {
      await gitText(repo, 'add', '--', skillRelative)
      const staged = (await gitAt(repo, 'diff', '--cached', '--name-only', '-z', '--')).split('\0').filter(Boolean)
      if (staged.length !== 1 || staged[0] !== skillRelative || await gitText(repo, 'diff', '--name-only', '--')) {
        throw new Error('Source changed during save; only the selected SKILL.md may be committed')
      }
      await gitText(repo, 'commit', '--only', '-m', 'Edit managed skill in SkillBuddy', '--', skillRelative)
    } catch (cause) {
      throw new Error('Skill edit could not be committed; local file changes were kept', { cause })
    }
    const childAfter = await gitText(repo, 'rev-parse', 'HEAD')
    const childParents = (await gitText(repo, 'show', '-s', '--format=%P', childAfter)).split(' ').filter(Boolean)
    const childFiles = (await gitAt(repo, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', childAfter)).split('\0').filter(Boolean)
    if (childParents.length !== 1 || childParents[0] !== childBefore || childFiles.length !== 1 || childFiles[0] !== skillRelative ||
        await gitAt(repo, 'show', `${childAfter}:${skillRelative}`) !== updatedRaw) {
      throw new Error('Skill edit commit did not match the requested change; local commit was kept')
    }
    if (await fs.readFile(file, 'utf8') !== updatedRaw || await gitText(repo, 'status', '--porcelain', '--untracked-files=normal')) {
      throw new Error('Source changed during save; local commit was kept')
    }
    const receipt: PendingPublication = {
      schemaVersion: 1,
      operationId: randomUUID(),
      kind: 'save',
      repo,
      parent,
      gitlink,
      manifest,
      sourceOrigin: source.origin,
      sourceUpstream: source.upstream,
      parentRemoteHash: parentRemote.hash,
      childBase: childBefore,
      childCommit: childAfter,
      parentBase: parentBefore,
      skillPath: skillRelative,
      skillBlob: sha256(updatedRaw),
    }
    await writeReceipt(await receiptPath(repo), receipt)
    try {
      return await publishFromReceipt(receipt)
    } catch (cause) {
      throw new Error('Skill edit was committed locally; retry publication to finish it', { cause })
    }
  } finally {
    await release?.()
    mutationActive = false
  }
}
