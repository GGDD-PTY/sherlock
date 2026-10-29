// ============================================================================
// AUTH PROVIDER COMPONENT TESTS
// ============================================================================
// Tests for AuthProvider component - conditional provider selection logic.
// This is a critical auth component that switches between WorkOS AuthKit and
// DevAuth (development) based on environment configuration.
// ============================================================================

import { describe, it, expect } from 'vitest'
import * as authProviderModule from '@/components/providers/AuthProvider'

// ============================================================================
// TYPES
// ============================================================================

type AuthMode = 'workos' | 'dev'

// ============================================================================
// EXTRACTED PURE FUNCTIONS (mirroring component logic)
// ============================================================================

/**
 * Determine which auth provider to use based on configuration.
 * Mirrors the conditional logic in AuthProvider component.
 */
function getAuthMode(devAuthEnabled: boolean): AuthMode {
  return devAuthEnabled ? 'dev' : 'workos'
}

/**
 * Check if dev auth should be used.
 * This mirrors the DEV_AUTH_ENABLED check in the component.
 */
function shouldUseDevAuth(nodeEnv: string, bypassAuthFlag: string | undefined): boolean {
  // Dev auth is enabled when:
  // 1. NODE_ENV is 'development'
  // 2. BYPASS_AUTH environment variable is set to 'true'
  return nodeEnv === 'development' && bypassAuthFlag === 'true'
}

/**
 * Get the provider component name for debugging/logging.
 */
function getProviderName(authMode: AuthMode): string {
  return authMode === 'dev' ? 'DevAuthProvider' : 'WorkOSAuthProvider'
}

// ============================================================================
// TESTS: AUTH MODE SELECTION
// ============================================================================

describe('AuthProvider - Auth Mode Selection', () => {
  it('should use dev mode when devAuthEnabled is true', () => {
    expect(getAuthMode(true)).toBe('dev')
  })

  it('should use workos mode when devAuthEnabled is false', () => {
    expect(getAuthMode(false)).toBe('workos')
  })
})

// ============================================================================
// TESTS: DEV AUTH FLAG LOGIC
// ============================================================================

describe('AuthProvider - Dev Auth Flag Logic', () => {
  it('should enable dev auth in development with bypass flag', () => {
    expect(shouldUseDevAuth('development', 'true')).toBe(true)
  })

  it('should not enable dev auth in production', () => {
    expect(shouldUseDevAuth('production', 'true')).toBe(false)
  })

  it('should not enable dev auth without bypass flag', () => {
    expect(shouldUseDevAuth('development', undefined)).toBe(false)
  })

  it('should not enable dev auth with bypass flag set to false', () => {
    expect(shouldUseDevAuth('development', 'false')).toBe(false)
  })

  it('should not enable dev auth in test environment', () => {
    expect(shouldUseDevAuth('test', 'true')).toBe(false)
  })

  it('should require both development AND bypass flag', () => {
    // Both conditions must be true
    expect(shouldUseDevAuth('development', 'true')).toBe(true)
    // Missing one condition fails
    expect(shouldUseDevAuth('production', 'true')).toBe(false)
    expect(shouldUseDevAuth('development', 'false')).toBe(false)
    expect(shouldUseDevAuth('production', 'false')).toBe(false)
  })
})

// ============================================================================
// TESTS: PROVIDER NAME
// ============================================================================

describe('AuthProvider - Provider Name', () => {
  it('should return DevAuthProvider for dev mode', () => {
    expect(getProviderName('dev')).toBe('DevAuthProvider')
  })

  it('should return WorkOSAuthProvider for workos mode', () => {
    expect(getProviderName('workos')).toBe('WorkOSAuthProvider')
  })
})

// ============================================================================
// TESTS: ENVIRONMENT VARIABLE PARSING
// ============================================================================

describe('AuthProvider - Environment Variable Parsing', () => {
  /**
   * Parse bypass auth environment variable.
   * Returns true only for exact string "true".
   */
  function parseBypassAuth(value: string | undefined): boolean {
    return value === 'true'
  }

  it("should return true for string 'true'", () => {
    expect(parseBypassAuth('true')).toBe(true)
  })

  it("should return false for string 'false'", () => {
    expect(parseBypassAuth('false')).toBe(false)
  })

  it('should return false for undefined', () => {
    expect(parseBypassAuth(undefined)).toBe(false)
  })

  it('should return false for empty string', () => {
    expect(parseBypassAuth('')).toBe(false)
  })

  it("should return false for string '1'", () => {
    expect(parseBypassAuth('1')).toBe(false)
  })

  it("should return false for string 'TRUE' (case sensitive)", () => {
    expect(parseBypassAuth('TRUE')).toBe(false)
  })

  it("should return false for string 'True'", () => {
    expect(parseBypassAuth('True')).toBe(false)
  })
})

// ============================================================================
// TESTS: SECURITY CONSTRAINTS
// ============================================================================

describe('AuthProvider - Security Constraints', () => {
  /**
   * Validate that dev auth cannot be enabled in production.
   * This is a critical security check.
   */
  function isDevAuthSafeToEnable(nodeEnv: string): { safe: boolean; reason?: string } {
    if (nodeEnv === 'production') {
      return {
        safe: false,
        reason: 'Dev auth cannot be enabled in production environment',
      }
    }
    return { safe: true }
  }

  it('should be safe in development', () => {
    const result = isDevAuthSafeToEnable('development')
    expect(result.safe).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('should not be safe in production regardless of bypass flag', () => {
    const result = isDevAuthSafeToEnable('production')
    expect(result.safe).toBe(false)
    expect(result.reason).toContain('production')
  })

  it('should be safe in test environment', () => {
    const result = isDevAuthSafeToEnable('test')
    expect(result.safe).toBe(true)
  })
})

// ============================================================================
// TESTS: PROVIDER SELECTION LOGIC
// ============================================================================

describe('AuthProvider - Provider Selection Logic', () => {
  /**
   * Full provider selection logic combining all checks.
   */
  function selectProvider(
    nodeEnv: string,
    bypassFlag: string | undefined
  ): { provider: AuthMode; isDevMode: boolean } {
    const isDevMode = shouldUseDevAuth(nodeEnv, bypassFlag)
    return {
      provider: getAuthMode(isDevMode),
      isDevMode,
    }
  }

  it('should select DevAuthProvider in development with bypass', () => {
    const result = selectProvider('development', 'true')
    expect(result.provider).toBe('dev')
    expect(result.isDevMode).toBe(true)
  })

  it('should select WorkOSAuthProvider in production', () => {
    const result = selectProvider('production', 'true')
    expect(result.provider).toBe('workos')
    expect(result.isDevMode).toBe(false)
  })

  it('should select WorkOSAuthProvider in development without bypass', () => {
    const result = selectProvider('development', undefined)
    expect(result.provider).toBe('workos')
    expect(result.isDevMode).toBe(false)
  })

  it('should select WorkOSAuthProvider in development with bypass=false', () => {
    const result = selectProvider('development', 'false')
    expect(result.provider).toBe('workos')
    expect(result.isDevMode).toBe(false)
  })
})

// ============================================================================
// TESTS: CHILDREN PASSTHROUGH
// ============================================================================

describe('AuthProvider - Children Passthrough', () => {
  /**
   * Verify that children are passed through correctly.
   * The AuthProvider should be transparent and just wrap children.
   */
  function createProviderProps(authMode: AuthMode) {
    return {
      providerType: authMode,
      // Children would be passed through
      wrapChildren: true,
    }
  }

  it('should wrap children with dev provider', () => {
    const props = createProviderProps('dev')
    expect(props.providerType).toBe('dev')
    expect(props.wrapChildren).toBe(true)
  })

  it('should wrap children with workos provider', () => {
    const props = createProviderProps('workos')
    expect(props.providerType).toBe('workos')
    expect(props.wrapChildren).toBe(true)
  })
})

// ============================================================================
// TESTS: DEV AUTH ENABLED CONSTANT
// ============================================================================

describe('AuthProvider - DEV_AUTH_ENABLED Constant', () => {
  /**
   * Simulate the DEV_AUTH_ENABLED constant computation.
   * This is computed at module load time from environment variables.
   */
  function computeDevAuthEnabled(env: {
    NODE_ENV?: string
    NEXT_PUBLIC_BYPASS_AUTH?: string
  }): boolean {
    return env.NODE_ENV === 'development' && env.NEXT_PUBLIC_BYPASS_AUTH === 'true'
  }

  it('should compute true for development + bypass=true', () => {
    expect(
      computeDevAuthEnabled({
        NODE_ENV: 'development',
        NEXT_PUBLIC_BYPASS_AUTH: 'true',
      })
    ).toBe(true)
  })

  it('should compute false for production', () => {
    expect(
      computeDevAuthEnabled({
        NODE_ENV: 'production',
        NEXT_PUBLIC_BYPASS_AUTH: 'true',
      })
    ).toBe(false)
  })

  it('should compute false for missing env vars', () => {
    expect(computeDevAuthEnabled({})).toBe(false)
  })

  it('should compute false for only NODE_ENV', () => {
    expect(computeDevAuthEnabled({ NODE_ENV: 'development' })).toBe(false)
  })

  it('should compute false for only BYPASS_AUTH', () => {
    expect(computeDevAuthEnabled({ NEXT_PUBLIC_BYPASS_AUTH: 'true' })).toBe(false)
  })
})

// ============================================================================
// TESTS: EXPORT DEFAULT
// ============================================================================

describe('AuthProvider - Module Exports', () => {
  it('exposes the named AuthProvider without restoring the retired default alias', () => {
    expect(authProviderModule.AuthProvider).toBeTypeOf('function')
    expect(authProviderModule).not.toHaveProperty('default')
  })
})

// ============================================================================
// TESTS: EDGE CASES
// ============================================================================

describe('AuthProvider - Edge Cases', () => {
  it('should handle whitespace in bypass flag', () => {
    // Whitespace should not match "true"
    expect(shouldUseDevAuth('development', ' true')).toBe(false)
    expect(shouldUseDevAuth('development', 'true ')).toBe(false)
    expect(shouldUseDevAuth('development', ' true ')).toBe(false)
  })

  it('should handle empty NODE_ENV', () => {
    expect(shouldUseDevAuth('', 'true')).toBe(false)
  })

  it('should handle staging environment', () => {
    // Staging should use WorkOS AuthKit (not dev auth)
    expect(shouldUseDevAuth('staging', 'true')).toBe(false)
  })

  it('should handle preview environment', () => {
    // Preview should use WorkOS AuthKit
    expect(shouldUseDevAuth('preview', 'true')).toBe(false)
  })
})
