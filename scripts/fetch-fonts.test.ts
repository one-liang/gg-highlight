import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  copyFont,
  downloadFont,
  fetchFonts,
  findInstalledFont,
  findSystemFont,
  FONT_FILE,
  fontKind,
  fontRank,
  inspectFontFile,
  main,
  manualInstructions,
  MIN_FONT_BYTES,
  resolveFontsDir,
  systemFontDirs,
} from './fetch-fonts.mjs'

const SYSTEM_TTC = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fetch-fonts.mjs')

function fakeFont(magic: string | Buffer, size = MIN_FONT_BYTES + 1024): Buffer {
  const buf = Buffer.alloc(size)
  const head = typeof magic === 'string' ? Buffer.from(magic, 'latin1') : magic
  head.copy(buf, 0)
  return buf
}

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gg-fonts-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('fontKind', () => {
  it('recognises OpenType, TrueType and collections', () => {
    expect(fontKind(Buffer.from('OTTO\0\0'))).toBe('otf')
    expect(fontKind(Buffer.from('ttcf\0\0'))).toBe('ttc')
    expect(fontKind(Buffer.from([0, 1, 0, 0, 0]))).toBe('ttf')
    expect(fontKind(Buffer.from('true'))).toBe('ttf')
  })
  it('rejects anything else', () => {
    expect(fontKind(Buffer.from('<!DOCTYPE html>'))).toBeNull()
    expect(fontKind(Buffer.from('OTT'))).toBeNull()
    expect(fontKind(Buffer.alloc(0))).toBeNull()
    expect(fontKind(null)).toBeNull()
  })
})

describe('inspectFontFile', () => {
  it('accepts a big file with font magic', async () => {
    const file = path.join(tmp, 'a.otf')
    await fs.writeFile(file, fakeFont('OTTO'))
    expect(await inspectFontFile(file)).toMatchObject({ ok: true, kind: 'otf' })
  })
  it('rejects files of 1 MB or less', async () => {
    const file = path.join(tmp, 'a.otf')
    await fs.writeFile(file, fakeFont('OTTO', MIN_FONT_BYTES))
    const r = await inspectFontFile(file)
    expect(r.ok).toBe(false)
    expect(r).toHaveProperty('reason', expect.stringMatching(/太小/))
  })
  it('rejects a big HTML error page', async () => {
    const file = path.join(tmp, 'a.otf')
    await fs.writeFile(file, fakeFont('<htm'))
    expect(await inspectFontFile(file)).toMatchObject({ ok: false, reason: expect.stringMatching(/OpenType/) })
  })
  it('limits the accepted formats', async () => {
    const file = path.join(tmp, 'a.ttc')
    await fs.writeFile(file, fakeFont('ttcf'))
    expect((await inspectFontFile(file, ['otf'])).ok).toBe(false)
    expect((await inspectFontFile(file, ['otf', 'ttc'])).ok).toBe(true)
  })
  it('handles missing files and folders', async () => {
    expect(await inspectFontFile(path.join(tmp, 'nope.otf'))).toMatchObject({ ok: false, reason: '找不到檔案' })
    expect((await inspectFontFile(tmp)).ok).toBe(false)
  })
})

describe('resolveFontsDir', () => {
  it('defaults to <root>/fonts and honours GG_FONTS_DIR', () => {
    const root = path.resolve('/srv/gg')
    expect(resolveFontsDir({}, root)).toBe(path.join(root, 'fonts'))
    expect(resolveFontsDir({ GG_FONTS_DIR: 'my-fonts' }, root)).toBe(path.join(root, 'my-fonts'))
    const abs = path.resolve('/opt/fonts')
    expect(resolveFontsDir({ GG_FONTS_DIR: abs }, root)).toBe(abs)
  })
})

describe('fontRank', () => {
  it('only accepts files providing the Noto Sans CJK TC family', () => {
    expect(fontRank('NotoSansCJKtc-Bold.otf')).not.toBeNull()
    expect(fontRank('NotoSansCJK-Bold.ttc')).not.toBeNull()
    expect(fontRank('NotoSansCJK.ttc')).not.toBeNull()
    expect(fontRank('notosanscjk-regular.TTC')).not.toBeNull()
    expect(fontRank('NotoSansCJKsc-Bold.otf')).toBeNull()
    expect(fontRank('NotoSansCJKjp-Bold.otf')).toBeNull()
    expect(fontRank('NotoSerifCJK-Bold.ttc')).toBeNull()
    expect(fontRank('NotoSansTC-Bold.otf')).toBeNull()
    expect(fontRank('NotoSansCJKtc-Bold.otf.part')).toBeNull()
  })
  it('prefers bold, then the TC-only file', () => {
    const names = ['NotoSansCJK-Regular.ttc', 'NotoSansCJK-Bold.ttc', 'NotoSansCJKtc-Bold.otf', 'NotoSansCJK.ttc', 'NotoSansCJKtc-Light.otf']
    const sorted = [...names].sort((a, b) => fontRank(a)! - fontRank(b)!)
    expect(sorted).toEqual(['NotoSansCJKtc-Bold.otf', 'NotoSansCJK-Bold.ttc', 'NotoSansCJK.ttc', 'NotoSansCJK-Regular.ttc', 'NotoSansCJKtc-Light.otf'])
  })
})

describe('systemFontDirs', () => {
  it('lists the Linux Noto folders', () => {
    const dirs = systemFontDirs('linux', {}, '/home/me')
    expect(dirs[0]).toBe('/usr/share/fonts/opentype/noto')
    expect(dirs).toContain('/home/me/.local/share/fonts')
  })
  it('lists the Windows system and per-user font folders with backslashes', () => {
    const dirs = systemFontDirs('win32', { WINDIR: 'D:\\Windows', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'C:\\Users\\me')
    expect(dirs).toEqual(['D:\\Windows\\Fonts', 'C:\\Users\\me\\AppData\\Local\\Microsoft\\Windows\\Fonts'])
    expect(systemFontDirs('win32', {}, 'C:\\Users\\me')).toEqual(['C:\\Windows\\Fonts'])
  })
  it('lists the macOS font folders', () => {
    const dirs = systemFontDirs('darwin', {}, '/Users/me')
    expect(dirs).toEqual(expect.arrayContaining(['/Users/me/Library/Fonts', '/Library/Fonts', '/System/Library/Fonts']))
  })
})

describe('findSystemFont / findInstalledFont', () => {
  it('picks the best valid Noto Sans CJK file across folders', async () => {
    const a = path.join(tmp, 'a')
    const b = path.join(tmp, 'b')
    await fs.mkdir(a)
    await fs.mkdir(b)
    await fs.writeFile(path.join(a, 'NotoSansCJK-Regular.ttc'), fakeFont('ttcf'))
    await fs.writeFile(path.join(a, 'NotoSerifCJK-Bold.ttc'), fakeFont('ttcf'))
    await fs.writeFile(path.join(a, 'NotoSansCJKtc-Bold.otf'), fakeFont('OTTO', 100)) // truncated: skipped
    await fs.writeFile(path.join(b, 'NotoSansCJK-Bold.ttc'), fakeFont('ttcf'))
    expect(await findSystemFont({ dirs: [a, b, path.join(tmp, 'missing')] })).toBe(path.join(b, 'NotoSansCJK-Bold.ttc'))
    expect(await findInstalledFont(a)).toBe(path.join(a, 'NotoSansCJK-Regular.ttc'))
  })

  it('returns null when nothing qualifies', async () => {
    await fs.writeFile(path.join(tmp, 'Arial.ttf'), fakeFont(Buffer.from([0, 1, 0, 0])))
    expect(await findSystemFont({ dirs: [tmp] })).toBeNull()
    expect(await findInstalledFont(path.join(tmp, 'missing'))).toBeNull()
  })

  it.skipIf(!existsSync(SYSTEM_TTC))('finds the Noto Sans CJK installed on this Linux box', async () => {
    expect(await findSystemFont({ platform: 'linux', env: {}, home: tmp })).toBe(SYSTEM_TTC)
  })
})

describe('downloadFont', () => {
  let server: http.Server
  let base: string
  let body: Buffer = fakeFont('OTTO')

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/font.otf' })
        res.end()
      }
      else if (req.url === '/font.otf') {
        res.writeHead(200, { 'Content-Length': body.length })
        res.end(body)
      }
      else if (req.url === '/stall') {
        res.writeHead(200, { 'Content-Length': body.length })
        res.write(body.subarray(0, 10))
      }
      else {
        res.writeHead(403)
        res.end('blocked')
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })

  it('follows redirects, validates and renames the .part file', async () => {
    body = fakeFont('OTTO')
    const dest = path.join(tmp, FONT_FILE)
    const progress: number[] = []
    const r = await downloadFont({ url: `${base}/redirect`, dest, onProgress: (n: number) => progress.push(n) })
    expect(r.file).toBe(dest)
    expect((await fs.readFile(dest)).equals(body)).toBe(true)
    expect(existsSync(`${dest}.part`)).toBe(false)
    expect(progress.at(-1)).toBe(body.length)
  })

  it('rejects a response that is not an OpenType font', async () => {
    body = fakeFont('ttcf')
    const dest = path.join(tmp, FONT_FILE)
    await expect(downloadFont({ url: `${base}/font.otf`, dest })).rejects.toThrow(/不是完整的字型/)
    expect(await fs.readdir(tmp)).toEqual([])
  })

  it('fails on HTTP errors without leaving files', async () => {
    const dest = path.join(tmp, FONT_FILE)
    await expect(downloadFont({ url: `${base}/blocked`, dest })).rejects.toThrow(/HTTP 403/)
    expect(await fs.readdir(tmp)).toEqual([])
  })

  it('gives up when the server stops sending data', async () => {
    const dest = path.join(tmp, FONT_FILE)
    await expect(downloadFont({ url: `${base}/stall`, dest, idleTimeoutMs: 300 })).rejects.toThrow(/逾時/)
    expect(await fs.readdir(tmp)).toEqual([])
  })
})

describe('copyFont', () => {
  it('copies into the fonts folder keeping the name', async () => {
    const src = path.join(tmp, 'NotoSansCJK-Bold.ttc')
    await fs.writeFile(src, fakeFont('ttcf'))
    const fontsDir = path.join(tmp, 'fonts')
    await fs.mkdir(fontsDir)
    expect(await copyFont(src, fontsDir)).toBe(path.join(fontsDir, 'NotoSansCJK-Bold.ttc'))
    expect(await fs.readdir(fontsDir)).toEqual(['NotoSansCJK-Bold.ttc'])
  })
})

describe('fetchFonts', () => {
  const failingFetch = async () => {
    throw new Error('403 Forbidden')
  }

  it('skips everything when a valid font is already there', async () => {
    const fontsDir = path.join(tmp, 'fonts')
    await fs.mkdir(fontsDir)
    await fs.writeFile(path.join(fontsDir, FONT_FILE), fakeFont('OTTO'))
    const r = await fetchFonts({ fontsDir, fetchImpl: failingFetch, systemDirs: [] })
    expect(r).toEqual({ status: 'present', file: path.join(fontsDir, FONT_FILE), errors: [] })
  })

  it('downloads when missing', async () => {
    const fontsDir = path.join(tmp, 'fonts')
    const body = fakeFont('OTTO')
    const fetchImpl = async () => new Response(body, { headers: { 'content-length': String(body.length) } })
    const r = await fetchFonts({ fontsDir, fetchImpl, systemDirs: [] })
    expect(r.status).toBe('downloaded')
    expect(await fs.readdir(fontsDir)).toEqual([FONT_FILE])
  })

  it('replaces a truncated font left by an earlier run', async () => {
    const fontsDir = path.join(tmp, 'fonts')
    await fs.mkdir(fontsDir)
    await fs.writeFile(path.join(fontsDir, FONT_FILE), 'OTTO')
    const body = fakeFont('OTTO')
    const r = await fetchFonts({ fontsDir, fetchImpl: async () => new Response(body), systemDirs: [] })
    expect(r.status).toBe('downloaded')
    expect((await fs.stat(path.join(fontsDir, FONT_FILE))).size).toBe(body.length)
  })

  it('falls back to a system font when the download fails', async () => {
    const fontsDir = path.join(tmp, 'fonts')
    const sys = path.join(tmp, 'sys')
    await fs.mkdir(sys)
    await fs.writeFile(path.join(sys, 'NotoSansCJK-Bold.ttc'), fakeFont('ttcf'))
    const logs: string[] = []
    const r = await fetchFonts({ fontsDir, fetchImpl: failingFetch, systemDirs: [sys], log: (m: string) => logs.push(m) })
    expect(r.status).toBe('copied')
    expect(r.file).toBe(path.join(fontsDir, 'NotoSansCJK-Bold.ttc'))
    expect(r.errors[0]).toMatch(/403/)
    expect(logs.join('\n')).toMatch(/改用系統已安裝的字型/)
  })

  it('reports missing when nothing works', async () => {
    const fontsDir = path.join(tmp, 'fonts')
    const r = await fetchFonts({ fontsDir, fetchImpl: failingFetch, systemDirs: [path.join(tmp, 'none')] })
    expect(r.status).toBe('missing')
    expect(r.errors).toHaveLength(1)
    expect(manualInstructions(fontsDir)).toContain(fontsDir)
    expect(manualInstructions(fontsDir)).toContain(FONT_FILE)
  })

  it('can skip the network', async () => {
    const fontsDir = path.join(tmp, 'fonts')
    let called = false
    const r = await fetchFonts({ fontsDir, download: false, fetchImpl: async () => { called = true; throw new Error('x') }, systemDirs: [] })
    expect(called).toBe(false)
    expect(r.status).toBe('missing')
  })
})

describe('CLI', () => {
  it.skipIf(!existsSync(SYSTEM_TTC))('copies the system font into GG_FONTS_DIR with --no-download', () => {
    const fontsDir = path.join(tmp, 'fonts dir')
    const r = spawnSync(process.execPath, [script, '--no-download'], {
      env: { ...process.env, GG_FONTS_DIR: fontsDir },
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/已從系統字型複製/)
    expect(existsSync(path.join(fontsDir, 'NotoSansCJK-Bold.ttc'))).toBe(true)

    const again = spawnSync(process.execPath, [script, '--no-download'], {
      env: { ...process.env, GG_FONTS_DIR: fontsDir },
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(again.status).toBe(0)
    expect(again.stdout).toMatch(/字幕字型已就緒/)
  })

  it('main exits 1 with Chinese instructions when no font can be found', async () => {
    const fontsDir = path.join(tmp, 'fonts')
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((msg: string) => { errors.push(msg) })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const code = await main([], { fontsDir, fetchImpl: async () => { throw new Error('403') }, systemDirs: [] })
      expect(code).toBe(1)
      expect(errors.join('\n')).toMatch(/請手動下載/)
      expect(errors.join('\n')).toContain(fontsDir)
      // the download error is logged once, not repeated with the instructions
      expect(errors.join('\n')).not.toMatch(/下載失敗/)
    }
    finally {
      spy.mockRestore()
      vi.restoreAllMocks()
    }
  })

  it('main honours GG_FONTS_DIR from the given env', async () => {
    const fontsDir = path.join(tmp, 'env-fonts')
    await fs.mkdir(fontsDir)
    await fs.writeFile(path.join(fontsDir, FONT_FILE), fakeFont('OTTO'))
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(msg) })
    try {
      expect(await main([], { env: { GG_FONTS_DIR: fontsDir }, systemDirs: [] })).toBe(0)
      expect(logs.join('\n')).toMatch(/字幕字型已就緒/)
    }
    finally {
      vi.restoreAllMocks()
    }
  })
})
