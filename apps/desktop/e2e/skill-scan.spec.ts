import { promises as fs } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { _electron as electron } from 'playwright'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('扫描本机 Skill 并在 Skills 页面展示', async () => {
  const home = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-e2e-'))
  const skillDirectory = join(home, '.agents', 'skills', 'e2e-skill')
  const codexHome = join(home, '.codex')
  await fs.mkdir(skillDirectory, { recursive: true })
  await fs.mkdir(codexHome, { recursive: true })
  await fs.writeFile(
    join(skillDirectory, 'SKILL.md'),
    `---
name: e2e-skill
description: Electron end-to-end fixture
version: 1.0.0
---

# E2E Skill
`,
    'utf8',
  )

  let application: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    application = await electron.launch({
      args: [
        `--user-data-dir=${join(home, 'user-data')}`,
        join(desktopRoot, 'out', 'main', 'index.js'),
      ],
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
      },
    })
    const page = await application.firstWindow()
    await page.evaluate(() => localStorage.setItem('skm.language', JSON.stringify('zh-CN')))
    await page.reload()
    await expect(page.getByText('SkillBuddy', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /Skills/ }).click()
    await page.getByText('e2e-skill', { exact: true }).click()
    await expect(page.getByRole('heading', { name: 'E2E Skill' })).toBeVisible()
    await page.getByRole('button', { name: '编辑' }).click()
    await expect(page.locator('.cm-editor')).toBeVisible()
  } finally {
    await application?.close()
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('показывает проверенный источник управляемой установки', async () => {
  test.skip(process.platform === 'win32', 'Fixture uses a symbolic link')
  const home = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-provenance-e2e-'))
  const codexHome = join(home, '.codex')
  const repo = join(codexHome, 'vendor', 'source')
  const skill = join(repo, 'skills', 'managed-example')
  const manifest = join(codexHome, 'skills', '.manifests')
  const installed = join(home, '.agents', 'skills')
  await fs.mkdir(skill, { recursive: true })
  await fs.mkdir(manifest, { recursive: true })
  await fs.mkdir(installed, { recursive: true })
  await fs.writeFile(join(skill, 'SKILL.md'), '---\nname: managed-example\ndescription: Example\n---\n\n# Managed example\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q')
  git('remote', 'add', 'origin', 'https://example.com/private.git')
  git('remote', 'add', 'upstream', 'https://example.com/upstream.git')
  git('add', '.')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture')
  const commit = git('rev-parse', 'HEAD')
  await fs.symlink(skill, join(installed, 'managed-example'), 'dir')
  await fs.writeFile(join(manifest, 'source.json'), JSON.stringify({
    schemaVersion: 1,
    managedPath: 'vendor/source',
    managedOrigin: 'https://example.com/private.git',
    upstream: 'https://example.com/upstream.git',
    installations: [{ managedPath: 'vendor/source/skills/managed-example' }],
  }))
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    application = await electron.launch({
      args: [`--user-data-dir=${join(home, 'user-data')}`, join(desktopRoot, 'out', 'main', 'index.js')],
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
    })
    const page = await application.firstWindow()
    await page.getByRole('button', { name: /Skills/ }).click()
    await page.getByText('managed-example', { exact: true }).click()
    await expect(page.getByText(new RegExp(commit.slice(0, 8))).first()).toBeVisible()
    await expect(page.locator(`[title*="${commit}"]`).first()).toBeVisible()
  } finally {
    await application?.close()
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('редактор публикует управляемый Git навык и указатель родителя', async () => {
  test.skip(process.platform === 'win32', 'Fixture uses a symbolic link and Unix Git configuration')
  const home = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-managed-edit-e2e-'))
  const codexHome = join(home, '.codex')
  const parent = codexHome
  const seed = join(home, 'seed')
  const repositories = join(home, 'remotes')
  const childOrigin = join(repositories, 'child.git')
  const upstream = join(repositories, 'upstream.git')
  const parentOrigin = join(repositories, 'parent.git')
  const config = join(home, 'gitconfig')
  const keyPath = join(home, 'server.key')
  const certificatePath = join(home, 'server.crt')
  const portPath = join(home, 'server.port')
  await fs.mkdir(parent, { recursive: true })
  await fs.mkdir(repositories, { recursive: true })
  await fs.mkdir(seed, { recursive: true })
  await fs.mkdir(join(home, '.agents', 'skills'), { recursive: true })
  await fs.mkdir(join(codexHome, 'skills', '.manifests'), { recursive: true })
  await fs.writeFile(join(home, '.agents', 'skills', '.keep'), '')
  await fs.writeFile(config, '')

  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_SSL_NO_VERIFY: '1' }
  const git = (...args: string[]): string => execFileSync('git', args, {
    encoding: 'utf8',
    env: gitEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  const at = (cwd: string, ...args: string[]): string => git('-C', cwd, ...args)
  for (const bare of [childOrigin, upstream, parentOrigin]) {
    git('init', '--bare', '-q', bare)
    git('--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    git('--git-dir', bare, 'config', 'http.receivepack', 'true')
  }
  at(seed, 'init', '-q', '-b', 'main')
  at(seed, 'config', 'user.name', 'E2E')
  at(seed, 'config', 'user.email', 'e2e@example.invalid')
  const managedSkill = join(seed, 'skills', 'managed-edit')
  await fs.mkdir(join(managedSkill, 'assets'), { recursive: true })
  await fs.writeFile(join(managedSkill, 'SKILL.md'), '---\nname: managed-edit\ndescription: Before edit\ncustomMetadata: retain-me\n---\n\n# Before edit\n')
  await fs.writeFile(join(managedSkill, 'assets', 'reference.md'), 'keep resource\n')
  at(seed, 'add', '.')
  at(seed, 'commit', '-qm', 'initial skill')

  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certificatePath, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' })
  const serverProgram = `
    const https = require('node:https')
    const fs = require('node:fs')
    const { spawn } = require('node:child_process')
    const repositories = process.argv[1]
    const server = https.createServer({ key: fs.readFileSync(process.argv[2]), cert: fs.readFileSync(process.argv[3]) }, (request, response) => {
      const url = new URL(request.url || '/', 'https://' + (request.headers.host || '127.0.0.1'))
      console.error('HTTP', request.method, url.pathname + url.search)
      const child = spawn('git', ['http-backend'], { cwd: repositories, env: {
        ...process.env, GIT_PROJECT_ROOT: repositories, GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: request.method || 'GET', PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers['content-type'] || '',
        CONTENT_LENGTH: request.headers['content-length'] || '0', REMOTE_ADDR: '127.0.0.1',
        SERVER_PROTOCOL: 'HTTP/1.1', SERVER_PORT: String(server.address().port), SERVER_NAME: '127.0.0.1',
        SERVER_SOFTWARE: 'SkillBuddy E2E', HTTPS: 'on', SCRIPT_NAME: '', REQUEST_URI: request.url || '/',
      }, stdio: ['pipe', 'pipe', 'pipe'] })
      const output = []; const errors = []
      child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk))
      child.on('close', code => {
        console.error('CGI', code, Buffer.concat(errors).toString())
        if (code !== 0) { response.writeHead(502).end(Buffer.concat(errors)); return }
        const raw = Buffer.concat(output); const separator = raw.indexOf(Buffer.from('\\r\\n\\r\\n'))
        if (separator < 0) { response.writeHead(502).end('Invalid CGI response'); return }
        let status = 200; const headers = {}
        for (const line of raw.subarray(0, separator).toString().split('\\r\\n')) {
          const colon = line.indexOf(':'); if (colon < 0) continue
          const name = line.slice(0, colon).trim(); const value = line.slice(colon + 1).trim()
          if (name.toLowerCase() === 'status') status = Number.parseInt(value.slice(0, 3), 10); else headers[name] = value
        }
        response.writeHead(status, headers).end(raw.subarray(separator + 4))
      })
      request.pipe(child.stdin)
    })
    server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[4], String(server.address().port)))
  `
  const server = spawn(process.execPath, ['-e', serverProgram, repositories, keyPath, certificatePath, portPath], {
    env: gitEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverOutput = ''
  server.stderr.on('data', (chunk: Buffer) => { serverOutput += chunk.toString() })
  let serverPort = 0
  for (let attempt = 0; attempt < 100 && serverPort === 0; attempt += 1) {
    serverPort = Number.parseInt(await fs.readFile(portPath, 'utf8').catch(() => ''), 10) || 0
    if (serverPort === 0) await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25))
    if (server.exitCode !== null) throw new Error(serverOutput || `HTTPS fixture exited with ${server.exitCode}`)
  }
  if (serverPort === 0) throw new Error(`HTTPS fixture did not listen: ${serverOutput}`)
  const baseUrl = `https://127.0.0.1:${serverPort}`
  const childUrl = `${baseUrl}/child.git`
  const upstreamUrl = `${baseUrl}/upstream.git`
  const parentUrl = `${baseUrl}/parent.git`

  let application: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
  at(seed, 'remote', 'add', 'origin', childUrl)
  at(seed, 'remote', 'add', 'upstream', upstreamUrl)
  at(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  at(seed, 'push', '-q', 'upstream', 'HEAD:refs/heads/main')

  at(parent, 'init', '-q', '-b', 'main')
  at(parent, 'config', 'user.name', 'E2E')
  at(parent, 'config', 'user.email', 'e2e@example.invalid')
  at(parent, 'remote', 'add', 'origin', parentOrigin)
  git('-C', parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childOrigin, 'vendor/source')
  const repo = join(parent, 'vendor', 'source')
  at(repo, 'config', 'user.name', 'E2E')
  at(repo, 'config', 'user.email', 'e2e@example.invalid')
  at(repo, 'remote', 'set-url', 'origin', childUrl)
  at(repo, 'remote', 'add', 'upstream', upstreamUrl)
  at(repo, 'fetch', '-q', 'upstream')
  at(repo, 'symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/main')
  at(parent, 'remote', 'set-url', 'origin', parentUrl)
  const currentCommit = at(repo, 'rev-parse', 'HEAD')
  const manifestPath = join(codexHome, 'skills', '.manifests', 'managed-source.json')
  await fs.writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    managedPath: 'vendor/source',
    managedOrigin: childUrl,
    upstream: upstreamUrl,
    currentCommit,
    installations: [{ managedPath: 'vendor/source/skills/managed-edit' }],
  }, null, 2)}\n`)
  await fs.symlink(join(repo, 'skills', 'managed-edit'), join(home, '.agents', 'skills', 'managed-edit'), 'dir')
  await at(parent, 'add', '.')
  at(parent, 'commit', '-qm', 'managed source')
  at(parent, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  const parentBeforeEdit = at(parent, 'rev-parse', 'HEAD')
  const rejectOnceMarker = join(home, 'reject-first-child-push')
  await fs.writeFile(join(childOrigin, 'hooks', 'pre-receive'), `#!/bin/sh\nif [ ! -e '${rejectOnceMarker}' ]; then touch '${rejectOnceMarker}'; exit 1; fi\nexit 0\n`, { mode: 0o755 })

    application = await electron.launch({
      args: [`--user-data-dir=${join(home, 'user-data')}`, join(desktopRoot, 'out', 'main', 'index.js')],
      env: { ...gitEnv, HOME: home, CODEX_HOME: codexHome },
    })
    const page = await application.firstWindow()
    await page.evaluate(() => localStorage.setItem('skm.language', JSON.stringify('zh-CN')))
    await page.reload()
    await page.getByRole('button', { name: /Skills/ }).click()
    await page.getByText('managed-edit', { exact: true }).click()
    await expect(page.getByText(new RegExp(currentCommit.slice(0, 8))).first()).toBeVisible()
    await page.getByRole('button', { name: '编辑' }).click()
    await page.getByLabel('描述').fill('After edit')
    await page.getByLabel('版本').fill('2.0.0')
    const editor = page.locator('.cm-content[contenteditable="true"]')
    await editor.click()
    await editor.press('Meta+A')
    await editor.type('# After edit')
    await expect(page.getByLabel('描述')).toHaveValue('After edit')
    await expect(editor).toContainText('# After edit')
    await page.getByRole('button', { name: '保存并发布' }).click()
    await expect(page.getByRole('button', { name: '重试发布' })).toBeVisible({ timeout: 20000 })
    const retainedChildHead = at(repo, 'rev-parse', 'HEAD')
    expect(retainedChildHead).not.toBe(currentCommit)
    expect(at(childOrigin, 'rev-parse', 'refs/heads/main')).toBe(currentCommit)
    expect(at(parentOrigin, 'rev-parse', 'refs/heads/main')).toBe(parentBeforeEdit)
    await application.close()
    application = undefined
    application = await electron.launch({
      args: [`--user-data-dir=${join(home, 'user-data')}`, join(desktopRoot, 'out', 'main', 'index.js')],
      env: { ...gitEnv, HOME: home, CODEX_HOME: codexHome },
    })
    const restartedPage = await application.firstWindow()
    await restartedPage.getByRole('button', { name: /Skills/ }).click()
    await restartedPage.getByText('managed-edit', { exact: true }).click()
    await expect(restartedPage.getByRole('button', { name: '重试发布' })).toBeVisible({ timeout: 20000 })
    await restartedPage.getByRole('button', { name: '重试发布' }).click()
    await expect(restartedPage.getByText('更改已发布。')).toBeVisible({ timeout: 20000 })

    const childHead = at(repo, 'rev-parse', 'HEAD')
    const parentHead = at(parent, 'rev-parse', 'HEAD')
    expect(childHead).not.toBe(currentCommit)
    expect(parentHead).not.toBe(parentBeforeEdit)
    expect(at(childOrigin, 'rev-parse', 'refs/heads/main')).toBe(childHead)
    expect(at(parentOrigin, 'rev-parse', 'refs/heads/main')).toBe(parentHead)
    expect(at(parent, 'rev-parse', `HEAD:vendor/source`)).toBe(childHead)
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf8'))).toMatchObject({ currentCommit: childHead })
    const persisted = await fs.readFile(join(repo, 'skills', 'managed-edit', 'SKILL.md'), 'utf8')
    expect(persisted).toContain('description: After edit')
    expect(persisted).toContain('version: 2.0.0')
    expect(persisted).toContain('customMetadata: retain-me')
    expect(persisted).toContain('# After edit')
    await expect(fs.readFile(join(repo, 'skills', 'managed-edit', 'assets', 'reference.md'), 'utf8')).resolves.toBe('keep resource\n')
  } finally {
    await application?.close()
    const stopped = new Promise<void>((resolveStopped) => server.once('exit', () => resolveStopped()))
    server.kill()
    await stopped
    await fs.rm(home, { recursive: true, force: true })
  }
})
