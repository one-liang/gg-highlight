import { describe, expect, it } from 'vitest'
import {
  canonicalYoutubeUrl, isYoutubeVideoId, NOT_YOUTUBE_MESSAGE, parseYoutubeUrl, PLAYLIST_OR_CHANNEL_MESSAGE,
} from './youtube-url'

const ID = 'dQw4w9WgXcQ'
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`

describe('parseYoutubeUrl', () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `http://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    `youtube.com/watch?v=${ID}`,
    `//www.youtube.com/watch?v=${ID}`,
    `  https://www.youtube.com/watch?v=${ID}  \n`,
    `HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?feature=share&v=${ID}`,
    `https://youtu.be/${ID}`,
    `youtu.be/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/v/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube.com/watch?v=${ID}#t=30`,
    // YouTube Studio's pages of one video (where a streamer manages past streams).
    `https://studio.youtube.com/video/${ID}/edit`,
    `https://studio.youtube.com/video/${ID}/livestreaming`,
    `https://studio.youtube.com/video/${ID}/analytics/tab-overview/period-default`,
    `https://studio.youtube.com/video/${ID}/comments/inbox?filter=%5B%5D`,
    `studio.youtube.com/video/${ID}/edit`,
  ])('accepts %s', (input) => {
    expect(parseYoutubeUrl(input)).toEqual({ ok: true, id: ID, url: CANONICAL })
  })

  it.each([
    `https://www.youtube.com/watch?v=${ID}&list=PLabcdefghijklmnop&index=3`,
    `https://www.youtube.com/watch?v=${ID}&t=1m30s`,
    `https://youtu.be/${ID}?si=AbCdEfGhIjKlMnOp`,
    `https://youtu.be/${ID}?t=42&si=x`,
    `https://www.youtube.com/live/${ID}?si=abc&t=100`,
    `https://www.youtube.com/shorts/${ID}?feature=share`,
    `https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`,
  ])('drops list=, t=, si= and other parameters: %s', (input) => {
    expect(parseYoutubeUrl(input)).toEqual({ ok: true, id: ID, url: CANONICAL })
  })

  it('keeps ids with - and _', () => {
    expect(parseYoutubeUrl('https://youtu.be/a-b_c-d_e-f')).toEqual({
      ok: true, id: 'a-b_c-d_e-f', url: 'https://www.youtube.com/watch?v=a-b_c-d_e-f',
    })
  })

  it.each([
    'https://www.youtube.com/playlist?list=PLabcdefghijklmnop',
    'https://music.youtube.com/playlist?list=PLabcdefghijklmnop',
    'https://www.youtube.com/watch?list=PLabcdefghijklmnop',
    'https://www.youtube.com/embed/videoseries?list=PLabcdefghijklmnop',
    'https://www.youtube.com/@SomeChannel',
    'https://www.youtube.com/@SomeChannel/live',
    'https://www.youtube.com/@SomeChannel/videos',
    'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv',
    'https://www.youtube.com/c/SomeChannel',
    'https://www.youtube.com/user/SomeUser',
    'https://www.youtube.com/results?search_query=gg',
    'youtube.com/@SomeChannel',
  ])('rejects playlists, channels and searches: %s', (input) => {
    expect(parseYoutubeUrl(input)).toEqual({
      ok: false, reason: 'playlist-or-channel', message: PLAYLIST_OR_CHANNEL_MESSAGE,
    })
  })

  it.each([
    '',
    '   ',
    'hello world',
    ID,
    `https://vimeo.com/${ID}`,
    `https://www.youtube.com.evil.example/watch?v=${ID}`,
    `https://notyoutube.com/watch?v=${ID}`,
    `https://gaming.youtube.com/watch?v=${ID}`,
    `ftp://www.youtube.com/watch?v=${ID}`,
    'https://www.youtube.com/',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQX',
    'https://www.youtube.com/watch?v=dQw4w9$gXcQ',
    'https://youtu.be/',
    'https://youtu.be/dQw4w9!gXcQ',
    'https://www.youtube.com/shorts/',
    'https://www.youtube.com/live/abc',
    'https://www.youtube.com/feed/subscriptions',
    'https://www.youtube.com/SomeLegacyName',
    'http://[::1',
    'https://studio.youtube.com/',
    'https://studio.youtube.com/video/short/edit',
    `https://studio.youtube.com/watch?v=${ID}`,
  ])('rejects non-YouTube or malformed input: %j', (input) => {
    expect(parseYoutubeUrl(input)).toEqual({ ok: false, reason: 'not-youtube', message: NOT_YOUTUBE_MESSAGE })
  })
})

describe('isYoutubeVideoId / canonicalYoutubeUrl', () => {
  it('checks the 11-character id form', () => {
    expect(isYoutubeVideoId(ID)).toBe(true)
    expect(isYoutubeVideoId('ggVodChat01')).toBe(true)
    expect(isYoutubeVideoId('short')).toBe(false)
    expect(isYoutubeVideoId('dQw4w9WgXc!')).toBe(false)
  })

  it('builds the watch URL', () => {
    expect(canonicalYoutubeUrl(ID)).toBe(CANONICAL)
  })
})
