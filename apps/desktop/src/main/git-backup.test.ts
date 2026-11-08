import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { listInstructionProfiles, type InstalledSkill, type InstructionDocument } from '@skillbuddy/core'
import { prepareGitRestore, pushGitBackup, restoreGitInstructions } from './git-backup.js'
import { PathAccessPolicy } from './path-policy.js'

const execFileAsync = promisify(execFile)
const temporaryRoots: string[] = []
const noInstructions = async (): Promise<InstructionDocument[]> => []

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

async function git(cwd: string | undefined, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).stdout.trim()
}

async function fixture(name: string, content = `# ${name}`): Promise<InstalledSkill> {
  const root = await temporaryDirectory('skillbuddy-backup-skill-')
  const directory = join(root, name)
  await fs.mkdir(join(directory, 'assets'), { recursive: true })
  await fs.writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: fixture\n---\n\n${content}\n`,
    'utf8',
  )
  await fs.writeFile(join(directory, 'assets', 'note.txt'), 'portable', 'utf8')
  return {
    agent: 'codex',
    scope: 'user',
    path: directory,
    enabled: true,
    skill: {
      name,
      description: 'fixture',
      tags: [],
      content,
      resources: { 'assets/note.txt': join(directory, 'assets', 'note.txt') },
    },
  }
}

async function bareRepository(): Promise<string> {
  const remote = await temporaryDirectory('skillbuddy-backup-remote-')
  await git(undefined, ['init', '--bare', remote])
  return remote
}

async function instructionFixture(content = '# Global instructions\n') {
  const root = await temporaryDirectory('skillbuddy-backup-instruction-')
  const targetPath = join(root, '.codex', 'AGENTS.md')
  await fs.mkdir(join(root, '.codex'), { recursive: true })
  await fs.writeFile(targetPath, content, 'utf8')
  const baseProfile = listInstructionProfiles().find((profile) => profile.key.productId === 'codex')!
  const profile = { ...baseProfile, globalPaths: [targetPath] }
  const surface = { ...profile.key }
  const document: InstructionDocument = {
    id: targetPath,
    kind: 'agents',
    fileName: 'AGENTS.md',
    path: targetPath,
    scope: 'user',
    bindings: [{ surface, role: 'primary', status: 'ok' }],
    contentHash: createHash('sha256').update(content).digest('hex'),
    modifiedAt: Date.now(),
    size: Buffer.byteLength(content),
    readOnly: false,
    linked: false,
  }
  return { content, document, profile, targetPath }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  )
})

describe('Git backup', () => {
  it('允许首次推送空快照', async () => {
    const remote = await bareRepository()
    const request = { remoteUrl: remote, branch: 'main', presets: [] }
    const result = await pushGitBackup(request, {
      allowLocalRemote: true,
      scan: async () => [],
      scanInstructions: noInstructions,
    })
    expect(result).toMatchObject({
      committed: true,
      skills: 0,
      presets: 0,
      instructions: 0,
    })
  })

  it('推送可移植快照并从指定分支恢复', async () => {
    const remote = await bareRepository()
    const skill = await fixture('alpha')
    const request = {
      remoteUrl: remote,
      branch: 'devices/main',
      presets: [{ name: 'Frontend', skills: ['alpha'] }],
    }

    const pushed = await pushGitBackup(request, {
      allowLocalRemote: true,
      scan: async () => [skill],
      scanInstructions: noInstructions,
    })
    expect(pushed).toMatchObject({ committed: true, skills: 1, presets: 1 })

    const preview = await prepareGitRestore(request, new PathAccessPolicy(), {
      allowLocalRemote: true,
    })
    temporaryRoots.push(preview.root)
    expect(preview.presets).toEqual([{ name: 'Frontend', skills: ['alpha'] }])
    expect(preview.items.map((item) => item.skill.name)).toEqual(['alpha'])
    expect(await fs.readFile(preview.items[0]!.skill.resources!['assets/note.txt']!, 'utf8')).toBe(
      'portable',
    )
  })

  it('相同内容重复备份不产生提交', async () => {
    const remote = await bareRepository()
    const skill = await fixture('alpha')
    const request = { remoteUrl: remote, branch: 'main', presets: [] }

    const options = {
      allowLocalRemote: true,
      scan: async () => [skill],
      scanInstructions: noInstructions,
    }
    expect((await pushGitBackup(request, options)).committed).toBe(true)
    expect((await pushGitBackup(request, options)).committed).toBe(false)
  })

  it('兼容不包含 AI 指令的 v1 快照', async () => {
    const remote = await bareRepository()
    const skill = await fixture('alpha')
    const request = { remoteUrl: remote, branch: 'main', presets: [] }
    await pushGitBackup(request, {
      allowLocalRemote: true,
      scan: async () => [skill],
      scanInstructions: noInstructions,
    })

    const worktree = await temporaryDirectory('skillbuddy-backup-v1-')
    await git(undefined, ['clone', '--branch', 'main', remote, worktree])
    const manifestPath = join(worktree, 'skillbuddy-backup.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.version = 1
    delete manifest.instructions
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await git(worktree, ['add', 'skillbuddy-backup.json'])
    await git(worktree, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'v1'])
    await git(worktree, ['push', 'origin', 'main'])

    const preview = await prepareGitRestore(request, new PathAccessPolicy(), {
      allowLocalRemote: true,
    })
    temporaryRoots.push(preview.root)
    expect(preview.instructions).toEqual([])
  })

  it('备份并按原 Agent 路径恢复全局 AI 指令', async () => {
    const remote = await bareRepository()
    const skill = await fixture('alpha')
    const instruction = await instructionFixture()
    const request = { remoteUrl: remote, branch: 'main', presets: [] }
    const instructionOptions = {
      instructionProfiles: () => [instruction.profile],
    }

    const pushed = await pushGitBackup(request, {
      allowLocalRemote: true,
      scan: async () => [skill],
      scanInstructions: async () => [instruction.document],
      ...instructionOptions,
    })
    expect(pushed.instructions).toBe(1)

    await fs.writeFile(instruction.targetPath, '# Local instructions\n', 'utf8')
    const pathPolicy = new PathAccessPolicy()
    const preview = await prepareGitRestore(request, pathPolicy, {
      allowLocalRemote: true,
      ...instructionOptions,
    })
    temporaryRoots.push(preview.root)
    expect(preview.instructions).toEqual([
      expect.objectContaining({
        displayName: 'Codex',
        targetPath: instruction.targetPath,
        state: 'conflict',
      }),
    ])

    const skipped = await restoreGitInstructions(
      { root: preview.root, overwriteConflicts: false },
      pathPolicy,
      instructionOptions,
    )
    expect(skipped).toEqual([
      expect.objectContaining({ path: instruction.targetPath, ok: true, skipped: true }),
    ])
    expect(await fs.readFile(instruction.targetPath, 'utf8')).toBe('# Local instructions\n')

    const restored = await restoreGitInstructions(
      { root: preview.root, overwriteConflicts: true },
      pathPolicy,
      instructionOptions,
    )
    expect(restored).toEqual([
      expect.objectContaining({ path: instruction.targetPath, ok: true }),
    ])
    expect(await fs.readFile(instruction.targetPath, 'utf8')).toBe(instruction.content)
  })

  it('拒绝存在漂移的 Skill 和内嵌凭据的远程地址', async () => {
    const first = await fixture('alpha', '# first')
    const second = await fixture('alpha', '# second')
    await expect(
      pushGitBackup(
        { remoteUrl: await bareRepository(), branch: 'main', presets: [] },
        { allowLocalRemote: true, scan: async () => [first, second], scanInstructions: noInstructions },
      ),
    ).rejects.toThrow('resolve Skill drift')

    await expect(
      pushGitBackup(
        { remoteUrl: 'https://token@example.com/private.git', branch: 'main', presets: [] },
        { scan: async () => [], scanInstructions: noInstructions },
      ),
    ).rejects.toThrow('must not contain credentials')
    await expect(
      pushGitBackup(
        { remoteUrl: 'git://example.com/private.git', branch: 'main', presets: [] },
        { scan: async () => [], scanInstructions: noInstructions },
      ),
    ).rejects.toThrow('use HTTPS or SSH')
  })

  it('拒绝 manifest 与仓库 Skill 内容不一致的快照', async () => {
    const remote = await bareRepository()
    const skill = await fixture('alpha')
    const request = { remoteUrl: remote, branch: 'main', presets: [] }
    await pushGitBackup(request, {
      allowLocalRemote: true,
      scan: async () => [skill],
      scanInstructions: noInstructions,
    })

    const worktree = await temporaryDirectory('skillbuddy-backup-tamper-')
    await git(undefined, ['clone', '--branch', 'main', remote, worktree])
    await fs.appendFile(join(worktree, 'skills', 'alpha', 'SKILL.md'), '\nTampered\n', 'utf8')
    await git(worktree, ['add', '.'])
    await git(worktree, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'tamper'])
    await git(worktree, ['push', 'origin', 'main'])

    await expect(
      prepareGitRestore(request, new PathAccessPolicy(), { allowLocalRemote: true }),
    ).rejects.toThrow(
      'does not match its manifest',
    )
  })

  it('推送前拒绝远程仓库中的符号链接', async () => {
    const remote = await bareRepository()
    const worktree = await temporaryDirectory('skillbuddy-backup-symlink-')
    const outside = join(await temporaryDirectory('skillbuddy-backup-outside-'), 'outside.json')
    await git(undefined, ['clone', remote, worktree])
    await fs.writeFile(outside, 'unchanged', 'utf8')
    await fs.symlink(outside, join(worktree, 'skillbuddy-backup.json'))
    await git(worktree, ['add', '.'])
    await git(worktree, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'link'])
    await git(worktree, ['push', 'origin', 'HEAD:main'])

    await expect(
      pushGitBackup(
        { remoteUrl: remote, branch: 'main', presets: [] },
        { allowLocalRemote: true, scan: async () => [], scanInstructions: noInstructions },
      ),
    ).rejects.toThrow('symbolic links')
    expect(await fs.readFile(outside, 'utf8')).toBe('unchanged')
  })
})
