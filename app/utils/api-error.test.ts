import { describe, expect, it } from 'vitest'
import { apiErrorMessage, describeApiError, InvalidResponseError } from './api-error'

describe('describeApiError', () => {
  it('uses the zh-TW statusMessage sent by the server', () => {
    const err = { name: 'FetchError', statusCode: 409, data: { statusCode: 409, statusMessage: '這個檔案已經在影片庫裡了' } }
    expect(describeApiError(err, '加入失敗')).toEqual({ message: '這個檔案已經在影片庫裡了', status: 409 })
  })

  it('falls back to data.message', () => {
    const err = { status: 400, data: { message: '影片長度不足' } }
    expect(apiErrorMessage(err, '失敗')).toBe('影片長度不足')
  })

  it('prefers a Chinese message over an English statusMessage', () => {
    const err = { statusCode: 400, data: { statusMessage: 'Bad Request', message: '起點必須小於終點' } }
    expect(apiErrorMessage(err, '儲存失敗')).toBe('起點必須小於終點')
  })

  it('wraps non-Chinese server messages with the fallback', () => {
    const err = { statusCode: 404, data: { statusMessage: 'Page Not Found: /api/videos' } }
    expect(describeApiError(err, '讀取影片庫失敗')).toEqual({ message: '讀取影片庫失敗（404：Page Not Found: /api/videos）', status: 404 })
  })

  it('reports the status code when there is no body', () => {
    expect(apiErrorMessage({ response: { status: 502 } }, '儲存失敗')).toBe('儲存失敗（錯誤代碼 502）')
  })

  it('explains network failures', () => {
    const err = new TypeError('Failed to fetch')
    expect(describeApiError(err, '讀取失敗')).toEqual({ message: '讀取失敗（無法連線到 gg-highlight，請確認程式仍在執行）', status: null })
  })

  it('handles non-JSON responses and aborts', () => {
    expect(apiErrorMessage(new InvalidResponseError(), '讀取失敗')).toBe('讀取失敗（伺服器回應格式不正確）')
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(apiErrorMessage(abort, '上傳失敗')).toBe('已取消')
  })

  it('handles junk', () => {
    expect(apiErrorMessage(undefined, '失敗')).toBe('失敗')
    expect(apiErrorMessage('boom', '失敗')).toBe('失敗')
  })
})
