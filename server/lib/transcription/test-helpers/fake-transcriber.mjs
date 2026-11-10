// Fake gg-transcribe for tests: speaks the JSON-lines protocol, with scripted misbehaviour.
// Usage: node fake-transcriber.mjs [--scenario=<name>] [--pid-file=<path>] <transcribe|check|download> [args...]
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const options = {}
while (argv[0]?.startsWith('--')) {
  const token = argv.shift().slice(2)
  const eq = token.indexOf('=')
  options[eq < 0 ? token : token.slice(0, eq)] = eq < 0 ? '' : token.slice(eq + 1)
}
const scenario = options.scenario || 'ok'
const [command, ...rest] = argv
const args = {}
for (let i = 0; i < rest.length; i++) {
  const token = rest[i]
  if (!token.startsWith('--')) continue
  const eq = token.indexOf('=')
  if (eq > 0) args[token.slice(2, eq)] = token.slice(eq + 1)
  else args[token.slice(2)] = rest[++i]
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const line = event => `${JSON.stringify(event)}\n`
/** Separate writes with a pause so the parent receives them as separate chunks. */
async function chunks(...parts) {
  for (const part of parts) {
    process.stdout.write(part)
    await sleep(15)
  }
}

const transcript = {
  language: 'en',
  durationSec: 9.8,
  model: args.model ?? 'fake',
  device: 'cpu',
  segments: [
    {
      start: 0,
      end: 2.9,
      text: 'Hello everyone, welcome back to the stream.',
      words: [
        { start: 0, end: 0.4, word: ' Hello', probability: 0.5 },
        { start: 1.36, end: 1.72, word: ' welcome', probability: 0.93 },
        { start: 2.5, end: 2.9, word: ' 直播', probability: 0.9 },
      ],
    },
  ],
}

async function transcribe() {
  const out = args.out
  if (scenario !== 'slow') {
    fs.writeFileSync(`${out}.args.json`, JSON.stringify({
      argv: process.argv.slice(2),
      env: { PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? null, PYTHONUTF8: process.env.PYTHONUTF8 ?? null },
    }))
  }
  switch (scenario) {
    case 'ok': {
      // A log line cut in the middle of a 3-byte UTF-8 character, with a \r\n ending.
      const log = Buffer.from(line({ type: 'log', message: '載入模型中…' }).replace('\n', '\r\n'))
      const cut = log.indexOf(Buffer.from('模')) + 1
      const p1 = line({ type: 'progress', progress: 0.25 })
      await chunks(
        'Loading something...\n',
        'not json at all {\n',
        line({ type: 'unknown', value: 1 }),
        '{"type":"progress","progress":"0.1"}\n',
        log.subarray(0, cut),
        log.subarray(cut),
        p1.slice(0, 10),
        p1.slice(10) + line({ type: 'progress', progress: 0.5 }),
        `noise before json ${line({ type: 'progress', progress: 0.75 })}`,
        `${JSON.stringify({ type: 'progress', progress: 1.7 })}\r`,
        '\n',
      )
      process.stderr.write('some diagnostics\r\n')
      fs.writeFileSync(out, JSON.stringify(transcript))
      await chunks(line({ type: 'done', output: out }))
      return 0
    }
    case 'no-trailing-newline':
      fs.writeFileSync(out, JSON.stringify(transcript))
      await chunks(line({ type: 'log', message: 'a' }), JSON.stringify({ type: 'progress', progress: 0.5 }))
      return 0
    case 'error':
      process.stderr.write('Traceback (most recent call last):\n  RuntimeError: boom\n')
      await chunks(
        line({ type: 'log', message: 'starting' }),
        line({ type: 'error', message: 'first problem' }),
        line({ type: 'error', message: '找不到音訊檔：x.wav' }),
      )
      return 1
    case 'crash':
      process.stderr.write('Loading:  10%|#   |\rLoading:  50%|#####|\r\n')
      process.stderr.write('Traceback (most recent call last):\n  File "cli.py", line 1\nRuntimeError: CUDA failed\n')
      await chunks(line({ type: 'progress', progress: 0.3 }))
      return 3
    case 'silent-crash':
      return 4
    case 'no-output':
      await chunks(line({ type: 'done', output: out }))
      return 0
    case 'bad-output':
      fs.writeFileSync(out, JSON.stringify({ language: 'en', durationSec: 1, model: 'm', device: 'cpu', segments: 'nope' }))
      return 0
    case 'invalid-json-output':
      fs.writeFileSync(out, '{"language": "en", ')
      return 0
    case 'kill-self':
      process.kill(process.pid, 'SIGKILL')
      await sleep(1000)
      return 0
    case 'slow': {
      // Like `uv run`: the real work happens in a grandchild that shares our stdout/stderr.
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
      fs.writeFileSync(options['pid-file'], JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }))
      await chunks(line({ type: 'progress', progress: 0.1 }))
      setInterval(() => {}, 1000)
      return new Promise(() => {})
    }
    default:
      throw new Error(`unknown scenario ${scenario}`)
  }
}

async function check() {
  if (scenario === 'error') {
    await chunks(line({ type: 'error', message: 'No module named faster_whisper' }))
    return 1
  }
  if (scenario === 'no-check') return 0
  await chunks('warming up\n', line({ type: 'check', python: '3.12.3', fasterWhisper: '1.2.1', ctranslate2: '4.8.3', cudaDevices: 1 }))
  return 0
}

async function download() {
  if (scenario === 'error') {
    await chunks(line({ type: 'error', message: '無法下載語音辨識模型 x/y，請檢查網路連線' }))
    return 1
  }
  await chunks(
    line({ type: 'log', message: `正在下載語音辨識模型 ${args.model}…` }),
    line({ type: 'progress', progress: 0.5 }),
    line({ type: 'progress', progress: 1 }),
    line({ type: 'done', output: `/cache/${args.model}` }),
  )
  return 0
}

const commands = { transcribe, check, download }
const run = commands[command]
if (!run) {
  process.stderr.write(`unknown command ${command}\n`)
  process.exitCode = 2
}
else {
  process.exitCode = await run()
}
