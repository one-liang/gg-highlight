import { describe, expect, it } from 'vitest'
import { buildAss, buildSrt, escapeAssText, formatAssTime, formatSrtTime, subtitleStyleFor } from './ass'
import { SUBTITLE_FONT_NAME } from './types'
import type { SubtitleCanvas } from './types'

const vertical: SubtitleCanvas = { width: 1080, height: 1920, layout: 'blurred-background' }

function dialogues(ass: string): string[] {
  return ass.split('\n').filter(l => l.startsWith('Dialogue:'))
}

describe('subtitleStyleFor', () => {
  it('uses the fixed short-video style for both vertical layouts', () => {
    const expected = { fontSize: 72, outline: 5, marginH: 60, marginV: 440, maxUnitsPerLine: 13 }
    expect(subtitleStyleFor(vertical)).toEqual(expected)
    expect(subtitleStyleFor({ width: 1080, height: 1920, layout: 'center-crop' })).toEqual(expected)
  })

  it('scales with the frame for the original layout', () => {
    expect(subtitleStyleFor({ width: 1920, height: 1080, layout: 'original' }))
      .toEqual({ fontSize: 59, outline: 5, marginH: 96, marginV: 65, maxUnitsPerLine: 29 })
    expect(subtitleStyleFor({ width: 1280, height: 720, layout: 'original' }))
      .toEqual({ fontSize: 40, outline: 3, marginH: 64, marginV: 43, maxUnitsPerLine: 28 })
    // Portrait source kept as is.
    expect(subtitleStyleFor({ width: 720, height: 1280, layout: 'original' }))
      .toEqual({ fontSize: 40, outline: 3, marginH: 36, marginV: 77, maxUnitsPerLine: 16 })
  })

  it('keeps a minimum outline and at least one unit per line on tiny frames', () => {
    const style = subtitleStyleFor({ width: 160, height: 90, layout: 'original' })
    expect(style.outline).toBe(2)
    expect(style.maxUnitsPerLine).toBeGreaterThanOrEqual(1)
  })
})

describe('formatAssTime / formatSrtTime', () => {
  it('formats ASS times as H:MM:SS.cc', () => {
    expect(formatAssTime(0)).toBe('0:00:00.00')
    expect(formatAssTime(1.5)).toBe('0:00:01.50')
    expect(formatAssTime(59.999)).toBe('0:01:00.00')
    expect(formatAssTime(3661.25)).toBe('1:01:01.25')
    expect(formatAssTime(-1)).toBe('0:00:00.00')
  })

  it('formats SRT times as HH:MM:SS,mmm', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000')
    expect(formatSrtTime(2.2)).toBe('00:00:02,200')
    expect(formatSrtTime(3661.25)).toBe('01:01:01,250')
    expect(formatSrtTime(59.9996)).toBe('00:01:00,000')
  })
})

describe('escapeAssText', () => {
  it('neutralises override blocks and backslash escapes', () => {
    expect(escapeAssText('{\\b1}粗體{\\pos(1,1)}')).toBe('｛＼b1｝粗體｛＼pos(1,1)｝')
    expect(escapeAssText('換行\\N不行')).toBe('換行＼N不行')
    expect(escapeAssText('普通文字')).toBe('普通文字')
  })
})

describe('buildAss', () => {
  it('writes the script header and the Default style', () => {
    const ass = buildAss([], vertical)
    expect(ass).toContain('[Script Info]\n')
    expect(ass).toContain('ScriptType: v4.00+\n')
    expect(ass).toContain('PlayResX: 1080\nPlayResY: 1920\n')
    expect(ass).toContain('WrapStyle: 2\n')
    expect(ass).toContain('ScaledBorderAndShadow: yes\n')
    expect(ass).toContain('YCbCr Matrix: TV.709\n')
    expect(ass).toContain('[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n')
    expect(ass).toContain(`Style: Default,${SUBTITLE_FONT_NAME},72,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,1,2,60,60,440,1\n`)
    expect(ass).toContain('[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n')
    expect(dialogues(ass)).toEqual([])
    expect(ass.endsWith('\n')).toBe(true)
  })

  it('writes one Dialogue per cue', () => {
    const ass = buildAss([
      { start: 0, end: 1.5, text: '這個遊戲太厲害了' },
      { start: 1.5, end: 3.25, text: 'Good game!' },
    ], vertical)
    expect(dialogues(ass)).toEqual([
      'Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,這個遊戲太厲害了',
      'Dialogue: 0,0:00:01.50,0:00:03.25,Default,,0,0,0,,Good game!',
    ])
  })

  it('pre-wraps long text into at most two lines with \\N', () => {
    const ass = buildAss([{ start: 0, end: 2, text: '這個遊戲太厲害了 我們再來一局吧好不好' }], vertical)
    expect(dialogues(ass)).toEqual(['Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,這個遊戲太厲害了\\N我們再來一局吧好不好'])
    const long = buildAss([{ start: 0, end: 2, text: '一二三四五六七八九十'.repeat(5) }], vertical)
    expect(dialogues(long)[0]!.split('\\N')).toHaveLength(2)
  })

  it('wraps by the canvas width', () => {
    const text = 'Hello everyone, welcome back to the stream. Today we are going to play'
    const wide = buildAss([{ start: 0, end: 2, text }], { width: 1920, height: 1080, layout: 'original' })
    expect(dialogues(wide)[0]).toContain('\\N')
    const narrow = buildAss([{ start: 0, end: 2, text }], vertical)
    expect(dialogues(narrow)[0]!.split('\\N')).toHaveLength(2)
  })

  it('neutralises ASS override syntax in user text', () => {
    const ass = buildAss([{ start: 0, end: 1, text: '{\\fs200}大字\\N' }], vertical)
    expect(dialogues(ass)).toEqual(['Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,｛＼fs200｝大字＼N'])
  })

  it('uses a custom font name and keeps the Style line parseable', () => {
    expect(buildAss([], vertical, 'Noto Sans TC')).toContain('Style: Default,Noto Sans TC,72,')
    expect(buildAss([], vertical, 'Bad,Font')).toContain('Style: Default,Bad Font,72,')
  })

  it('skips cues that are empty or have no duration', () => {
    const ass = buildAss([
      { start: 1, end: 1, text: '零' },
      { start: 1, end: 1.004, text: '太短' },
      { start: 2, end: 3, text: '   ' },
      { start: 3, end: 4, text: '好' },
    ], vertical)
    expect(dialogues(ass)).toEqual(['Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,好'])
  })
})

describe('buildSrt', () => {
  it('numbers cues from 1 with HH:MM:SS,mmm times and a blank line between cues', () => {
    const srt = buildSrt([
      { start: 0, end: 1.5, text: '這個遊戲太厲害了' },
      { start: 61.25, end: 3725.004, text: 'Good game!' },
    ])
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,500\n這個遊戲太厲害了\n\n2\n00:01:01,250 --> 01:02:05,004\nGood game!\n')
  })

  it('keeps each cue on one line and skips empty text', () => {
    const srt = buildSrt([
      { start: 0, end: 1, text: '' },
      { start: 1, end: 2, text: '第一行\n第二行' },
    ])
    expect(srt).toBe('1\n00:00:01,000 --> 00:00:02,000\n第一行 第二行\n')
  })

  it('returns an empty string for no cues', () => {
    expect(buildSrt([])).toBe('')
  })
})
