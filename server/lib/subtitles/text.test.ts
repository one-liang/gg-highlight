import { describe, expect, it } from 'vitest'
import { cleanEnText, cleanZhText, dropTightSpaces, hasContent, isWide, textEm, textUnits, toTaiwanTraditional } from './text'

describe('toTaiwanTraditional', () => {
  it('converts Simplified Chinese to Taiwan Traditional characters', () => {
    expect(toTaiwanTraditional('这个游戏太厉害了')).toBe('這個遊戲太厲害了')
    expect(toTaiwanTraditional('我们打完这一局再说吧')).toBe('我們打完這一局再說吧')
  })

  it('uses Taiwan phrases (twp)', () => {
    expect(toTaiwanTraditional('软件')).toBe('軟體')
    expect(toTaiwanTraditional('鼠标')).toBe('滑鼠')
    expect(toTaiwanTraditional('视频')).toBe('影片')
    expect(toTaiwanTraditional('内存')).toBe('記憶體')
    expect(toTaiwanTraditional('服务器')).toBe('伺服器')
  })

  it('leaves Traditional text, latin text and empty input alone', () => {
    expect(toTaiwanTraditional('這個遊戲很好玩')).toBe('這個遊戲很好玩')
    expect(toTaiwanTraditional('Boss 好難打 GG')).toBe('Boss 好難打 GG')
    expect(toTaiwanTraditional('')).toBe('')
  })

  it('keeps the everyday 台 instead of OpenCC\'s formal 臺', () => {
    expect(toTaiwanTraditional('台灣')).toBe('台灣')
    expect(toTaiwanTraditional('台湾的台北')).toBe('台灣的台北')
    expect(toTaiwanTraditional('后台和舞台上的台词，电台和平台')).toBe('後台和舞台上的台詞，電台和平台')
    expect(toTaiwanTraditional('臺灣')).toBe('台灣')
    // other characters that simplify to 台 keep their own form
    expect(toTaiwanTraditional('台风')).toBe('颱風')
    expect(toTaiwanTraditional('柜台')).toBe('櫃檯')
  })

  it('is idempotent', () => {
    const once = toTaiwanTraditional('这个软件的视频质量很好，鼠标也很顺')
    expect(toTaiwanTraditional(once)).toBe(once)
  })
})

describe('textUnits', () => {
  it('counts CJK as 1 and everything else as 0.5', () => {
    expect(textUnits('')).toBe(0)
    expect(textUnits('abc')).toBe(1.5)
    expect(textUnits('你好')).toBe(2)
    expect(textUnits('你好 ab')).toBe(3.5)
    expect(textUnits('Hello, world!')).toBe(6.5)
  })

  it('counts kana, hangul, CJK punctuation and full-width forms as 1', () => {
    expect(textUnits('カタカナ')).toBe(4)
    expect(textUnits('ひらがな')).toBe(4)
    expect(textUnits('한국어')).toBe(3)
    expect(textUnits('，。「」、')).toBe(5)
    expect(textUnits('！？（）')).toBe(4)
    expect(textUnits('ＡＢ１')).toBe(3)
    expect(textUnits('\u3000')).toBe(1)
  })

  it('counts by code point, so astral ideographs are one unit', () => {
    expect(textUnits('𠀀')).toBe(1)
    expect(textUnits('😀')).toBe(0.5)
  })

  it('isWide matches textUnits', () => {
    expect(isWide('中')).toBe(true)
    expect(isWide('a')).toBe(false)
    expect(isWide(undefined)).toBe(false)
  })
})

describe('textEm', () => {
  it('measures CJK as 1 em and ASCII by the subtitle font\'s advance widths', () => {
    expect(textEm('')).toBe(0)
    expect(textEm('你好')).toBe(2)
    expect(textEm('一二三四五六七八九十一二三')).toBe(13)
    expect(textEm(' ')).toBe(0.227)
    expect(textEm('W')).toBe(0.915)
    expect(textEm('i')).toBe(0.304)
    expect(textEm('0123456789')).toBeCloseTo(5.9, 6)
    expect(textEm('Hello world')).toBeCloseTo(0.757 + 0.581 + 0.315 * 2 + 0.626 + 0.227 + 0.863 + 0.626 + 0.436 + 0.315 + 0.644, 6)
  })

  it('counts other characters (curly quotes, …, accents) as full width, like the CJK font draws most of them', () => {
    expect(textEm('“…”')).toBe(3)
    expect(textEm('é')).toBe(1)
    expect(textEm('𠀀')).toBe(1)
  })

  it('is wider than textUnits for latin capitals, narrower for spaces', () => {
    expect(textEm('WWWW')).toBeGreaterThan(textUnits('WWWW'))
    expect(textEm('    ')).toBeLessThan(textUnits('    '))
  })
})

describe('dropTightSpaces', () => {
  it('removes spaces between CJK characters only', () => {
    expect(dropTightSpaces('這個 遊戲  太 厲害')).toBe('這個遊戲太厲害')
    expect(dropTightSpaces('我用 iPhone 拍')).toBe('我用 iPhone 拍')
    expect(dropTightSpaces('好， 我們')).toBe('好，我們')
    expect(dropTightSpaces('hello world')).toBe('hello world')
  })
})

describe('cleanZhText', () => {
  it('drops Whisper spaces between CJK characters', () => {
    expect(cleanZhText(' 這個 遊戲 太 厲害 了')).toBe('這個遊戲太厲害了')
  })

  it('turns internal ，。、；： into one space and strips trailing punctuation', () => {
    expect(cleanZhText('好，我們走吧。')).toBe('好 我們走吧')
    expect(cleanZhText('蘋果、香蕉；橘子：好吃')).toBe('蘋果 香蕉 橘子 好吃')
    expect(cleanZhText('好, 我們走吧.')).toBe('好 我們走吧')
    expect(cleanZhText('等一下…')).toBe('等一下')
    expect(cleanZhText('好啦～')).toBe('好啦')
    expect(cleanZhText('，開頭')).toBe('開頭')
  })

  it('keeps question and exclamation marks and closing quotes', () => {
    expect(cleanZhText('真的嗎？')).toBe('真的嗎？')
    expect(cleanZhText('太扯了吧！')).toBe('太扯了吧！')
    expect(cleanZhText('什麼?!')).toBe('什麼?!')
    expect(cleanZhText('他說：「好」。')).toBe('他說 「好」')
  })

  it('keeps ASCII separators inside numbers and names', () => {
    expect(cleanZhText('版本 2.0。')).toBe('版本 2.0')
    expect(cleanZhText('總共 1,000 元')).toBe('總共 1,000 元')
    expect(cleanZhText('十點 10:30 開始')).toBe('十點 10:30 開始')
    expect(cleanZhText('用 Node.js 寫的')).toBe('用 Node.js 寫的')
  })

  it('keeps spaces around latin words and collapses whitespace', () => {
    expect(cleanZhText('我 用  iPhone   拍 的')).toBe('我用 iPhone 拍的')
    expect(cleanZhText('  ')).toBe('')
    expect(cleanZhText('。')).toBe('')
  })
})

describe('cleanEnText', () => {
  it('trims and collapses whitespace but keeps punctuation', () => {
    expect(cleanEnText('  Hello   everyone,\n welcome back.  ')).toBe('Hello everyone, welcome back.')
  })
})

describe('hasContent', () => {
  it('needs a letter or a digit', () => {
    expect(hasContent('。')).toBe(false)
    expect(hasContent('...')).toBe(false)
    expect(hasContent(' ')).toBe(false)
    expect(hasContent('好')).toBe(true)
    expect(hasContent('3')).toBe(true)
  })
})
