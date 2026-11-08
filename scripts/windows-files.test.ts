// Static checks for the Windows entry points, which cannot run in CI.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')))

/** Source with comments and string literals blanked out, so operators can be searched. */
function psCode(text: string): string {
  return text
    .replace(/<#[\s\S]*?#>/g, '')
    .replace(/'(?:[^']|'')*'/g, '\'\'')
    .replace(/"(?:[^"`]|`.|"")*"/g, '""')
    .replace(/#.*$/gm, '')
}

describe('setup.ps1', () => {
  const raw = read('scripts/setup.ps1')
  const text = raw.toString('utf8').replace(/^﻿/, '')

  it('is UTF-8 with BOM so Windows PowerShell 5.1 reads the Chinese text', () => {
    expect([...raw.subarray(0, 3)]).toEqual([0xEF, 0xBB, 0xBF])
  })

  it('uses no PowerShell 7-only operators', () => {
    const code = psCode(text)
    expect(code).not.toMatch(/\?\?|\?\.|&&|\|\|/)
    expect(code).not.toMatch(/ForEach-Object\s+-Parallel/i)
  })

  it('has balanced brackets outside strings and comments', () => {
    const stack: string[] = []
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
    for (const ch of psCode(text)) {
      if ('([{'.includes(ch)) stack.push(ch)
      else if (ch in pairs) expect(stack.pop()).toBe(pairs[ch])
    }
    expect(stack).toEqual([])
  })

  it('installs the documented tools and models', () => {
    for (const id of ['OpenJS.NodeJS.LTS', 'Gyan.FFmpeg', 'astral-sh.uv', 'Ollama.Ollama', 'DenoLand.Deno']) {
      expect(text).toContain(`'${id}'`)
    }
    expect(text).toMatch(/npm install -g pnpm@10/)
    expect(text).toMatch(/uv sync --project transcriber/)
    expect(text).toMatch(/gg-transcribe download --model \$model\.Id/)
    expect(text).toContain('SoybeanMilk/faster-whisper-Breeze-ASR-25')
    expect(text).toContain('deepdml/faster-whisper-large-v3-turbo-ct2')
    expect(text).toMatch(/\[switch\]\$SkipOptional/)
    expect(text).toMatch(/\[switch\]\$SkipModels/)
  })
})

describe.each(['start.bat', 'setup.bat'])('%s', (file) => {
  const raw = read(file)
  const text = raw.toString('utf8')

  it('has CRLF line endings and no BOM (cmd.exe would choke on either)', () => {
    expect(raw[0]).not.toBe(0xEF)
    expect(text.startsWith('@echo off\r\n')).toBe(true)
    expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/)
  })

  it('switches the console to UTF-8 and runs from its own folder', () => {
    expect(text).toContain('chcp 65001 >nul')
    expect(text).toContain('cd /d "%~dp0"')
  })
})

describe('bat entry points', () => {
  it('start.bat checks for node and passes its arguments on', () => {
    const text = read('start.bat').toString('utf8')
    expect(text).toMatch(/where node/)
    expect(text).toContain('setup.bat')
    expect(text).toContain('node scripts\\start.mjs %*')
    expect(text).toMatch(/pause/)
  })

  it('setup.bat runs setup.ps1 with a bypassed execution policy, then pauses', () => {
    const text = read('setup.bat').toString('utf8')
    expect(text).toContain('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\setup.ps1" %*')
    expect(text).toMatch(/pause/)
  })
})
