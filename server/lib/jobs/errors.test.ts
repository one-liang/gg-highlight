import { describe, expect, it } from 'vitest'
import { readableError, stripStackTrace } from './errors'

describe('stripStackTrace', () => {
  it('drops JavaScript stack frames', () => {
    const err = new Error('找不到第 2 條音軌')
    expect(stripStackTrace(err.stack ?? '')).toBe('Error: 找不到第 2 條音軌')
  })

  it('keeps only the exception line of a Python traceback', () => {
    const text = [
      '語音辨識失敗：Traceback (most recent call last):',
      'Traceback (most recent call last):',
      '  File "cli.py", line 10, in main',
      '    run()',
      '',
      'RuntimeError: CUDA failed with error out of memory',
    ].join('\n')
    expect(stripStackTrace(text)).toBe('語音辨識失敗：Traceback (most recent call last):\nRuntimeError: CUDA failed with error out of memory')
  })

  it('handles chained tracebacks', () => {
    const text = [
      'Traceback (most recent call last):',
      '  File "a.py", line 1',
      'ValueError: x',
      '',
      'During handling of the above exception, another exception occurred:',
      '',
      'Traceback (most recent call last):',
      '  File "b.py", line 2',
      'RuntimeError: y',
    ].join('\n')
    expect(stripStackTrace(text)).toBe('ValueError: x\n\nRuntimeError: y')
  })
})

describe('readableError', () => {
  it('keeps Chinese messages as they are', () => {
    expect(readableError(new Error('找不到原始影片檔'), '讀取影片資訊')).toBe('找不到原始影片檔')
  })

  it('prefixes English-only messages with the step', () => {
    expect(readableError(new Error('EACCES: permission denied, open \'x\''), '擷取音訊')).toBe('擷取音訊失敗：EACCES: permission denied, open \'x\'')
  })

  it('never returns an empty message and never a stack trace', () => {
    expect(readableError(new Error(''), '輸出剪輯')).toBe('輸出剪輯失敗（原因不明）')
    expect(readableError(undefined, '輸出剪輯')).toBe('輸出剪輯失敗（原因不明）')
    const err = new Error('boom')
    err.message = `ffmpeg 執行失敗（結束碼 1）：\nInvalid data\n    at runTool (process.ts:10:5)`
    const text = readableError(err, '輸出剪輯')
    expect(text).not.toMatch(/\bat runTool/)
    expect(text).toContain('Invalid data')
  })

  it('cuts very long messages', () => {
    const text = readableError(new Error(`失敗${'x'.repeat(5000)}`), '輸出剪輯')
    expect(text.length).toBeLessThanOrEqual(1200)
    expect(text.endsWith('…')).toBe(true)
  })
})
