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
  isPortOpen,
  listenAddress,
  listStampFiles,
  parseArgs,
  probeServer,
  serverEnv,
  STAMP_FILE,
  stopExitCode,
  urlHost,
  waitForServer,
  writeBuildStamp,
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
    expect(env).toMatchObject({ HOST: '127.0.0.1', PORT: '3939', GG_DATA_DIR: 'd' })
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096 --disable-warning=ExperimentalWarning')
    expect(serverEnv({ NODE_OPTIONS: env.NODE_OPTIONS }).NODE_OPTIONS).toBe(env.NODE_OPTIONS)
    expect(serverEnv({}).NODE_OPTIONS).toBe('--disable-warning=ExperimentalWarning')
    expect(serverEnv({ PORT: '5000', HOST: 'localhost' })).toMatchObject({ PORT: '5000', HOST: 'localhost' })
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
  res.end(JSON.stringify({ url: req.url, host: process.env.HOST, port: process.env.PORT, nodeOptions: process.env.NODE_OPTIONS, cwd: process.cwd() }))
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
    env: { ...process.env, ...env },
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

async function fakeRoot(withBuild: boolean) {
  await write('node_modules/.keep', '')
  await write('app/app.vue', '<template />')
  await write('server/api/system.get.ts', 'export default 1')
  await write('shared/types/domain.ts', 'export {}')
  await write('nuxt.config.ts', 'export default {}')
  await write('fake-server.mjs', FAKE_SERVER)
  await write('fake-build.mjs', FAKE_BUILD)
  await write('package.json', JSON.stringify({ name: 'fake', private: true, type: 'module', scripts: { build: 'node fake-build.mjs' } }))
  if (withBuild) {
    await write('.output/server/index.mjs', FAKE_SERVER)
    await writeBuildStamp(tmp, await computeBuildStamp(tmp))
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
    expect(info).toMatchObject({ url: '/api/system', host: '127.0.0.1', port: String(port), cwd: await fs.realpath(tmp) })
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

  it('rejects a bad PORT', async () => {
    await fakeRoot(true)
    const run = launch(tmp, { PORT: 'abc' })
    expect(await run.exit).toBe(1)
    expect(run.output()).toMatch(/PORT 設定不正確/)
  })

  it.skipIf(!hasPnpm)('runs pnpm build when the build is missing or stale, then only when sources change', async () => {
    await fakeRoot(false)
    const port = String(await freePort())
    const marker = path.join(tmp, 'm')

    const first = launch(tmp, { PORT: port, GG_TEST_MARKER: marker })
    await first.waitFor(/gg-highlight 已啟動/, 60_000)
    expect(first.output()).toMatch(/第一次啟動：建置程式/)
    first.child.kill('SIGTERM')
    expect(await first.exit).toBe(0)
    expect(existsSync(path.join(tmp, STAMP_FILE))).toBe(true)

    const second = launch(tmp, { PORT: port, GG_TEST_MARKER: marker })
    await second.waitFor(/gg-highlight 已啟動/)
    expect(second.output()).not.toMatch(/建置/)
    second.child.kill('SIGTERM')
    expect(await second.exit).toBe(0)

    await write('server/api/system.get.ts', 'export default 2')
    const third = launch(tmp, { PORT: port, GG_TEST_MARKER: marker })
    await third.waitFor(/gg-highlight 已啟動/, 60_000)
    expect(third.output()).toMatch(/程式有更新，重新建置/)
    third.child.kill('SIGTERM')
    expect(await third.exit).toBe(0)

    expect(await fs.readFile(path.join(tmp, 'build-count.txt'), 'utf8')).toBe('xx')
  })
})
