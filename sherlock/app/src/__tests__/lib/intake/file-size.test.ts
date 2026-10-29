import { describe, expect, it } from 'vitest'

import { formatFileSize, formatTransferredBytes } from '@/lib/intake/file-size'

describe('formatFileSize', () => {
  it('never shows a document with size zero', () => {
    expect(formatFileSize(0)).toBe('1 KB')
    expect(formatFileSize(512)).toBe('1 KB')
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3 MB')
  })
})

describe('formatTransferredBytes', () => {
  it('says 0 KB before the first byte and follows the size format after', () => {
    expect(formatTransferredBytes(0)).toBe('0 KB')
    expect(formatTransferredBytes(2048)).toBe('2 KB')
    expect(formatTransferredBytes(2 * 1024 * 1024)).toBe('2 MB')
  })
})
