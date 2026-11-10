// Filtergraph escaping, per https://ffmpeg.org/ffmpeg-filters.html#Notes-on-filtergraph-escaping.
//
// libavfilter parses `-filter_complex` with two nested av_get_token() passes (graphparser.c):
//   level 2: the whole option string of a filter is cut at  [ ] , ;  and unescaped once;
//   level 1: each option value is cut at  :  and unescaped again.
// av_get_token treats  \  as "take the next char literally" and  '  as quoting, and trims leading
// and trailing whitespace unless escaped. So we escape bottom-up: level 1 first, then level 2.
// No shell is involved (spawn without shell), so there is no third level.

const WHITESPACE = ' \t\n\r'
const LEVEL1_SPECIALS = '\\\':'
const LEVEL2_SPECIALS = '\\\'[],;'

function escapeLevel(value: string, specials: string): string {
  const chars = Array.from(value)
  let lead = 0
  while (lead < chars.length && WHITESPACE.includes(chars[lead]!)) lead++
  let trail = chars.length
  while (trail > lead && WHITESPACE.includes(chars[trail - 1]!)) trail--
  return chars
    .map((c, i) => (specials.includes(c) || i < lead || i >= trail ? `\\${c}` : c))
    .join('')
}

/** Escapes any string for use as one filter option value inside a filtergraph. */
export function escapeFilterValue(value: string): string {
  return escapeLevel(escapeLevel(value, LEVEL1_SPECIALS), LEVEL2_SPECIALS)
}

/**
 * Escapes a file path for use as a filter option value inside an ffmpeg filtergraph
 * (e.g. subtitles=filename=...:fontsdir=...), including Windows drive letters.
 * Backslashes become forward slashes first (Windows accepts both), so
 * C:\Users\me\a.ass → C\\:/Users/me/a.ass.
 */
export function escapeFilterPath(filePath: string): string {
  return escapeFilterValue(filePath.replace(/\\/g, '/'))
}
