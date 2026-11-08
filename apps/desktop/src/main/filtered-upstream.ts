import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const ORIGIN = 'https://github.com/anthropics/skills.git'
const PATHS = [':(top)frontend-design/', ':(top)skills/frontend-design/']
const TREE_PATHS = ['frontend-design', 'skills/frontend-design']
const UPSTREAM_REF = 'refs/remotes/upstream/main'
const STAGING_PREFIX = 'refs/skillbuddy/filtered-upstream-staging/'
const SOURCE_PIN_PREFIX = 'refs/skillbuddy/filtered-upstream-source/'
const MAX_EXPORT = 64 * 1024 * 1024
const MAX_METADATA = 4 * 1024 * 1024
const MAX_SNAPSHOTS = 4096
const SHA = /^[0-9a-f]{40}$/u

export interface FilteredUpstreamRequest {
  sourceCheckoutPath: string
  managedRepositoryPath: string
  /** Test fixtures may use a local bare remote. Production should omit this. */
  trustedOrigin?: string
}

export interface FilteredUpstreamResult {
  sourceCommit: string
  filteredCommit: string
  updated: boolean
}

interface Snapshot {
  sourceCommit: string
  filteredCommit: string
}

class GitFailure extends Error {
  constructor(readonly code: number | null, operation: string) {
    super(`Filtered upstream Git ${operation} failed`)
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function runGit(cwd: string, args: string[], operation: string, input?: Buffer, limit = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 1000).unref()
    }, 120_000)
    timeout.unref()
    child.stdout.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        child.kill('SIGTERM')
      } else chunks.push(chunk)
    })
    child.stderr.on('data', () => undefined)
    child.stdin.on('error', () => undefined)
    child.on('error', () => rejectPromise(new GitFailure(null, operation)))
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (tooLarge) rejectPromise(new Error(`Filtered upstream ${operation} exceeded its output limit`))
      else if (code !== 0) rejectPromise(new GitFailure(code, operation))
      else resolvePromise(Buffer.concat(chunks, size))
    })
    child.stdin.end(input)
  })
}

async function gitText(repo: string, args: string[], operation: string): Promise<string> {
  return (await runGit(repo, args, operation)).toString('utf8').trim()
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function trustedOrigin(value: string): string {
  if (/\r|\n|\0/u.test(value)) throw new Error('Filtered upstream trust anchor is invalid')
  if (isAbsolute(value)) return resolve(value)
  try {
    const url = new URL(value)
    if ((url.protocol !== 'https:' && url.protocol !== 'ssh:') || url.username || url.password || url.search || url.hash ||
        url.host.toLowerCase() !== 'github.com' || url.pathname !== '/anthropics/skills.git') {
      throw new Error('Filtered upstream trust anchor is not the Anthropic skills repository')
    }
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname}`
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Filtered upstream trust anchor is not')) throw error
    throw new Error('Filtered upstream trust anchor is invalid')
  }
}

async function checkRemote(repo: string, remote: string, expected: string): Promise<void> {
  let fetchUrl: string
  let pushUrl: string
  try {
    fetchUrl = await gitText(repo, ['remote', 'get-url', '--all', remote], `read ${remote} URL`)
    pushUrl = await gitText(repo, ['remote', 'get-url', '--push', '--all', remote], `read ${remote} push URL`)
  } catch {
    throw new Error(`Filtered upstream requires a configured ${remote} remote`)
  }
  if (fetchUrl !== expected || pushUrl !== expected || fetchUrl.includes('\n') || pushUrl.includes('\n')) {
    throw new Error(`Filtered upstream ${remote} remote does not match its verified trust anchor`)
  }
}

async function repository(path: string, label: string, allowSubmodule: boolean): Promise<{ root: string; gitDir: string }> {
  const requested = resolve(path)
  const requestedStat = await fs.lstat(requested).catch(() => null)
  if (!requestedStat?.isDirectory() || requestedStat.isSymbolicLink()) throw new Error(`Filtered upstream ${label} checkout is invalid`)
  const root = await fs.realpath(requested)
  const gitPath = join(root, '.git')
  const gitStat = await fs.lstat(gitPath).catch(() => null)
  if (!gitStat || gitStat.isSymbolicLink()) throw new Error(`Filtered upstream ${label} checkout is invalid`)
  const top = await gitText(root, ['rev-parse', '--show-toplevel'], `inspect ${label} checkout`)
  const gitDir = await fs.realpath(await gitText(root, ['rev-parse', '--absolute-git-dir'], `inspect ${label} gitdir`))
  if (resolve(top) !== root) throw new Error(`Filtered upstream ${label} checkout identity is inconsistent`)

  if (gitStat.isDirectory()) {
    if (gitDir !== await fs.realpath(gitPath)) throw new Error(`Filtered upstream ${label} checkout identity is inconsistent`)
  } else if (allowSubmodule && gitStat.isFile()) {
    const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(await fs.readFile(gitPath, 'utf8'))
    const declared = pointer ? await fs.realpath(resolve(root, pointer[1]!)).catch(() => '') : ''
    const superRootText = await gitText(root, ['rev-parse', '--show-superproject-working-tree'], 'verify submodule owner').catch(() => '')
    if (!declared || declared !== gitDir || !superRootText) throw new Error(`Filtered upstream ${label} submodule metadata is invalid`)
    const superRoot = await fs.realpath(superRootText)
    const superGitDir = await fs.realpath(await gitText(superRoot, ['rev-parse', '--absolute-git-dir'], 'verify submodule owner'))
    const modules = await fs.realpath(join(superGitDir, 'modules')).catch(() => '')
    const submodulePath = relative(superRoot, root)
    if (!modules || !inside(modules, gitDir) || !submodulePath || !inside(superRoot, root)) {
      throw new Error(`Filtered upstream ${label} gitdir escapes its superproject`)
    }
    const index = await runGit(superRoot, ['ls-files', '--stage', '-z', '--', submodulePath], 'verify submodule index')
    if (!index.toString('utf8').split('\0').some((entry) => entry.startsWith('160000 ') && entry.includes(' 0\t') &&
        entry.slice(entry.indexOf('\t') + 1) === submodulePath)) {
      throw new Error(`Filtered upstream ${label} is not a registered Git submodule`)
    }
  } else {
    throw new Error(`Filtered upstream ${label} must be an existing primary checkout or registered submodule`)
  }
  return { root, gitDir }
}

async function cleanMain(repo: string, label: string): Promise<string> {
  if (await gitText(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], `read ${label} branch`).catch(() => '') !== 'main') {
    throw new Error(`Filtered upstream ${label} checkout must be on main`)
  }
  if ((await runGit(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], `check ${label} status`)).length) {
    throw new Error(`Filtered upstream ${label} checkout has local changes`)
  }
  return gitText(repo, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], `read ${label} commit`)
}

async function ref(repo: string, name: string): Promise<string | null> {
  try {
    return await gitText(repo, ['rev-parse', '--verify', '--end-of-options', `${name}^{commit}`], `read ${name}`)
  } catch (error) {
    if (error instanceof GitFailure && error.code === 128) return null
    throw error
  }
}

async function ancestor(repo: string, older: string, newer: string): Promise<boolean> {
  try {
    await runGit(repo, ['merge-base', '--is-ancestor', older, newer], 'verify history')
    return true
  } catch (error) {
    if (error instanceof GitFailure && error.code === 1) return false
    throw error
  }
}

function parseMarks(text: string): Map<string, string> {
  const marks = new Map<string, string>()
  for (const line of text.split('\n').filter(Boolean)) {
    const match = /^(:[1-9][0-9]*) ([0-9a-f]{40})$/u.exec(line)
    if (!match || marks.has(match[1]!)) throw new Error('Filtered upstream marks are invalid')
    marks.set(match[1]!, match[2]!)
  }
  return marks
}

function exportLine(stream: Buffer, start: number): { line: string; next: number } {
  const end = stream.indexOf(0x0a, start)
  if (end < 0) throw new Error('Filtered upstream export stream is truncated')
  return { line: stream.toString('utf8', start, end), next: end + 1 }
}

function inspectExport(stream: Buffer, stagingRef: string): Map<string, string> {
  const commits = new Map<string, string>()
  let offset = 0
  let inCommit = false
  let mark = ''
  let original = ''
  while (offset < stream.length) {
    const { line, next } = exportLine(stream, offset)
    offset = next
    if (line.startsWith('commit ') || line.startsWith('reset ')) {
      const index = line.indexOf(' ')
      if (line.slice(index + 1) !== stagingRef) {
        throw new Error('Filtered upstream export contains an unexpected ref')
      }
      inCommit = line.startsWith('commit ')
      mark = ''
      original = ''
      continue
    }
    if (line.startsWith('tag ')) throw new Error('Filtered upstream export unexpectedly contains a tag')
    if (line === 'blob') inCommit = false
    if (line.startsWith('mark ') && inCommit) mark = line.slice(5)
    if (line.startsWith('original-oid ') && inCommit) original = line.slice(13)
    if ((line.startsWith('from ') && !line.startsWith('from :')) || (line.startsWith('merge ') && !line.startsWith('merge :'))) {
      throw new Error('Filtered upstream export contains an unfiltered parent')
    }
    if (line.startsWith('data ')) {
      const length = Number(line.slice(5))
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > stream.length) throw new Error('Filtered upstream export has invalid data length')
      if (inCommit) {
        if (!mark || !SHA.test(original)) throw new Error('Filtered upstream export omitted commit identities')
        commits.set(mark, original)
        inCommit = false
      }
      const end = offset + length
      offset = end
      if (stream[offset] === 0x0a) offset += 1
    }
  }
  if (!commits.size) throw new Error('Verified source has no frontend-design history')
  return commits
}

async function verifyTree(source: string, sourceSha: string, target: string, filteredSha: string): Promise<void> {
  const sourceTree = await runGit(source, ['ls-tree', '-r', '-z', sourceSha, '--', ...TREE_PATHS], 'verify source paths', undefined, MAX_EXPORT)
  const targetTree = await runGit(target, ['ls-tree', '-r', '-z', filteredSha], 'verify filtered paths', undefined, MAX_EXPORT)
  const names = targetTree.toString('utf8').split('\0').filter(Boolean)
  if (names.some((line) => !TREE_PATHS.some((path) => line.includes(`\t${path}/`))) || !sourceTree.equals(targetTree)) {
    throw new Error('Filtered upstream tree does not match its two allowed paths')
  }
}

function parseMapping(raw: string, origin: string): Snapshot[] {
  if (Buffer.byteLength(raw) > MAX_METADATA) throw new Error('Filtered upstream SHA mapping exceeded its size limit')
  const bySource = new Map<string, string>()
  for (const line of raw.split('\n').filter(Boolean)) {
    let value: unknown
    try { value = JSON.parse(line) } catch { throw new Error('Filtered upstream SHA mapping is invalid') }
    if (!record(value) || value.origin !== origin || typeof value.sourceCommit !== 'string' || !SHA.test(value.sourceCommit) ||
        typeof value.filteredCommit !== 'string' || !SHA.test(value.filteredCommit)) {
      throw new Error('Filtered upstream SHA mapping is invalid')
    }
    const existing = bySource.get(value.sourceCommit)
    if (existing && existing !== value.filteredCommit) throw new Error('Filtered upstream SHA mapping conflicts')
    bySource.set(value.sourceCommit, value.filteredCommit)
  }
  if (bySource.size > MAX_SNAPSHOTS) throw new Error('Filtered upstream SHA mapping reached its entry limit')
  return [...bySource].map(([sourceCommit, filteredCommit]) => ({ sourceCommit, filteredCommit }))
}

async function readMapping(path: string, origin: string): Promise<Snapshot[]> {
  const stat = await fs.lstat(path).catch((error: unknown) => {
    if (record(error) && error.code === 'ENOENT') return null
    throw error
  })
  if (!stat) return []
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA) throw new Error('Filtered upstream SHA mapping is not a regular bounded file')
  return parseMapping(await fs.readFile(path, 'utf8'), origin)
}

async function checkMappingCapacity(path: string, origin: string, entry: Snapshot, existing: Snapshot[]): Promise<void> {
  if (existing.some((value) => value.sourceCommit === entry.sourceCommit)) return
  if (existing.length >= MAX_SNAPSHOTS) throw new Error('Filtered upstream SHA mapping reached its entry limit')
  const line = `${JSON.stringify({ origin, ...entry })}\n`
  const stat = await fs.lstat(path).catch((error: unknown) => {
    if (record(error) && error.code === 'ENOENT') return null
    throw error
  })
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Filtered upstream SHA mapping is not a regular file')
  if ((stat?.size ?? 0) + Buffer.byteLength(line) > MAX_METADATA) {
    throw new Error('Filtered upstream SHA mapping exceeded its size limit')
  }
}

async function saveMapping(path: string, origin: string, entry: Snapshot, existing: Snapshot[]): Promise<void> {
  if (existing.some((value) => value.sourceCommit === entry.sourceCommit)) return
  const line = `${JSON.stringify({ origin, ...entry })}\n`
  await fs.appendFile(path, line, { mode: 0o600 })
}

async function ensureDirectory(path: string): Promise<void> {
  const stat = await fs.lstat(path).catch(() => null)
  if (!stat) await fs.mkdir(path, { mode: 0o700 })
  else if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Filtered upstream metadata path is not a regular directory')
}

/** Fetches source main and imports only the fixed frontend-design paths into an existing managed repo. */
export async function syncFilteredUpstream(request: FilteredUpstreamRequest): Promise<FilteredUpstreamResult> {
  const origin = trustedOrigin(request.trustedOrigin ?? ORIGIN)
  const source = await repository(request.sourceCheckoutPath, 'source', false)
  const target = await repository(request.managedRepositoryPath, 'managed', true)
  if (source.root === target.root || inside(source.root, target.root) || inside(target.root, source.root)) {
    throw new Error('Filtered upstream source and managed repositories must be separate')
  }
  const sourceHead = await cleanMain(source.root, 'source')
  const targetHead = await cleanMain(target.root, 'managed')
  if (await gitText(source.root, ['rev-parse', '--is-shallow-repository'], 'inspect source history') !== 'false') {
    throw new Error('Filtered upstream requires complete source history')
  }
  await checkRemote(source.root, 'origin', origin)
  await checkRemote(target.root, 'upstream', origin)

  const metadata = join(target.gitDir, 'skillbuddy', 'filtered-upstream')
  await ensureDirectory(join(target.gitDir, 'skillbuddy'))
  await ensureDirectory(metadata)
  const mappingPath = join(metadata, 'sha-mapping.jsonl')
  const temporary = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-filtered-upstream-'))
  const stagingRef = `${STAGING_PREFIX}${randomUUID()}`
  const sourcePin = `${SOURCE_PIN_PREFIX}${randomUUID()}`
  let staging = false
  let pinned = false
  let pinnedCommit: string | null = null
  try {
    const previousSource = await ref(source.root, 'refs/remotes/origin/main')
    await runGit(source.root, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', 'refs/heads/main:refs/remotes/origin/main'], 'fetch verified source main')
    const sourceCommit = await ref(source.root, 'refs/remotes/origin/main')
    if (!sourceCommit) throw new Error('Verified source does not provide main')
    if ((previousSource && !(await ancestor(source.root, previousSource, sourceCommit))) || !(await ancestor(source.root, sourceHead, sourceCommit))) {
      throw new Error('Verified source main was rewritten or diverged; refusing filtered import')
    }
    await runGit(source.root, ['update-ref', sourcePin, sourceCommit, '0'.repeat(sourceCommit.length)], 'pin source snapshot')
    pinned = true
    pinnedCommit = sourceCommit
    if (await cleanMain(source.root, 'source') !== sourceHead) throw new Error('Source checkout changed during fetch')
    await checkRemote(source.root, 'origin', origin)

    const sourceMarksPath = join(temporary, 'source.marks')
    const targetMarksPath = join(temporary, 'target.marks')
    const exported = await runGit(source.root, [
      'fast-export', '--show-original-ids', '--signed-tags=strip', `--export-marks=${sourceMarksPath}`,
      `--refspec=${sourcePin}:${stagingRef}`, sourcePin, '--', ...PATHS,
    ], 'export selected source history', undefined, MAX_EXPORT)
    const commitMarks = inspectExport(exported, stagingRef)
    if (await ref(source.root, sourcePin) !== sourceCommit || await ref(source.root, 'refs/remotes/origin/main') !== sourceCommit) {
      throw new Error('Source origin/main changed during filtered export; refusing this snapshot')
    }
    const sourceMarks = parseMarks(await fs.readFile(sourceMarksPath, 'utf8'))
    for (const [mark, sha] of commitMarks) if (sourceMarks.get(mark) !== sha) throw new Error('Source SHA mapping failed verification')

    staging = true
    await runGit(target.root, ['fast-import', '--quiet', `--export-marks=${targetMarksPath}`], 'import filtered history', exported)
    const filteredCommit = await ref(target.root, stagingRef)
    if (!filteredCommit) throw new Error('Filtered import did not create a commit')
    const targetMarks = parseMarks(await fs.readFile(targetMarksPath, 'utf8'))
    for (const mark of commitMarks.keys()) {
      const mapped = targetMarks.get(mark)
      if (!mapped || !(await ancestor(target.root, mapped, filteredCommit))) throw new Error('Filtered SHA mapping failed verification')
    }
    if (!(await [...commitMarks.keys()].some((mark) => targetMarks.get(mark) === filteredCommit))) {
      throw new Error('Filtered tip has no verified source SHA mapping')
    }
    await verifyTree(source.root, sourceCommit, target.root, filteredCommit)

    const previousFiltered = await ref(target.root, UPSTREAM_REF)
    if (previousFiltered && !(await ancestor(target.root, previousFiltered, filteredCommit))) {
      throw new Error('Filtered upstream history conflicts with the managed repository')
    }
    const snapshots = await readMapping(mappingPath, origin)
    for (const snapshot of snapshots) {
      if (!(await ancestor(source.root, snapshot.sourceCommit, sourceCommit)) ||
          !(await ancestor(target.root, snapshot.filteredCommit, filteredCommit))) throw new Error('Existing SHA mapping conflicts with fetched history')
    }
    const prior = snapshots.find((snapshot) => snapshot.sourceCommit === sourceCommit)
    if (prior && prior.filteredCommit !== filteredCommit) throw new Error('Filtered export changed a previously mapped SHA')
    await checkMappingCapacity(mappingPath, origin, { sourceCommit, filteredCommit }, snapshots)
    if (await cleanMain(target.root, 'managed') !== targetHead) throw new Error('Managed repository changed during filtered import')
    if (await ref(source.root, sourcePin) !== sourceCommit || await ref(source.root, 'refs/remotes/origin/main') !== sourceCommit) {
      throw new Error('Source origin/main changed before filtered ref update; refusing this snapshot')
    }

    const updated = previousFiltered !== filteredCommit
    if (updated) await runGit(target.root, ['update-ref', UPSTREAM_REF, filteredCommit, previousFiltered ?? '0'.repeat(filteredCommit.length)], 'advance filtered upstream ref')
    const stageSha = await ref(target.root, stagingRef)
    if (stageSha) await runGit(target.root, ['update-ref', '-d', stagingRef, stageSha], 'remove staging ref')
    staging = false
    await saveMapping(mappingPath, origin, { sourceCommit, filteredCommit }, snapshots)
    return { sourceCommit, filteredCommit, updated }
  } finally {
    if (staging) {
      const stageSha = await ref(target.root, stagingRef).catch(() => null)
      if (stageSha) await runGit(target.root, ['update-ref', '-d', stagingRef, stageSha], 'remove staging ref').catch(() => undefined)
    }
    if (pinned && pinnedCommit) {
      await runGit(source.root, ['update-ref', '-d', sourcePin, pinnedCommit], 'remove source snapshot ref').catch(() => undefined)
    }
    await fs.rm(temporary, { recursive: true, force: true })
  }
}
