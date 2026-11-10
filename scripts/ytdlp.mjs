#!/usr/bin/env node
// Installs and updates the yt-dlp the app manages in tools/ (ADR-0003). setup.bat installs it,
// start.mjs checks for an update once a day before the server starts, so no file is replaced while
// the server may be running it.
//
//   node scripts/ytdlp.mjs install   (setup.bat)
//   node scripts/ytdlp.mjs ensure    (start.mjs: install when missing, upgrade once a day)
import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { isMain, projectRoot } from './lib/common.mjs'

/** `default` brings yt-dlp-ejs (YouTube's JS challenges), `deno` a sandboxed JS runtime. */
export const YTDLP_REQUIREMENT = 'yt-dlp[default,deno]'
/** Re-asserts the requirement and recreates a missing tools/bin/yt-dlp(.exe). */
export const INSTALL_ARGS = ['tool', 'install', '--upgrade', YTDLP_REQUIREMENT]
/** Keeps the settings of the install (a manual nightly install stays on nightly). */
export const UPGRADE_ARGS = ['tool', 'upgrade', 'yt-dlp']
/**
 * Rebuilds the tool environment (from uv's cache when it can). Repairs a yt-dlp whose environment
 * broke: its launcher keeps the absolute path of the environment's Python, so a moved project folder
 * or a removed Python breaks it, while `uv tool upgrade` answers "Nothing to upgrade" and
 * `install --upgrade` leaves it broken.
 */
export const REINSTALL_ARGS = ['tool', 'install', '--reinstall', YTDLP_REQUIREMENT]
/** `yt-dlp --version` after an install or a check the server asked for (the first run may compile .pyc files). */
export const VERSION_TIMEOUT_MS = 30_000
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** A `uv tool upgrade` was once seen hanging for minutes; a retry finished in seconds. */
export const UV_TIMEOUT_MS = 180_000

const UV_MISSING = '找不到 uv，請重新執行 setup.bat'

/**
 * Where the managed yt-dlp lives. Same layout as server/lib/config.ts (toolsDir, ytdlpCommand,
 * ytdlpStampPath): the server deletes the stamp to force a check on the next start.
 */
export function ytdlpPaths(root = projectRoot, platform = process.platform) {
  const toolsDir = path.join(root, 'tools')
  const binDir = path.join(toolsDir, 'bin')
  return {
    toolsDir,
    uvToolDir: path.join(toolsDir, 'uv'),
    binDir,
    exe: path.join(binDir, platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
    stamp: path.join(toolsDir, '.yt-dlp-checked'),
  }
}

/** True when GG_YTDLP_CMD is set (not blank): the app then uses it and never installs or updates. */
export function hasCustomCommand(env = process.env) {
  return (env.GG_YTDLP_CMD ?? '').trim() !== ''
}

/** Environment for uv: tool and bin dirs inside tools/, everything else as it is. */
export function uvEnv(root = projectRoot, env = process.env, platform = process.platform) {
  const paths = ytdlpPaths(root, platform)
  return { ...env, UV_TOOL_DIR: paths.uvToolDir, UV_TOOL_BIN_DIR: paths.binDir }
}

/** Ends a process and its children (uv → python, deno): taskkill /T /F on Windows. */
function killTree(child, platform, spawn) {
  if (child.pid === undefined || child.exitCode !== null) return
  if (platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => child.kill())
      killer.on('exit', (code) => {
        if (code !== 0 && child.exitCode === null) child.kill()
      })
    }
    catch {
      child.kill()
    }
  }
  else {
    child.kill('SIGKILL')
  }
}

/**
 * Runs a command (argument array, no shell) and collects its output. Never rejects. On timeout the
 * process tree is killed and the promise resolves at once with timedOut: true.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, platform?: NodeJS.Platform, spawn?: typeof nodeSpawn }} [opts]
 * @returns {Promise<{ ok: boolean, code: number | null, stdout: string, stderr: string, notFound: boolean, timedOut: boolean, error: string | null }>}
 */
export function runProcess(command, args, opts = {}) {
  const { cwd, env = process.env, timeoutMs, platform = process.platform, spawn = nodeSpawn } = opts
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr, ...value })
    }
    let child
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    }
    catch (err) {
      finish({ ok: false, code: null, notFound: err?.code === 'ENOENT', timedOut: false, error: err?.message ?? String(err) })
      return
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    if (timeoutMs) {
      timer = setTimeout(() => {
        killTree(child, platform, spawn)
        finish({ ok: false, code: null, notFound: false, timedOut: true, error: 'timeout' })
      }, timeoutMs)
    }
    child.on('error', (err) => {
      finish({ ok: false, code: null, notFound: err?.code === 'ENOENT', timedOut: false, error: err?.message ?? String(err) })
    })
    child.on('close', (code) => {
      finish({ ok: code === 0, code, notFound: false, timedOut: false, error: null })
    })
  })
}

/**
 * The line of uv's output that names the error: the last "Caused by:", else the "error:" line,
 * else the last line that is not a warning.
 */
export function uvErrorLine(text, max = 200) {
  const lines = String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const caused = lines.filter(l => /^caused by:/i.test(l)).at(-1)
  const line = caused?.replace(/^caused by:\s*/i, '')
    ?? lines.find(l => /^error:/i.test(l))?.replace(/^error:\s*/i, '')
    ?? lines.filter(l => !/^warning:/i.test(l)).at(-1)
    ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** Version from `+ yt-dlp==2026.10.26` in uv's install output. */
export function installedVersion(output) {
  return /^\s*\+\s*yt-dlp==(\S+)/m.exec(String(output ?? ''))?.[1] ?? null
}

/** [from, to] from `Updated yt-dlp v2026.10.21 -> v2026.10.26`, or null (e.g. "Nothing to upgrade"). */
export function upgradedVersions(output) {
  const m = /Updated yt-dlp v(\S+) -> v(\S+)/.exec(String(output ?? ''))
  return m ? [m[1], m[2]] : null
}

/** Why a uv run failed, in Chinese. */
export function failureReason(r, timeoutMs = UV_TIMEOUT_MS) {
  if (r.notFound) return UV_MISSING
  if (r.timedOut) return `uv 超過 ${Math.round(timeoutMs / 1000)} 秒沒有完成（網路太慢或連不到 PyPI），下次啟動會再試`
  const line = uvErrorLine(`${r.stderr}\n${r.stdout}`) || r.error || `結束代碼 ${r.code}`
  return `uv 執行失敗：${line}`
}

/** Time the stamp records (ms), or null when it is missing or unreadable. */
export async function readStamp(stampPath) {
  let text
  try {
    text = await fsp.readFile(stampPath, 'utf8')
  }
  catch {
    return null
  }
  const time = Date.parse(text.trim())
  return Number.isFinite(time) ? time : null
}

export async function writeStamp(stampPath, nowMs) {
  try {
    await fsp.mkdir(path.dirname(stampPath), { recursive: true })
    await fsp.writeFile(stampPath, `${new Date(nowMs).toISOString()}\n`)
  }
  catch {
    // Not fatal: the next start just checks again.
  }
}

/**
 * What `ensure` has to do: 'skip' (GG_YTDLP_CMD), 'install' (no executable), 'upgrade' (not checked
 * in the last 24 h, no stamp, or a stamp from the future) or 'none'.
 * @returns {Promise<'skip'|'install'|'upgrade'|'none'>}
 */
export async function ensurePlan({ root = projectRoot, env = process.env, platform = process.platform, now = Date.now } = {}) {
  if (hasCustomCommand(env)) return 'skip'
  const paths = ytdlpPaths(root, platform)
  if (!fs.existsSync(paths.exe)) return 'install'
  const checked = await readStamp(paths.stamp)
  if (checked === null) return 'upgrade'
  const age = now() - checked
  return age >= 0 && age < CHECK_INTERVAL_MS ? 'none' : 'upgrade'
}

/**
 * @typedef {{ ok: boolean, action: 'skipped'|'installed'|'upgraded'|'up-to-date'|'failed', message: string }} YtdlpResult
 * @typedef {{
 *   root?: string,
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   now?: () => number,
 *   run?: typeof runProcess,
 *   log?: (msg: string) => void,
 *   timeoutMs?: number,
 * }} YtdlpOptions
 */

function resolveOptions(opts) {
  return {
    root: opts.root ?? projectRoot,
    env: opts.env ?? process.env,
    platform: opts.platform ?? process.platform,
    now: opts.now ?? Date.now,
    run: opts.run ?? runProcess,
    log: opts.log ?? (msg => console.log(msg)),
    timeoutMs: opts.timeoutMs ?? UV_TIMEOUT_MS,
  }
}

function runUv(o, args) {
  return o.run('uv', args, { cwd: o.root, env: uvEnv(o.root, o.env, o.platform), timeoutMs: o.timeoutMs, platform: o.platform })
}

function skipped() {
  return { ok: true, action: 'skipped', message: '已設定 GG_YTDLP_CMD，不自動安裝或更新 yt-dlp' }
}

function failed(o, verb, reason) {
  const message = `無法${verb} yt-dlp（只影響 YouTube）：${reason}`
  o.log(`⚠️ ${message}`)
  return { ok: false, action: 'failed', message }
}

/** Why `yt-dlp --version` failed, in Chinese. */
export function versionFailure(r, timeoutMs = VERSION_TIMEOUT_MS) {
  if (r.timedOut) return `${Math.round(timeoutMs / 1000)} 秒內沒有回應`
  if (r.notFound) return '找不到執行檔'
  return uvErrorLine(`${r.stderr}\n${r.stdout}`) || r.error || `結束代碼 ${r.code}`
}

function runVersion(o) {
  const paths = ytdlpPaths(o.root, o.platform)
  return o.run(paths.exe, ['--version'], { cwd: o.root, env: o.env, timeoutMs: VERSION_TIMEOUT_MS, platform: o.platform })
}

/**
 * After an install, or an upgrade the server asked for (it deletes the stamp after an unknown yt-dlp
 * failure, which is what a broken environment gives): `yt-dlp --version` must work, else one
 * `uv tool install --reinstall` and a second check. Resolves with { ok: true, repaired } or the
 * failure result (no stamp is written then, so the next start checks again).
 */
async function verify(o, verb) {
  const first = await runVersion(o)
  if (first.ok) return { ok: true, repaired: false }
  o.log(`▶ yt-dlp 無法執行（${versionFailure(first)}），重新安裝…`)
  const r = await runUv(o, REINSTALL_ARGS)
  const fix = '請刪掉專案裡的 tools 資料夾，再雙擊 start.bat 重新安裝（需要網路）'
  if (!r.ok) return failed(o, verb, `yt-dlp 無法執行，重新安裝也失敗（${failureReason(r, o.timeoutMs)}）；${fix}`)
  const second = await runVersion(o)
  if (second.ok) return { ok: true, repaired: true }
  return failed(o, verb, `重新安裝後 yt-dlp 還是無法執行（${versionFailure(second)}）；${fix}`)
}

const REPAIRED_MESSAGE = '已重新安裝 yt-dlp（原本的無法執行，例如專案資料夾搬過位置）'

async function doInstall(o) {
  const paths = ytdlpPaths(o.root, o.platform)
  o.log('▶ 安裝 yt-dlp（YouTube 下載工具，只有第一次需要，大約 1 分鐘）…')
  const r = await runUv(o, INSTALL_ARGS)
  if (!r.ok) return failed(o, '安裝', failureReason(r, o.timeoutMs))
  if (!fs.existsSync(paths.exe)) return failed(o, '安裝', `uv 執行完了，但找不到 ${paths.exe}`)
  const check = await verify(o, '安裝')
  if (!check.ok) return check
  await writeStamp(paths.stamp, o.now())
  const version = installedVersion(`${r.stderr}\n${r.stdout}`)
  const message = check.repaired ? REPAIRED_MESSAGE : version ? `已安裝 yt-dlp ${version}` : '已安裝 yt-dlp'
  o.log(`✅ ${message}`)
  return { ok: true, action: 'installed', message }
}

/** `forceCheck`: the server deleted the stamp, so also make sure yt-dlp still runs (verify). */
async function doUpgrade(o, forceCheck) {
  const paths = ytdlpPaths(o.root, o.platform)
  o.log('▶ 檢查 yt-dlp 更新…')
  const r = await runUv(o, UPGRADE_ARGS)
  if (!r.ok) {
    // An executable without uv's record of it (e.g. copied by hand): install over it.
    if (/is not installed/i.test(`${r.stderr}\n${r.stdout}`)) return doInstall(o)
    return failed(o, '更新', failureReason(r, o.timeoutMs))
  }
  const check = forceCheck ? await verify(o, '更新') : { ok: true, repaired: false }
  if (!check.ok) return check
  await writeStamp(paths.stamp, o.now())
  const versions = upgradedVersions(`${r.stderr}\n${r.stdout}`)
  const message = check.repaired
    ? REPAIRED_MESSAGE
    : versions ? `已更新 yt-dlp（${versions[0]} → ${versions[1]}）` : 'yt-dlp 已是最新版'
  o.log(`✅ ${message}`)
  return { ok: true, action: 'upgraded', message }
}

/**
 * setup.bat: install (or upgrade) the managed yt-dlp. Never throws.
 * @param {YtdlpOptions} [opts]
 * @returns {Promise<YtdlpResult>}
 */
export async function install(opts = {}) {
  const o = resolveOptions(opts)
  try {
    if (hasCustomCommand(o.env)) {
      const result = skipped()
      o.log(`▶ ${result.message}`)
      return result
    }
    return await doInstall(o)
  }
  catch (err) {
    return failed(o, '安裝', err?.message ?? String(err))
  }
}

/**
 * start.mjs: install when tools/bin has no yt-dlp, upgrade when the last check is older than 24 h
 * (or the server deleted the stamp: then also check that yt-dlp runs, reinstalling it when not), else
 * nothing. Installs are always checked. Prints only when it runs uv. Never throws.
 * @param {YtdlpOptions} [opts]
 * @returns {Promise<YtdlpResult>}
 */
export async function ensure(opts = {}) {
  const o = resolveOptions(opts)
  try {
    const plan = await ensurePlan(o)
    if (plan === 'skip') return skipped()
    if (plan === 'install') return await doInstall(o)
    if (plan === 'upgrade') return await doUpgrade(o, (await readStamp(ytdlpPaths(o.root, o.platform).stamp)) === null)
    return { ok: true, action: 'up-to-date', message: '24 小時內已經檢查過 yt-dlp 更新' }
  }
  catch (err) {
    return failed(o, '更新', err?.message ?? String(err))
  }
}

const HELP = [
  '用法：node scripts/ytdlp.mjs <install|ensure>',
  '  install  安裝或更新程式自己管理的 yt-dlp（裝在 tools/，setup.bat 會執行）',
  '  ensure   沒有就安裝，超過 24 小時沒檢查就更新（start.bat 會執行）',
  '  設定了環境變數 GG_YTDLP_CMD 時兩者都不做事',
].join('\n')

/** CLI entry; resolves with the exit code (1 when the install or update failed). */
export async function main(argv = process.argv.slice(2), opts = {}) {
  const log = opts.log ?? (msg => console.log(msg))
  const command = argv[0]
  if (command === 'install') return (await install({ ...opts, log })).ok ? 0 : 1
  if (command === 'ensure') {
    const result = await ensure({ ...opts, log })
    if (result.action === 'skipped' || result.action === 'up-to-date') log(`✅ ${result.message}`)
    return result.ok ? 0 : 1
  }
  log(HELP)
  return command === '--help' || command === '-h' ? 0 : 2
}

if (isMain(import.meta.url)) {
  main().then((code) => { process.exitCode = code }, (err) => {
    console.error(`❌ yt-dlp 安裝程式本身出錯：${err?.stack ?? err}`)
    process.exit(1)
  })
}
