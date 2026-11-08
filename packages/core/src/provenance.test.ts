import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlatformAdapter } from './adapters/platform-adapter.js'
import { resolveSkillProvenance } from './provenance.js'
import { readSkillDir } from './skill-io.js'
import type { InstalledSkill } from './types.js'

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

describe.runIf(process.platform !== 'win32')('managed skill provenance', () => {
  it('marks a committed skill dirty when a nested tracked link resolves outside it or breaks', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-skill-links-'))
    roots.push(home)
    const codex = join(home, '.codex')
    const folder = join(codex, 'skills', 'example')
    const resources = join(folder, 'resources')
    await fs.mkdir(resources, { recursive: true })
    await fs.writeFile(join(folder, 'SKILL.md'), '---\nname: example\ndescription: example\nmetadata:\n  skillBuddyProvenance: { kind: codex }\n---\n# example\n')
    const outside = join(home, 'external.txt')
    await fs.writeFile(outside, 'original')
    await fs.writeFile(join(folder, 'internal.txt'), 'internal')
    const link = join(resources, 'target')
    await fs.symlink('../internal.txt', link)
    const git = (...args: string[]) => execFileSync('git', ['-C', codex, ...args], { encoding: 'utf8' }).trim()
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'internal link')
    const skill = await readSkillDir(folder)
    if (!skill) throw new Error('fixture could not be read')
    const item: InstalledSkill = { agent: 'codex', scope: 'user', path: folder, origin: 'user', skill }
    const scan = async () => (await resolveSkillProvenance([item], codex))[0]?.provenance
    expect(await scan()).toMatchObject({ kind: 'codex', git: { dirty: false } })
    await fs.unlink(link)
    await fs.symlink(outside, link)
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'external link')
    expect(await scan()).toMatchObject({ kind: 'codex', git: { dirty: true } })
    await fs.writeFile(outside, 'changed without Git status')
    expect(git('status', '--porcelain')).toBe('')
    expect(await scan()).toMatchObject({ kind: 'codex', git: { dirty: true } })
    await fs.unlink(outside)
    expect(await scan()).toMatchObject({ kind: 'codex', git: { dirty: true } })
  })

  it('resolves declared Codex creation and a scoped local Git version without treating it as publication', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-created-skill-'))
    roots.push(home)
    const codex = join(home, '.codex')
    const folder = join(codex, 'skills', 'example')
    await fs.mkdir(folder, { recursive: true })
    const raw = '---\nname: example\ndescription: example\nmetadata:\n  skillBuddyProvenance: { kind: codex }\n---\n\n# example\n'
    await fs.writeFile(join(folder, 'SKILL.md'), raw)
    await fs.writeFile(join(codex, '.gitignore'), '*.cache\n')
    const git = (...args: string[]) => execFileSync('git', ['-C', codex, ...args], { encoding: 'utf8' }).trim()
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'skill')
    const commit = git('rev-parse', 'HEAD')
    await fs.writeFile(join(codex, 'other'), 'unrelated')
    git('add', 'other')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'unrelated')
    const skill = await readSkillDir(folder)
    expect(skill).not.toBeNull()
    if (!skill) throw new Error('fixture could not be read')
    const item: InstalledSkill = { agent: 'codex', scope: 'user', path: folder, origin: 'user', skill }
    const scan = async (entry = item) => (await resolveSkillProvenance([entry], codex))[0]?.provenance
    expect(await scan()).toMatchObject({ kind: 'codex', evidence: { confidence: 'declared' }, git: { commit, dirty: false, repository: await fs.realpath(codex) } })
    expect(await scan({ ...item, scope: 'project' })).toEqual({ kind: 'codex', evidence: { source: 'skill-frontmatter', field: 'skillBuddyProvenance', confidence: 'declared' } })
    await fs.writeFile(join(folder, 'untracked'), 'new')
    expect(await scan()).toMatchObject({ git: { commit, dirty: true } })
    await fs.rm(join(folder, 'untracked'))
    await fs.writeFile(join(folder, 'data.cache'), 'ignored')
    expect(await scan()).toMatchObject({ git: { commit, dirty: true } })
    await fs.rm(join(folder, 'data.cache'))
    await fs.writeFile(join(folder, 'SKILL.md'), raw + 'modified\n')
    expect(await scan()).toMatchObject({ git: { commit, dirty: true } })
    const outside = join(home, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(join(outside, 'SKILL.md'), raw)
    const link = join(codex, 'skills', 'escape')
    await fs.symlink(outside, link, 'dir')
    expect(await scan({ ...item, path: link })).not.toHaveProperty('git')
    expect(await scan({ ...item, origin: 'plugin' })).toEqual({ kind: 'plugin' })
  })

  it('matches real paths, verifies Git remotes and reports the live revision and dirty state', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'skill-provenance-'))
    roots.push(root)
    const repo = join(root, 'vendor', 'source')
    const skill = join(repo, 'skills', 'example')
    const manifestDir = join(root, 'skills', '.manifests')
    const link = join(root, 'installed')
    const copy = join(root, 'copy')
    await fs.mkdir(skill, { recursive: true })
    await fs.mkdir(manifestDir, { recursive: true })
    await fs.mkdir(copy)
    await fs.writeFile(join(skill, 'SKILL.md'), '# example\n')
    await fs.writeFile(join(copy, 'SKILL.md'), '# example\n')
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
    git('init', '-q')
    git('remote', 'add', 'origin', 'https://example.com/private.git')
    git('remote', 'add', 'upstream', 'https://example.com/upstream.git')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture')
    const commit = git('rev-parse', 'HEAD')
    await fs.symlink(skill, link, 'dir')
    await fs.writeFile(join(manifestDir, 'source.json'), JSON.stringify({
      schemaVersion: 1,
      managedPath: 'vendor/source',
      managedOrigin: 'https://example.com/private.git',
      upstream: 'https://example.com/upstream.git',
      installations: [{ managedPath: 'vendor/source/skills/example' }, { managedPath: 'vendor/source' }],
    }))
    const item = (path: string, origin: InstalledSkill['origin'] = 'user'): InstalledSkill => ({
      agent: 'codex', scope: 'user', path, origin, skill: { name: 'example', description: '', content: '' },
    })
    const result = await resolveSkillProvenance([item(link), item(copy), item(link, 'plugin'), item(repo)], root)
    expect(result[0]?.provenance).toMatchObject({ kind: 'git', commit, dirty: false })
    expect(result[0]?.installationId).not.toEqual(result[1]?.installationId)
    expect(result[1]?.provenance).toEqual({ kind: 'unknown', confidence: 'none' })
    expect(result[2]?.provenance).toEqual({ kind: 'plugin' })
    expect(result[3]?.provenance).toMatchObject({ kind: 'git', commit, dirty: false })
    await fs.writeFile(join(skill, 'SKILL.md'), '# changed\n')
    expect((await resolveSkillProvenance([item(link)], root))[0]?.provenance).toMatchObject({ kind: 'git', dirty: true })
    git('remote', 'set-url', 'origin', 'https://example.com/other.git')
    expect((await resolveSkillProvenance([item(link)], root))[0]?.provenance).toEqual({ kind: 'unknown', confidence: 'none' })
  })

  it('recognizes only explicit local frontmatter declarations and preserves safe archive details', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'declared-skill-provenance-'))
    roots.push(home)
    const paths = ['manual', 'codex', 'archive', 'bad-archive', 'codex-created']
    const metadata = [
      'skillBuddyProvenance: { kind: manual }',
      'skillBuddyProvenance: { kind: codex }',
      'skillBuddyProvenance: { kind: archive, url: "https://example.com/skills.zip", archiveType: zip }',
      'skillBuddyProvenance: { kind: archive, url: "https://user:secret@example.com/file.zip?token=x", archiveType: exe }',
      '',
    ]
    const items: InstalledSkill[] = []
    for (const [index, name] of paths.entries()) {
      const folder = join(home, name)
      await fs.mkdir(folder)
      await fs.writeFile(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n${metadata[index] ?? ''}\n---\n\n# ${name}\n`)
      const skill = await readSkillDir(folder)
      expect(skill).not.toBeNull()
      if (skill) items.push({ agent: 'codex', scope: 'user', path: folder, origin: 'user', skill })
    }
    const result = await resolveSkillProvenance(items, join(home, '.codex'))
    expect(result.map(({ provenance }) => provenance?.kind)).toEqual(['manual', 'codex', 'archive', 'archive', 'unknown'])
    expect(result[0]?.provenance).toMatchObject({ kind: 'manual', evidence: { source: 'skill-frontmatter', confidence: 'declared' } })
    expect(result[1]?.provenance).toMatchObject({ kind: 'codex', evidence: { source: 'skill-frontmatter', confidence: 'declared' } })
    expect(result[2]?.provenance).toMatchObject({ kind: 'archive', url: 'https://example.com/skills.zip', archiveType: 'zip' })
    expect(result[3]?.provenance).toMatchObject({ kind: 'archive' })
    expect(result[3]?.provenance).not.toHaveProperty('url')
    expect(result[3]?.provenance).not.toHaveProperty('archiveType')
    expect(result[4]?.provenance).toEqual({ kind: 'unknown', confidence: 'none' })
  })

  it('does not replace a managed Git installation when an adapter installs over it', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'managed-skill-install-'))
    roots.push(home)
    const codex = join(home, '.codex')
    const managed = join(codex, 'vendor', 'repo', 'skill')
    const skills = join(home, '.fixture', 'skills')
    await fs.mkdir(managed, { recursive: true })
    await fs.mkdir(skills, { recursive: true })
    await fs.writeFile(join(managed, 'SKILL.md'), 'original')
    await fs.symlink(managed, join(skills, 'example'), 'dir')
    vi.stubEnv('CODEX_HOME', codex)
    const adapter = new PlatformAdapter({ id: 'fixture', displayName: 'Fixture', userSkillsDir: '~/.fixture/skills', detectPath: '~/.fixture' }, home)
    await expect(adapter.install({ name: 'example', description: '', content: 'changed' }, 'user'))
      .rejects.toThrow('Managed Git Skill cannot be replaced by a platform copy')
    expect((await fs.lstat(join(skills, 'example'))).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(join(managed, 'SKILL.md'), 'utf8')).toBe('original')
  })
})
