// ============================================================================
// TESTS: dev-auth/config
// ============================================================================
// Tests for the isDevAuthEnabled function that controls auth bypass.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isDevAuthEnabled } from '@/lib/dev-auth/config'

describe('isDevAuthEnabled', () => {
  const savedEnv: Record<string, string | undefined> = {}
  const envKeys = [
    'NODE_ENV',
    'NEXT_PUBLIC_BYPASS_AUTH',
    'BYPASS_AUTH',
    'NEXT_PUBLIC_DEV_AUTH_ENABLED',
    'E2E_DRIVER',
    'E2E_SERVER_MODE',
    'PLAYWRIGHT_REUSE_SERVER',
  ]

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()

    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
  })

  it('returns false in non-local production even with flags set', () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'production'
    process.env.NEXT_PUBLIC_BYPASS_AUTH = 'true'
    vi.stubGlobal('window', { location: { hostname: 'sherlock.capital' } })

    expect(isDevAuthEnabled()).toBe(false)
  })

  it('returns false in production-start E2E with bypass enabled', () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'production'
    process.env.NEXT_PUBLIC_BYPASS_AUTH = 'true'
    process.env.E2E_SERVER_MODE = 'start'
    expect(isDevAuthEnabled()).toBe(false)
  })

  it('returns false in local browser production-start with public bypass enabled', () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'production'
    process.env.NEXT_PUBLIC_BYPASS_AUTH = 'true'
    vi.stubGlobal('window', { location: { hostname: '127.0.0.1' } })

    expect(isDevAuthEnabled()).toBe(false)
  })

  it('returns false in non-local browser production with public bypass enabled', () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'production'
    process.env.NEXT_PUBLIC_BYPASS_AUTH = 'true'
    vi.stubGlobal('window', { location: { hostname: 'sherlock.capital' } })

    expect(isDevAuthEnabled()).toBe(false)
  })

  it('returns true with NEXT_PUBLIC_BYPASS_AUTH=true in dev', () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'development'
    process.env.NEXT_PUBLIC_BYPASS_AUTH = 'true'
    expect(isDevAuthEnabled()).toBe(true)
  })

  it('returns true with BYPASS_AUTH=true in test', () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'test'
    delete process.env.NEXT_PUBLIC_BYPASS_AUTH
    process.env.BYPASS_AUTH = 'true'
    expect(isDevAuthEnabled()).toBe(true)
  })

  it('returns true with NEXT_PUBLIC_DEV_AUTH_ENABLED=true', () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'development'
    delete process.env.NEXT_PUBLIC_BYPASS_AUTH
    delete process.env.BYPASS_AUTH
    process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED = 'true'
    expect(isDevAuthEnabled()).toBe(true)
  })

  it('returns false when no flags set', () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'development'
    delete process.env.NEXT_PUBLIC_BYPASS_AUTH
    delete process.env.BYPASS_AUTH
    delete process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED
    expect(isDevAuthEnabled()).toBe(false)
  })

  it('returns false when flag is "false"', () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'development'
    process.env.NEXT_PUBLIC_BYPASS_AUTH = 'false'
    expect(isDevAuthEnabled()).toBe(false)
  })

  it('returns false for non-true values like "1"', () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'development'
    process.env.NEXT_PUBLIC_BYPASS_AUTH = '1'
    expect(isDevAuthEnabled()).toBe(false)
  })

  it('NEXT_PUBLIC_BYPASS_AUTH takes priority over BYPASS_AUTH', () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'development'
    process.env.NEXT_PUBLIC_BYPASS_AUTH = 'false'
    process.env.BYPASS_AUTH = 'true'
    // NEXT_PUBLIC_BYPASS_AUTH is checked first via ?? chain
    expect(isDevAuthEnabled()).toBe(false)
  })
})
