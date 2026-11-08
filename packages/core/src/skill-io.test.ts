import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findSkills, readSkillDir, readSkillFile, updateSkillDocument } from './skill-io.js'

let root: string

async function writeSkill(dir: string, name: string, content = '# Hi'): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: d\n---\n\n${content}\n`,
    'utf8',
  )
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'skm-io-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('readSkillDir', () => {
  it('reads frontmatter, content and resources', async () => {
    const dir = join(root, 'my-skill')
    await writeSkill(dir, 'my-skill', '# Body')
    await fs.mkdir(join(dir, 'assets'), { recursive: true })
    await fs.writeFile(join(dir, 'assets', 'a.txt'), 'x', 'utf8')

    const skill = await readSkillDir(dir)
    expect(skill).not.toBeNull()
    expect(skill!.name).toBe('my-skill')
    expect(skill!.content).toBe('# Body')
    expect(Object.keys(skill!.resources!)).toEqual(['assets/a.txt'])
  })

  it('returns null without SKILL.md', async () => {
    const dir = join(root, 'not-skill')
    await fs.mkdir(dir, { recursive: true })
    expect(await readSkillDir(dir)).toBeNull()
  })

  it('falls back to folder name when frontmatter has no name', async () => {
    const dir = join(root, 'anon')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'SKILL.md'), '# no frontmatter', 'utf8')
    const skill = await readSkillDir(dir, 'anon')
    expect(skill!.name).toBe('anon')
  })

  it('skips malformed frontmatter without throwing', async () => {
    const dir = join(root, 'broken')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      join(dir, 'SKILL.md'),
      '---\nname: broken\ndescription: invalid: yaml\n---\n',
      'utf8',
    )

    await expect(readSkillDir(dir, 'broken')).resolves.toBeNull()
  })
})

describe('readSkillFile', () => {
  it('preserves extra frontmatter while applying editor fields', async () => {
    const original = '---\nname: example\ndescription: Old\ncustom:\n  value: retained\n---\n\nOld body\n'
    const updated = updateSkillDocument(original, { description: 'New', version: '2', tags: ['one'], content: 'New body' })
    await fs.writeFile(join(root, 'SKILL.md'), updated)
    const skill = await readSkillFile(join(root, 'SKILL.md'))
    expect(skill).toMatchObject({ name: 'example', description: 'New', version: '2', tags: ['one'], content: 'New body', metadata: { custom: { value: 'retained' } } })
    expect(updateSkillDocument(updated, { description: 'New', version: '2', tags: ['one'], content: 'New body' })).toBe(updated)
  })
  it('reads only the selected SKILL.md without sibling resources', async () => {
    const dir = join(root, 'standalone')
    await writeSkill(dir, 'standalone')
    await fs.writeFile(join(dir, 'notes.md'), 'not selected', 'utf8')

    const skill = await readSkillFile(join(dir, 'SKILL.md'), 'standalone')
    expect(skill?.name).toBe('standalone')
    expect(skill?.resources).toBeUndefined()
  })
})

describe('findSkills', () => {
  it('finds nested skills and skips .git/node_modules', async () => {
    await writeSkill(join(root, 'skills', 'alpha'), 'alpha')
    await writeSkill(join(root, 'deep', 'nested', 'beta'), 'beta')
    await writeSkill(join(root, 'node_modules', 'ignored'), 'ignored')
    await writeSkill(join(root, '.git', 'ignored2'), 'ignored2')

    const found = await findSkills(root)
    expect(found.map((f) => f.skill.name)).toEqual(['alpha', 'beta'])
  })

  it('does not descend into a skill folder', async () => {
    await writeSkill(join(root, 'outer'), 'outer')
    await writeSkill(join(root, 'outer', 'inner'), 'inner')
    const found = await findSkills(root)
    expect(found.map((f) => f.skill.name)).toEqual(['outer'])
  })
})
