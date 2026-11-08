#!/usr/bin/env node
// Launcher used by start.bat: install → build when the source changed → run the server → open the browser.
//
//   node scripts/start.mjs [--no-open]
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { isMain, nodeProblem, projectRoot, runInherited } from './lib/common.mjs'

/** Folders and files whose changes require a new `pnpm build`. */
export const STAMP_DIRS = ['app', 'server', 'shared']
export const STAMP_FILES = ['nuxt.config.ts', 'package.json', 'pnpm-lock.yaml']
export const STAMP_FILE = path.join('.output', '.gg-build-stamp')
export const SERVER_ENTRY = path.join('.output', 'server', 'index.mjs')
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 3939
const READY_TIMEOUT_MS = 60_000
const FORCE_KILL_MS = 15_000

const HELP = [
  '用法：node scripts/start.mjs [--no-open]',
  '  --no-open  啟動後不要自動打開瀏覽器',
  `  環境變數 HOST / PORT 可以改監聽位址（預設 ${DEFAULT_HOST}:${DEFAULT_PORT}）`,
].join('\n')

export function parseArgs(argv) {
  return {
    open: !argv.includes('--no-open'),
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

async function collectFiles(root, rel, out) {
  let entries
  try {
    entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true })
  }
  catch {
    return
  }
  for (const entry of entries) {
    const child = path.join(rel, entry.name)
    if (entry.isDirectory()) await collectFiles(root, child, out)
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(child)
  }
}

/** Files that make up the build stamp, as forward-slash paths relative to root, sorted. */
export async function listStampFiles(root) {
  const files = []
  for (const dir of STAMP_DIRS) await collectFiles(root, dir, files)
  return files.map(f => f.split(path.sep).join('/')).sort()
}

/** Hash of path + size + mtime of every source file that goes into `pnpm build`. */
export async function computeBuildStamp(root) {
  const hash = createHash('sha256')
  const files = [...await listStampFiles(root), ...STAMP_FILES]
  for (const rel of files) {
    try {
      const stat = await fsp.stat(path.join(root, ...rel.split('/')))
      hash.update(`${rel}\t${stat.size}\t${Math.floor(stat.mtimeMs)}\n`)
    }
    catch {
      hash.update(`${rel}\tmissing\n`)
    }
  }
  return hash.digest('hex')
}

export async function readBuildStamp(root) {
  try {
    return (await fsp.readFile(path.join(root, STAMP_FILE), 'utf8')).trim()
  }
  catch {
    return null
  }
}

export async function writeBuildStamp(root, stamp) {
  await fsp.writeFile(path.join(root, STAMP_FILE), `${stamp}\n`)
}

/** Whether `pnpm build` must run: no server bundle yet, or the sources changed since the last build. */
export async function buildStatus(root, stamp) {
  if (!fs.existsSync(path.join(root, SERVER_ENTRY))) return { needed: true, reason: 'missing' }
  if ((await readBuildStamp(root)) !== stamp) return { needed: true, reason: 'changed' }
  return { needed: false, reason: null }
}

/** HOST / PORT from the environment, validated so they are safe to put in a URL and a shell command. */
export function listenAddress(env = process.env) {
  const host = (env.HOST || DEFAULT_HOST).trim()
  const portText = String(env.PORT || DEFAULT_PORT).trim()
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new Error(`PORT 設定不正確：${portText}（要是 1–65535 的數字）`)
  }
  if (!/^[A-Za-z0-9.:-]+$/.test(host)) throw new Error(`HOST 設定不正確：${host}`)
  return { host, port }
}

/** Host to connect to / show in the browser: wildcard addresses become loopback, IPv6 gets brackets. */
export function urlHost(host) {
  if (host === '0.0.0.0' || host === '::' || host === '') return DEFAULT_HOST
  return host.includes(':') ? `[${host}]` : host
}

/** Environment for the Nitro server: HOST/PORT defaults and a quiet node:sqlite. */
export function serverEnv(env = process.env) {
  const { host, port } = listenAddress(env)
  const flag = '--disable-warning=ExperimentalWarning'
  const current = (env.NODE_OPTIONS ?? '').trim()
  const nodeOptions = current.split(/\s+/).includes(flag) ? current : [current, flag].filter(Boolean).join(' ')
  return { ...env, HOST: host, PORT: String(port), NODE_OPTIONS: nodeOptions }
}

/** True when something accepts TCP connections on host:port. */
export function isPortOpen(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: host.replace(/^\[|\]$/g, ''), port })
    const done = (open) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** True when `url` answers with any HTTP response within timeoutMs (no proxy, unlike fetch). */
export function probeServer(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs, agent: false }, (res) => {
      res.resume()
      resolve(true)
    })
    req.once('timeout', () => req.destroy(new Error('timeout')))
    req.once('error', () => resolve(false))
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Polls `url` until it answers. Resolves 'ready', 'timeout', or 'exited' when isAlive() turns false.
 * onTick(seconds) is called about every tickMs while waiting.
 */
export async function waitForServer(url, { timeoutMs = READY_TIMEOUT_MS, intervalMs = 500, tickMs = 5000, onTick, isAlive = () => true } = {}) {
  const started = Date.now()
  let nextTick = started + tickMs
  for (;;) {
    if (!isAlive()) return 'exited'
    const remaining = timeoutMs - (Date.now() - started)
    if (remaining <= 0) return 'timeout'
    if (await probeServer(url, Math.max(1, Math.min(remaining, 30_000)))) return 'ready'
    if (!isAlive()) return 'exited'
    const now = Date.now()
    if (onTick && now >= nextTick) {
      onTick(Math.round((now - started) / 1000))
      nextTick = now + tickMs
    }
    await sleep(intervalMs)
  }
}

/** Command that opens `url` in the default browser. */
export function browserCommand(url, platform = process.platform, env = process.env) {
  if (!/^https?:\/\/[A-Za-z0-9.:[\]/-]+$/.test(url)) throw new Error(`Refusing to open unexpected URL: ${url}`)
  if (platform === 'win32') {
    // Same quoting Node uses for shell: true: cmd /d /s /c "start "" "url"".
    return { command: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"start "" "${url}""`], options: { windowsVerbatimArguments: true } }
  }
  if (platform === 'darwin') return { command: 'open', args: [url], options: { detached: true } }
  return { command: 'xdg-open', args: [url], options: { detached: true } }
}

export function openBrowser(url, { platform = process.platform, log = console.log } = {}) {
  const fallback = () => log(`   請自己打開瀏覽器，輸入網址：${url}`)
  let spec
  try {
    spec = browserCommand(url, platform)
  }
  catch {
    fallback()
    return
  }
  try {
    const child = spawn(spec.command, spec.args, { ...spec.options, stdio: 'ignore', windowsHide: true })
    child.once('error', fallback)
    child.unref()
  }
  catch {
    fallback()
  }
}

/**
 * Runs the whole launch sequence and resolves with the process exit code.
 * @param {{ root?: string, argv?: string[], env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, log?: (msg: string) => void, readyTimeoutMs?: number }} [opts]
 */
export async function main({
  root = projectRoot,
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  log = msg => console.log(msg),
  readyTimeoutMs = READY_TIMEOUT_MS,
} = {}) {
  const args = parseArgs(argv)
  if (args.help) {
    log(HELP)
    return 0
  }
  process.chdir(root)
  log('▶ gg-highlight 啟動中…')

  const problem = await nodeProblem()
  if (problem) {
    log(`❌ ${problem}`)
    return 1
  }

  let address
  try {
    address = listenAddress(env)
  }
  catch (err) {
    log(`❌ ${err.message}`)
    return 1
  }
  const baseUrl = `http://${urlHost(address.host)}:${address.port}`

  if (await isPortOpen(urlHost(address.host), address.port)) {
    if (await probeServer(`${baseUrl}/api/system`, 3000)) {
      log(`✅ gg-highlight 已經在執行中：${baseUrl}`)
    }
    else {
      log(`⚠️ 連接埠 ${address.port} 已經被其他程式使用。如果打開的不是 gg-highlight，請關閉那個程式，或用環境變數 PORT 換一個連接埠。`)
    }
    if (args.open) openBrowser(baseUrl, { platform, log })
    return 0
  }

  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    log('▶ 第一次啟動：安裝套件（pnpm install），需要幾分鐘…')
    const code = await runInherited('pnpm', ['install'], { cwd: root, env, platform })
    if (code !== 0) {
      log('❌ 套件安裝失敗。請確認網路連線，或重新執行 setup.bat 後再試一次。')
      return code || 1
    }
  }

  const stamp = await computeBuildStamp(root)
  const build = await buildStatus(root, stamp)
  if (build.needed) {
    log(build.reason === 'missing'
      ? '▶ 第一次啟動：建置程式（pnpm build），大約 1–2 分鐘…'
      : '▶ 程式有更新，重新建置（pnpm build），大約 1–2 分鐘…')
    const code = await runInherited('pnpm', ['build'], { cwd: root, env, platform })
    if (code !== 0 || !fs.existsSync(path.join(root, SERVER_ENTRY))) {
      log('❌ 建置失敗，請看上面的錯誤訊息。可以執行 node scripts/doctor.mjs 檢查環境。')
      return code || 1
    }
    await writeBuildStamp(root, stamp)
  }

  log(`▶ 啟動伺服器（${baseUrl}）…`)
  const child = spawn(process.execPath, [path.join(root, SERVER_ENTRY)], {
    cwd: root,
    env: serverEnv(env),
    stdio: 'inherit',
    windowsHide: true,
  })

  let exited = null
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = { code, signal }
      resolve(exited)
    })
    child.once('error', (err) => {
      exited = { code: 1, signal: null, error: err }
      resolve(exited)
    })
  })

  let stopping = false
  let forceTimer = null
  const onSignal = (signal) => {
    if (exited) return
    if (stopping) {
      child.kill('SIGKILL')
      return
    }
    stopping = true
    log('\n▶ 正在關閉 gg-highlight…')
    // On Windows the server shares this console and already got the Ctrl+C itself;
    // kill() there would terminate it without a graceful shutdown.
    if (platform !== 'win32') child.kill(signal)
    forceTimer = setTimeout(() => {
      if (!exited) child.kill('SIGKILL')
    }, FORCE_KILL_MS)
    forceTimer.unref()
  }
  const signals = platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const s of signals) process.on(s, onSignal)

  try {
    const state = await waitForServer(`${baseUrl}/api/system`, {
      timeoutMs: readyTimeoutMs,
      isAlive: () => !exited,
      onTick: s => log(`   等待伺服器啟動…（${s} 秒）`),
    })
    if (state === 'ready') {
      log(`✅ gg-highlight 已啟動：${baseUrl}`)
      log('   只有這台電腦能連線。要停止的話，關閉這個視窗或按 Ctrl+C。')
      if (args.open) openBrowser(baseUrl, { platform, log })
    }
    else if (state === 'timeout') {
      log(`⚠️ 伺服器 ${Math.round(readyTimeoutMs / 1000)} 秒內沒有回應。請看上面的訊息，或另外執行 node scripts/doctor.mjs 檢查環境；之後可以自己打開 ${baseUrl}`)
    }

    const { code, signal, error } = await exitPromise
    if (error) {
      log(`❌ 無法啟動伺服器：${error.message}`)
      return 1
    }
    if (stopping) {
      log('▶ gg-highlight 已關閉。')
      return code ?? 0
    }
    log(`❌ 伺服器意外結束（${code !== null ? `代碼 ${code}` : `訊號 ${signal}`}）。請看上面的錯誤訊息，或執行 node scripts/doctor.mjs 檢查環境。`)
    return code || 1
  }
  finally {
    clearTimeout(forceTimer)
    for (const s of signals) process.off(s, onSignal)
  }
}

if (isMain(import.meta.url)) {
  main().then(code => process.exit(code), (err) => {
    console.error(`❌ 啟動失敗：${err?.stack ?? err}`)
    process.exit(1)
  })
}
