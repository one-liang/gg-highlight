import type { CandidateDraft, CandidateInput, CandidateOptions } from './types'

/** Pure: combined score → peaks → windows snapped to sentences → capped, non-overlapping candidates, ordered by start. */
export function buildCandidates(_input: CandidateInput, _options: Partial<CandidateOptions> = {}): CandidateDraft[] {
  throw new Error('not implemented')
}
