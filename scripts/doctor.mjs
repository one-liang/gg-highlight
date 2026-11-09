#!/usr/bin/env node
// Environment check: prints a Chinese checklist and exits 1 when a required item fails.
//
//   node scripts/doctor.mjs [--json]
import fsp from 'node:fs/promises'
import path from 'node:path'
import { findInstalledFont, resolveFontsDir } from './fetch-fonts.mjs'
import {
  compareVersions,
  errorLine,
  hasNodeSqlite,
  isMain,
  lastLine,
  MIN_NODE_VERSION,
  MIN_PNPM_VERSION,
  pnpmVersionOk,
  projectRoot,
  runCommand,
} from './lib/common.mjs'

export { compareVersions, parseVersion } from './lib/common.mjs'

/** @typedef {'ok'|'warn'|'fail'|'later'} CheckStatus */
/**
 * @typedef {object} CheckResult
 * @property {string} id
 * @property {string} label
 * @property {CheckStatus} status
 * @property {boolean} required  A failing required item makes the doctor exit 1.
 * @property {string} detail
 * @property {string | null} fix  How to fix it, when status is not ok.
 */

export const ICONS = { ok: '✅', warn: '⚠️', fail: '❌', later: '➖' }

const TRANSCRIBER_TIMEOUT_MS = 10 * 60_000
const NVENC_TIMEOUT_MS = 30_000
const VERSION_TIMEOUT_MS = 30_000

/** @returns {CheckResult} */
function result(id, label, status, detail, fix = null, required = true) {
  return { id, label, status, required, detail, fix: status === 'ok' ? null : fix }
}

/**
 * Everything the checks read from the outside world, so tests can replace it.
 * @param {Partial<ReturnType<typeof createContext>>} [overrides]
 */
export function createContext(overrides = {}) {
  const env = overrides.env ?? process.env
  const root = overrides.root ?? projectRoot
  return {
    env,
    root,
    platform: process.platform,
    nodeVersion: process.versions.node,
    hasSqlite: hasNodeSqlite,
    run: runCommand,
    ffmpegPath: env.GG_FFMPEG || 'ffmpeg',
    ffprobePath: env.GG_FFPROBE || 'ffprobe',
    fontsDir: resolveFontsDir(env, root),
    dataDir: path.resolve(root, env.GG_DATA_DIR || 'data'),
    onProgress: () => {},
    ...overrides,
  }
}

// ---- parsing helpers ----

/** Version string from the first line of `ffmpeg -version` / `ffprobe -version`. */
export function parseFfmpegVersion(text) {
  const m = /^\s*ff(?:mpeg|probe) version (\S+)/m.exec(String(text ?? ''))
  return m ? m[1] : null
}

/** True when `ffmpeg -buildconf` output shows libass (needed for the subtitles filter). */
export function hasLibass(buildconf) {
  return /--enable-libass(?![\w-])/.test(String(buildconf ?? ''))
}

/**
 * Reads the JSON lines printed by `gg-transcribe check`.
 * @returns {{ check: { python?: string, fasterWhisper?: string, ctranslate2?: string, cudaDevices: number } | null, error: string | null }}
 */
export function parseTranscriberCheck(stdout) {
  let check = null
  let error = null
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    let event
    try {
      event = JSON.parse(text)
    }
    catch {
      continue
    }
    if (event?.type === 'check') {
      const devices = Number(event.cudaDevices)
      check = { ...event, cudaDevices: Number.isFinite(devices) ? devices : 0 }
    }
    else if (event?.type === 'error' && typeof event.message === 'string') {
      error = event.message
    }
  }
  return { check, error }
}

/** Most telling line of a failed ffmpeg run: an encoder/driver message if any, without the `[h264_nvenc @ 0x…]` prefix. */
export function summarizeFfmpegError(stderr) {
  const lines = String(stderr ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const line = lines.find(l => /nvenc|cuda|nvidia|driver|unknown encoder/i.test(l)) ?? lines[0] ?? ''
  return line.replace(/^\[[^\]]*\]\s*/, '')
}

/** GPUs from `nvidia-smi --query-gpu=name,driver_version --format=csv,noheader`. */
export function parseNvidiaSmi(stdout) {
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, driver] = line.split(',').map(s => s.trim())
      return { name, driver: driver || null }
    })
    .filter(gpu => gpu.name)
}

/** argv prefix of the transcriber CLI, same rules as server/lib/config.ts. */
export function transcriberCommand(env = process.env, root = projectRoot) {
  const value = env.GG_TRANSCRIBER_CMD?.trim()
  if (value) {
    if (value.startsWith('[')) return JSON.parse(value)
    return value.split(/\s+/)
  }
  return ['uv', 'run', '--project', path.join(root, 'transcriber'), 'gg-transcribe']
}

// ---- checks ----

export async function checkNode(ctx) {
  const version = ctx.nodeVersion
  const fix = '執行 setup.bat，或到 https://nodejs.org 安裝 LTS 版（22.13 以上）'
  if (compareVersions(version, MIN_NODE_VERSION) < 0) {
    return result('node', 'Node.js', 'fail', `v${version}，需要 ${MIN_NODE_VERSION} 以上`, fix)
  }
  if (!(await ctx.hasSqlite())) {
    return result('node', 'Node.js', 'fail', `v${version}，無法載入 node:sqlite`, fix)
  }
  return result('node', 'Node.js', 'ok', `v${version}`)
}

export async function checkPnpm(ctx) {
  const fix = '重新執行 setup.bat（會安裝或更新 pnpm），或執行 npm install -g pnpm@10'
  const r = await ctx.run('pnpm', ['--version'], { cwd: ctx.root, timeoutMs: VERSION_TIMEOUT_MS })
  if (!r.ok) {
    return result('pnpm', 'pnpm', 'fail', r.notFound ? '找不到 pnpm' : `無法執行：${errorLine(r.stderr) || r.error}`, fix)
  }
  const version = lastLine(r.stdout)
  if (!pnpmVersionOk(version)) {
    return result('pnpm', 'pnpm', 'fail', `${version}，需要 ${MIN_PNPM_VERSION} 以上（10、11、12 都可以）`, fix)
  }
  return result('pnpm', 'pnpm', 'ok', version)
}

/** ffmpeg, ffprobe and libass, in that order. */
export async function checkFfmpeg(ctx) {
  const ffmpegFix = '執行 setup.bat（會用 winget 安裝 Gyan.FFmpeg），或設定環境變數 GG_FFMPEG / GG_FFPROBE 指向執行檔'
  const [ffmpeg, ffprobe] = await Promise.all([
    ctx.run(ctx.ffmpegPath, ['-version'], { timeoutMs: VERSION_TIMEOUT_MS }),
    ctx.run(ctx.ffprobePath, ['-version'], { timeoutMs: VERSION_TIMEOUT_MS }),
  ])
  const describe = (r, exe) => r.notFound ? `找不到 ${exe}` : `無法執行 ${exe}：${lastLine(r.stderr) || r.error}`
  const results = [
    ffmpeg.ok
      ? result('ffmpeg', 'ffmpeg', 'ok', `${parseFfmpegVersion(ffmpeg.stdout) ?? '已安裝'}${ctx.env.GG_FFMPEG ? `（${ctx.ffmpegPath}）` : ''}`)
      : result('ffmpeg', 'ffmpeg', 'fail', describe(ffmpeg, ctx.ffmpegPath), ffmpegFix),
    ffprobe.ok
      ? result('ffprobe', 'ffprobe', 'ok', `${parseFfmpegVersion(ffprobe.stdout) ?? '已安裝'}${ctx.env.GG_FFPROBE ? `（${ctx.ffprobePath}）` : ''}`)
      : result('ffprobe', 'ffprobe', 'fail', describe(ffprobe, ctx.ffprobePath), ffmpegFix),
  ]
  const libassFix = '換成有 libass 的 ffmpeg（例如 winget install Gyan.FFmpeg），否則無法燒錄字幕'
  if (!ffmpeg.ok) {
    results.push(result('libass', '字幕燒錄（libass）', 'fail', '無法檢查（ffmpeg 不能用）', libassFix))
  }
  else {
    const conf = await ctx.run(ctx.ffmpegPath, ['-hide_banner', '-buildconf'], { timeoutMs: VERSION_TIMEOUT_MS })
    results.push(hasLibass(conf.stdout + conf.stderr)
      ? result('libass', '字幕燒錄（libass）', 'ok', '已啟用')
      : result('libass', '字幕燒錄（libass）', 'fail', '這個 ffmpeg 沒有 --enable-libass', libassFix))
  }
  return results
}

export async function checkNvenc(ctx, ffmpegOk = true) {
  const label = 'NVENC 硬體編碼'
  const fallback = '輸出剪輯會改用 CPU（libx264）編碼，比較慢但畫質一樣。有 NVIDIA 顯示卡的話，請更新驅動程式並使用 Gyan.FFmpeg。'
  const override = ctx.env.GG_VIDEO_ENCODER
  if (override === 'libx264') {
    return result('nvenc', label, 'ok', '已用 GG_VIDEO_ENCODER 指定 libx264（CPU 編碼）', null, false)
  }
  if (!ffmpegOk) return result('nvenc', label, 'warn', '無法檢查（ffmpeg 不能用）', fallback, false)
  const r = await ctx.run(ctx.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2',
    '-c:v', 'h264_nvenc',
    '-f', 'null', '-',
  ], { timeoutMs: NVENC_TIMEOUT_MS })
  if (r.ok) return result('nvenc', label, 'ok', '可以使用（h264_nvenc）', null, false)
  const why = r.timedOut ? '測試編碼逾時' : summarizeFfmpegError(r.stderr) || r.error || '測試編碼失敗'
  return result('nvenc', label, 'warn', `無法使用：${why}`, fallback, false)
}

export async function checkUv(ctx) {
  const r = await ctx.run('uv', ['--version'], { timeoutMs: VERSION_TIMEOUT_MS })
  if (r.ok) return result('uv', 'uv（Python 環境管理）', 'ok', r.stdout.trim())
  return result('uv', 'uv（Python 環境管理）', 'fail', r.notFound ? '找不到 uv' : `無法執行：${lastLine(r.stderr) || r.error}`,
    '執行 setup.bat（會用 winget 安裝 astral-sh.uv）')
}

export async function checkTranscriber(ctx, uvOk = true) {
  const label = '語音辨識環境'
  const fix = '在專案資料夾執行 uv sync --project transcriber（或重新執行 setup.bat）'
  let command
  try {
    command = transcriberCommand(ctx.env, ctx.root)
  }
  catch {
    return result('transcriber', label, 'fail', 'GG_TRANSCRIBER_CMD 格式不正確', '改成空白分隔的指令，或 JSON 字串陣列')
  }
  if (command[0] === 'uv' && !uvOk) {
    return result('transcriber', label, 'fail', '需要先安裝 uv', '執行 setup.bat（會用 winget 安裝 astral-sh.uv）')
  }
  ctx.onProgress('檢查語音辨識環境（第一次可能要幾分鐘）…')
  const r = await ctx.run(command[0], [...command.slice(1), 'check'], { cwd: ctx.root, timeoutMs: TRANSCRIBER_TIMEOUT_MS })
  const { check, error } = parseTranscriberCheck(r.stdout)
  if (!r.ok || !check) {
    const why = r.timedOut ? '檢查逾時' : error || lastLine(r.stderr) || r.error || `結束代碼 ${r.code}`
    return result('transcriber', label, 'fail', `無法執行 ${command.join(' ')} check：${why}`, fix)
  }
  const versions = [
    check.python && `Python ${check.python}`,
    check.fasterWhisper && `faster-whisper ${check.fasterWhisper}`,
    check.ctranslate2 && `ctranslate2 ${check.ctranslate2}`,
  ].filter(Boolean).join('、')
  const detail = `${versions}${versions ? '、' : ''}CUDA 裝置 ${check.cudaDevices} 個`
  if (check.cudaDevices > 0) return result('transcriber', label, 'ok', detail)
  return result('transcriber', label, 'warn', `${detail}：語音辨識會用 CPU，很慢`,
    '確認電腦有 NVIDIA 顯示卡並安裝最新驅動程式，之後重新執行 node scripts/doctor.mjs')
}

export async function checkFonts(ctx) {
  const label = '字幕字型（Noto Sans CJK TC）'
  const fix = '執行 node scripts/fetch-fonts.mjs（或重新執行 setup.bat）'
  const font = await findInstalledFont(ctx.fontsDir)
  if (font) return result('fonts', label, 'ok', path.basename(font))
  let others = []
  try {
    others = (await fsp.readdir(ctx.fontsDir)).filter(n => /\.(?:otf|ttf|ttc)$/i.test(n))
  }
  catch {
    // folder missing
  }
  if (others.length) {
    return result('fonts', label, 'warn', `${ctx.fontsDir} 裡沒有 Noto Sans CJK，只有 ${others.join('、')}，字幕可能顯示不正確`, fix)
  }
  return result('fonts', label, 'fail', `${ctx.fontsDir} 裡沒有字型檔`, fix)
}

export async function checkDataDir(ctx) {
  const label = '資料夾可寫入'
  const probe = path.join(ctx.dataDir, `.gg-doctor-${process.pid}-${Date.now()}.tmp`)
  try {
    await fsp.mkdir(ctx.dataDir, { recursive: true })
    await fsp.writeFile(probe, 'ok')
    await fsp.rm(probe, { force: true })
    return result('data', label, 'ok', ctx.dataDir)
  }
  catch (err) {
    return result('data', label, 'fail', `${ctx.dataDir} 無法寫入：${err.code ?? err.message}`,
      '確認資料夾權限、磁碟空間，或用環境變數 GG_DATA_DIR 換一個資料夾')
  }
}

export async function checkNvidiaSmi(ctx) {
  const label = 'NVIDIA 驅動程式（nvidia-smi）'
  const r = await ctx.run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], { timeoutMs: VERSION_TIMEOUT_MS })
  const gpus = r.ok ? parseNvidiaSmi(r.stdout) : []
  if (gpus.length) {
    return result('nvidia-smi', label, 'ok', gpus.map(g => g.driver ? `${g.name}（驅動 ${g.driver}）` : g.name).join('、'), null, false)
  }
  return result('nvidia-smi', label, 'warn', r.notFound ? '找不到 nvidia-smi' : `沒有偵測到顯示卡：${lastLine(r.stderr || r.stdout) || r.error}`,
    '有 NVIDIA 顯示卡的話，請到 https://www.nvidia.com/Download/index.aspx 安裝最新驅動程式；沒有的話語音辨識與輸出都會用 CPU，比較慢',
    false)
}

/** Tools for later milestones: listed, never failing. */
export async function checkLaterTools(ctx) {
  const tools = [
    { id: 'ollama', label: 'Ollama', command: 'ollama', why: '里程碑 2「自動找精華」才會用到' },
    { id: 'deno', label: 'Deno', command: 'deno', why: '里程碑 3「YouTube」才會用到' },
  ]
  return Promise.all(tools.map(async (tool) => {
    const r = await ctx.run(tool.command, ['--version'], { timeoutMs: 10_000 })
    const installed = r.ok ? `，已安裝 ${lastLine(r.stdout)}` : r.notFound ? '' : '，已安裝'
    return result(tool.id, tool.label, 'later', `尚未需要（${tool.why}）${installed}`, null, false)
  }))
}

/** Runs every check; results come back in display order. */
export async function runChecks(ctx = createContext()) {
  const [node, pnpm, ffmpegGroup, uv, fonts, data, smi, later] = await Promise.all([
    checkNode(ctx),
    checkPnpm(ctx),
    checkFfmpeg(ctx),
    checkUv(ctx),
    checkFonts(ctx),
    checkDataDir(ctx),
    checkNvidiaSmi(ctx),
    checkLaterTools(ctx),
  ])
  const ffmpegOk = ffmpegGroup[0].status === 'ok'
  const [nvenc, transcriber] = await Promise.all([
    checkNvenc(ctx, ffmpegOk),
    checkTranscriber(ctx, uv.status === 'ok'),
  ])
  return [node, pnpm, ...ffmpegGroup, nvenc, uv, transcriber, fonts, data, smi, ...later]
}

/** Required items that failed. */
export function failures(results) {
  return results.filter(r => r.required && r.status === 'fail')
}

export function exitCodeFor(results) {
  return failures(results).length ? 1 : 0
}

export function formatReport(results) {
  const lines = ['gg-highlight 環境檢查', '']
  for (const r of results) {
    lines.push(`${ICONS[r.status]} ${r.label}：${r.detail}`)
    if (r.fix) lines.push(`   → ${r.fix}`)
  }
  const failed = failures(results).length
  const warned = results.filter(r => r.status === 'warn' || (!r.required && r.status === 'fail')).length
  lines.push('')
  if (failed) {
    lines.push(`❌ 有 ${failed} 個必要項目沒有通過，請照上面「→」的說明處理後再執行一次：node scripts/doctor.mjs`)
  }
  else {
    lines.push(`✅ 必要項目都通過了${warned ? `（另有 ${warned} 個提醒）` : ''}。可以用 start.bat（或 node scripts/start.mjs）啟動。`)
  }
  return lines.join('\n')
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json')
  const ctx = createContext({
    onProgress: json ? () => {} : msg => process.stderr.write(`${msg}\n`),
  })
  const results = await runChecks(ctx)
  const code = exitCodeFor(results)
  if (json) process.stdout.write(`${JSON.stringify({ ok: code === 0, results }, null, 2)}\n`)
  else console.log(formatReport(results))
  return code
}

if (isMain(import.meta.url)) {
  main().then((code) => { process.exitCode = code }, (err) => {
    console.error(`❌ 環境檢查本身出錯：${err?.stack ?? err}`)
    process.exit(1)
  })
}
