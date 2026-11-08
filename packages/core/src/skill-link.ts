import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** SkillBuddy 在平台 Skills 根目录下的私有目录名。 */
export const SKILLBUDDY_DIR_NAME = '.skillbuddy'

/** 停放已禁用链接型 Skill 的子目录名。 */
export const DISABLED_LINKS_DIR_NAME = 'disabled'

/**
 * 让停放区对 Git 完全隐身：`*` 会连同 `.gitignore` 自身一起忽略，而 Git 不跟踪
 * 空目录，因此 `<project>/.claude/skills/.skillbuddy/` 根本不会出现在 `git status`
 * 里，团队成员也不会拿到别人的个人禁用状态。想改成团队共享时删掉该文件即可。
 */
const SELF_HIDING_GITIGNORE = '*\n'

/** One linked Skill parked in a root's disabled area. */
export interface ParkedLink {
  name: string
  /** Absolute path of the parked link itself. */
  path: string
  /** Absolute path the link points at; null when unreadable. */
  target: string | null
  /** Whether the link target is missing, so the Skill cannot be read or enabled. */
  broken: boolean
}

/** Resolve the link parking area for one Skills root. */
export function disabledLinksDir(skillsDir: string): string {
  return join(skillsDir, SKILLBUDDY_DIR_NAME, DISABLED_LINKS_DIR_NAME)
}

/** 判断路径本身是否存在，不跟随符号链接（断链同样视为存在）。 */
async function lexists(path: string): Promise<boolean> {
  return fs.lstat(path).then(
    () => true,
    () => false,
  )
}

/** Create the parking area on demand, keeping it invisible to Git. */
async function ensureDisabledLinksDir(skillsDir: string): Promise<string> {
  const dir = disabledLinksDir(skillsDir)
  await fs.mkdir(dir, { recursive: true })
  const ignorePath = join(skillsDir, SKILLBUDDY_DIR_NAME, '.gitignore')
  // 已存在时不覆盖：用户可能已经手动删除或改写它来让团队共享禁用状态。
  if (!(await lexists(ignorePath))) {
    await fs.writeFile(ignorePath, SELF_HIDING_GITIGNORE, 'utf8').catch(() => undefined)
  }
  return dir
}

/**
 * Disable a linked Skill by moving the link itself out of the platform's scan path.
 *
 * `fs.rename` 对符号链接是 lstat 语义，只搬动链接条目本身，不会跟随链接改写上游
 * 本体——这正是链接型 Skill 能安全启停的前提。
 */
export async function parkLink(skillsDir: string, name: string): Promise<string> {
  const source = join(skillsDir, name)
  const entry = await fs.lstat(source).catch(() => null)
  if (!entry?.isSymbolicLink()) {
    throw new Error(`not a linked Skill: ${source}`)
  }
  const destination = join(await ensureDisabledLinksDir(skillsDir), name)
  if (await lexists(destination)) {
    throw new Error(`a disabled link named "${name}" already exists`)
  }
  await fs.rename(source, destination)
  return destination
}

/** Re-enable a parked link by moving it back into the platform's scan path. */
export async function restoreLink(skillsDir: string, name: string): Promise<string> {
  const source = join(disabledLinksDir(skillsDir), name)
  const entry = await fs.lstat(source).catch(() => null)
  if (!entry?.isSymbolicLink()) {
    throw new Error(`no disabled link named "${name}"`)
  }
  const destination = join(skillsDir, name)
  // 停放期间平台目录可能已被同名 Skill 占用，覆盖会丢失用户数据，只能拒绝。
  if (await lexists(destination)) {
    throw new Error(`"${name}" already exists in the Skills directory`)
  }
  await fs.rename(source, destination)
  return destination
}

/** Whether a link with this name currently sits in the root's disabled area. */
export async function isLinkParked(skillsDir: string, name: string): Promise<boolean> {
  const entry = await fs.lstat(join(disabledLinksDir(skillsDir), name)).catch(() => null)
  return entry?.isSymbolicLink() ?? false
}

/**
 * Remove a parked link, leaving its upstream target untouched.
 *
 * `fs.unlink` 只摘掉链接条目本身，因此这也是断链条目在界面上的清理出口。
 */
export async function removeParkedLink(skillsDir: string, name: string): Promise<boolean> {
  const path = join(disabledLinksDir(skillsDir), name)
  const entry = await fs.lstat(path).catch(() => null)
  if (!entry?.isSymbolicLink()) return false
  await fs.unlink(path)
  return true
}

/** List every link parked in a root's disabled area. */
export async function listParkedLinks(
  skillsDir: string,
  onError?: (path: string, error: unknown) => void,
): Promise<ParkedLink[]> {
  const dir = disabledLinksDir(skillsDir)
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) onError?.(dir, error)
    return []
  }
  const parked: ParkedLink[] = []
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    const target = await fs.readlink(path).catch((error: unknown) => {
      onError?.(path, error)
      return null
    })
    // 上游本体在停放期间可能被删除或移走，断链要保留条目并标记，
    // 否则已禁用的 Skill 会从列表里静默消失。
    const broken = await fs
      .stat(path)
      .then(() => false)
      .catch((error: unknown) => {
        onError?.(path, error)
        return true
      })
    parked.push({ name: entry.name, path, target, broken })
  }
  return parked
}
