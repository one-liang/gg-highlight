// Types for fake-yt-dlp.mjs (plain ESM so it also runs with `node` for integration and e2e tests).
//
// Run: GG_YTDLP_CMD='["node","<abs>/fake-yt-dlp.mjs"]' (or fakeYtdlpCommand()). Lenient argv parsing:
// unknown flags are ignored; the video id is the 11-character id in the URL (watch?v=, youtu.be/,
// /live/, /shorts/, /embed/, /v/, or a bare id). The id picks the scenario (FAKE_YTDLP_IDS); any other
// valid id behaves like ggVodChat01.
//
// Knobs: env var or argv flag placed before the yt-dlp arguments (the flag wins; --fake-* flags are not
// passed on to the logged argv):
//   GG_FAKE_YTDLP_MEDIA        / --fake-media=<path>       file a download copies (required to download)
//   GG_FAKE_YTDLP_LOG_DIR      / --fake-log-dir=<dir>      where the args logs go (default os.tmpdir())
//   GG_FAKE_YTDLP_DURATION     / --fake-duration=<sec>     -J duration, heatmap and chat scale (default 60)
//   GG_FAKE_YTDLP_SLOW_MS      / --fake-slow-ms=<ms>       ggSlowDl001: pause per step (default 400, 50 steps)
//   GG_FAKE_YTDLP_HEATMAP_PEAK / --fake-heatmap-peak=<sec> centre of the heatmap burst (default 23/60 of duration)
//
// Args log: every run except --version writes
//   <log dir>/fake-yt-dlp-<id>-<n>.args.json   (n = 1, 2, … per id, the first free number; id 'noid' when
//   the URL has none) with FakeYtdlpArgsLog. Use a fresh log dir per test (readArgsLogs reads them back).
//
// Behaviour:
//   --version                → prints FAKE_YTDLP_VERSION.
//   -J                       → the metadata JSON (fakeMetadata) on stdout.
//   --write-subs (chat)      → writes <-P>/<-o without ext>.live_chat.json (fakeChatLines) through a .part
//                              (appended to when one exists, like yt-dlp); no chat → "[info] There are no
//                              subtitles…", exit 0, no file; final file already there → skipped, exit 0.
//   otherwise (video)        → copies the media to <-P>/<-o with the media's own extension>.part (an .mkv
//                              stays .mkv so ffprobe/preview see what it is), prints GGDL-style lines filled
//                              from --progress-template (format 137 with total_bytes, then 140 with only
//                              total_bytes_estimate), renames it and prints --print after_move templates
//                              (%(filepath)j → JSON string of the absolute path). Also prints one WARNING line.
//   Scenario errors go to stderr as `ERROR: …` lines with exit code 1 (FAKE_YTDLP_ERRORS):
//     ggPrivate01, ggBotCheck1 → every run fails (private video / bot check).
//     ggChatFail1  → the chat run leaves a 0-byte .part and fails with HTTP 429.
//     ggDl403Err1  → the video run leaves <id>.f137.mp4.part and fails with HTTP 403.
//     ggUpcoming1  → every run fails with "This live event will begin in 3 hours." (a stream that has not
//                    started: real yt-dlp has no formats for it and never prints live_status is_upcoming).
//     ggRetryErr1  → retries used up, as yt-dlp prints them ("ERROR: \r[download] Got error: … Giving up
//                    after 10 retries", the reason after a lone \r): the video run leaves a .part and fails
//                    with HTTP 403; the chat run leaves a 0-byte .part and fails with HTTP 429 (two ERROR lines).
//     ggSlowDl001  → the video run takes slowSteps × slowMs; the chat run writes 10 chunks slowMs apart;
//                    SIGINT → "ERROR: Interrupted by user", exit 1; SIGTERM → exit 143.
//   ggNoChat001's -J says language en-US (the others zh-TW), so the form's language preselect can be checked.
//   Note: with the default 60 s duration the heatmap burst (20–26 s) starts inside the first 30 s, which
//   the heatmap Signal caps at the median (design.md「重播熱度」step 2) → "沒有明顯起伏". Use a longer
//   duration or --fake-heatmap-peak=36 for a heatmap the Signal uses.
//   Chat: about 4 background messages per minute plus a burst of 40 reactions from 20 authors at 30–40 s
//   of 60 s (scaled by duration ÷ 60); the chat Signal scores the seconds just before it (chat lags 5–25 s).
//   The burst keeps 40 messages, so beyond about 10 minutes it is spread too thin to score.

export type FakeYtdlpScenarioName =
  | 'vodChat'
  | 'noChat'
  | 'noHeatmap'
  | 'liveNow'
  | 'postLive'
  | 'private'
  | 'chatFail'
  | 'download403'
  | 'slowDownload'
  | 'botCheck'
  | 'upcoming'
  | 'retryErrors'

export interface FakeYtdlpScenario {
  live: 'not_live' | 'was_live' | 'post_live' | 'is_live' | 'is_upcoming'
  /** -J lists subtitles.live_chat and the chat run writes the file. */
  chat: boolean
  /** -J has a heatmap (else the key is absent, as yt-dlp drops null fields). */
  heatmap: boolean
  /** -J language (default zh-TW). */
  language?: string
  /** Every run (except --version) fails with this FAKE_YTDLP_ERRORS entry. */
  fail?: 'private' | 'botCheck' | 'upcoming'
  chatFail?: boolean
  /** The video and chat runs fail with yt-dlp's "Giving up after 10 retries" ERROR lines. */
  retryErrors?: boolean
  download403?: boolean
  slow?: boolean
}

export interface FakeYtdlpArgsLog {
  /** yt-dlp arguments as received (without the --fake-* knobs). */
  argv: string[]
  mode: 'metadata' | 'video' | 'chat'
  pid: number
  env: { PYTHONUTF8: string | null }
}

export interface FakeHeatmapMarker {
  start_time: number
  end_time: number
  value: number
}

export interface FakeYtdlpCommandOptions {
  media?: string
  logDir?: string
  slowMs?: number
  durationSec?: number
  heatmapPeakSec?: number
}

export declare const FAKE_YTDLP_PATH: string
export declare const FAKE_YTDLP_VERSION: '2026.10.26'
export declare const FAKE_YTDLP_IDS: Readonly<{
  vodChat: 'ggVodChat01'
  noChat: 'ggNoChat001'
  noHeatmap: 'ggNoHeat001'
  liveNow: 'ggLiveNow01'
  postLive: 'ggPostLive1'
  private: 'ggPrivate01'
  chatFail: 'ggChatFail1'
  download403: 'ggDl403Err1'
  slowDownload: 'ggSlowDl001'
  botCheck: 'ggBotCheck1'
  upcoming: 'ggUpcoming1'
  retryErrors: 'ggRetryErr1'
}>
export declare const FAKE_YTDLP_ERRORS: Readonly<{
  private: (id: string) => string
  botCheck: (id: string) => string
  chat429: string
  download403: string
  upcoming: (id: string) => string
  retry403: string
  retryChat429: readonly string[]
}>
export declare const FAKE_YTDLP_DEFAULTS: Readonly<{ durationSec: number, slowMs: number, slowSteps: number }>

export declare function fakeScenario(id: string): FakeYtdlpScenario
export declare function fakeHeatmap(durationSec?: number, peakSec?: number): FakeHeatmapMarker[]
/** The -J document (plain object) for this id. */
export declare function fakeMetadata(id: string, durationSec?: number, options?: { heatmapPeakSec?: number }): Record<string, any>
/** The chat file's lines (without newlines). */
export declare function fakeChatLines(id: string, durationSec?: number): string[]
export declare function argsLogPath(dir: string, id: string, n: number): string
export declare function readArgsLogs(dir: string, id: string): FakeYtdlpArgsLog[]
/** [process.execPath, FAKE_YTDLP_PATH, ...--fake-* flags]. */
export declare function fakeYtdlpCommand(options?: FakeYtdlpCommandOptions): string[]
