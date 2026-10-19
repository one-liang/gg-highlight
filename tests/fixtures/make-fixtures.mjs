// Generates small media fixtures for tests into tests/.tmp/fixtures.
// Speech comes from espeak-ng when installed; otherwise a tone stands in and ASR tests skip.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const FIXTURES_DIR = path.join(root, 'tests', '.tmp', 'fixtures')

const EN_TEXT = 'Hello everyone, welcome back to the stream. Today we are going to play a brand new game. Wow, that was an amazing shot!'
const ZH_TEXT = '大家好，歡迎回到直播。今天我們要玩一款全新的遊戲。哇，剛剛那一槍太厲害了！'

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr}`)
  return r
}

export function hasEspeak() {
  return spawnSync('espeak-ng', ['--version']).status === 0
}

function atomic(target, make) {
  if (fs.existsSync(target)) return
  const tmp = `${target}.${process.pid}.tmp${path.extname(target)}`
  make(tmp)
  fs.renameSync(tmp, target)
}

function speech(target, text, voice) {
  atomic(target, (tmp) => {
    if (hasEspeak()) {
      const raw = `${tmp}.raw.wav`
      run('espeak-ng', ['-v', voice, '-s', '150', '-w', raw, text])
      run('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-af', 'apad=pad_dur=1', '-ar', '16000', '-ac', '1', tmp])
      fs.rmSync(raw)
    } else {
      run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ar', '16000', '-ac', '1', tmp])
    }
  })
}

function durationOf(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  return Number.parseFloat(r.stdout.trim())
}

/** Two audio tracks: 0 = speech mixed with a quiet tone ("game audio"), 1 = speech only ("mic"). */
function twoTrackVideo(target, speechWav) {
  atomic(target, (tmp) => {
    const d = (durationOf(speechWav) + 1).toFixed(2)
    run('ffmpeg', ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${d}`,
      '-i', speechWav,
      '-f', 'lavfi', '-i', `sine=frequency=220:duration=${d}`,
      '-filter_complex', '[2:a]volume=0.15[tone];[1:a]apad[sp];[sp][tone]amix=inputs=2:duration=shortest:normalize=0[mix];[1:a]apad,atrim=0:' + d + '[mic]',
      '-map', '0:v', '-map', '[mix]', '-map', '[mic]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '60',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-t', d, tmp])
  })
}

export function makeFixtures() {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true })
  const enWav = path.join(FIXTURES_DIR, 'speech-en.wav')
  const zhWav = path.join(FIXTURES_DIR, 'speech-zh.wav')
  speech(enWav, EN_TEXT, 'en-us')
  speech(zhWav, ZH_TEXT, 'cmn')
  twoTrackVideo(path.join(FIXTURES_DIR, 'sample-en.mkv'), enWav)
  twoTrackVideo(path.join(FIXTURES_DIR, 'sample-zh.mkv'), zhWav)
  atomic(path.join(FIXTURES_DIR, 'sample-en.mp4'), (tmp) => {
    run('ffmpeg', ['-y', '-v', 'error', '-i', path.join(FIXTURES_DIR, 'sample-en.mkv'), '-map', '0:v', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', tmp])
  })
  atomic(path.join(FIXTURES_DIR, 'noaudio.mp4'), (tmp) => {
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', tmp])
  })
  atomic(path.join(FIXTURES_DIR, 'vertical.mp4'), (tmp) => {
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', tmp])
  })
  return {
    dir: FIXTURES_DIR,
    speechEn: enWav,
    speechZh: zhWav,
    sampleEnMkv: path.join(FIXTURES_DIR, 'sample-en.mkv'),
    sampleZhMkv: path.join(FIXTURES_DIR, 'sample-zh.mkv'),
    sampleEnMp4: path.join(FIXTURES_DIR, 'sample-en.mp4'),
    noAudioMp4: path.join(FIXTURES_DIR, 'noaudio.mp4'),
    verticalMp4: path.join(FIXTURES_DIR, 'vertical.mp4'),
    hasSpeech: hasEspeak(),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(makeFixtures(), null, 2))
}
