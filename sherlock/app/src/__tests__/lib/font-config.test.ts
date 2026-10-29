import { describe, expect, it } from 'vitest'

import { getRootFontClassName, shouldDisableRemoteFonts } from '@/lib/fonts/font-config'

describe('font config', () => {
  it('uses local fallback font variables when remote fonts are disabled', () => {
    const env = { NEXT_DISABLE_REMOTE_FONTS: 'true' }

    expect(shouldDisableRemoteFonts(env)).toBe(true)
    expect(getRootFontClassName({ env, remoteFontVariables: 'remote-font-vars' })).toBe(
      'font-fallback-vars font-sans antialiased'
    )
  })

  it('uses remote font variables when remote fonts are enabled', () => {
    const env = { NEXT_DISABLE_REMOTE_FONTS: 'false' }

    expect(shouldDisableRemoteFonts(env)).toBe(false)
    expect(getRootFontClassName({ env, remoteFontVariables: 'remote-font-vars' })).toBe(
      'remote-font-vars font-sans antialiased'
    )
  })

  it('falls back when no remote font variables are available', () => {
    const env = { NEXT_DISABLE_REMOTE_FONTS: 'false' }

    expect(getRootFontClassName({ env, remoteFontVariables: '' })).toBe(
      'font-fallback-vars font-sans antialiased'
    )
  })
})
