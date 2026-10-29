import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ mutation: vi.fn(), client: vi.fn() }))
vi.mock('@/lib/convex-auth', () => ({ getUnauthenticatedConvex: mocks.client }))
vi.mock('@/lib/dev-auth/config', () => ({ DEV_AUTH_ENABLED: true }))
vi.mock('@/../convex/_generated/api', () => ({
  api: { devAuth: { bootstrapUsers: 'devAuth.bootstrapUsers' } },
}))

beforeEach(() => {
  vi.resetModules()
  mocks.mutation.mockReset().mockResolvedValue({ ready: true })
  mocks.client.mockReset().mockReturnValue({ mutation: mocks.mutation })
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210')
  vi.stubEnv('NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY', 'local-only-key')
})
afterEach(() => vi.unstubAllEnvs())

it('prepares only the local identities before entering the app', async () => {
  const { prepareLocalDevLogin } = await import('@/app/[locale]/dev-login/actions')
  expect(await prepareLocalDevLogin()).toBe(true)
  expect(mocks.mutation).toHaveBeenCalledWith('devAuth.bootstrapUsers', {})
})

it('keeps the isolated fixture lane offline', async () => {
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://placeholder.convex.cloud')
  const { prepareLocalDevLogin } = await import('@/app/[locale]/dev-login/actions')
  expect(await prepareLocalDevLogin()).toBe(true)
  expect(mocks.client).not.toHaveBeenCalled()
})

it('blocks local login preparation if the backend rejects the bootstrap', async () => {
  mocks.mutation.mockRejectedValue(new Error('unavailable'))
  const { prepareLocalDevLogin } = await import('@/app/[locale]/dev-login/actions')
  expect(await prepareLocalDevLogin()).toBe(false)
})

it('refuses the local bootstrap in production even when a local key is set', async () => {
  vi.stubEnv('NODE_ENV', 'production')
  const { prepareLocalDevLogin } = await import('@/app/[locale]/dev-login/actions')
  expect(await prepareLocalDevLogin()).toBe(false)
  expect(mocks.client).not.toHaveBeenCalled()
})
