import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { escapeFilterPath, escapeFilterValue } from './escape'
import { CJK_FONT, installFont, makeTmpDir, minimalAss, validDirName } from './test-utils'

describe('escapeFilterPath (strings)', () => {
  it('escapes a Windows drive-letter path', () => {
    // C:\Users\me\a.ass → C:/Users/me/a.ass → level 1 C\:/… → level 2 C\\:/…
    expect(escapeFilterPath('C:\\Users\\me\\a.ass')).toBe('C\\\\:/Users/me/a.ass')
  })

  it('escapes quotes, brackets, commas and semicolons at the right level', () => {
    expect(escapeFilterPath('C:\\Users\\me\\My Videos\\it\'s [1],x;y.ass'))
      .toBe('C\\\\:/Users/me/My Videos/it\\\\\\\'s \\[1\\]\\,x\\;y.ass')
  })

  it('leaves CJK, spaces inside, = and % alone', () => {
    expect(escapeFilterPath('/影片/精華 #1/字幕=final%d.ass')).toBe('/影片/精華 #1/字幕=final%d.ass')
  })

  it('escapes leading and trailing whitespace so it is not trimmed', () => {
    expect(escapeFilterPath('/data/fonts ')).toBe('/data/fonts\\\\\\ ')
    expect(escapeFilterPath(' x')).toBe('\\\\ x')
  })

  it('turns UNC backslashes into forward slashes', () => {
    expect(escapeFilterPath('\\\\nas\\share\\a.ass')).toBe('//nas/share/a.ass')
  })

  it('escapeFilterValue keeps backslashes (for non-path values)', () => {
    expect(escapeFilterValue('a\\b')).toBe('a\\\\\\\\b')
  })
})

/** Asks ffmpeg's own graph parser what it made of the values (logged at debug level). */
function parsedByFfmpeg(filename: string, fontsdir: string): { filename: string | undefined, fontsdir: string | undefined } {
  const graph = `[0:v]subtitles=filename=${escapeFilterPath(filename)}:fontsdir=${escapeFilterPath(fontsdir)}[v]`
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'debug', '-f', 'lavfi', '-i', 'color=s=64x64:d=0.04',
    '-filter_complex', graph, '-map', '[v]', '-f', 'null', '-'], { encoding: 'utf8' })
  const pick = (key: string) => new RegExp(`Setting '${key}' to value '(.*)'$`, 'm').exec(r.stderr)?.[1]
  return { filename: pick('filename'), fontsdir: pick('fontsdir') }
}

describe('escapeFilterPath round-trips through ffmpeg\'s filtergraph parser', () => {
  const values = [
    'C:\\Users\\me\\a.ass',
    'C:\\Users\\me\\My Videos\\it\'s [1],x;y.ass',
    'D:\\錄影\\精華 #1\\字幕=final.ass',
    '/tmp/a b/it\'s/x,y;z/[br]/c:d/中文/s.ass',
    '/fonts dir ',
    ' /leading space',
    '/tab\tinside/and trailing\t',
    '/\'quoted\'/\'\'/end\'',
    '/x/key=value:other=1/::::',
    '/x/[in][out];split,null;%{pts}',
    '/x/a\\b',
  ]
  for (const value of values) {
    it(JSON.stringify(value), () => {
      const expected = value.replace(/\\/g, '/')
      expect(parsedByFfmpeg(value, value)).toEqual({ filename: expected, fontsdir: expected })
    })
  }
})

describe.skipIf(!CJK_FONT)('subtitles filter really opens ASS + fontsdir in tricky directories', () => {
  let root: string
  beforeAll(async () => {
    root = await makeTmpDir('gg-escape-')
  })

  const dirs = [
    'a b',
    'it\'s',
    'x,y;z',
    '[br]',
    'c:d',
    '中文',
    'trail ',
    'all [it\'s] a,b;c:d 中文 =%',
    path.join('a b', 'it\'s', 'x,y;z', '[br]', 'c:d', '中文'),
  ].filter(validDirName)
  for (const name of dirs) {
    it(JSON.stringify(name), async () => {
      const dir = path.join(root, name)
      // A fonts folder whose own name ends with a space is the case trimming would break.
      const fontsDir = path.join(dir, name === 'trail ' ? 'fonts ' : 'fonts')
      await fs.mkdir(fontsDir, { recursive: true })
      const fontFile = await installFont(fontsDir)
      const assPath = path.join(dir, 'sub [1].ass')
      await fs.writeFile(assPath, minimalAss('字幕 Test', { width: 320, height: 240 }, 48))

      const graph = `[0:v]subtitles=filename=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(fontsDir)}[v]`
      const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'info',
        '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.1',
        '-filter_complex', graph, '-map', '[v]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
      const stderr = r.stderr.toString()
      expect(r.status, stderr).toBe(0)
      // libass logs every font it loads from fontsdir, with the full path.
      const slashes = (p: string) => p.replace(/\\/g, '/')
      const loaded = [...stderr.matchAll(/Loading font file '(.*)'$/gm)].map(m => slashes(m[1]!))
      expect(loaded).toContain(`${slashes(fontsDir)}/${path.basename(fontFile)}`)
      // White text was drawn on the black frame.
      const frame = r.stdout as Buffer
      expect(frame.length).toBe(320 * 240)
      expect(frame.filter(p => p > 200).length).toBeGreaterThan(100)
    })
  }
})
