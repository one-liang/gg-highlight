// Fake yt-dlp for tests (docs/design.md「測試」): plain ESM, no dependencies, never touches the network.
// Run it as GG_YTDLP_CMD='["node","<abs>/fake-yt-dlp.mjs"]'; the scenario comes from the 11-character
// video id in the URL (FAKE_YTDLP_IDS). Types and the option / log-file rules: fake-yt-dlp.d.mts.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FAKE_YTDLP_PATH = fileURLToPath(import.meta.url)
export const FAKE_YTDLP_VERSION = '2026.10.26'

export const FAKE_YTDLP_IDS = Object.freeze({
  vodChat: 'ggVodChat01',
  noChat: 'ggNoChat001',
  noHeatmap: 'ggNoHeat001',
  liveNow: 'ggLiveNow01',
  postLive: 'ggPostLive1',
  private: 'ggPrivate01',
  chatFail: 'ggChatFail1',
  download403: 'ggDl403Err1',
  slowDownload: 'ggSlowDl001',
  botCheck: 'ggBotCheck1',
  upcoming: 'ggUpcoming1',
  retryErrors: 'ggRetryErr1',
})

export const FAKE_YTDLP_ERRORS = Object.freeze({
  private: id => `ERROR: [youtube] ${id}: Private video. Sign in if you've been granted access to this video`,
  botCheck: id => `ERROR: [youtube] ${id}: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.`,
  chat429: 'ERROR: Unable to download video subtitles for \'live_chat\': HTTP Error 429: Too Many Requests',
  download403: 'ERROR: unable to download video data: HTTP Error 403: Forbidden',
  // A stream or premiere that has not started has no formats: yt-dlp fails with YouTube's reason
  // instead of printing live_status is_upcoming.
  upcoming: id => `ERROR: [youtube] ${id}: This live event will begin in 3 hours.`,
  // Retries used up (yt-dlp's downloader: report_error(f'\r[download] Got error: {e}')): the reason
  // follows a lone \r inside the ERROR line; the chat run wraps it in a second ERROR line.
  retry403: 'ERROR: \r[download] Got error: HTTP Error 403: Forbidden. Giving up after 10 retries',
  retryChat429: [
    'ERROR: \r[download] Got error: HTTP Error 429: Too Many Requests. Giving up after 10 retries',
    'ERROR: Unable to download video subtitles for \'live_chat\': ERROR: \r[download] Got error: HTTP Error 429: Too Many Requests. Giving up after 10 retries',
  ],
})

/** Defaults of the knobs (env var GG_FAKE_YTDLP_<NAME> or argv --fake-<name>=…). */
export const FAKE_YTDLP_DEFAULTS = Object.freeze({ durationSec: 60, slowMs: 400, slowSteps: 50 })

const SCENARIOS = {
  ggVodChat01: { live: 'was_live', chat: true, heatmap: true },
  ggNoChat001: { live: 'not_live', chat: false, heatmap: true, language: 'en-US' },
  ggNoHeat001: { live: 'was_live', chat: true, heatmap: false },
  ggLiveNow01: { live: 'is_live', chat: true, heatmap: false },
  ggPostLive1: { live: 'post_live', chat: true, heatmap: false },
  ggPrivate01: { live: 'not_live', chat: false, heatmap: false, fail: 'private' },
  ggChatFail1: { live: 'was_live', chat: true, heatmap: true, chatFail: true },
  ggDl403Err1: { live: 'was_live', chat: true, heatmap: true, download403: true },
  ggSlowDl001: { live: 'was_live', chat: true, heatmap: true, slow: true },
  ggBotCheck1: { live: 'was_live', chat: true, heatmap: true, fail: 'botCheck' },
  ggUpcoming1: { live: 'is_upcoming', chat: true, heatmap: false, fail: 'upcoming' },
  ggRetryErr1: { live: 'was_live', chat: true, heatmap: true, retryErrors: true },
}

export function fakeScenario(id) {
  return SCENARIOS[id] ?? SCENARIOS.ggVodChat01
}

const round = (value, digits) => Number(value.toFixed(digits))

/**
 * 100 equal buckets over the video, values 0–1 with the maximum exactly 1: a low wavy background and a
 * clear burst centred at `peakSec` (default 23/60 of the duration, i.e. about 20–26 s of a 60 s video).
 */
export function fakeHeatmap(durationSec = FAKE_YTDLP_DEFAULTS.durationSec, peakSec = durationSec * 23 / 60) {
  const n = 100
  const step = durationSec / n
  const sigma = durationSec * 2 / 60
  const raw = []
  for (let k = 0; k < n; k++) {
    const mid = (k + 0.5) * step
    raw.push(0.18 + 0.04 * Math.sin(k * 0.7) + 0.85 * Math.exp(-0.5 * ((mid - peakSec) / sigma) ** 2))
  }
  const max = Math.max(...raw)
  return raw.map((v, k) => ({
    start_time: round(k * step, 3),
    end_time: round((k + 1) * step, 3),
    value: v === max ? 1 : round(v / max, 4),
  }))
}

/** What `-J` prints for this id (yt-dlp leaves out null fields, so absent things are absent). */
export function fakeMetadata(id, durationSec = FAKE_YTDLP_DEFAULTS.durationSec, options = {}) {
  const s = fakeScenario(id)
  const titles = { was_live: '測試直播重播', not_live: '測試影片', is_live: '測試直播中', post_live: '測試直播剛結束' }
  const url = `https://www.youtube.com/watch?v=${id}`
  const meta = {
    id,
    title: `${titles[s.live] ?? '測試影片'} ${id}`,
    fulltitle: `${titles[s.live] ?? '測試影片'} ${id}`,
    channel: '測試頻道',
    channel_id: 'UCfakeChannel000000000000',
    uploader: '測試頻道',
    uploader_id: '@fake-channel',
    duration: durationSec,
    live_status: s.live,
    was_live: s.live === 'was_live' || s.live === 'post_live',
    is_live: s.live === 'is_live',
    upload_date: '20261101',
    timestamp: 1761998400,
    view_count: 123456,
    webpage_url: url,
    original_url: url,
    thumbnail: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    language: s.language ?? 'zh-TW',
    availability: 'public',
    extractor: 'youtube',
    extractor_key: 'Youtube',
    _type: 'video',
    formats: [
      { format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', width: 1920, height: 1080 },
      { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2' },
    ],
    subtitles: {},
  }
  if (s.heatmap) meta.heatmap = fakeHeatmap(durationSec, options.heatmapPeakSec)
  if (s.chat) {
    meta.subtitles.live_chat = [{
      url: `https://www.youtube.com/watch?v=${id}&bpctr=9999999999&has_verified=1`,
      video_id: id,
      ext: 'json',
      protocol: s.live === 'is_live' ? 'youtube_live_chat' : 'youtube_live_chat_replay',
    }]
  }
  return meta
}

function mmss(sec) {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The live chat replay in yt-dlp's shape (one JSON action per line, ordered by videoOffsetTimeMsec):
 * first a liveChatViewerEngagementMessageRenderer at 0, then a low background of ordinary messages
 * (about 4 per minute, one greeting, one Super Chat, one membership item) and a dense reaction burst of
 * 40 messages from 20 authors at 30–40 s of a 60 s video (offsets scale with duration ÷ 60). Each burst
 * author's two messages are more than 5 s apart, so all 40 count.
 */
export function fakeChatLines(id, durationSec = FAKE_YTDLP_DEFAULTS.durationSec) {
  const scale = durationSec / 60
  const baseUsec = 1761998400000000
  const items = []
  const add = (sec, item) => items.push({ ms: Math.round(sec * 1000), item })
  const text = (sec, author, name, message) => add(sec, {
    liveChatTextMessageRenderer: {
      message: { runs: [{ text: message }] },
      authorName: { simpleText: name },
      authorPhoto: { thumbnails: [{ url: 'https://yt4.ggpht.com/fake=s32', width: 32, height: 32 }] },
      authorExternalChannelId: author,
      contextMenuEndpoint: {},
      id: `${id}-msg-${items.length}`,
      timestampUsec: String(baseUsec + Math.round(sec * 1e6)),
      timestampText: { simpleText: mmss(sec) },
      trackingParams: 'CAEQl98BIhMI',
    },
  })

  add(0, {
    liveChatViewerEngagementMessageRenderer: {
      id: `${id}-engagement`,
      timestampUsec: String(baseUsec + 10 ** 12),
      icon: { iconType: 'YOUTUBE_ROUND' },
      message: { runs: [{ text: 'Live chat replay is on. Messages that appeared when the stream was live will show up here.' }] },
    },
  })

  const background = ['大家好', '這關好難', '主播加油', '剛剛那個是什麼操作', '今天玩什麼', '音樂好好聽']
  const count = Math.max(4, Math.round(4 * durationSec / 60))
  for (let i = 0; i < count; i++) {
    const n = (i % 6) + 1
    text((i + 0.5) * durationSec / count, `UCfakeViewer0000000000${String(n).padStart(2, '0')}`, `觀眾${n}`, background[i % background.length])
  }
  add(45 * scale, {
    liveChatPaidMessageRenderer: {
      id: `${id}-superchat`,
      timestampUsec: String(baseUsec + Math.round(45 * scale * 1e6)),
      authorName: { simpleText: '贊助者' },
      authorExternalChannelId: 'UCfakeSponsor000000000001',
      purchaseAmountText: { simpleText: 'NT$75.00' },
      message: { runs: [{ text: '加油！' }] },
      timestampText: { simpleText: mmss(45 * scale) },
    },
  })
  add(50 * scale, {
    liveChatMembershipItemRenderer: {
      id: `${id}-member`,
      timestampUsec: String(baseUsec + Math.round(50 * scale * 1e6)),
      authorExternalChannelId: 'UCfakeMember0000000000001',
      authorName: { simpleText: '新會員' },
      headerSubtext: { runs: [{ text: '歡迎加入會員！' }] },
    },
  })

  const reactions = ['笑死', '哈哈哈哈哈', 'XD', '笑死 XDDD', '哈哈哈']
  for (let k = 0; k < 20; k++) {
    const author = `UCfakeBurst00000000000${String(k + 1).padStart(3, '0')}`
    const first = 30 + k * 0.22
    text(first * scale, author, `路人${k + 1}`, reactions[k % reactions.length])
    text((first + 5.3) * scale, author, `路人${k + 1}`, reactions[(k + 2) % reactions.length])
  }

  items.sort((a, b) => a.ms - b.ms)
  return items.map(({ ms, item }, i) => JSON.stringify({
    clickTrackingParams: 'CAEQl98BIhMI',
    replayChatItemAction: {
      actions: [{ clickTrackingParams: 'CAEQl98BIhMI', addChatItemAction: { item, clientId: `fake-client-${i}` } }],
      videoOffsetTimeMsec: String(ms),
    },
  }))
}

/** <dir>/fake-yt-dlp-<id>-<n>.args.json: the n-th run (1-based) for this video id ('noid' without one). */
export function argsLogPath(dir, id, n) {
  return path.join(dir, `fake-yt-dlp-${id}-${n}.args.json`)
}

/** Every args log of this id in `dir`, in run order. */
export function readArgsLogs(dir, id) {
  let names
  try {
    names = fs.readdirSync(dir)
  }
  catch {
    return []
  }
  const re = new RegExp(`^fake-yt-dlp-${id.replace(/[^\w-]/g, '')}-(\\d+)\\.args\\.json$`)
  return names
    .map(name => ({ name, n: Number(re.exec(name)?.[1] ?? Number.NaN) }))
    .filter(entry => Number.isFinite(entry.n))
    .sort((a, b) => a.n - b.n)
    .map(entry => JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8')))
}

/** argv for runCli / GG_YTDLP_CMD: node + this script + the given knobs as --fake-* flags. */
export function fakeYtdlpCommand(options = {}) {
  const command = [process.execPath, FAKE_YTDLP_PATH]
  const flags = { media: options.media, 'log-dir': options.logDir, 'slow-ms': options.slowMs, duration: options.durationSec, 'heatmap-peak': options.heatmapPeakSec }
  for (const [name, value] of Object.entries(flags)) {
    if (value !== undefined && value !== null) command.push(`--fake-${name}=${value}`)
  }
  return command
}

// ---------------------------------------------------------------------------------------------------
// CLI

const VALUE_FLAGS = new Set([
  '-f', '--format', '-S', '--format-sort', '--merge-output-format', '-P', '--paths', '-o', '--output',
  '--progress-template', '--print', '-O', '--sub-langs', '--sub-format', '--js-runtimes', '--ffmpeg-location',
  '--progress-delta', '--cookies', '--cookies-from-browser', '--remux-video', '-t', '--preset-alias',
  '--extractor-args', '--proxy', '--limit-rate', '-r', '--retries', '--fragment-retries', '--match-filters',
  '--load-info-json', '--user-agent', '--referer', '--sleep-interval', '--remote-components',
])
const PATH_TYPES = new Set(['home', 'temp', 'subtitle', 'thumbnail', 'description', 'annotation', 'infojson', 'link', 'pl_thumbnail', 'pl_description', 'pl_infojson', 'chapter', 'pl_video'])
const PRINT_STAGES = new Set(['pre_process', 'after_filter', 'video', 'before_dl', 'post_process', 'after_move', 'after_video', 'playlist'])

function parseArgv(argv) {
  const fake = {}
  const args = []
  const opts = { flags: new Set(), values: {}, urls: [] }
  let rest = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!rest && token.startsWith('--fake-')) {
      const eq = token.indexOf('=')
      fake[eq < 0 ? token.slice(7) : token.slice(7, eq)] = eq < 0 ? '' : token.slice(eq + 1)
      continue
    }
    args.push(token)
    if (rest || !token.startsWith('-') || token === '-') {
      opts.urls.push(token)
      continue
    }
    if (token === '--') {
      rest = true
      continue
    }
    const eq = token.startsWith('--') ? token.indexOf('=') : -1
    const name = eq > 0 ? token.slice(0, eq) : token
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 ? token.slice(eq + 1) : argv[++i]
      if (eq < 0 && value !== undefined) args.push(value)
      ;(opts.values[name] ??= []).push(value ?? '')
    }
    else {
      opts.flags.add(name)
    }
  }
  return { fake, args, opts }
}

function videoIdOf(urls) {
  for (const raw of urls) {
    const match = /[?&]v=([\w-]{11})(?![\w-])/.exec(raw)
      ?? /youtu\.be\/([\w-]{11})(?![\w-])/.exec(raw)
      ?? /\/(?:live|shorts|embed|v)\/([\w-]{11})(?![\w-])/.exec(raw)
      ?? /^([\w-]{11})$/.exec(raw)
    if (match) return match[1]
  }
  return null
}

function knob(fake, flag, env, fallback) {
  const value = fake[flag] ?? process.env[env]
  return value === undefined || value === '' ? fallback : value
}

function writeArgsLog(dir, id, entry) {
  fs.mkdirSync(dir, { recursive: true })
  for (let n = 1; n < 100_000; n++) {
    try {
      fs.writeFileSync(argsLogPath(dir, id, n), JSON.stringify(entry, null, 2), { flag: 'wx' })
      return
    }
    catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function out(line) {
  process.stdout.write(`${line}\n`)
}

function err(line) {
  process.stderr.write(`${line}\n`)
}

/** Writes and exits only after stdout/stderr are flushed (they are async pipes). */
function exit(code) {
  process.exitCode = code
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}

function homeDir(opts) {
  let home = process.cwd()
  for (const value of opts.values['-P'] ?? opts.values['--paths'] ?? []) {
    const match = /^([a-z_]+):(.*)$/.exec(value)
    if (match && PATH_TYPES.has(match[1])) {
      if (match[1] === 'home') home = match[2]
    }
    else {
      home = value
    }
  }
  return path.resolve(home)
}

function outputTemplate(opts) {
  let template = '%(title)s [%(id)s].%(ext)s'
  for (const value of opts.values['-o'] ?? opts.values['--output'] ?? []) {
    // "TYPE:template" sets another output type (subtitle, thumbnail…); "default:" or no type sets the main one.
    const match = /^([a-z_]+):(.*)$/.exec(value)
    if (match?.[1] === 'default') template = match[2]
    else if (!match || !PATH_TYPES.has(match[1])) template = value
  }
  return template
}

function fillOutput(template, meta, ext) {
  return template.replace(/%\((\w+)\)s/g, (_, key) => key === 'ext' ? ext : String(meta[key] ?? 'NA'))
}

/** --progress-template for downloads, filled like yt-dlp: %(info.x)s, %(progress.x)s, %(progress.{a,b})j. */
function progressLine(template, info, progress) {
  return template.replace(/%\((info|progress)\.(\{[^}]*\}|\w+)\)([sdj])/g, (_, scope, key, conv) => {
    const source = scope === 'info' ? info : progress
    let value
    if (key.startsWith('{')) {
      value = {}
      for (const k of key.slice(1, -1).split(',').map(s => s.trim())) {
        if (source[k] !== undefined && source[k] !== null) value[k] = source[k]
      }
    }
    else {
      value = source[key] ?? 'NA'
    }
    return conv === 'j' ? JSON.stringify(value) : String(value)
  })
}

function fillPrint(template, filepath, meta) {
  return template.replace(/%\((\w+)\)([sjq])/g, (_, key, conv) => {
    const value = key === 'filepath' ? filepath : meta[key] ?? 'NA'
    if (conv === 'j') return JSON.stringify(value)
    if (conv === 'q') return `"${value}"`
    return String(value)
  })
}

async function runDownload(ctx) {
  const { id, scenario, opts, meta, media, slowMs, slowSteps } = ctx
  const home = homeDir(opts)
  fs.mkdirSync(home, { recursive: true })
  const templates = (opts.values['--progress-template'] ?? [])
    .map(v => /^(download|postprocess|download-title|postprocess-title):(.*)$/.exec(v) ?? [v, 'download', v])
  const template = templates.find(m => m[1] === 'download')?.[2] ?? null
  const prints = (opts.values['--print'] ?? opts.values['-O'] ?? [])
    .map((v) => {
      const match = /^(\w+):(.*)$/.exec(v)
      return match && PRINT_STAGES.has(match[1]) ? { stage: match[1], template: match[2] } : { stage: 'video', template: v }
    })
  const quiet = prints.length > 0
  const showProgress = !quiet || opts.flags.has('--progress')
  const emit = (formatId, progress) => {
    if (!showProgress) return
    if (template) out(progressLine(template, { id, format_id: formatId }, progress))
    else out(`[download] ${(100 * (progress.downloaded_bytes ?? 0) / (progress.total_bytes || progress.total_bytes_estimate || 1)).toFixed(1)}% (format ${formatId})`)
  }

  err(`WARNING: [youtube] ${id}: Some web client https formats have been skipped as they are missing a url. YouTube is forcing SABR streaming for this client.`)

  if (scenario.download403) {
    const partial = path.join(home, fillOutput(outputTemplate(opts), meta, 'f137.mp4')) + '.part'
    const bytes = media && fs.existsSync(media) ? fs.readFileSync(media).subarray(0, 4096) : Buffer.from('partial')
    fs.writeFileSync(partial, bytes)
    emit('137', { status: 'downloading', downloaded_bytes: bytes.length, total_bytes: bytes.length * 10 })
    await sleep(20)
    err(FAKE_YTDLP_ERRORS.download403)
    return exit(1)
  }

  if (scenario.retryErrors) {
    const partial = path.join(home, fillOutput(outputTemplate(opts), meta, 'f137.mp4')) + '.part'
    fs.writeFileSync(partial, Buffer.from('partial'))
    emit('137', { status: 'downloading', downloaded_bytes: 7, total_bytes: 70 })
    out('[download] Got error: HTTP Error 403: Forbidden. Retrying (1/10)...')
    await sleep(20)
    err(FAKE_YTDLP_ERRORS.retry403)
    return exit(1)
  }

  if (!media || !fs.existsSync(media)) {
    err(`ERROR: [fake-yt-dlp] GG_FAKE_YTDLP_MEDIA is not set or does not exist: ${media ?? '(unset)'}`)
    return exit(1)
  }

  // The file keeps the source's bytes and extension (an .mkv stays .mkv), so ffprobe and the preview see what it is.
  const ext = path.extname(media).slice(1).toLowerCase() || 'mp4'
  const finalPath = path.join(home, fillOutput(outputTemplate(opts), meta, ext))
  const partPath = `${finalPath}.part`
  const size = fs.statSync(media).size
  const videoBytes = Math.max(1, Math.round(size * 0.9))
  const audioBytes = Math.max(1, size - videoBytes)

  if (!quiet) out(`[download] Destination: ${finalPath}`)
  fs.copyFileSync(media, partPath)

  let stop = false
  if (scenario.slow) {
    process.on('SIGINT', () => {
      stop = true
      err('ERROR: Interrupted by user')
      exit(1)
    })
    process.on('SIGTERM', () => {
      stop = true
      exit(143)
    })
  }
  const videoSteps = scenario.slow ? slowSteps : 4
  for (let i = 1; i <= videoSteps && !stop; i++) {
    emit('137', { status: 'downloading', downloaded_bytes: Math.round(videoBytes * i / (videoSteps + 1)), total_bytes: videoBytes })
    await sleep(scenario.slow ? slowMs : 5)
  }
  if (stop) return
  emit('137', { status: 'finished', downloaded_bytes: videoBytes, total_bytes: videoBytes })
  for (let i = 1; i <= 3; i++) {
    // The audio part reports only an estimate, like many DASH formats.
    emit('140', { status: 'downloading', downloaded_bytes: Math.round(audioBytes * i / 4), total_bytes_estimate: audioBytes })
    await sleep(5)
  }
  emit('140', { status: 'finished', downloaded_bytes: audioBytes, total_bytes: audioBytes })

  fs.renameSync(partPath, finalPath)
  for (const p of prints) {
    if (p.stage === 'after_move' || p.stage === 'post_process' || p.stage === 'after_video') out(fillPrint(p.template, finalPath, meta))
  }
  return exit(0)
}

async function runChat(ctx) {
  const { id, scenario, opts, meta, durationSec, slowMs } = ctx
  const home = homeDir(opts)
  fs.mkdirSync(home, { recursive: true })
  const langs = (opts.values['--sub-langs'] ?? []).join(',').split(',').map(s => s.trim())
  if (!scenario.chat || !langs.includes('live_chat')) {
    out('[info] There are no subtitles for the requested languages')
    return exit(0)
  }
  const base = fillOutput(outputTemplate(opts), meta, 'webm').replace(/\.webm$/, '')
  const finalPath = path.join(home, `${base}.live_chat.json`)
  const partPath = `${finalPath}.part`
  if (fs.existsSync(finalPath)) {
    out('[info] Video subtitle live_chat.json is already present')
    return exit(0)
  }
  out(`[info] Writing video subtitles to: ${finalPath}`)
  if (scenario.chatFail) {
    fs.closeSync(fs.openSync(partPath, 'a'))
    err(FAKE_YTDLP_ERRORS.chat429)
    return exit(1)
  }
  if (scenario.retryErrors) {
    fs.closeSync(fs.openSync(partPath, 'a'))
    out('[download] Got error: HTTP Error 429: Too Many Requests. Retrying fragment 1 (1/10)...')
    for (const line of FAKE_YTDLP_ERRORS.retryChat429) err(line)
    return exit(1)
  }
  // Like yt-dlp: an existing .part is appended to (the chat download cannot resume).
  const lines = fakeChatLines(id, durationSec)
  const chunks = scenario.slow ? 10 : 1
  const per = Math.ceil(lines.length / chunks)
  for (let c = 0; c < chunks; c++) {
    const part = lines.slice(c * per, (c + 1) * per)
    if (part.length) fs.appendFileSync(partPath, part.map(l => `${l}\n`).join(''))
    if (scenario.slow) await sleep(slowMs)
  }
  fs.renameSync(partPath, finalPath)
  return exit(0)
}

async function main() {
  const { fake, args, opts } = parseArgv(process.argv.slice(2))
  if (opts.flags.has('--version')) {
    out(FAKE_YTDLP_VERSION)
    return exit(0)
  }
  const id = videoIdOf(opts.urls)
  const mode = opts.flags.has('-J') || opts.flags.has('--dump-single-json')
    ? 'metadata'
    : opts.flags.has('--write-subs') || opts.flags.has('--write-sub')
      ? 'chat'
      : 'video'
  const logDir = knob(fake, 'log-dir', 'GG_FAKE_YTDLP_LOG_DIR', os.tmpdir())
  writeArgsLog(logDir, id ?? 'noid', {
    argv: args,
    mode,
    pid: process.pid,
    env: { PYTHONUTF8: process.env.PYTHONUTF8 ?? null },
  })
  if (!id) {
    err(`ERROR: [generic] '${opts.urls[0] ?? ''}' is not a valid URL`)
    return exit(1)
  }

  const durationSec = Number(knob(fake, 'duration', 'GG_FAKE_YTDLP_DURATION', FAKE_YTDLP_DEFAULTS.durationSec))
  const peak = knob(fake, 'heatmap-peak', 'GG_FAKE_YTDLP_HEATMAP_PEAK', undefined)
  const ctx = {
    id,
    scenario: fakeScenario(id),
    opts,
    durationSec,
    meta: fakeMetadata(id, durationSec, { heatmapPeakSec: peak === undefined ? undefined : Number(peak) }),
    media: knob(fake, 'media', 'GG_FAKE_YTDLP_MEDIA', null),
    slowMs: Number(knob(fake, 'slow-ms', 'GG_FAKE_YTDLP_SLOW_MS', FAKE_YTDLP_DEFAULTS.slowMs)),
    slowSteps: FAKE_YTDLP_DEFAULTS.slowSteps,
  }
  const failure = ctx.scenario.fail
  if (failure) {
    await sleep(10)
    err(FAKE_YTDLP_ERRORS[failure](id))
    return exit(1)
  }
  if (mode === 'metadata') {
    out(JSON.stringify(ctx.meta))
    return exit(0)
  }
  if (mode === 'chat') return runChat(ctx)
  return runDownload(ctx)
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedAs === FAKE_YTDLP_PATH || (() => {
  try {
    return fs.realpathSync(invokedAs) === fs.realpathSync(FAKE_YTDLP_PATH)
  }
  catch {
    return false
  }
})()) {
  main().catch((error) => {
    err(`ERROR: [fake-yt-dlp] ${error?.stack ?? error}`)
    exit(1)
  })
}
