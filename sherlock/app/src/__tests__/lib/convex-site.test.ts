import { describe, expect, it } from 'vitest'

import { resolveConvexSiteOrigin } from '@/lib/convex-site'

describe('resolveConvexSiteOrigin', () => {
  it('maps the API deployment host to its HTTP-actions host', () => {
    expect(resolveConvexSiteOrigin('https://brainy-emu-822.convex.cloud')).toBe(
      'https://brainy-emu-822.convex.site'
    )
  })

  it('keeps an origin that already points at the HTTP-actions host', () => {
    expect(resolveConvexSiteOrigin('https://brainy-emu-822.convex.site')).toBe(
      'https://brainy-emu-822.convex.site'
    )
  })

  it('drops any path, query or fragment the environment carries', () => {
    expect(resolveConvexSiteOrigin('https://brainy-emu-822.convex.cloud/api?x=1#y')).toBe(
      'https://brainy-emu-822.convex.site'
    )
  })

  it('fails closed on hosts that are not a Convex deployment', () => {
    expect(resolveConvexSiteOrigin('https://evil.example')).toBeNull()
    expect(resolveConvexSiteOrigin('https://brainy-emu-822.convex.cloud.evil.example')).toBeNull()
    expect(resolveConvexSiteOrigin('http://brainy-emu-822.convex.cloud')).toBeNull()
    expect(resolveConvexSiteOrigin('not a url')).toBeNull()
    expect(resolveConvexSiteOrigin(undefined)).toBeNull()
  })
})
