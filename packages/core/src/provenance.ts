import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { DeclaredProvenanceEvidence, InstalledSkill, SkillProvenance } from './types.js'

const run = promisify(execFile)

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path !== '' && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path)
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined
    return value
  } catch {
    return undefined
  }
}

const declaredEvidence: DeclaredProvenanceEvidence = {
  source: 'skill-frontmatter',
  field: 'skillBuddyProvenance',
  confidence: 'declared',
}

function declaredProvenance(metadata: Record<string, unknown> | undefined): SkillProvenance | undefined {
  const nested = metadata?.metadata
  const value = object(nested) && nested.skillBuddyProvenance !== undefined ? nested.skillBuddyProvenance : metadata?.skillBuddyProvenance
  if (!object(value) || typeof value.kind !== 'string') return undefined
  if (value.kind === 'manual') return { kind: 'manual', evidence: declaredEvidence }
  if (value.kind === 'codex') return { kind: 'codex', evidence: declaredEvidence }
  if (value.kind !== 'archive') return undefined
  const archiveType = value.archiveType
  const url = safeUrl(value.url)
  const normalizedArchiveType = archiveType === 'zip' || archiveType === 'tar' || archiveType === 'tar.gz' || archiveType === 'other'
    ? archiveType
    : undefined
  return {
    kind: 'archive',
    ...(url ? { url } : {}),
    ...(normalizedArchiveType ? { archiveType: normalizedArchiveType } : {}),
    evidence: declaredEvidence,
  }
}

/** Report only the local commit covering a Codex-owned skill, never infer a remote version. */
async function localCodexVersion(codexHome: string, skillPath: string): Promise<{ commit: string; dirty: boolean; repository: string } | undefined> {
  try {
    const repository = await fs.realpath(codexHome)
    const skills = await fs.realpath(join(repository, 'skills'))
    if (!within(repository, skills) || !within(skills, skillPath)) return undefined
    const relativeSkill = relative(skills, skillPath)
    if (relativeSkill.split(/[\\/]/).some((part) => part.startsWith('.'))) return undefined
    const git = async (...args: string[]) => (await run('git', ['-C', repository, ...args], { maxBuffer: 1024 * 1024 })).stdout.trim()
    const [root, skillRoot] = await Promise.all([
      git('rev-parse', '--show-toplevel'),
      (await run('git', ['-C', skillPath, 'rev-parse', '--show-toplevel'])).stdout.trim(),
    ])
    if (await fs.realpath(root) !== repository || await fs.realpath(skillRoot) !== repository) return undefined
    const skillFile = join(skillPath, 'SKILL.md')
    if (!(await fs.lstat(skillFile)).isFile() || await fs.realpath(skillFile) !== skillFile) return undefined
    const path = relative(repository, skillPath)
    const head = await git('rev-parse', 'HEAD')
    await git('cat-file', '-e', `${head}:${path.split(sep).join('/')}/SKILL.md`)
    const [commit, status, ignored, trackedEntries, endHead] = await Promise.all([
      git('log', '-1', '--format=%H', head, '--', path),
      git('status', '--porcelain=v1', '--untracked-files=all', '--', path),
      git('ls-files', '--others', '--ignored', '--exclude-standard', '--', path),
      git('ls-files', '--stage', '-z', '--', path),
      git('rev-parse', 'HEAD'),
    ])
    if (head !== endHead || !/^[0-9a-f]{40}$/.test(commit)) return undefined
    // A Git symlink records its target path, not the target contents. External
    // or broken targets can change independently of this commit.
    const links = trackedEntries.split('\0').filter((entry) => entry.startsWith('120000 '))
    const targets = await Promise.all(links.map(async (entry) => {
      const separator = entry.indexOf('\t')
      if (separator < 0) return false
      const target = await fs.realpath(join(repository, entry.slice(separator + 1))).catch(() => null)
      return target !== null && (target === skillPath || within(skillPath, target))
    }))
    return { commit, dirty: Boolean(status || ignored || targets.includes(false)), repository }
  } catch {
    return undefined
  }
}

/** Resolve only installations whose real path matches a verified managed Git checkout. */
export async function resolveSkillProvenance(
  items: InstalledSkill[],
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
): Promise<InstalledSkill[]> {
  const vendor = await fs.realpath(join(codexHome, 'vendor')).catch(() => null)
  const manifestDir = join(codexHome, 'skills', '.manifests')
  const files = await fs.readdir(manifestDir).catch(() => [])
  const managed = new Map<string, SkillProvenance>()
  if (vendor) for (const file of files.filter((name) => name.endsWith('.json'))) {
    try {
      const manifestPath = join(manifestDir, file)
      if (!(await fs.lstat(manifestPath)).isFile()) continue
      const value: unknown = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
      if (!object(value) || value.schemaVersion !== 1 || typeof value.managedPath !== 'string' || !Array.isArray(value.installations)) continue
      const origin = safeUrl(value.managedOrigin)
      const upstream = safeUrl(value.upstream)
      if (!origin || !upstream) continue
      if (value.upstreamFilter !== undefined && value.upstreamFilter !== 'anthropic-frontend-design-v1') continue
      if (value.upstreamFilter === 'anthropic-frontend-design-v1' && upstream !== 'https://github.com/anthropics/skills.git') continue
      const repo = await fs.realpath(resolve(codexHome, value.managedPath))
      if (!within(vendor, repo)) continue
      const git = async (...args: string[]) => (await run('git', ['-C', repo, ...args])).stdout.trim()
      const [actualOrigin, actualUpstream, commit, status] = await Promise.all([
        git('remote', 'get-url', 'origin'), git('remote', 'get-url', 'upstream'),
        git('rev-parse', 'HEAD'), git('status', '--porcelain', '--untracked-files=normal'),
      ])
      if (actualOrigin !== origin || actualUpstream !== upstream || !/^[0-9a-f]{40}$/.test(commit)) continue
      const provenance: SkillProvenance = {
        kind: 'git', origin, upstream, commit, dirty: status.length > 0, managedPath: repo, manifestPath,
        ...(value.upstreamFilter === 'anthropic-frontend-design-v1' ? { upstreamFilter: value.upstreamFilter } : {}),
      }
      for (const installation of value.installations) {
        if (!object(installation) || typeof installation.managedPath !== 'string') continue
        const path = await fs.realpath(resolve(codexHome, installation.managedPath)).catch(() => null)
        if (path && (path === repo || within(repo, path))) managed.set(path, provenance)
      }
    } catch {
      // Missing, malformed, or inaccessible metadata is not evidence of origin.
    }
  }
  return Promise.all(items.map(async (item) => {
    const installationId = JSON.stringify([item.agent, item.scope, resolve(item.path)])
    if (item.origin === 'plugin') return { ...item, installationId, provenance: { kind: 'plugin' } }
    const path = await fs.realpath(item.path).catch(() => null)
    const provenance = path ? managed.get(path) : undefined
    let declared = declaredProvenance(item.skill.metadata)
    if (!provenance && declared?.kind === 'codex' && item.scope === 'user' && item.origin !== 'system' && path) {
      const git = await localCodexVersion(codexHome, path)
      if (git) declared = { ...declared, git }
    }
    return {
      ...item,
      installationId,
      provenance: provenance ?? declared ?? { kind: 'unknown', confidence: 'none' },
    }
  }))
}
