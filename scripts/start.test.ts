import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  browserCommand,
  buildStatus,
  computeBuildStamp,
  computeInstallStamp,
  INSTALL_STAMP_FILE,
  installFailureMessage,
  installStatus,
  isPortOpen,
  listenAddress,
  listStampFiles,
  parseArgs,
  PNPM_INSTALL_ARGS,
  probeServer,
  serverEnv,
  STAMP_FILE,
  stopExitCode,
  urlHost,
  waitForServer,
  writeBuildStamp,
  writeInstallStamp,
} from './start.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const startUrl = pathToFileURL(path.join(here, 'start.mjs')).href
const hasPnpm = spawnSync('pnpm', ['--version'], { windowsHide: true, shell: process.platform === 'win32' }).status === 0

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gg-start-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function write(rel: string, content: string) {
  const file = path.join(tmp, ...rel.split('/'))
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  return file
}

async function freePort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise(resolve => server.close(resolve))
  return port
}

describe('build stamp', () => {
  beforeEach(async () => {
    await write('app/app.vue', '<template />')
    await write('app/pages/index.vue', '<template />')
    await write('server/api/system.get.ts', 'export default 1')
    await write('shared/types/domain.ts', 'export {}')
    await write('package.json', '{}')
    await write('nuxt.config.ts', 'export default {}')
    await write('README.md', 'not part of the build')
  })

  it('lists source files with forward slashes, sorted', async () => {
    expect(await listStampFiles(tmp)).toEqual(['app/app.vue', 'app/pages/index.vue', 'server/api/system.get.ts', 'shared/types/domain.ts'])
  })

  it('is stable while nothing changes', async () => {
    const a = await computeBuildStamp(tmp)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await computeBuildStamp(tmp)).toBe(a)
  })

  it('changes when a file size changes', async () => {
    const before = await computeBuildStamp(tmp)
    await write('server/api/system.get.ts', 'export default 12')
    expect(await computeBuildStamp(tmp)).not.toBe(before)
  })

  it('changes when only the mtime changes', async () => {
    const file = path.join(tmp, 'app', 'app.vue')
    const before = await computeBuildStamp(tmp)
    const later = new Date(Date.now() + 60_000)
    await fs.utimes(file, later, later)
    expect(await computeBuildStamp(tmp)).not.toBe(before)
  })

  it('changes when files are added, removed or the lockfile appears', async () => {
    const s0 = await computeBuildStamp(tmp)
    await write('app/components/New.vue', '<template />')
    const s1 = await computeBuildStamp(tmp)
    expect(s1).not.toBe(s0)
    await fs.rm(path.join(tmp, 'app', 'components', 'New.vue'))
    expect(await computeBuildStamp(tmp)).toBe(s0)
    await write('pnpm-lock.yaml', 'lockfileVersion: 9')
    expect(await computeBuildStamp(tmp)).not.toBe(s0)
  })

  it('ignores files outside the build inputs', async () => {
    const before = await computeBuildStamp(tmp)
    await write('README.md', 'changed readme')
    await write('data/gg-highlight.db', 'x')
    await write('scripts/start.mjs', 'x')
    expect(await computeBuildStamp(tmp)).toBe(before)
  })

  it('needs a build without .output, after a source change, and not otherwise', async () => {
    const stamp = await computeBuildStamp(tmp)
    expect(await buildStatus(tmp, stamp)).toEqual({ needed: true, reason: 'missing' })
    await write('.output/server/index.mjs', '')
    expect(await buildStatus(tmp, stamp)).toEqual({ needed: true, reason: 'changed' })
    await writeBuildStamp(tmp, stamp)
    expect(await fs.readFile(path.join(tmp, STAMP_FILE), 'utf8')).toBe(`${stamp}\n`)
    expect(await buildStatus(tmp, stamp)).toEqual({ needed: false, reason: null })
    await write('shared/types/domain.ts', 'export type X = 1')
    expect(await buildStatus(tmp, await computeBuildStamp(tmp))).toEqual({ needed: true, reason: 'changed' })
  })
})

describe('install stamp', () => {
  beforeEach(async () => {
    await write('package.json', '{"name":"fake"}')
    await write('pnpm-lock.yaml', 'lockfileVersion: 9')
    await write('node_modules/.keep', '')
  })

  it('hashes the contents of package.json and the lockfile, not their mtimes', async () => {
    const a = await computeInstallStamp(tmp)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    const later = new Date(Date.now() + 60_000)
    await fs.utimes(path.join(tmp, 'package.json'), later, later)
    expect(await computeInstallStamp(tmp)).toBe(a)
    await write('app/app.vue', '<template />')
    expect(await computeInstallStamp(tmp)).toBe(a)
    await write('pnpm-lock.yaml', 'lockfileVersion: 10')
    expect(await computeInstallStamp(tmp)).not.toBe(a)
  })

  it('changes when pnpm-workspace.yaml (the build approvals) appears or changes', async () => {
    const a = await computeInstallStamp(tmp)
    await write('pnpm-workspace.yaml', 'allowBuilds:\n  esbuild: true\n')
    const b = await computeInstallStamp(tmp)
    expect(b).not.toBe(a)
    await write('pnpm-workspace.yaml', 'allowBuilds:\n  esbuild: true\n  vue-demi: true\n')
    expect(await computeInstallStamp(tmp)).not.toBe(b)
  })

  it('needs an install without node_modules, without a stamp, after a dependency change, and not otherwise', async () => {
    const stamp = await computeInstallStamp(tmp)
    // installed by setup.bat (no stamp yet)
    expect(await installStatus(tmp, stamp)).toEqual({ needed: true, reason: 'unknown' })
    await writeInstallStamp(tmp, stamp)
    expect(await fs.readFile(path.join(tmp, INSTALL_STAMP_FILE), 'utf8')).toBe(`${stamp}\n`)
    expect(await installStatus(tmp, stamp)).toEqual({ needed: false, reason: null })
    // an update added a dependency
    await write('package.json', '{"name":"fake","dependencies":{"x":"1.0.0"}}')
    expect(await installStatus(tmp, await computeInstallStamp(tmp))).toEqual({ needed: true, reason: 'changed' })
    await fs.rm(path.join(tmp, 'node_modules'), { recursive: true })
    expect(await installStatus(tmp, stamp)).toEqual({ needed: true, reason: 'missing' })
  })
})

describe('pnpm install', () => {
  const version = (stdout: string) => ({ ok: true, notFound: false, stdout, stderr: '', error: null })

  it('rebuilds node_modules made by another pnpm major instead of asking Y/n', () => {
    expect(PNPM_INSTALL_ARGS).toEqual(['install', '--config.confirm-modules-purge=false'])
  })

  it('points at pnpm\'s own error and lists the common causes instead of blaming the network', () => {
    const lines = installFailureMessage(version('12.18.0\n'))
    const text = lines.join('\n')
    expect(lines[0]).toMatch(/^❌ 套件安裝（pnpm install）失敗，原因請看上面 pnpm 印出的錯誤訊息/)
    for (const cause of ['ERR_PNPM_FETCH_', 'EPERM', 'ERR_PNPM_IGNORED_BUILDS', 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION']) {
      expect(text).toContain(cause)
    }
    expect(text).toMatch(/再雙擊 start\.bat/)
    expect(text).not.toMatch(/pnpm 是|需要 10\.5/)
  })

  it('says when pnpm is missing, too old or broken', () => {
    expect(installFailureMessage({ ok: false, notFound: true, stdout: '', stderr: '', error: 'spawn pnpm ENOENT' }))
      .toEqual(['❌ 找不到 pnpm。請先雙擊 setup.bat 安裝需要的工具，裝好後再雙擊 start.bat。'])
    expect(installFailureMessage(version('10.4.1\n'))[1]).toBe('   你的 pnpm 是 10.4.1，需要 10.5.0 以上：請重新執行 setup.bat，它會更新 pnpm。')
    expect(installFailureMessage({ ok: false, notFound: false, stdout: '', stderr: 'Error: boom\n', error: null })[1])
      .toBe('   pnpm 本身無法執行（Error: boom）：請重新執行 setup.bat。')
  })
})

describe('settings', () => {
  it('parses flags', () => {
    expect(parseArgs([])).toEqual({ open: true, help: false })
    expect(parseArgs(['--no-open'])).toEqual({ open: false, help: false })
    expect(parseArgs(['-h']).help).toBe(true)
  })

  it('defaults to 127.0.0.1:3939 and validates HOST/PORT', () => {
    expect(listenAddress({})).toEqual({ host: '127.0.0.1', port: 3939 })
    expect(listenAddress({ HOST: '0.0.0.0', PORT: '4000' })).toEqual({ host: '0.0.0.0', port: 4000 })
    expect(() => listenAddress({ PORT: '70000' })).toThrow(/PORT/)
    expect(() => listenAddress({ PORT: '12ab' })).toThrow(/PORT/)
    expect(() => listenAddress({ HOST: 'a&calc' })).toThrow(/HOST/)
  })

  it('maps wildcard hosts to loopback and brackets IPv6', () => {
    expect(urlHost('0.0.0.0')).toBe('127.0.0.1')
    expect(urlHost('::')).toBe('127.0.0.1')
    expect(urlHost('::1')).toBe('[::1]')
    expect(urlHost('localhost')).toBe('localhost')
  })

  it('builds the server env without dropping existing NODE_OPTIONS', () => {
    const env = serverEnv({ NODE_OPTIONS: '--max-old-space-size=4096', GG_DATA_DIR: 'd' })
    expect(env).toMatchObject({ HOST: '127.0.0.1', PORT: '3939', GG_DATA_DIR: 'd', NITRO_SHUTDOWN_TIMEOUT: '3000' })
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096 --disable-warning=ExperimentalWarning')
    expect(serverEnv({ NODE_OPTIONS: env.NODE_OPTIONS }).NODE_OPTIONS).toBe(env.NODE_OPTIONS)
    expect(serverEnv({}).NODE_OPTIONS).toBe('--disable-warning=ExperimentalWarning')
    expect(serverEnv({ PORT: '5000', HOST: 'localhost' })).toMatchObject({ PORT: '5000', HOST: 'localhost' })
  })

  it('shortens Nitro\'s shutdown wait well below the force-kill delay, unless set', () => {
    // An open <video> response would otherwise hold the shutdown for Nitro's default 30 s.
    expect(Number(serverEnv({}).NITRO_SHUTDOWN_TIMEOUT)).toBeLessThanOrEqual(5000)
    expect(serverEnv({ NITRO_SHUTDOWN_TIMEOUT: '10000' }).NITRO_SHUTDOWN_TIMEOUT).toBe('10000')
  })

  it('adds SIGHUP to Nitro\'s shutdown signals (closing the console window on Windows), unless set', () => {
    // Nitro's default is "SIGTERM SIGINT": SIGHUP would end the server before its close hook unloads the Ollama model.
    expect(serverEnv({}).NITRO_SHUTDOWN_SIGNALS.split(' ').sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM'])
    expect(serverEnv({ NITRO_SHUTDOWN_SIGNALS: 'SIGTERM' }).NITRO_SHUTDOWN_SIGNALS).toBe('SIGTERM')
  })

  it('treats being ended by the stop request as a clean exit', () => {
    expect(stopExitCode(0)).toBe(0)
    expect(stopExitCode(null)).toBe(0)
    expect(stopExitCode(0xC000013A)).toBe(0)
    expect(stopExitCode(2)).toBe(2)
  })

  it('opens the browser per platform', () => {
    const url = 'http://127.0.0.1:3939'
    expect(browserCommand(url, 'win32', {})).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `"start "" "${url}""`],
      options: { windowsVerbatimArguments: true },
    })
    expect(browserCommand(url, 'darwin').command).toBe('open')
    expect(browserCommand(url, 'linux')).toMatchObject({ command: 'xdg-open', args: [url] })
    expect(() => browserCommand('http://x/"&calc', 'win32')).toThrow()
  })
})

describe('network helpers', () => {
  let server: http.Server | null = null
  afterEach(async () => {
    if (server) {
      server.closeAllConnections()
      await new Promise(resolve => server!.close(resolve))
      server = null
    }
  })

  it('detects an open and a closed port', async () => {
    const port = await freePort()
    expect(await isPortOpen('127.0.0.1', port)).toBe(false)
    server = http.createServer((_req, res) => res.end('ok'))
    await new Promise<void>(resolve => server!.listen(port, '127.0.0.1', resolve))
    expect(await isPortOpen('127.0.0.1', port)).toBe(true)
    expect(await probeServer(`http://127.0.0.1:${port}/api/system`)).toBe(true)
  })

  it('treats any HTTP answer (even 404) as up', async () => {
    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    expect(await probeServer(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/system`)).toBe(true)
  })

  it('waits until the server comes up', async () => {
    const port = await freePort()
    setTimeout(() => {
      server = http.createServer((_req, res) => res.end('{}'))
      server.listen(port, '127.0.0.1')
    }, 400)
    const ticks: number[] = []
    const state = await waitForServer(`http://127.0.0.1:${port}/api/system`, { timeoutMs: 10_000, intervalMs: 100, tickMs: 200, onTick: (s: number) => ticks.push(s) })
    expect(state).toBe('ready')
    expect(ticks.length).toBeGreaterThan(0)
  })

  it('gives up after the timeout or when the server process is gone', async () => {
    const port = await freePort()
    expect(await waitForServer(`http://127.0.0.1:${port}/`, { timeoutMs: 300, intervalMs: 50 })).toBe('timeout')
    expect(await waitForServer(`http://127.0.0.1:${port}/`, { timeoutMs: 5000, isAlive: () => false })).toBe('exited')
  })
})

// ---- whole launch sequence against a fake project root ----

const FAKE_SERVER = `
import fs from 'node:fs'
import http from 'node:http'
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ url: req.url, host: process.env.HOST, port: process.env.PORT, nodeOptions: process.env.NODE_OPTIONS, shutdownTimeout: process.env.NITRO_SHUTDOWN_TIMEOUT, cwd: process.cwd() }))
})
if (process.env.GG_TEST_EXIT) setTimeout(() => process.exit(Number(process.env.GG_TEST_EXIT)), 50)
else server.listen(Number(process.env.PORT), process.env.HOST)
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => {
  fs.writeFileSync(process.env.GG_TEST_MARKER, s)
  server.close()
  process.exit(0)
})
`

const FAKE_BUILD = `
import fs from 'node:fs'
fs.mkdirSync('.output/server', { recursive: true })
fs.copyFileSync('fake-server.mjs', '.output/server/index.mjs')
fs.appendFileSync('build-count.txt', 'x')
`

interface Launch {
  child: ReturnType<typeof spawn>
  output: () => string
  waitFor: (re: RegExp, timeoutMs?: number) => Promise<void>
  exit: Promise<number | null>
}

function launch(root: string, env: Record<string, string>): Launch {
  const wrapper = `
    const { main } = await import(${JSON.stringify(startUrl)})
    const code = await main({ root: ${JSON.stringify(root)}, argv: ['--no-open'], readyTimeoutMs: 20000 })
    process.exit(code)
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', wrapper], {
    // GG_YTDLP_CMD set: start.mjs must not run the real uv (network) unless a test fakes it.
    env: { ...process.env, GG_YTDLP_CMD: 'node fake-yt-dlp.mjs', ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout!.setEncoding('utf8').on('data', (d: string) => { out += d })
  child.stderr!.setEncoding('utf8').on('data', (d: string) => { out += d })
  const exit = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  const waitFor = async (re: RegExp, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs
    while (!re.test(out)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Did not see ${re} in:\n${out}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  return { child, output: () => out, waitFor, exit }
}

const FAKE_INSTALL = `
import fs from 'node:fs'
if (process.env.GG_TEST_INSTALL_FAIL) process.exit(1)
fs.appendFileSync('install-count.txt', 'i')
`

const FAKE_PACKAGE = { name: 'fake', private: true, type: 'module', scripts: { build: 'node fake-build.mjs', postinstall: 'node fake-install.mjs' } }

async function fakeRoot(withBuild: boolean, { installed = true } = {}) {
  await write('app/app.vue', '<template />')
  await write('server/api/system.get.ts', 'export default 1')
  await write('shared/types/domain.ts', 'export {}')
  await write('nuxt.config.ts', 'export default {}')
  await write('fake-server.mjs', FAKE_SERVER)
  await write('fake-build.mjs', FAKE_BUILD)
  await write('fake-install.mjs', FAKE_INSTALL)
  await write('package.json', JSON.stringify(FAKE_PACKAGE))
  if (installed) {
    await write('node_modules/.keep', '')
    await writeInstallStamp(tmp, await computeInstallStamp(tmp))
  }
  if (withBuild) {
    await write('.output/server/index.mjs', FAKE_SERVER)
    await writeBuildStamp(tmp, await computeBuildStamp(tmp))
  }
}

/**
 * A `pnpm` first on PATH that logs its arguments, then runs the real one. pnpm 11 and later skip the
 * root postinstall when nothing changed, so counting postinstall runs would miss an install.
 */
async function pnpmSpy() {
  const real = spawnSync('sh', ['-c', 'command -v pnpm'], { encoding: 'utf8' }).stdout.trim()
  const dir = path.join(tmp, '.spy')
  const log = path.join(dir, 'calls.txt')
  await write('.spy/pnpm', `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`)
  await fs.chmod(path.join(dir, 'pnpm'), 0o755)
  return {
    env: { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` },
    calls: async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean),
  }
}

describe.skipIf(process.platform === 'win32')('main (fake project)', () => {
  it('starts the server with HOST/PORT/NODE_OPTIONS and forwards SIGTERM', async () => {
    await fakeRoot(true)
    const port = await freePort()
    const marker = path.join(tmp, 'signal.txt')
    const run = launch(tmp, { PORT: String(port), HOST: '127.0.0.1', GG_TEST_MARKER: marker })
    await run.waitFor(/gg-highlight 已啟動：http:\/\/127\.0\.0\.1:\d+/)
    expect(run.output()).not.toMatch(/pnpm build/)

    const info = await (await fetch(`http://127.0.0.1:${port}/api/system`)).json()
    expect(info).toMatchObject({ url: '/api/system', host: '127.0.0.1', port: String(port), shutdownTimeout: '3000', cwd: await fs.realpath(tmp) })
    expect(info.nodeOptions).toContain('--disable-warning=ExperimentalWarning')

    run.child.kill('SIGTERM')
    expect(await run.exit).toBe(0)
    expect(await fs.readFile(marker, 'utf8')).toBe('SIGTERM')
    expect(run.output()).toMatch(/已關閉/)
  })

  it('only opens the browser when the port is already serving', async () => {
    await fakeRoot(true)
    const server = http.createServer((_req, res) => res.end('{}'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const run = launch(tmp, { PORT: String(port), GG_TEST_MARKER: path.join(tmp, 'm') })
      expect(await run.exit).toBe(0)
      expect(run.output()).toMatch(/已經在執行中/)
      expect(run.output()).not.toMatch(/啟動伺服器/)
    }
    finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('reports a server that exits on its own with its exit code', async () => {
    await fakeRoot(true)
    const run = launch(tmp, { PORT: String(await freePort()), GG_TEST_EXIT: '3', GG_TEST_MARKER: path.join(tmp, 'm') })
    expect(await run.exit).toBe(3)
    expect(run.output()).toMatch(/伺服器意外結束（代碼 3）/)
  })

  it('installs yt-dlp into tools/ before the server starts, checks once a day, and only warns on failure', async () => {
    await fakeRoot(true)
    const dir = path.join(tmp, '.uv')
    const log = path.join(dir, 'calls.txt')
    await write('.uv/uv', [
      '#!/bin/sh',
      `printf '%s|%s|%s\\n' "$*" "$UV_TOOL_DIR" "$UV_TOOL_BIN_DIR" >> ${JSON.stringify(log)}`,
      'if [ -n "$GG_TEST_UV_FAIL" ]; then echo "error: Failed to fetch" >&2; exit 2; fi',
      // A runnable yt-dlp: installs are checked with `yt-dlp --version`.
      'if [ "$2" = install ]; then mkdir -p "$UV_TOOL_BIN_DIR"; printf \'#!/bin/sh\\necho 2026.10.26\\n\' > "$UV_TOOL_BIN_DIR/yt-dlp"; chmod +x "$UV_TOOL_BIN_DIR/yt-dlp"; echo " + yt-dlp==2026.10.26" >&2; fi',
      'if [ "$2" = upgrade ]; then echo "Nothing to upgrade" >&2; fi',
      '',
    ].join('\n'))
    await fs.chmod(path.join(dir, 'uv'), 0o755)
    const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`, GG_YTDLP_CMD: '', PORT: String(await freePort()), GG_TEST_MARKER: path.join(tmp, 'm') }
    const toolsEnv = `${path.join(tmp, 'tools', 'uv')}|${path.join(tmp, 'tools', 'bin')}`

    const first = launch(tmp, env)
    await first.waitFor(/gg-highlight 已啟動/)
    const out = first.output()
    expect(out).toMatch(/✅ 已安裝 yt-dlp 2026\.10\.26/)
    expect(out.indexOf('已安裝 yt-dlp')).toBeLessThan(out.indexOf('啟動伺服器'))
    first.child.kill('SIGTERM')
    expect(await first.exit).toBe(0)
    expect(await calls()).toEqual([`tool install --upgrade yt-dlp[default,deno]|${toolsEnv}`])
    expect(existsSync(path.join(tmp, 'tools', '.yt-dlp-checked'))).toBe(true)

    // checked less than a day ago: uv is not run, nothing is printed
    const second = launch(tmp, env)
    await second.waitFor(/gg-highlight 已啟動/)
    expect(second.output()).not.toMatch(/yt-dlp/)
    second.child.kill('SIGTERM')
    expect(await second.exit).toBe(0)
    expect(await calls()).toHaveLength(1)

    // the server asked for a check (deleted the stamp) and PyPI cannot be reached: warn and start anyway
    await fs.rm(path.join(tmp, 'tools', '.yt-dlp-checked'))
    const third = launch(tmp, { ...env, GG_TEST_UV_FAIL: '1' })
    await third.waitFor(/gg-highlight 已啟動/)
    expect(third.output()).toMatch(/⚠️ 無法更新 yt-dlp（只影響 YouTube）：uv 執行失敗：Failed to fetch/)
    third.child.kill('SIGTERM')
    expect(await third.exit).toBe(0)
    expect((await calls()).at(-1)).toBe(`tool upgrade yt-dlp|${toolsEnv}`)
  })

  it('rejects a bad PORT', async () => {
    await fakeRoot(true)
    const run = launch(tmp, { PORT: 'abc' })
    expect(await run.exit).toBe(1)
    expect(run.output()).toMatch(/PORT 設定不正確/)
  })

  it.skipIf(!hasPnpm)('runs pnpm build when the build is missing or stale, then only when sources change', async () => {
    await fakeRoot(false)
    // A real install, as setup.bat leaves it: pnpm 11+ installs before `pnpm build` when node_modules
    // is not one it made, which would add a lockfile to this fake project.
    const install = spawnSync('pnpm', ['install'], { cwd: tmp, encoding: 'utf8', windowsHide: true })
    expect(install.status, install.stdout + install.stderr).toBe(0)
    await writeInstallStamp(tmp, await computeInstallStamp(tmp))
    const port = String(await freePort())
    const marker = path.join(tmp, 'm')
    const spy = await pnpmSpy()

    const first = launch(tmp, { ...spy.env, PORT: port, GG_TEST_MARKER: marker })
    await first.waitFor(/gg-highlight 已啟動/, 60_000)
    expect(first.output()).toMatch(/第一次啟動：建置程式/)
    first.child.kill('SIGTERM')
    expect(await first.exit).toBe(0)
    expect(existsSync(path.join(tmp, STAMP_FILE))).toBe(true)

    const second = launch(tmp, { ...spy.env, PORT: port, GG_TEST_MARKER: marker })
    await second.waitFor(/gg-highlight 已啟動/)
    expect(second.output()).not.toMatch(/建置/)
    second.child.kill('SIGTERM')
    expect(await second.exit).toBe(0)

    await write('server/api/system.get.ts', 'export default 2')
    const third = launch(tmp, { ...spy.env, PORT: port, GG_TEST_MARKER: marker })
    await third.waitFor(/gg-highlight 已啟動/, 60_000)
    expect(third.output()).toMatch(/程式有更新，重新建置/)
    third.child.kill('SIGTERM')
    expect(await third.exit).toBe(0)

    expect(await fs.readFile(path.join(tmp, 'build-count.txt'), 'utf8')).toBe('xx')
    expect(await spy.calls()).toEqual(['build', 'build'])
  })

  it.skipIf(!hasPnpm)('runs pnpm install without node_modules and after a dependency change, before building', async () => {
    await fakeRoot(true, { installed: false })
    const port = String(await freePort())
    const marker = path.join(tmp, 'm')
    const spy = await pnpmSpy()
    const installs = async () => (await spy.calls()).filter(c => c.startsWith('install'))
    const installCall = PNPM_INSTALL_ARGS.join(' ')

    const first = launch(tmp, { ...spy.env, PORT: port, GG_TEST_MARKER: marker })
    await first.waitFor(/gg-highlight 已啟動/, 60_000)
    expect(first.output()).toMatch(/第一次啟動：安裝套件/)
    first.child.kill('SIGTERM')
    expect(await first.exit).toBe(0)
    expect(await installs()).toEqual([installCall])
    expect(await fs.readFile(path.join(tmp, 'install-count.txt'), 'utf8')).toBe('i')
    expect(existsSync(path.join(tmp, INSTALL_STAMP_FILE))).toBe(true)

    // nothing changed: no install
    const second = launch(tmp, { ...spy.env, PORT: port, GG_TEST_MARKER: marker })
    await second.waitFor(/gg-highlight 已啟動/)
    expect(second.output()).not.toMatch(/pnpm install/)
    second.child.kill('SIGTERM')
    expect(await second.exit).toBe(0)
    expect(await installs()).toEqual([installCall])

    // an update changed package.json (a new dependency would go here): install, then rebuild
    await write('package.json', JSON.stringify({ ...FAKE_PACKAGE, description: 'updated' }))
    const third = launch(tmp, { ...spy.env, PORT: port, GG_TEST_MARKER: marker })
    await third.waitFor(/gg-highlight 已啟動/, 60_000)
    const out = third.output()
    expect(out).toMatch(/套件有更新，安裝套件/)
    expect(out).toMatch(/程式有更新，重新建置/)
    expect(out.indexOf('套件有更新')).toBeLessThan(out.indexOf('程式有更新'))
    third.child.kill('SIGTERM')
    expect(await third.exit).toBe(0)
    expect(await installs()).toEqual([installCall, installCall])
  })

  it.skipIf(!hasPnpm)('stops before building when pnpm install fails, and points at pnpm\'s error', async () => {
    await fakeRoot(false, { installed: false })
    const run = launch(tmp, { PORT: String(await freePort()), GG_TEST_INSTALL_FAIL: '1', GG_TEST_MARKER: path.join(tmp, 'm') })
    const code = await run.exit
    expect(code).not.toBe(0)
    const out = run.output()
    expect(out).toMatch(/套件安裝（pnpm install）失敗，原因請看上面 pnpm 印出的錯誤訊息/)
    expect(out).toMatch(/ERR_PNPM_IGNORED_BUILDS/)
    expect(out).not.toMatch(/請確認網路連線，或重新執行 setup\.bat/)
    expect(out).not.toMatch(/建置程式/)
    expect(existsSync(path.join(tmp, INSTALL_STAMP_FILE))).toBe(false)
  })

  it('says pnpm is missing instead of blaming the install', async () => {
    await fakeRoot(false, { installed: false })
    const empty = path.join(tmp, '.empty-path')
    await fs.mkdir(empty)
    const run = launch(tmp, { PATH: empty, PORT: String(await freePort()), GG_TEST_MARKER: path.join(tmp, 'm') })
    expect(await run.exit).not.toBe(0)
    expect(run.output()).toMatch(/找不到 pnpm。請先雙擊 setup\.bat/)
    expect(run.output()).not.toMatch(/原因請看上面/)
  })

  it.skipIf(!hasPnpm)('checks the packages once when node_modules came from somewhere else (setup.bat)', async () => {
    await fakeRoot(true, { installed: false })
    await write('node_modules/.keep', '')
    const run = launch(tmp, { PORT: String(await freePort()), GG_TEST_MARKER: path.join(tmp, 'm') })
    await run.waitFor(/gg-highlight 已啟動/, 60_000)
    expect(run.output()).toMatch(/確認套件是否齊全/)
    run.child.kill('SIGTERM')
    expect(await run.exit).toBe(0)
    expect(existsSync(path.join(tmp, INSTALL_STAMP_FILE))).toBe(true)
  })
})
