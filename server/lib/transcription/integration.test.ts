// Runs the real Python CLI through uv with the tiny Whisper model on CPU.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { fixtures } from '../../../tests/fixtures'
import { checkTranscriber, runTranscriber } from './index'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const COMMAND = ['uv', 'run', '--project', path.join(ROOT, 'transcriber'), 'gg-transcribe']
const hasUv = spawnSync('uv', ['--version'], { windowsHide: true }).status === 0

describe.skipIf(!hasUv)('gg-transcribe via uv (real model)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-transcribe-'))
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('check reports the installed versions', async () => {
    const check = await checkTranscriber(COMMAND)
    expect(check.python).toMatch(/^3\.12\./)
    expect(check.fasterWhisper).toMatch(/^\d+\.\d+/)
    expect(check.ctranslate2).toMatch(/^4\./)
    expect(check.cudaDevices).toBeGreaterThanOrEqual(0)
  }, 600_000)

  it('transcribes speech-en.wav with Systran/faster-whisper-tiny on CPU', async () => {
    const fx = fixtures()
    const outPath = path.join(tmp, 'videos', 'v1', 'transcript.raw.json')
    const progress: number[] = []
    const logs: string[] = []
    const raw = await runTranscriber(COMMAND, {
      audioPath: fx.speechEn,
      language: 'en',
      outPath,
      model: 'Systran/faster-whisper-tiny',
      device: 'cpu',
    }, { onProgress: p => progress.push(p), onLog: m => logs.push(m) })

    expect(raw.device).toBe('cpu')
    expect(raw.model).toBe('Systran/faster-whisper-tiny')
    expect(raw.language).toBe('en')
    expect(raw.durationSec).toBeGreaterThan(5)
    expect(fs.existsSync(outPath)).toBe(true)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)).toBe(1)
    expect([...progress].sort((a, b) => a - b)).toEqual(progress)

    if (fx.hasSpeech) {
      const text = raw.segments.flatMap(s => s.words.map(w => w.word)).join(' ').toLowerCase()
      expect(text).toContain('welcome')
      expect(text).toContain('stream')
    }
  }, 600_000)

  it('turns a CLI error into a readable rejection', async () => {
    await expect(runTranscriber(COMMAND, {
      audioPath: path.join(tmp, '不存在.wav'),
      language: 'zh',
      outPath: path.join(tmp, 'x.json'),
      model: 'Systran/faster-whisper-tiny',
      device: 'cpu',
    })).rejects.toThrow(`語音辨識失敗：找不到音訊檔：${path.join(tmp, '不存在.wav')}`)
  }, 600_000)
})
