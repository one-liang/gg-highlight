// Chat density Signal (design.md「聊天室密度（chat 訊號）」): stream <videoId>.live_chat.json (yt-dlp's
// format, one JSON action per line) → counted messages → per-second 0–1 track. Recomputed every run;
// authors are only kept in memory while computing.
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { rollingMedian } from '../signals/loudness'
import type { ChatDensity, ChatMessage } from './types'

/** Chat lags the moment (latency + reading + typing): r[s] sums the messages in [s + 5, s + 5 + 20). */
export const CHAT_LAG_START_SEC = 5
export const CHAT_WINDOW_SEC = 20
/** Baseline b[s] = median of r over [s − 150, s + 150]. */
export const CHAT_BASELINE_HALF_WINDOW_SEC = 150
/** Fewer counted (weight > 0) messages per hour than this → the Signal is missing (too little chat). */
export const CHAT_MIN_PER_HOUR = 120
/** A window needs at least this weighted count and this many distinct authors before it can score. */
export const CHAT_MIN_COUNT = 3
export const CHAT_MIN_AUTHORS = 3
/** Per author, only the first message within this many seconds counts. */
export const CHAT_AUTHOR_COOLDOWN_SEC = 5

/** b[s] is at least this many weighted messages per window. */
const MIN_BASELINE = 1
/** Ratio r/b (log2) where scoring starts (2×) and reaches 1 (6×). */
const RATIO_FROM = 1
const RATIO_TO = Math.log2(6)
/** Variance-stabilised excess z where scoring starts and reaches 1. */
const Z_FROM = 3
const Z_TO = 6

/** Max characters (code points, emoji shortcuts removed) of a message that counts as a greeting. */
const GREETING_MAX_CHARS = 12
/** Latin tokens match as whole words (no ASCII letter or digit right before or after). */
const word = (alternatives: string) => `(?<![a-z0-9])(?:${alternatives})(?![a-z0-9])`
/**
 * Greeting / farewell tokens. Three are narrowed so common reactions do not read as greetings:
 * 主播好 only when followed by the end, punctuation, a space, an emoji or a sentence particle (not
 * 主播好猛／主播好扯／主播好強), 嗨 not in 好嗨 or 嗨起來, 安安 not in 安安靜靜.
 */
const GREETING = new RegExp(
  `晚安|晚上好|午安|早安|安安(?!靜)|哈囉|(?<!好)嗨(?!起來)|大家好|主播好(?=$|[^\\p{L}\\p{N}]|[啊呀喔哦唷耶])|掰掰|拜拜|下播|辛苦了|報到|👋|:hand-pink-waving:|${word('hi|hello|bye|8{2,}')}`,
  'iu',
)
const REACTION = new RegExp(
  `笑死|笑爛|笑翻|哈{2,}|草|🤣|😂|[?？]{2,}|[!！]{2,}|好扯|太扯|靠北|救命|嚇死|太神|好猛|神操作|ㄏㄏ|${word('w{3,}|xd+|lol|lmao|kekw|nice|g{2,}|6{3,}')}`,
  'iu',
)
/** Custom emoji shortcuts such as :hand-pink-waving: (not counted in the greeting length). */
const EMOJI_SHORTCUT = /:[^:\s]+:/g

const COUNTED_RENDERERS = new Set([
  'liveChatTextMessageRenderer',
  'liveChatPaidMessageRenderer',
  'liveChatPaidStickerRenderer',
])

/**
 * Weight of one message (design.md step 3): 0 for a short greeting or farewell (contains a greeting
 * token and has at most 12 characters once emoji shortcuts are removed), 2 for a reaction, 1 otherwise.
 * `text` joins the text runs with standard emoji characters and custom emoji shortcuts.
 */
export function messageWeight(text: string): number {
  if (GREETING.test(text) && [...text.replace(EMOJI_SHORTCUT, '').trim()].length <= GREETING_MAX_CHARS) return 0
  return REACTION.test(text) ? 2 : 1
}

/**
 * Reads the counted chat messages of a yt-dlp live chat replay file (design.md steps 1–3), sorted by
 * time. Lines that do not parse (e.g. a truncated last line) are skipped. Rejects when the file
 * cannot be read.
 */
export async function readChatMessages(filePath: string, durationSec: number): Promise<ChatMessage[]> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  // A read error of the stream (missing file, directory…) rejects the iteration.
  const lines = createInterface({ input: stream, crlfDelay: Infinity })

  const seenIds = new Set<string>()
  const raw: ChatMessage[] = []
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      }
      catch {
        continue
      }
      collectLine(parsed, durationSec, seenIds, raw)
    }
  }
  finally {
    lines.close()
    stream.destroy()
  }

  // yt-dlp writes in time order; sort anyway (stable) so the per-author cooldown sees each author's first message.
  raw.sort((a, b) => a.offsetSec - b.offsetSec)
  const lastCounted = new Map<string, number>()
  return raw.filter((message) => {
    if (message.author === null) return true
    const last = lastCounted.get(message.author)
    if (last !== undefined && message.offsetSec - last < CHAT_AUTHOR_COOLDOWN_SEC) return false
    lastCounted.set(message.author, message.offsetSec)
    return true
  })
}

/** Adds the counted messages of one parsed line to `out` (offset range and id de-duplication applied). */
function collectLine(line: unknown, durationSec: number, seenIds: Set<string>, out: ChatMessage[]) {
  if (!isRecord(line)) return
  const replay = isRecord(line.replayChatItemAction) ? line.replayChatItemAction : null
  if (!replay || !Array.isArray(replay.actions)) return
  const offsetMs = parseOffsetMs(replay.videoOffsetTimeMsec) ?? parseOffsetMs(line.videoOffsetTimeMsec)
  if (offsetMs === null) return
  const offsetSec = offsetMs / 1000
  if (offsetSec < 0 || !(offsetSec <= durationSec)) return

  for (const action of replay.actions) {
    if (!isRecord(action) || !isRecord(action.addChatItemAction)) continue
    const item = action.addChatItemAction.item
    if (!isRecord(item)) continue
    for (const [kind, renderer] of Object.entries(item)) {
      if (!COUNTED_RENDERERS.has(kind) || !isRecord(renderer)) continue
      if (typeof renderer.id === 'string' && renderer.id !== '') {
        if (seenIds.has(renderer.id)) continue
        seenIds.add(renderer.id)
      }
      const author = typeof renderer.authorExternalChannelId === 'string' && renderer.authorExternalChannelId !== ''
        ? renderer.authorExternalChannelId
        : null
      out.push({ offsetSec, weight: messageWeight(messageText(renderer.message)), author })
    }
  }
}

/** videoOffsetTimeMsec is a decimal string ("172030"); null when absent or not a number. */
function parseOffsetMs(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const ms = Number(value)
  return Number.isFinite(ms) ? ms : null
}

/** Text runs joined with emoji: a standard emoji's emojiId is the character; a custom emoji gives its first shortcut. */
function messageText(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.runs)) return ''
  let text = ''
  for (const run of message.runs) {
    if (!isRecord(run)) continue
    if (typeof run.text === 'string') text += run.text
    else if (isRecord(run.emoji)) {
      const emoji = run.emoji
      if (emoji.isCustomEmoji === true) {
        const shortcut = Array.isArray(emoji.shortcuts) ? emoji.shortcuts[0] : undefined
        if (typeof shortcut === 'string') text += shortcut
      }
      else if (typeof emoji.emojiId === 'string') text += emoji.emojiId
    }
  }
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Per-second chat density score (design.md steps 4–6): r[s] = weights in [s + 5, s + 25), compared
 * with the ±150 s rolling median b[s] (at least 1) by both the ratio (2× → 6×) and the Poisson
 * z = 2(√(r + 3/8) − √(b + 3/8)) (3 → 6), taking the smaller. 0 when r < 3 or the window has fewer
 * than 3 distinct authors of weighted messages (each message without an author counts as its own).
 * Messages outside [0, durationSec] are ignored.
 */
export function chatDensity(messages: readonly ChatMessage[], durationSec: number): ChatDensity {
  const length = Number.isFinite(durationSec) && durationSec > 0 ? Math.ceil(durationSec) : 0
  const values = new Float32Array(length)
  const inRange = (m: ChatMessage) => m.weight > 0 && m.offsetSec >= 0 && m.offsetSec <= durationSec
  if (length === 0) return { values, counted: 0, perHour: 0 }

  // Group the counted messages by whole second (an offset equal to the duration may land in second `length`).
  const seconds = length + 1
  const weightAt = new Float64Array(seconds)
  const firstOf = new Int32Array(seconds + 1) // messages of second t: authors[firstOf[t] .. firstOf[t + 1])
  let counted = 0
  for (const m of messages) {
    if (!inRange(m)) continue
    const t = Math.floor(m.offsetSec)
    weightAt[t]! += m.weight
    firstOf[t + 1]!++
    counted++
  }
  for (let t = 0; t < seconds; t++) firstOf[t + 1]! += firstOf[t]!
  const authors: (string | null)[] = Array.from({ length: counted })
  const fill = firstOf.slice(0, seconds)
  for (const m of messages) if (inRange(m)) authors[fill[Math.floor(m.offsetSec)]!++] = m.author

  // r[s] = weights of the messages in the seconds [s + 5, s + 25).
  const lagEnd = CHAT_LAG_START_SEC + CHAT_WINDOW_SEC
  const prefix = new Float64Array(seconds + 1)
  for (let t = 0; t < seconds; t++) prefix[t + 1] = prefix[t]! + weightAt[t]!
  const r = new Float64Array(length)
  for (let s = 0; s < length; s++) r[s] = prefix[Math.min(seconds, s + lagEnd)]! - prefix[Math.min(seconds, s + CHAT_LAG_START_SEC)]!
  const baseline = rollingMedian(r, length, CHAT_BASELINE_HALF_WINDOW_SEC)

  // Distinct authors in the sliding window: messages per author, plus one per message without an author.
  const perAuthor = new Map<string, number>()
  let distinct = 0
  const enter = (author: string | null) => {
    const n = author === null ? 0 : perAuthor.get(author) ?? 0
    if (n === 0) distinct++
    if (author !== null) perAuthor.set(author, n + 1)
  }
  const leave = (author: string | null) => {
    const n = author === null ? 0 : perAuthor.get(author)! - 1
    if (n === 0) distinct--
    if (author !== null) perAuthor.set(author, n)
  }
  let entered = CHAT_LAG_START_SEC // next second to enter the window
  let left = CHAT_LAG_START_SEC // next second to leave it
  for (let s = 0; s < length; s++) {
    for (const to = Math.min(seconds, s + lagEnd); entered < to; entered++) {
      for (let i = firstOf[entered]!; i < firstOf[entered + 1]!; i++) enter(authors[i] ?? null)
    }
    for (const from = Math.min(entered, s + CHAT_LAG_START_SEC); left < from; left++) {
      for (let i = firstOf[left]!; i < firstOf[left + 1]!; i++) leave(authors[i] ?? null)
    }
    const rs = r[s]!
    if (rs < CHAT_MIN_COUNT || distinct < CHAT_MIN_AUTHORS) continue
    const b = Math.max(MIN_BASELINE, baseline[s]!)
    const ratioScore = (Math.log2(rs / b) - RATIO_FROM) / (RATIO_TO - RATIO_FROM)
    const z = 2 * (Math.sqrt(rs + 3 / 8) - Math.sqrt(b + 3 / 8))
    const zScore = (z - Z_FROM) / (Z_TO - Z_FROM)
    values[s] = Math.min(1, Math.max(0, Math.min(ratioScore, zScore)))
  }
  return { values, counted, perHour: counted / (durationSec / 3600) }
}
