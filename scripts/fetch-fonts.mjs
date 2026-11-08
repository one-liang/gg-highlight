#!/usr/bin/env node
// Puts the subtitle font (Noto Sans CJK TC Bold) into fonts/.
// Order: already there → download from GitHub → copy an installed system Noto Sans CJK → manual instructions.
//
//   node scripts/fetch-fonts.mjs [--force] [--no-download]
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isMain, projectRoot } from './lib/common.mjs'

export const FONT_URL = 'https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Bold.otf'
export const FONT_FILE = 'NotoSansCJKtc-Bold.otf'
export const RELEASES_URL = 'https://github.com/notofonts/noto-cjk/releases'
export const MIN_FONT_BYTES = 1024 * 1024
const IDLE_TIMEOUT_MS = 60_000

/**
 * Files that provide the "Noto Sans CJK TC" family: the multi-region collection
 * (NotoSansCJK-Bold.ttc), the TC-only OTF (NotoSansCJKtc-Bold.otf) or the Super OTC (NotoSansCJK.ttc).
 * SC/JP/KR-only files and Noto Sans TC (Google Fonts) use other family names, so they don't match.
 */
const NOTO_CJK_NAME = /^NotoSansCJK(tc)?(?:-([A-Za-z]+))?\.(otf|ttc)$/i
const WEIGHT_RANK = { bold: 0, black: 1, medium: 2, '': 3, regular: 4 }

export function resolveFontsDir(env = process.env, root = projectRoot) {
  return path.resolve(root, env.GG_FONTS_DIR || 'fonts')
}

/** 'otf' | 'ttf' | 'ttc' from the file's first bytes, or null when it is not a font. */
export function fontKind(head) {
  if (!head || head.length < 4) return null
  const tag = head.subarray(0, 4).toString('latin1')
  if (tag === 'OTTO') return 'otf'
  if (tag === 'ttcf') return 'ttc'
  if (tag === 'true' || head.readUInt32BE(0) === 0x00010000) return 'ttf'
  return null
}

/**
 * Checks that `file` is a complete font: larger than 1 MB and starting with a font magic.
 * @param {string} file
 * @param {Array<'otf'|'ttf'|'ttc'>} [kinds]
 * @returns {Promise<{ ok: true, kind: string, size: number } | { ok: false, reason: string }>}
 */
export async function inspectFontFile(file, kinds = ['otf', 'ttf', 'ttc']) {
  let handle
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile()) return { ok: false, reason: '不是檔案' }
    if (stat.size <= MIN_FONT_BYTES) return { ok: false, reason: `檔案太小（${stat.size} bytes），可能下載不完整` }
    handle = await fsp.open(file, 'r')
    const head = Buffer.alloc(4)
    await handle.read(head, 0, 4, 0)
    const kind = fontKind(head)
    if (!kind) return { ok: false, reason: '不是 OpenType 字型檔' }
    if (!kinds.includes(kind)) return { ok: false, reason: `字型格式是 ${kind}，需要 ${kinds.join('/')}` }
    return { ok: true, kind, size: stat.size }
  }
  catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? '找不到檔案' : err.message }
  }
  finally {
    await handle?.close()
  }
}

/** Sort key for a Noto Sans CJK file name (lower is better), or null when the name doesn't qualify. */
export function fontRank(name) {
  const m = NOTO_CJK_NAME.exec(name)
  if (!m) return null
  const weight = (m[2] ?? '').toLowerCase()
  const weightRank = WEIGHT_RANK[weight] ?? 5
  // Same weight: the TC-only OTF is smaller than the collection.
  return weightRank * 2 + (m[1] ? 0 : 1)
}

/** Folders where an installed Noto Sans CJK font may live, most likely first. */
export function systemFontDirs(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') {
    const p = path.win32
    return [
      p.join(env.WINDIR || env.SystemRoot || 'C:\\Windows', 'Fonts'),
      env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts') : null,
    ].filter(Boolean)
  }
  const p = path.posix
  if (platform === 'darwin') {
    return [
      p.join(home, 'Library', 'Fonts'),
      '/Library/Fonts',
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
    ]
  }
  return [
    '/usr/share/fonts/opentype/noto',
    '/usr/share/fonts/noto-cjk',
    '/usr/share/fonts/google-noto-cjk',
    '/usr/share/fonts/google-noto-sans-cjk-fonts',
    '/usr/share/fonts/truetype/noto',
    '/usr/local/share/fonts',
    p.join(home, '.local', 'share', 'fonts'),
    p.join(home, '.fonts'),
  ]
}

/** Valid Noto Sans CJK files in `dirs`, best first. Unreadable folders are skipped. */
export async function findNotoFonts(dirs) {
  const candidates = []
  for (const [dirIndex, dir] of dirs.entries()) {
    let names
    try {
      names = await fsp.readdir(dir)
    }
    catch {
      continue
    }
    for (const name of names) {
      const rank = fontRank(name)
      if (rank !== null) candidates.push({ file: path.join(dir, name), rank, dirIndex })
    }
  }
  candidates.sort((a, b) => a.rank - b.rank || a.dirIndex - b.dirIndex || a.file.localeCompare(b.file))
  const found = []
  for (const c of candidates) {
    if ((await inspectFontFile(c.file)).ok) found.push(c.file)
  }
  return found
}

/** Best valid Noto Sans CJK font already in the fonts folder, or null. */
export async function findInstalledFont(fontsDir) {
  return (await findNotoFonts([fontsDir]))[0] ?? null
}

/** Best installed system Noto Sans CJK font, or null. */
export async function findSystemFont(opts = {}) {
  const dirs = opts.dirs ?? systemFontDirs(opts.platform, opts.env, opts.home)
  return (await findNotoFonts(dirs))[0] ?? null
}

function formatMb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1)
}

/**
 * Downloads `url` to `dest` through `dest.part`, then validates and renames it.
 * Aborts when no data arrives for `idleTimeoutMs`. Leaves nothing behind on failure.
 */
export async function downloadFont({ url = FONT_URL, dest, fetchImpl = fetch, idleTimeoutMs = IDLE_TIMEOUT_MS, onProgress } = {}) {
  const part = `${dest}.part`
  const controller = new AbortController()
  let timer = null
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new Error('下載逾時（超過 60 秒沒有收到資料）')), idleTimeoutMs)
  }
  try {
    arm()
    const res = await fetchImpl(url, { redirect: 'follow', signal: controller.signal })
    if (!res.ok || !res.body) throw new Error(`伺服器回應 HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length')) || 0
    let received = 0
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (source) {
        for await (const chunk of source) {
          arm()
          received += chunk.length
          onProgress?.(received, total)
          yield chunk
        }
      },
      fs.createWriteStream(part),
      { signal: controller.signal },
    )
    const check = await inspectFontFile(part, ['otf'])
    if (!check.ok) throw new Error(`下載的檔案不是完整的字型：${check.reason}`)
    await fsp.rename(part, dest)
    return { file: dest, size: check.size }
  }
  catch (err) {
    await fsp.rm(part, { force: true })
    const reason = controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : err
    throw reason instanceof Error ? reason : new Error(String(reason))
  }
  finally {
    clearTimeout(timer)
  }
}

/** Copies a system font into `fontsDir` (through a .part file) and returns the new path. */
export async function copyFont(src, fontsDir) {
  const dest = path.join(fontsDir, path.basename(src))
  const part = `${dest}.part`
  try {
    await fsp.copyFile(src, part)
    const check = await inspectFontFile(part)
    if (!check.ok) throw new Error(`複製的字型檔不完整：${check.reason}`)
    await fsp.rename(part, dest)
    return dest
  }
  catch (err) {
    await fsp.rm(part, { force: true })
    throw err
  }
}

/**
 * Makes sure fontsDir holds a Noto Sans CJK TC font.
 * @returns {Promise<{ status: 'present'|'downloaded'|'copied'|'missing', file: string|null, errors: string[] }>}
 */
export async function fetchFonts({
  fontsDir = resolveFontsDir(),
  download = true,
  force = false,
  fetchImpl = fetch,
  url = FONT_URL,
  systemDirs,
  platform = process.platform,
  env = process.env,
  log = () => {},
  onProgress,
} = {}) {
  const errors = []
  await fsp.mkdir(fontsDir, { recursive: true })

  if (!force) {
    const existing = await findInstalledFont(fontsDir)
    if (existing) return { status: 'present', file: existing, errors }
  }

  if (download) {
    log(`下載字幕字型：${url}`)
    try {
      const { file } = await downloadFont({ url, dest: path.join(fontsDir, FONT_FILE), fetchImpl, onProgress })
      return { status: 'downloaded', file, errors }
    }
    catch (err) {
      errors.push(`下載失敗：${err.message}`)
      log(`下載失敗：${err.message}`)
    }
  }

  const system = await findSystemFont({ dirs: systemDirs, platform, env })
  if (system) {
    log(`改用系統已安裝的字型：${system}`)
    try {
      return { status: 'copied', file: await copyFont(system, fontsDir), errors }
    }
    catch (err) {
      errors.push(`複製系統字型失敗：${err.message}`)
      log(`複製系統字型失敗：${err.message}`)
    }
  }
  return { status: 'missing', file: null, errors }
}

export function manualInstructions(fontsDir) {
  return [
    '❌ 無法自動取得字幕字型（Noto Sans CJK TC）。請手動下載：',
    `  1. 用瀏覽器打開 ${FONT_URL}`,
    `     （打不開的話，到 ${RELEASES_URL} 下載 Noto Sans CJK 的壓縮檔，取出 ${FONT_FILE}）`,
    `  2. 把 ${FONT_FILE} 放進這個資料夾：${fontsDir}`,
    '  3. 再執行一次 node scripts/fetch-fonts.mjs（或 setup.bat）確認字型已就緒',
    '  沒有字型的話，輸出剪輯時燒錄的字幕可能無法正確顯示中文。',
  ].join('\n')
}

function progressPrinter(write) {
  let lastStep = -1
  return (received, total) => {
    if (!total) return
    const step = Math.floor((received / total) * 10)
    if (step <= lastStep) return
    lastStep = step
    write(`  下載中… ${step * 10}%（${formatMb(received)} / ${formatMb(total)} MB）`)
  }
}

/** CLI entry; `opts` is passed on to fetchFonts (tests use it to replace the network and system folders). */
export async function main(argv = process.argv.slice(2), opts = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node scripts/fetch-fonts.mjs [--force] [--no-download]')
    console.log('  --force        已經有字型也重新取得')
    console.log('  --no-download  不連網，只從系統已安裝的字型複製')
    console.log('  字型資料夾可以用環境變數 GG_FONTS_DIR 指定（預設 fonts/）')
    return 0
  }
  const fontsDir = opts.fontsDir ?? resolveFontsDir(opts.env)
  const result = await fetchFonts({
    ...opts,
    fontsDir,
    force: argv.includes('--force'),
    download: !argv.includes('--no-download'),
    log: msg => console.log(msg),
    onProgress: progressPrinter(msg => console.log(msg)),
  })
  switch (result.status) {
    case 'present':
      console.log(`✅ 字幕字型已就緒：${result.file}`)
      return 0
    case 'downloaded':
      console.log(`✅ 字幕字型下載完成：${result.file}`)
      return 0
    case 'copied':
      console.log(`✅ 已從系統字型複製：${result.file}`)
      return 0
    default:
      // result.errors were already printed through log()
      console.error(manualInstructions(fontsDir))
      return 1
  }
}

if (isMain(import.meta.url)) {
  main().then((code) => { process.exitCode = code }, (err) => {
    console.error(`❌ 取得字型時發生錯誤：${err?.message ?? err}`)
    console.error(manualInstructions(resolveFontsDir()))
    process.exit(1)
  })
}
