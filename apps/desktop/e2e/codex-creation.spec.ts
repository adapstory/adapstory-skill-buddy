import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { _electron as electron } from 'playwright'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('показывает заявленное создание Codex и локальную Git-версию', async () => {
  const home = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-created-skill-'))
  const codex = join(home, '.codex')
  const skill = join(codex, 'skills', 'created-example')
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    const creatorHome = process.env.SKILL_CREATOR_HOME
    await fs.mkdir(join(codex, 'skills'), { recursive: true })
    const git = (...args: string[]) => execFileSync('git', ['-C', codex, ...args], { encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    if (creatorHome) {
      const system = join(creatorHome, 'skills', '.system')
      await fs.symlink(system, join(codex, 'skills', '.system'), 'dir')
      await fs.writeFile(join(codex, '.gitignore'), '/skills/.system/\n')
      git('add', '.gitignore')
      git('commit', '-qm', 'initialize fixture')
      const env = { ...process.env, HOME: home, CODEX_HOME: codex }
      execFileSync('python3', [join(system, 'skill-creator', 'scripts', 'init_skill.py'), 'created-example', '--path', join(codex, 'skills')], { env })
      await fs.writeFile(join(skill, 'SKILL.md'), '---\nname: created-example\ndescription: Created skill\n---\n\n# Created example\n')
      const output = execFileSync('python3', [join(creatorHome, 'bin', 'finish-codex-skill'), skill], { encoding: 'utf8', env })
      expect(output).toContain('not pushed')
      expect(git('show', '--pretty=format:', '--name-only', 'HEAD').split('\n').sort()).toEqual([
        'skills/created-example/SKILL.md', 'skills/created-example/agents/openai.yaml',
      ])
    } else {
      await fs.mkdir(skill, { recursive: true })
      await fs.writeFile(join(skill, 'SKILL.md'), '---\nname: created-example\ndescription: Created skill\nmetadata:\n  skillBuddyProvenance:\n    kind: codex\n---\n\n# Created example\n')
      git('add', 'skills/created-example')
      git('commit', '-qm', 'create skill')
    }
    const commit = git('rev-parse', 'HEAD')
    application = await electron.launch({
      args: [`--user-data-dir=${join(home, 'user-data')}`, join(desktopRoot, 'out', 'main', 'index.js')],
      env: { ...process.env, HOME: home, CODEX_HOME: codex },
    })
    const page = await application.firstWindow()
    await page.evaluate(() => localStorage.setItem('skm.language', JSON.stringify('en')))
    await page.reload()
    await page.getByRole('button', { name: /Skills/ }).click()
    await page.getByText('created-example', { exact: true }).click()
    await expect(page.getByText(/Created by Codex \(declared\)/).first()).toBeVisible()
    await expect(page.getByText(new RegExp(`Local Git commit ${commit.slice(0, 8)}`)).first()).toBeVisible()
  } finally {
    await application?.close()
    await fs.rm(home, { recursive: true, force: true })
  }
})
