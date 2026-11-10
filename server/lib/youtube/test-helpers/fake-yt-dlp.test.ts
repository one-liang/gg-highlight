// The fake yt-dlp itself: CLI behaviour the integration / e2e tests rely on, and data shapes the Signals need.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHAT_MIN_PER_HOUR, chatDensity, readChatMessages } from '../chat'
import { heatmapTrack } from '../heatmap'
import { parseMetadata } from '../info'
import {
  argsLogPath, FAKE_YTDLP_ERRORS, FAKE_YTDLP_IDS, FAKE_YTDLP_PATH, FAKE_YTDLP_VERSION, fakeChatLines, fakeHeatmap,
  fakeMetadata, fakeScenario, fakeYtdlpCommand, readArgsLogs,
} from './fake-yt-dlp.mjs'

const IDS = FAKE_YTDLP_IDS
const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-fake-ytdlp-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** Runs the fake synchronously with only the given GG_FAKE_* env vars. */
function run(args: string[], env: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GG_FAKE_YTDLP_')))
  const result = spawnSync(process.execPath, [FAKE_YTDLP_PATH, ...args], {
    env: { ...clean, GG_FAKE_YTDLP_LOG_DIR: dir, ...env },
    encoding: 'utf8',
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('CLI', () => {
  it('--version prints the version and writes no args log', () => {
    const result = run(['--version'])
    expect(result).toMatchObject({ code: 0, stdout: `${FAKE_YTDLP_VERSION}\n` })
    expect(FAKE_YTDLP_VERSION).toBe('2026.10.26')
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('logs every run to <log dir>/fake-yt-dlp-<id>-<n>.args.json without the --fake-* knobs', () => {
    const args = ['--no-config', '--fake-duration=30', '-J', '--skip-download', '--', watch(IDS.noChat)]
    expect(run(args).code).toBe(0)
    expect(run(['-J', `https://youtu.be/${IDS.noChat}?si=x`]).code).toBe(0)
    expect(fs.existsSync(argsLogPath(dir, IDS.noChat, 1))).toBe(true)
    expect(fs.existsSync(argsLogPath(dir, IDS.noChat, 2))).toBe(true)
    const logs = readArgsLogs(dir, IDS.noChat)
    expect(logs.map(l => l.mode)).toEqual(['metadata', 'metadata'])
    expect(logs[0]!.argv).toEqual(['--no-config', '-J', '--skip-download', '--', watch(IDS.noChat)])
    expect(logs[0]!.env.PYTHONUTF8).toBeNull()

    const noId = run(['-J', 'https://example.com/'])
    expect(noId.code).toBe(1)
    expect(noId.stderr).toMatch(/^ERROR: /)
    expect(readArgsLogs(dir, 'noid')).toHaveLength(1)
  })

  it('-J prints the scenario metadata; GG_FAKE_YTDLP_DURATION scales it', () => {
    const result = run(['-J', watch(IDS.vodChat)], { GG_FAKE_YTDLP_DURATION: '600' })
    expect(result.code).toBe(0)
    const json = JSON.parse(result.stdout)
    expect(json).toMatchObject({ id: IDS.vodChat, _type: 'video', duration: 600, live_status: 'was_live', was_live: true, language: 'zh-TW' })
    expect(json.heatmap.at(-1).end_time).toBeCloseTo(600)
    expect(json.subtitles.live_chat).toHaveLength(1)
  })

  it.each([
    [IDS.private, FAKE_YTDLP_ERRORS.private(IDS.private)],
    [IDS.botCheck, FAKE_YTDLP_ERRORS.botCheck(IDS.botCheck)],
  ])('%s: -J fails with its ERROR line', (id, line) => {
    const result = run(['-J', watch(id)])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.trim()).toBe(line)
  })

  it('a download needs the media file', () => {
    const result = run(['-P', dir, '-o', 'v.%(ext)s', watch(IDS.vodChat)])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ERROR: [fake-yt-dlp] GG_FAKE_YTDLP_MEDIA')
  })

  it('downloads the media from GG_FAKE_YTDLP_MEDIA with GGDL progress for 137 then 140 and the GGFILE line', () => {
    const media = path.join(dir, 'clip.mp4')
    fs.writeFileSync(media, Buffer.alloc(10_000, 7))
    const out = path.join(dir, 'downloads')
    const result = run([
      '-P', out, '-o', 'vid.%(ext)s', '--newline', '--progress',
      '--progress-template', 'download:GGDL %(info.format_id)s %(progress.{status,downloaded_bytes,total_bytes,total_bytes_estimate})j',
      '--print', 'after_move:GGFILE %(filepath)j', '--', watch(IDS.vodChat),
    ], { GG_FAKE_YTDLP_MEDIA: media })
    expect(result.code).toBe(0)
    const lines = result.stdout.trim().split('\n')
    const formats = lines.filter(l => l.startsWith('GGDL ')).map(l => l.split(' ')[1])
    expect([...new Set(formats)]).toEqual(['137', '140'])
    expect(JSON.parse(lines.find(l => l.startsWith('GGDL 140'))!.slice('GGDL 140 '.length))).toHaveProperty('total_bytes_estimate')
    expect(lines.at(-1)).toBe(`GGFILE ${JSON.stringify(path.join(out, 'vid.mp4'))}`)
    expect(fs.readFileSync(path.join(out, 'vid.mp4')).equals(fs.readFileSync(media))).toBe(true)
    expect(result.stderr).toMatch(/^WARNING: /)
  })

  it('a video without chat writes no chat file and exits 0', () => {
    const result = run(['--skip-download', '--write-subs', '--sub-langs', 'live_chat', '-P', dir, '-o', 'v.%(ext)s', '--', watch(IDS.noChat)])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('There are no subtitles')
    expect(fs.readdirSync(dir).filter(n => n.includes('live_chat'))).toEqual([])
  })

  it('the chat run appends to an existing .part, like yt-dlp', () => {
    fs.writeFileSync(path.join(dir, 'v.live_chat.json.part'), 'old line\n')
    const result = run(['--skip-download', '--write-subs', '--sub-langs', 'live_chat', '-P', dir, '-o', 'v.%(ext)s', '--', watch(IDS.vodChat)])
    expect(result.code).toBe(0)
    const text = fs.readFileSync(path.join(dir, 'v.live_chat.json'), 'utf8')
    expect(text.startsWith('old line\n')).toBe(true)
    expect(text.trim().split('\n')).toHaveLength(fakeChatLines(IDS.vodChat).length + 1)
  })

  it.each([
    ['SIGTERM', 143, ''],
    ['SIGINT', 1, 'ERROR: Interrupted by user'],
  ] as const)('ggSlowDl001 stops on %s', async (signal, exitCode, stderrText) => {
    const media = path.join(dir, 'clip.mkv')
    fs.writeFileSync(media, Buffer.alloc(5000))
    const child = spawn(process.execPath, [
      ...fakeYtdlpCommand({ media, logDir: dir, slowMs: 100 }).slice(1),
      '-P', dir, '-o', 'slow.%(ext)s', '--progress', '--progress-template', 'download:GGDL %(info.format_id)s %(progress.{downloaded_bytes,total_bytes})j',
      '--print', 'after_move:GGFILE %(filepath)j', '--', watch(IDS.slowDownload),
    ])
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)))
    await new Promise<void>(resolve => child.stdout.once('data', () => resolve()))
    child.kill(signal)
    expect(await exited).toBe(exitCode)
    if (stderrText) expect(stderr).toContain(stderrText)
    expect(fs.existsSync(path.join(dir, 'slow.mkv.part'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'slow.mkv'))).toBe(false)
  })
})

describe('scenarios', () => {
  it('match the ids', () => {
    expect(fakeScenario(IDS.vodChat)).toMatchObject({ live: 'was_live', chat: true, heatmap: true })
    expect(fakeScenario(IDS.noChat)).toMatchObject({ live: 'not_live', chat: false, heatmap: true })
    expect(fakeScenario(IDS.noHeatmap)).toMatchObject({ live: 'was_live', chat: true, heatmap: false })
    expect(fakeScenario(IDS.liveNow).live).toBe('is_live')
    expect(fakeScenario(IDS.postLive).live).toBe('post_live')
    expect(fakeScenario('abcdefghijk')).toEqual(fakeScenario(IDS.vodChat))
  })

  it('metadata parses into what the app expects', () => {
    const meta = parseMetadata(fakeMetadata(IDS.vodChat))
    expect(meta).toMatchObject({ title: `測試直播重播 ${IDS.vodChat}`, channel: '測試頻道', durationSec: 60, uploadDate: '2026-11-01', languageHint: 'zh', chatAvailable: true, heatmapAvailable: true })
    const noHeat = fakeMetadata(IDS.noHeatmap)
    expect('heatmap' in noHeat).toBe(false)
    expect(parseMetadata(noHeat)).toMatchObject({ heatmap: null, chatAvailable: true })
    expect(fakeMetadata(IDS.noChat).subtitles).toEqual({})
  })
})

describe('fakeHeatmap', () => {
  it('100 equal buckets, values 0–1 with the maximum exactly 1, the burst at about 20–26 s of 60 s', () => {
    const markers = fakeHeatmap()
    expect(markers).toHaveLength(100)
    for (const [k, m] of markers.entries()) {
      expect(m.start_time).toBeCloseTo(k * 0.6)
      expect(m.end_time).toBeCloseTo((k + 1) * 0.6)
      expect(m.value).toBeGreaterThanOrEqual(0)
      expect(m.value).toBeLessThanOrEqual(1)
    }
    expect(Math.max(...markers.map(m => m.value))).toBe(1)
    const high = markers.filter(m => m.value > 0.5)
    expect(high[0]!.start_time).toBeGreaterThanOrEqual(20)
    expect(high.at(-1)!.end_time).toBeLessThanOrEqual(26)
  })

  it('is proportional to the duration; the burst lands where the Signal uses it once past the first 30 s', () => {
    const long = fakeHeatmap(600)
    const peak = long.find(m => m.value === 1)!
    expect(peak.start_time).toBeGreaterThan(220)
    expect(peak.end_time).toBeLessThan(240)
    const toMarkers = (ms: ReturnType<typeof fakeHeatmap>) => ms.map(m => ({ start: m.start_time, end: m.end_time, value: m.value }))
    expect(heatmapTrack(toMarkers(long), 600).kind).toBe('track')
    // 60 s: the burst starts inside the first 30 s, which the Signal caps (documented in the .d.mts).
    expect(heatmapTrack(toMarkers(fakeHeatmap(60)), 60).kind).toBe('flat')
    expect(heatmapTrack(toMarkers(fakeHeatmap(60, 36)), 60).kind).toBe('track')
  })
})

describe('fakeChatLines', () => {
  it('is yt-dlp\'s shape: an engagement message at 0, then text messages from many authors', () => {
    const actions = fakeChatLines(IDS.vodChat).map(line => JSON.parse(line).replayChatItemAction)
    const items = actions.map(a => ({ ms: Number(a.videoOffsetTimeMsec), item: a.actions[0].addChatItemAction.item }))
    expect(items[0]!.ms).toBe(0)
    expect(items[0]!.item).toHaveProperty('liveChatViewerEngagementMessageRenderer')
    for (let i = 1; i < items.length; i++) expect(items[i]!.ms).toBeGreaterThanOrEqual(items[i - 1]!.ms)
    const texts = items.filter(i => i.item.liveChatTextMessageRenderer).map(i => i.item.liveChatTextMessageRenderer)
    expect(new Set(texts.map(t => t.authorExternalChannelId)).size).toBeGreaterThanOrEqual(5)

    const burst = items.filter(i => i.ms >= 30_000 && i.ms <= 40_000 && /笑死|哈哈哈|XD/.test(i.item.liveChatTextMessageRenderer?.message.runs[0].text ?? ''))
    expect(burst.length).toBeGreaterThanOrEqual(40)
    expect(new Set(burst.map(i => i.item.liveChatTextMessageRenderer.authorExternalChannelId)).size).toBeGreaterThanOrEqual(8)
  })

  it.each([60, 120, 600])('gives a used chat Signal with its peak right before the burst (%i s)', async (durationSec) => {
    const file = path.join(dir, 'x.live_chat.json')
    fs.writeFileSync(file, `${fakeChatLines(IDS.vodChat, durationSec).join('\n')}\n`)
    const density = chatDensity(await readChatMessages(file, durationSec), durationSec)
    expect(density.perHour).toBeGreaterThanOrEqual(CHAT_MIN_PER_HOUR)
    const scale = durationSec / 60
    const scored = [...density.values].flatMap((v, s) => v > 0 ? [s] : [])
    expect(Math.max(...density.values)).toBeGreaterThan(0.5)
    // The burst is at 30–40 s (scaled); chat lags 5–25 s, so the scored seconds lie before it.
    expect(scored[0]!).toBeGreaterThanOrEqual(30 * scale - 25)
    expect(scored.at(-1)!).toBeLessThan(40 * scale)
  })
})
