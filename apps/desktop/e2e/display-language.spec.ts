import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { _electron as electron } from 'playwright'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('switches to Russian and remembers the display language', async () => {
  const home = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-language-'))
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    application = await electron.launch({
      args: [`--user-data-dir=${join(home, 'user-data')}`, join(desktopRoot, 'out', 'main', 'index.js')],
      env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex') },
    })
    const page = await application.firstWindow()
    await page.getByRole('button', { name: /Settings|设置|Настройки/ }).first().click()
    const language = page.getByRole('combobox').first()
    await language.click()
    await page.getByRole('option', { name: 'Русский' }).click()
    await expect(page.getByText('Язык интерфейса', { exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: /Настройки/ }).first().click()
    await expect(page.getByText('Язык интерфейса', { exact: true })).toBeVisible()
    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: 'English' }).click()
    await expect(page.getByText('Display language', { exact: true })).toBeVisible()
  } finally {
    await application?.close()
    await fs.rm(home, { recursive: true, force: true })
  }
})
