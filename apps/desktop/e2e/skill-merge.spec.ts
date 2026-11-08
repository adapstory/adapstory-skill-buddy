import { promises as fs } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { _electron as electron } from 'playwright'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('Electron publishes a clean upstream merge and completes a conflicted merge', async () => {
  test.skip(process.platform !== 'darwin', 'Uses macOS Launch Services and a VS Code URL handler')
  test.setTimeout(180_000)
  const home = await fs.mkdtemp(join(tmpdir(), 'skillbuddy-managed-merge-e2e-'))
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
  const readinessPath = join(home, 'merge-conflict-ready.json')
  const manualVsCode = process.env.SKILL_MERGE_E2E_MANUAL_VSCODE === '1'
  await fs.mkdir(parent, { recursive: true })
  await fs.mkdir(repositories, { recursive: true })
  await fs.mkdir(seed, { recursive: true })
  await fs.mkdir(join(home, '.agents', 'skills'), { recursive: true })
  await fs.mkdir(join(codexHome, 'skills', '.manifests'), { recursive: true })
  await fs.writeFile(join(home, '.agents', 'skills', '.keep'), '')
  await fs.writeFile(config, '')

  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_SSL_NO_VERIFY: '1' }
  const git = (...args: string[]): string => execFileSync('git', args, {
    encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'],
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
  const managedSkill = join(seed, 'skills', 'merge-conflict')
  await fs.mkdir(managedSkill, { recursive: true })
  await fs.writeFile(join(managedSkill, 'SKILL.md'), '---\nname: merge-conflict\ndescription: Git merge fixture\n---\n\n# Shared line\nBase content\n')
  await fs.writeFile(join(seed, 'README.md'), 'base\n')
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
      const child = spawn('git', ['http-backend'], { cwd: repositories, env: {
        ...process.env, GIT_PROJECT_ROOT: repositories, GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: request.method || 'GET', PATH_INFO: decodeURIComponent(url.pathname), QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers['content-type'] || '', CONTENT_LENGTH: request.headers['content-length'] || '0',
        REMOTE_ADDR: '127.0.0.1', SERVER_PROTOCOL: 'HTTP/1.1', SERVER_PORT: String(server.address().port),
        SERVER_NAME: '127.0.0.1', SERVER_SOFTWARE: 'SkillBuddy E2E', HTTPS: 'on', SCRIPT_NAME: '', REQUEST_URI: request.url || '/',
      }, stdio: ['pipe', 'pipe', 'pipe'] })
      const output = []; const errors = []
      child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk))
      child.on('close', code => {
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
  const server = spawn(process.execPath, ['-e', serverProgram, repositories, keyPath, certificatePath, portPath], { env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] })
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

    // Put an application-owned commit on origin so the first upstream update is a clean merge.
    await fs.writeFile(join(repo, 'skills', 'merge-conflict', 'SKILL.md'), '---\nname: merge-conflict\ndescription: Git merge fixture\n---\n\n# Shared line\nLocal content\n')
    at(repo, 'add', 'skills/merge-conflict/SKILL.md')
    at(repo, 'commit', '-qm', 'local skill change')
    at(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
    const currentCommit = at(repo, 'rev-parse', 'HEAD')
    const manifestPath = join(codexHome, 'skills', '.manifests', 'managed-source.json')
    await fs.writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      managedPath: 'vendor/source',
      managedOrigin: childUrl,
      upstream: upstreamUrl,
      currentCommit,
      installations: [{ managedPath: 'vendor/source/skills/merge-conflict' }],
    }, null, 2)}\n`)
    await fs.symlink(join(repo, 'skills', 'merge-conflict'), join(home, '.agents', 'skills', 'merge-conflict'), 'dir')
    await at(parent, 'add', '.')
    at(parent, 'commit', '-qm', 'managed source')
    at(parent, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
    const parentOriginBase = at(parentOrigin, 'rev-parse', 'refs/heads/main')

    // First upstream change is independent and must merge and publish successfully.
    await fs.writeFile(join(seed, 'UPSTREAM.md'), 'clean upstream change\n')
    at(seed, 'add', 'UPSTREAM.md')
    at(seed, 'commit', '-qm', 'clean upstream change')
    at(seed, 'push', '-q', 'upstream', 'HEAD:refs/heads/main')

    application = await electron.launch({
      args: [`--user-data-dir=${join(home, 'user-data')}`, join(desktopRoot, 'out', 'main', 'index.js')],
      env: { ...gitEnv, HOME: home, CODEX_HOME: codexHome },
    })
    const page = await application.firstWindow()
    await page.evaluate(() => localStorage.setItem('skm.language', JSON.stringify('zh-CN')))
    await page.reload()
    await page.getByRole('button', { name: /Skills/ }).click()
    await page.getByText('merge-conflict', { exact: true }).click()

    await page.getByRole('button', { name: '检查上游' }).click()
    await expect(page.getByRole('button', { name: '合并上游并发布' })).toBeEnabled()
    await page.getByRole('button', { name: '合并上游并发布' }).click()
    await expect(page.getByText('更改已发布。')).toBeVisible({ timeout: 20_000 })
    const cleanMergeCommit = at(repo, 'rev-parse', 'HEAD')
    const parentAfterCleanMerge = at(parent, 'rev-parse', 'HEAD')
    expect(cleanMergeCommit).not.toBe(currentCommit)
    expect(at(childOrigin, 'rev-parse', 'refs/heads/main')).toBe(cleanMergeCommit)
    expect(at(parentOrigin, 'rev-parse', 'refs/heads/main')).toBe(parentAfterCleanMerge)
    expect(at(parent, 'rev-parse', 'HEAD:vendor/source')).toBe(cleanMergeCommit)
    expect(await fs.readFile(join(repo, 'UPSTREAM.md'), 'utf8')).toBe('clean upstream change\n')

    // This second upstream update edits the same line as the local commit and creates a conflict.
    await fs.writeFile(join(seed, 'skills', 'merge-conflict', 'SKILL.md'), '---\nname: merge-conflict\ndescription: Git merge fixture\n---\n\n# Shared line\nUpstream content\n')
    at(seed, 'add', 'skills/merge-conflict/SKILL.md')
    at(seed, 'commit', '-qm', 'conflicting upstream change')
    at(seed, 'push', '-q', 'upstream', 'HEAD:refs/heads/main')
    await page.getByRole('button', { name: '检查上游' }).click()
    await expect(page.getByRole('button', { name: '合并上游并发布' })).toBeEnabled()
    await page.getByRole('button', { name: '合并上游并发布' }).click()
    await expect(page.getByRole('status').getByText('在 VS Code 中解决并暂存冲突，然后完成合并。')).toBeVisible({ timeout: 20_000 })
    const conflictFile = join(repo, 'skills', 'merge-conflict', 'SKILL.md')
    await expect.poll(() => at(repo, 'diff', '--name-only', '--diff-filter=U')).toContain('skills/merge-conflict/SKILL.md')

    if (manualVsCode) {
      const conflictButton = page.getByRole('button', { name: 'skills/merge-conflict/SKILL.md' })
      await conflictButton.click()
      // The handler uses the real macOS URL scheme through Electron shell.openExternal.
      await expect.poll(() => execFileSync('/usr/bin/open', ['-Ra', 'Visual Studio Code'], { encoding: 'utf8' })).toBe('')
      await fs.writeFile(readinessPath, JSON.stringify({
        repo,
        conflictFile,
        file: 'skills/merge-conflict/SKILL.md',
        parent,
        parentOriginBase,
        cleanMergeCommit,
      }, null, 2))
      console.log(`VS_CODE_CONFLICT_READY ${readinessPath}`)

      // Resolve the conflict in the real VS Code window using Computer Use.
    } else {
      await fs.writeFile(conflictFile, '---\nname: merge-conflict\ndescription: Git merge fixture\n---\n\n# Shared line\nResolved automatically by E2E\n')
    }
    let resolvedContent = await fs.readFile(conflictFile, 'utf8')
    for (let attempt = 0; manualVsCode && attempt < 120; attempt += 1) {
      if (!resolvedContent.includes('<<<<<<<') && !resolvedContent.includes('>>>>>>>')) break
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_000))
      resolvedContent = await fs.readFile(conflictFile, 'utf8')
    }
    expect(resolvedContent).not.toContain('<<<<<<<')
    expect(resolvedContent).not.toContain('>>>>>>>')
    at(repo, 'add', '--', 'skills/merge-conflict/SKILL.md')
    expect(at(repo, 'diff', '--name-only', '--diff-filter=U')).toBe('')
    expect(at(repo, 'diff', '--cached', '--name-only')).toBe('skills/merge-conflict/SKILL.md')
    await page.getByRole('button', { name: '完成合并并发布' }).click()
    await expect(page.getByText('更改已发布。')).toBeVisible({ timeout: 30_000 })
    const finalChild = at(repo, 'rev-parse', 'HEAD')
    const finalParent = at(parent, 'rev-parse', 'HEAD')
    expect(at(childOrigin, 'rev-parse', 'refs/heads/main')).toBe(finalChild)
    expect(at(parentOrigin, 'rev-parse', 'refs/heads/main')).toBe(finalParent)
    expect(at(parent, 'rev-parse', 'HEAD:vendor/source')).toBe(finalChild)
    expect(finalChild).not.toBe(cleanMergeCommit)
    expect(finalParent).not.toBe(parentAfterCleanMerge)
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf8'))).toMatchObject({ currentCommit: finalChild })
    expect(await fs.readFile(conflictFile, 'utf8')).toContain(manualVsCode ? 'Local content' : 'Resolved automatically by E2E')
    expect(at(repo, 'status', '--porcelain')).toBe('')
    expect(at(parent, 'status', '--porcelain')).toBe('')
  } finally {
    await application?.close()
    const stopped = new Promise<void>((resolveStopped) => server.once('exit', () => resolveStopped()))
    server.kill()
    await stopped
    await fs.rm(home, { recursive: true, force: true })
  }
})
