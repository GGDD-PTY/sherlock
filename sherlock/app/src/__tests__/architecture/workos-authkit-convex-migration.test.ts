import { existsSync, readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

function read(path: string) {
  return readFileSync(`${root}/${path}`, 'utf8')
}

describe('WorkOS AuthKit + Convex migration boundary', () => {
  it('configures Convex to validate WorkOS custom JWT access tokens', () => {
    const source = read('convex/auth.config.ts')

    expect(source).toContain('customJwt')
    expect(source).toContain('WORKOS_CLIENT_ID')
    expect(source).toContain('https://api.workos.com/')
    expect(source).toContain('https://api.workos.com/user_management/')
    expect(source).toContain('https://api.workos.com/sso/jwks/')
    expect(source).not.toContain('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')
  })

  it('wires the client through AuthKit and ConvexProviderWithAuth', () => {
    const provider = read('src/components/providers/ConvexClientProvider.tsx')
    const authProvider = read('src/components/providers/AuthProvider.tsx')
    const workosProvider = read('src/components/providers/WorkOSAuthProvider.tsx')

    expect(provider).toContain('ConvexProviderWithAuth')
    expect(provider).toContain('useAccessToken')
    expect(provider).toContain('useAuthFromAuthKit')
    expect(provider).not.toContain('ConvexProviderWithClerk')
    expect(provider).not.toContain('@clerk/nextjs')

    expect(authProvider).toContain('WorkOSAuthProvider')
    expect(authProvider).not.toContain('ClerkProvider')

    expect(workosProvider).toContain('withAuth')
    expect(workosProvider).toContain('initialAuth')
    expect(workosProvider).toContain('delete initialAuth.accessToken')
    expect(workosProvider).toContain('<AuthKitProvider initialAuth={initialAuth}>')
  })

  it('uses WorkOS access tokens for authenticated server-side Convex calls', () => {
    const source = read('src/lib/convex-auth.ts')

    expect(source).toContain("from '@workos-inc/authkit-nextjs'")
    expect(source).toContain('withAuth')
    expect(source).toContain('accessToken')
    expect(source).not.toContain('@clerk/nextjs/server')
    expect(source).not.toContain("template: 'convex'")
    expect(source).not.toContain('CONVEX_DEPLOY_KEY')
  })

  it('pins the AuthKit callback redirect host to the configured app URL', () => {
    const source = read('src/app/callback/route.ts')

    expect(source).toContain('process.env.NEXT_PUBLIC_APP_URL')
    expect(source).toContain('baseURL: appBaseUrl')
    expect(source).toContain('handleAuth({')
  })

  it('keeps internal payment lookups provider-neutral after WorkOS migration', () => {
    const source = read('convex/users.ts')

    expect(source).toMatch(
      /typeof identityOrProviderUserId === 'string'\s*\?\s*await findUserByProviderIdentifier\(ctx, identityOrProviderUserId\)/
    )
  })

  it('runs E2E scripts through the project Node wrapper', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>
    }

    expect(packageJson.scripts['test:e2e']).toContain('bash scripts/with-project-node.sh')
    expect(packageJson.scripts['test:e2e:smoke']).toContain('bash scripts/with-project-node.sh')
    expect(packageJson.scripts['test:e2e:headed']).toContain('bash scripts/with-project-node.sh')
    expect(packageJson.scripts['test:e2e:ui']).toContain('bash scripts/with-project-node.sh')
    expect(packageJson.scripts['test:e2e:report']).toContain('bash scripts/with-project-node.sh')
  })

  it('keeps the default E2E command on the active sell-side inventory', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>
    }
    const script = packageJson.scripts['test:e2e']

    expect(script).toContain('tsx scripts/e2e-browser-preflight.ts')
    expect(script).toContain('playwright test')
    expect(script).toContain('e2e/intake-deliverables-journey.spec.ts')
    expect(script).toContain('e2e/sell-side-dev-auth-journeys.spec.ts')
    expect(script).toContain('e2e/admin-preparation-oversight.spec.ts')
  })

  it('requires an explicit target and disables dev auth for remote staging smoke', () => {
    const runner = read('scripts/run-staging-smoke.mjs')

    expect(runner).toContain('process.env.STAGING_E2E_BASE_URL?.trim()')
    expect(runner).toContain('if (!target)')
    expect(runner).toContain("E2E_LOAD_DOTENV_LOCAL: 'false'")
    expect(runner).toContain("PLAYWRIGHT_REUSE_SERVER: 'true'")
    expect(runner).toContain("BYPASS_AUTH: 'false'")
    expect(runner).toContain("NEXT_PUBLIC_BYPASS_AUTH: 'false'")
    expect(runner).toContain("NEXT_PUBLIC_DEV_AUTH_ENABLED: 'false'")
    expect(runner).toContain('e2e/reliability/staging-smoke.spec.ts')
  })

  it('defines a dev-auth journey gate for sell-side intake, company, admin, and guest flows', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>
    }
    const script = packageJson.scripts['test:e2e:journeys']

    expect(script).toBeDefined()
    expect(script).toContain('BYPASS_AUTH=true')
    expect(script).toContain('NEXT_PUBLIC_BYPASS_AUTH=true')
    expect(script).toContain('NEXT_PUBLIC_DEV_AUTH_ENABLED=true')
    expect(script).toContain('E2E_SERVER_MODE=dev')
    expect(script).toContain('bash scripts/with-project-node.sh')
    expect(script).toContain('tsx scripts/e2e-browser-preflight.ts')
    expect(script).toContain('e2e/sell-side-dev-auth-journeys.spec.ts')
    expect(script).toContain('e2e/intake-deliverables-journey.spec.ts')
    expect(script).toContain('e2e/admin-preparation-oversight.spec.ts')
    expect(script).toContain('e2e/vdr-guest.spec.ts')
  })

  it('keeps Clerk fully removed (F2): no SDK, no webhook, no env schema, no CSP domains', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const allDeps = { ...packageJson.dependencies, ...(packageJson.devDependencies ?? {}) }
    expect(Object.keys(allDeps).some((d) => d.startsWith('@clerk/'))).toBe(false)
    expect(allDeps).not.toHaveProperty('svix')

    expect(existsSync(`${root}/src/app/api/webhooks/clerk`)).toBe(false)
    expect(existsSync(`${root}/convex/clerk.ts`)).toBe(false)

    expect(read('src/lib/env.ts')).not.toMatch(/CLERK/i)
    expect(read('next.config.ts')).not.toMatch(/clerk/i)
    expect(read('src/__tests__/setup.ts')).not.toContain('@clerk')
    expect(read('.env.example')).not.toMatch(/CLERK/i)
  })

  it('keeps local dev-auth journeys out of the credential-free CI workflow', () => {
    const workflow = read('../../.github/workflows/ci.yml')

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toContain('test:e2e')
    expect(workflow).not.toContain('BYPASS_AUTH')
    expect(workflow).not.toContain('NEXT_PUBLIC_DEV_AUTH_ENABLED')
    expect(existsSync(`${root}/../../.github/workflows/nightly-verify.yml`)).toBe(false)
  })

  it('adds critical-path.spec.ts to the E2E smoke gate', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>
    }
    const script = packageJson.scripts['test:e2e:smoke']

    expect(script).toContain('e2e/reliability/smoke.spec.ts')
    expect(script).toContain('e2e/critical-path.spec.ts')
  })

  it('defines stable-scenario-only journey shards a/b/c/d matching the CI matrix', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>
    }

    const shardA = packageJson.scripts['test:e2e:journeys:shard-a']
    expect(shardA).toContain('e2e/intake-deliverables-journey.spec.ts')

    const shardB = packageJson.scripts['test:e2e:journeys:shard-b']
    expect(shardB).toContain('e2e/sell-side-dev-auth-journeys.spec.ts')

    const shardC = packageJson.scripts['test:e2e:journeys:shard-c']
    expect(shardC).toContain('e2e/vdr-guest.spec.ts')
    expect(shardC).toContain('e2e/vdr-large-room-performance.spec.ts')

    const shardD = packageJson.scripts['test:e2e:journeys:shard-d']
    expect(shardD).toContain('e2e/admin-preparation-oversight.spec.ts')
  })

  it('does not ship a scheduled backup bound to an operator production deployment', () => {
    const workflow = read('../../.github/workflows/ci.yml')

    expect(existsSync(`${root}/../../.github/workflows/convex-backup.yml`)).toBe(false)
    expect(workflow).not.toContain('schedule:')
    expect(workflow).not.toContain('CONVEX_DEPLOY_KEY')
    expect(workflow).not.toContain('CONVEX_DEPLOYMENT')
    expect(workflow).not.toContain('secrets.')
  })
})
