import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import matter from 'gray-matter'
import { SKILLBUDDY_DIR_NAME } from './skill-link.js'
import type { Skill, SkillParseWarning } from './types.js'
import { exists } from './adapters/shared.js'

export const SKILL_FILE_NAME = 'SKILL.md'
export const DISABLED_SKILL_FILE_NAME = 'SKILL.md.disabled'

/** Apply editor fields while retaining every other frontmatter field. */
export function updateSkillDocument(raw: string, edit: Pick<Skill, 'description' | 'version' | 'tags' | 'content'>): string {
  const parsed = matter(raw)
  const oldTags = Array.isArray(parsed.data.tags) ? parsed.data.tags.filter((tag: unknown) => typeof tag === 'string') : []
  if ((parsed.data.description ?? '') === edit.description && (parsed.data.version || undefined) === (edit.version || undefined) &&
      JSON.stringify(oldTags) === JSON.stringify(edit.tags ?? []) && parsed.content.trim() === edit.content.trim()) return raw
  const metadata: Record<string, unknown> = { ...parsed.data, description: edit.description }
  if (edit.version) metadata.version = edit.version
  else delete metadata.version
  if (edit.tags?.length) metadata.tags = edit.tags
  else delete metadata.tags
  return matter.stringify(`\n${edit.content}\n`, metadata)
}

export interface SkillFileState {
  skill: Skill
  enabled: boolean
  /** frontmatter 解析失败时的诊断；此时 `skill` 仅是兜底占位。 */
  parseError?: SkillParseWarning
}

export type { SkillParseWarning }

type ParseWarningHandler = (warning: SkillParseWarning) => void
type ReadErrorHandler = (path: string, error: unknown) => void

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function parseMatter(
  raw: string,
  filePath: string,
  onWarning?: ParseWarningHandler,
): matter.GrayMatterFile<string> | null {
  try {
    return matter(raw)
  } catch (error) {
    const candidate = error as { reason?: unknown; message?: unknown; mark?: { line?: unknown } }
    const line = typeof candidate.mark?.line === 'number' ? candidate.mark.line + 1 : undefined
    const message =
      typeof candidate.reason === 'string'
        ? candidate.reason
        : typeof candidate.message === 'string'
          ? candidate.message
          : String(error)
    onWarning?.({ path: filePath, message, line })
    return null
  }
}

interface SkillFileRead {
  skill: Skill
  parseError?: SkillParseWarning
}

/**
 * Read one SKILL.md (or its disabled twin) into a Skill.
 *
 * frontmatter 损坏时不返回 null，而是给出带 `parseError` 的兜底 Skill：名称取目录名、
 * 描述与正文为空。调用方据此决定是「隐藏」还是「标记后照常展示」。
 */
async function readSkillFileState(
  skillPath: string,
  filePath: string,
  fallbackName?: string,
  onWarning?: ParseWarningHandler,
  includeResources = true,
  onReadError?: ReadErrorHandler,
): Promise<SkillFileRead | null> {
  const raw = await fs.readFile(filePath, 'utf8').catch((error: unknown) => {
    onReadError?.(filePath, error)
    return null
  })
  if (raw === null) return null
  let parseError: SkillParseWarning | undefined
  const parsed = parseMatter(raw, filePath, (warning) => {
    parseError = warning
    onWarning?.(warning)
  })
  const data = (parsed?.data ?? {}) as Record<string, unknown>
  // 正文刻意留空：损坏文件的原文若灌进 content，详情页保存时会被再套一层 frontmatter。
  const content = parsed ? parsed.content.trim() : ''
  return {
    parseError,
    skill: {
      name: typeof data.name === 'string' ? data.name : (fallbackName ?? ''),
      description: typeof data.description === 'string' ? data.description : '',
      version: typeof data.version === 'string' ? data.version : undefined,
      tags: Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === 'string') : undefined,
      content,
      resources: includeResources ? await collectResources(skillPath, onReadError) : undefined,
      metadata: data,
    },
  }
}

/** 只读取一个 SKILL.md 文件，不把同目录中的其他文件作为资源带入。 */
export async function readSkillFile(
  filePath: string,
  fallbackName?: string,
  onWarning?: ParseWarningHandler,
): Promise<Skill | null> {
  const read = await readSkillFileState(
    dirname(filePath),
    filePath,
    fallbackName,
    onWarning,
    false,
  )
  if (!read || read.parseError) return null
  return read.skill
}

/**
 * Read one SKILL.md-convention folder into a canonical Skill.
 * Returns null when the folder has no readable SKILL.md.
 *
 * 导入、团队库等写入型场景走这里：frontmatter 损坏的 Skill 一律拒绝，
 * 不能把坏文件复制扩散出去。只读展示请用 {@link readSkillDirState}。
 */
export async function readSkillDir(
  skillPath: string,
  fallbackName?: string,
  onWarning?: ParseWarningHandler,
): Promise<Skill | null> {
  const skillFile = join(skillPath, SKILL_FILE_NAME)
  if (!(await exists(skillFile))) return null
  const read = await readSkillFileState(skillPath, skillFile, fallbackName, onWarning)
  if (!read || read.parseError) return null
  return read.skill
}

/**
 * Read an active or SkillBuddy-disabled skill while preserving its state.
 *
 * 与 {@link readSkillDir} 不同，frontmatter 损坏时这里仍返回条目并带上 `parseError`，
 * 让扫描结果里保留一条可见的「解析失败」记录。
 */
export async function readSkillDirState(
  skillPath: string,
  fallbackName?: string,
  onWarning?: ParseWarningHandler,
  onReadError?: ReadErrorHandler,
): Promise<SkillFileState | null> {
  const activePath = join(skillPath, SKILL_FILE_NAME)
  const disabledPath = join(skillPath, DISABLED_SKILL_FILE_NAME)
  async function present(path: string): Promise<boolean> {
    try {
      await fs.stat(path)
      return true
    } catch (error) {
      if (!isMissing(error)) onReadError?.(path, error)
      return false
    }
  }
  const enabled = await present(activePath)
  if (!enabled && !(await present(disabledPath))) return null
  const read = await readSkillFileState(
    skillPath,
    enabled ? activePath : disabledPath,
    fallbackName,
    onWarning,
    true,
    onReadError,
  )
  if (!read) return null
  return { enabled, skill: read.skill, parseError: read.parseError }
}

/** Walk a skill directory and collect non-SKILL.md files as resources. */
export async function collectResources(
  skillPath: string,
  onReadError?: ReadErrorHandler,
): Promise<Record<string, string> | undefined> {
  const resources: Record<string, string> = {}
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (!onReadError) throw error
      onReadError(dir, error)
      return
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel)
      } else if (rel !== SKILL_FILE_NAME && rel !== DISABLED_SKILL_FILE_NAME) {
        resources[rel] = join(dir, entry.name)
      }
    }
  }
  await walk(skillPath, '')
  return Object.keys(resources).length > 0 ? resources : undefined
}

export interface FoundSkill {
  /** Absolute path of the skill folder */
  dir: string
  skill: Skill
}

// 停放区里是别人禁用掉的链接，导入时不该把它们当作仓库自带的 Skill 收进来。
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', SKILLBUDDY_DIR_NAME])

/**
 * Recursively find SKILL.md folders under a root (for importing from a
 * cloned repo or an arbitrary local directory). A folder that itself
 * contains SKILL.md is returned and not descended further.
 */
export async function findSkills(
  root: string,
  maxDepth = 5,
  onWarning?: ParseWarningHandler,
): Promise<FoundSkill[]> {
  const found: FoundSkill[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    const name = dir.split('/').pop() ?? dir
    const skill = await readSkillDir(dir, name, onWarning)
    if (skill) {
      found.push({ dir, skill })
      return
    }
    if (depth >= maxDepth) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
      await walk(join(dir, entry.name), depth + 1)
    }
  }
  await walk(root, 0)
  return found.sort((a, b) => a.skill.name.localeCompare(b.skill.name))
}
