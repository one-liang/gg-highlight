// Balanced line breaking for subtitles (CJK and latin).
import { isWide, textUnits } from './text'

// No line may start with these…
const NO_BREAK_BEFORE = new Set([...'，。！？、」』）；：…⋯〉》】〕〗～ー々', ...',.!?;:)]}%”’'])
// …or end with these.
const NO_BREAK_AFTER = new Set([...'「『（〈《【〔〖', ...'([{“‘'])
// A break right after these reads naturally, like a break at a space.
const SOFT_AFTER = new Set([...'，。！？、；：」』）…', ...',.!?;:'])

/** Extra cost of breaking between two CJK characters instead of at a space or punctuation. */
const HARD_BREAK_COST = 1.5

interface BreakPoint {
  /** The line ends before this char index. */
  end: number
  /** The next line starts at this char index (skips the space). */
  next: number
  cost: number
}

interface Plan {
  /** Longest line in units. */
  max: number
  cost: number
  /** Sum of squared line widths: lower is more balanced. */
  squares: number
  breaks: number[]
}

/** Breaks text into at most maxLines balanced lines of at most maxUnitsPerLine units each. */
export function wrapLines(text: string, maxUnitsPerLine: number, maxLines = 2): string[] {
  const clean = text.replace(/\s+/gu, ' ').trim()
  if (!clean) return []
  if (maxLines <= 1 || textUnits(clean) <= maxUnitsPerLine) return [clean]

  const chars = Array.from(clean)
  const points = breakPoints(chars)
  if (!points.length) return [clean]

  const prefix = [0]
  for (const ch of chars) prefix.push(prefix[prefix.length - 1]! + (isWide(ch) ? 1 : 0.5))
  const width = (from: number, to: number) => prefix[to]! - prefix[from]!

  let chosen: Plan | null = null
  for (let lines = 2; lines <= Math.min(maxLines, points.length + 1); lines++) {
    const plan = bestPlan(points, chars.length, lines, maxUnitsPerLine, width)
    if (!plan) break
    chosen = plan
    if (plan.max <= maxUnitsPerLine) break
  }
  if (!chosen) return [clean]

  const out: string[] = []
  let from = 0
  for (const b of chosen.breaks) {
    const point = points[b]!
    out.push(chars.slice(from, point.end).join('').trim())
    from = point.next
  }
  out.push(chars.slice(from).join('').trim())
  return out.filter(Boolean)
}

function breakPoints(chars: string[]): BreakPoint[] {
  const points: BreakPoint[] = []
  for (let p = 1; p < chars.length; p++) {
    const a = chars[p - 1]!
    const b = chars[p]!
    if (b === ' ') {
      if (p + 1 < chars.length) points.push({ end: p, next: p + 1, cost: 0 })
      continue
    }
    if (a === ' ') continue
    // Latin text only breaks at spaces; CJK may break between any two characters.
    if (!isWide(a) && !isWide(b)) continue
    if (NO_BREAK_BEFORE.has(b) || NO_BREAK_AFTER.has(a)) continue
    points.push({ end: p, next: p, cost: SOFT_AFTER.has(a) ? 0 : HARD_BREAK_COST })
  }
  return points
}

/** Lines that fit beat lines that don't; then shortest longest line (plus break cost); then balance. */
function better(a: Plan, b: Plan, limit: number): boolean {
  const overA = Math.max(0, a.max - limit)
  const overB = Math.max(0, b.max - limit)
  if (overA !== overB) return overA < overB
  const scoreA = a.max + a.cost
  const scoreB = b.max + b.cost
  if (scoreA !== scoreB) return scoreA < scoreB
  return a.squares < b.squares
}

/** Best way to cut the text into exactly `lines` lines, by dynamic programming over break points. */
function bestPlan(
  points: BreakPoint[],
  length: number,
  lines: number,
  limit: number,
  width: (from: number, to: number) => number,
): Plan | null {
  // plans[k] = best plan whose last chosen break is points[k], for the current line count.
  let plans: Array<Plan | null> = points.map((pt, k) => {
    const w = width(0, pt.end)
    return { max: w, cost: pt.cost, squares: w * w, breaks: [k] }
  })
  for (let line = 2; line < lines; line++) {
    const nextPlans: Array<Plan | null> = points.map(() => null)
    points.forEach((pt, k) => {
      for (let prev = 0; prev < k; prev++) {
        const base = plans[prev]
        if (!base) continue
        const w = width(points[prev]!.next, pt.end)
        if (w <= 0) continue
        const plan: Plan = {
          max: Math.max(base.max, w),
          cost: base.cost + pt.cost,
          squares: base.squares + w * w,
          breaks: [...base.breaks, k],
        }
        const current = nextPlans[k]
        if (!current || better(plan, current, limit)) nextPlans[k] = plan
      }
    })
    plans = nextPlans
  }
  let best: Plan | null = null
  for (let k = 0; k < plans.length; k++) {
    const base = plans[k]
    if (!base) continue
    const w = width(points[k]!.next, length)
    if (w <= 0) continue
    const plan: Plan = { ...base, max: Math.max(base.max, w), squares: base.squares + w * w }
    if (!best || better(plan, best, limit)) best = plan
  }
  return best
}
