import { describe, expect, it } from 'vitest'

import {
  isNextDevTruncatedChunk,
  j3PullMeetsFloor,
  j3PullRequiresFreshDownload,
  parseJourneyKeys,
} from '../../../e2e/helpers/journey-rules'

describe('isNextDevTruncatedChunk', () => {
  it('accepts the two next-dev truncated-chunk markers', () => {
    expect(isNextDevTruncatedChunk(['Loading chunk 12 failed.\n(error: ChunkLoadError)'])).toBe(
      true
    )
    expect(isNextDevTruncatedChunk(['SyntaxError: Unexpected end of JSON input'])).toBe(true)
  })

  it('does not reload on other console noise', () => {
    expect(isNextDevTruncatedChunk(['Invalid or unexpected token'])).toBe(false)
    expect(isNextDevTruncatedChunk(['Router action dispatched before initialization.'])).toBe(false)
    expect(isNextDevTruncatedChunk([])).toBe(false)
  })
})

describe('j3PullRequiresFreshDownload', () => {
  it('requires a fresh download when j1 or j2 ran in the same execution', () => {
    expect(j3PullRequiresFreshDownload(parseJourneyKeys('j1,j2,j3,j4,j5'))).toBe(true)
    expect(j3PullRequiresFreshDownload(parseJourneyKeys('j2,j3'))).toBe(true)
    expect(j3PullRequiresFreshDownload(parseJourneyKeys('j1'))).toBe(true)
  })

  it('accepts omitted files when j3 runs alone', () => {
    expect(j3PullRequiresFreshDownload(parseJourneyKeys('j3'))).toBe(false)
    expect(j3PullRequiresFreshDownload(parseJourneyKeys(undefined))).toBe(false)
    expect(j3PullRequiresFreshDownload(parseJourneyKeys(''))).toBe(false)
  })

  it('accepts omitted files only when j3 runs alone', () => {
    expect(j3PullMeetsFloor(0, 1, parseJourneyKeys('j3'))).toBe(true)
    expect(j3PullMeetsFloor(0, 1, parseJourneyKeys('j1,j2,j3'))).toBe(false)
    expect(j3PullMeetsFloor(1, 0, parseJourneyKeys('j1,j2,j3'))).toBe(true)
  })
})
