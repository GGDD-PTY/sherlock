import { describe, expect, it } from 'vitest'

import {
  readOpenSourceRequest,
  serializeOpenSourceRequest,
} from '@/components/company/vdr/workspace-url-state'

describe('open source request in the room URL', () => {
  it('round-trips a page citation', () => {
    const request = { documentId: 'doc_1', versionId: 'ver_1', navigate: { page: 12 } }
    const params = new URLSearchParams(serializeOpenSourceRequest(request))
    expect(readOpenSourceRequest(params)).toEqual(request)
  })

  it('round-trips a sheet citation', () => {
    const request = {
      documentId: 'doc_1',
      versionId: 'ver_1',
      navigate: { sheet: 'Balance', range: 'B12:D12' },
    }
    const params = new URLSearchParams(serializeOpenSourceRequest(request))
    expect(readOpenSourceRequest(params)).toEqual(request)
  })

  it('opens a document id without version or citation (au-02)', () => {
    expect(readOpenSourceRequest(new URLSearchParams('source=doc_1'))).toEqual({
      documentId: 'doc_1',
    })
    const params = new URLSearchParams(serializeOpenSourceRequest({ documentId: 'doc_1' }))
    expect(readOpenSourceRequest(params)).toEqual({ documentId: 'doc_1' })
  })

  it('opens a pinned version without a page or sheet citation (au-02)', () => {
    expect(readOpenSourceRequest(new URLSearchParams('source=doc_1:ver_1'))).toEqual({
      documentId: 'doc_1',
      versionId: 'ver_1',
    })
  })

  it('keeps page citations when the source has no version (au-02)', () => {
    expect(readOpenSourceRequest(new URLSearchParams('source=doc_1&page=12'))).toEqual({
      documentId: 'doc_1',
      navigate: { page: 12 },
    })
  })

  it('rejects a malformed citation instead of opening anything', () => {
    expect(readOpenSourceRequest(new URLSearchParams('source=doc_1:'))).toBeNull()
    expect(readOpenSourceRequest(new URLSearchParams('source=:ver_1'))).toBeNull()
    expect(readOpenSourceRequest(new URLSearchParams('source=doc_1:ver_1&page=0'))).toBeNull()
    expect(
      readOpenSourceRequest(new URLSearchParams('source=doc_1:ver_1&sheet=Balance'))
    ).toBeNull()
    expect(readOpenSourceRequest(new URLSearchParams(''))).toBeNull()
  })
})
