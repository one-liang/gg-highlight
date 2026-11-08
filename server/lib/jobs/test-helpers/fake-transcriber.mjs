// Fake gg-transcribe for job and API tests. Speaks the JSON-lines protocol and writes a small
// RawTranscript that matches the sample fixtures.
//
//   node fake-transcriber.mjs [--scenario=ok|slow|fail] transcribe --audio a.wav --language en --model m --device cpu --out t.json
//
// Environment:
//   GG_FAKE_FAIL_FILE    when this file exists, `transcribe` fails (lets API tests produce a failed Analysis)
//   GG_FAKE_PID_FILE     `slow` writes {"pid": ...} here
//   GG_FAKE_DELAY_MS     pause between progress events (default 20)
import fs from 'node:fs'

const argv = process.argv.slice(2)
const options = {}
while (argv[0]?.startsWith('--')) {
  const token = argv.shift().slice(2)
  const eq = token.indexOf('=')
  options[eq < 0 ? token : token.slice(0, eq)] = eq < 0 ? '' : token.slice(eq + 1)
}
const [command, ...rest] = argv
const args = {}
for (let i = 0; i < rest.length; i++) {
  const token = rest[i]
  if (!token.startsWith('--')) continue
  const eq = token.indexOf('=')
  if (eq > 0) args[token.slice(2, eq)] = token.slice(eq + 1)
  else args[token.slice(2)] = rest[++i]
}

const scenario = options.scenario || 'ok'
const delay = Number(process.env.GG_FAKE_DELAY_MS ?? 20)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`)

function words(start, end, text, sep) {
  const parts = sep ? text.split(sep).filter(Boolean) : [...text]
  const step = (end - start) / parts.length
  return parts.map((w, i) => ({
    start: Math.round((start + i * step) * 100) / 100,
    end: Math.round((start + (i + 1) * step) * 100) / 100,
    word: sep ? ` ${w}` : w,
    probability: 0.9,
  }))
}

const SEGMENTS = {
  en: [
    [0.3, 2.9, 'Hello everyone, welcome back to the stream.'],
    [3.1, 6.2, 'Today we are going to play a brand new game.'],
    [6.6, 9.6, 'Wow, that was an amazing shot!'],
  ],
  // Simplified Chinese on purpose: the server must convert it to Taiwan Traditional.
  zh: [
    [0.3, 3.0, '大家好，欢迎回到直播。'],
    [3.4, 8.0, '今天我们要玩一款全新的游戏，测试软件。'],
    [8.6, 12.0, '哇，刚刚那一枪太厉害了！'],
  ],
}

function transcript(language) {
  const isZh = language === 'zh'
  return {
    language,
    durationSec: isZh ? 16.8 : 9.8,
    model: args.model ?? 'fake',
    device: 'cpu',
    segments: SEGMENTS[isZh ? 'zh' : 'en'].map(([start, end, text]) => ({
      start,
      end,
      text: isZh ? text : ` ${text}`,
      words: isZh ? words(start, end, text) : words(start, end, text, ' '),
    })),
  }
}

async function transcribe() {
  const out = args.out
  fs.writeFileSync(`${out}.args.json`, JSON.stringify({ argv: process.argv.slice(2), audioExists: fs.existsSync(args.audio ?? '') }))
  emit({ type: 'log', message: `使用 CPU 執行語音辨識（${args.model}）` })
  if (process.env.GG_FAKE_FAIL_FILE && fs.existsSync(process.env.GG_FAKE_FAIL_FILE)) scenarioFail()
  if (scenario === 'fail') scenarioFail()
  if (scenario === 'slow') {
    if (process.env.GG_FAKE_PID_FILE) fs.writeFileSync(process.env.GG_FAKE_PID_FILE, JSON.stringify({ pid: process.pid }))
    emit({ type: 'progress', progress: 0.1 })
    setInterval(() => {}, 1000)
    return new Promise(() => {})
  }
  for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    emit({ type: 'progress', progress: p })
    await sleep(delay)
  }
  fs.writeFileSync(out, JSON.stringify(transcript(args.language)), 'utf8')
  emit({ type: 'progress', progress: 1 })
  emit({ type: 'done', output: out })
  return 0
}

function scenarioFail() {
  process.stderr.write('Traceback (most recent call last):\n  File "cli.py", line 10, in main\n    run()\nRuntimeError: model exploded\n')
  emit({ type: 'error', message: '語音辨識模型載入失敗（測試）' })
  process.exit(1)
}

async function check() {
  emit({ type: 'check', python: '3.12.0', fasterWhisper: '1.2.1', ctranslate2: '4.8.3', cudaDevices: 0 })
  return 0
}

const commands = { transcribe, check }
const run = commands[command]
if (!run) {
  process.stderr.write(`unknown command ${command}\n`)
  process.exitCode = 2
}
else {
  process.exitCode = await run()
}
