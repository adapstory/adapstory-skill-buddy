import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import matter from 'gray-matter'
import { resolveResourcePath } from '../resource-path.js'
import { isLinkParked, parkLink, removeParkedLink, restoreLink } from '../skill-link.js'
import type { AgentAdapter, AgentId, InstallScope, InstalledSkill, Skill } from '../types.js'
import {
  DISABLED_SKILL_FILE_NAME,
  readSkillDirState,
  SKILL_FILE_NAME,
} from '../skill-io.js'
import { exists, isKebabCase } from './shared.js'

/** 判断路径条目本身是否存在，不跟随可能已经失效的符号链接。 */
async function entryExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Do not replace a managed Git installation with an unrelated platform copy. */
async function assertNotManagedGitTarget(path: string): Promise<void> {
  async function existingRealPath(value: string): Promise<string | null> {
    try {
      return await fs.realpath(value)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }
  const target = await existingRealPath(path)
  if (!target) return
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
  const vendor = await existingRealPath(join(codexHome, 'vendor'))
  if (!vendor) return
  const within = relative(vendor, target)
  if (within && within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within)) {
    throw new Error('Managed Git Skill cannot be replaced by a platform copy')
  }
}

/**
 * Base adapter for platforms following the SKILL.md folder convention
 * (a directory per skill containing SKILL.md with YAML frontmatter).
 * Subclasses provide agent identity, directory resolution and detection.
 */
export abstract class SkillDirAdapter implements AgentAdapter {
  abstract readonly agent: AgentId
  abstract readonly displayName: string
  readonly supportsToggle: boolean = true

  abstract skillsDir(scope: InstallScope, projectRoot?: string): string | null
  abstract detect(): Promise<boolean>

  async list(scope: InstallScope, projectRoot?: string): Promise<InstalledSkill[]> {
    const dir = this.skillsDir(scope, projectRoot)
    if (!dir || !(await exists(dir))) return []
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const skills: InstalledSkill[] = []
    for (const entry of entries) {
      // Dirent 是 lstat 语义：链接型 Skill 的 isDirectory() 为 false，需单独放行。
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const skillPath = join(dir, entry.name)
      const state = await readSkillDirState(skillPath, entry.name)
      if (!state) continue
      let modifiedAt: number | undefined
      try {
        modifiedAt = (
          await fs.stat(join(skillPath, state.enabled ? SKILL_FILE_NAME : DISABLED_SKILL_FILE_NAME))
        ).mtimeMs
      } catch {
        modifiedAt = undefined
      }
      skills.push({
        agent: this.agent,
        scope,
        path: skillPath,
        origin: scope,
        readOnly: false,
        canToggle: this.supportsToggle,
        enabled: state.enabled,
        modifiedAt,
        parseError: state.parseError,
        skill: state.skill,
      })
    }
    return skills
  }

  async install(skill: Skill, scope: InstallScope, projectRoot?: string): Promise<string> {
    if (!isKebabCase(skill.name)) {
      throw new Error(`skill name must be kebab-case, got "${skill.name}"`)
    }
    const dir = this.skillsDir(scope, projectRoot)
    if (!dir) throw new Error(`${this.agent}: no skills directory for scope "${scope}"`)
    const skillPath = join(dir, skill.name)
    await assertNotManagedGitTarget(skillPath)
    await fs.mkdir(dir, { recursive: true })
    const stagingPath = await fs.mkdtemp(join(dir, '.skillbuddy-install-'))
    const backupPath = `${stagingPath}-previous`
    const frontmatter: Record<string, unknown> = {
      name: skill.name,
      description: skill.description,
    }
    if (skill.version) frontmatter.version = skill.version
    if (skill.tags?.length) frontmatter.tags = skill.tags
    const raw = matter.stringify(`\n${skill.content}\n`, frontmatter)
    try {
      if (skill.resources) {
        for (const [rel, src] of Object.entries(skill.resources)) {
          const dest = resolveResourcePath(stagingPath, rel)
          await fs.mkdir(dirname(dest), { recursive: true })
          await fs.copyFile(src, dest)
        }
      }
      await fs.writeFile(join(stagingPath, SKILL_FILE_NAME), raw, 'utf8')
      // fs.access 会跟随链接，失效链接会被误判为不存在；Windows 随后会以
      // EPERM 拒绝把暂存目录改名到仍被该链接占用的目标路径。
      const hadPrevious = await entryExists(skillPath)
      if (hadPrevious) await fs.rename(skillPath, backupPath)
      try {
        await fs.rename(stagingPath, skillPath)
      } catch (error) {
        if (hadPrevious) await fs.rename(backupPath, skillPath)
        throw error
      }
      if (hadPrevious) await fs.rm(backupPath, { recursive: true, force: true }).catch(() => undefined)
    } catch (error) {
      await fs.rm(stagingPath, { recursive: true, force: true })
      throw error
    }
    return skillPath
  }

  async uninstall(name: string, scope: InstallScope, projectRoot?: string): Promise<void> {
    if (!isKebabCase(name)) throw new Error(`skill name must be kebab-case, got "${name}"`)
    const dir = this.skillsDir(scope, projectRoot)
    if (!dir) return
    await fs.rm(join(dir, name), { recursive: true, force: true })
    // 同名链接可能正停放在禁用区，一并摘掉，否则卸载后它会重新出现在列表里。
    await removeParkedLink(dir, name)
  }

  async setEnabled(
    name: string,
    enabled: boolean,
    scope: InstallScope,
    projectRoot?: string,
  ): Promise<void> {
    if (!this.supportsToggle) {
      throw new Error(`${this.agent}: enable/disable is not supported safely`)
    }
    if (!isKebabCase(name)) throw new Error(`skill name must be kebab-case, got "${name}"`)
    const dir = this.skillsDir(scope, projectRoot)
    if (!dir) throw new Error(`${this.agent}: no skills directory for scope "${scope}"`)
    const skillPath = join(dir, name)
    const entry = await fs.lstat(skillPath).catch(() => null)
    // 链接型 Skill 的本体归上游所有，重命名它的 SKILL.md 会顺着链接改写目标目录，
    // 连带影响其他引用同一本体的平台，也会弄脏上游仓库。改为搬动链接条目本身：
    // fs.rename 对符号链接是 lstat 语义，只动引用，上游分毫不碰。
    if (entry?.isSymbolicLink()) {
      if (!enabled) await parkLink(dir, name)
      return
    }
    if (!entry && (await isLinkParked(dir, name))) {
      if (enabled) await restoreLink(dir, name)
      return
    }
    const activePath = join(skillPath, SKILL_FILE_NAME)
    const disabledPath = join(skillPath, DISABLED_SKILL_FILE_NAME)
    if (enabled) {
      if (await exists(activePath)) {
        await fs.rm(disabledPath, { force: true })
        return
      }
      if (!(await exists(disabledPath))) throw new Error(`skill not found: ${name}`)
      await fs.rename(disabledPath, activePath)
      return
    }
    if (await exists(disabledPath)) {
      await fs.rm(activePath, { force: true })
      return
    }
    if (!(await exists(activePath))) throw new Error(`skill not found: ${name}`)
    await fs.rename(activePath, disabledPath)
  }
}
