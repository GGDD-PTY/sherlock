import { Effect } from 'effect'

import { McpOAuthError, type McpOAuthVerifiedToken } from './oauth-core'

const WORKOS_USER_SUB_PREFIX = 'user_'
const DEV_USER_SUB_PREFIX = 'dev_'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function isLocalDevAuthEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  return (
    process.env.NEXT_PUBLIC_BYPASS_AUTH === 'true' ||
    process.env.BYPASS_AUTH === 'true' ||
    process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED === 'true'
  )
}

function isLoopbackHttpIssuer(issuer: string): boolean {
  try {
    const url = new URL(issuer)
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

function sherlockMcpAuthPolicyError({
  claims,
  principal,
}: McpOAuthVerifiedToken): McpOAuthError | undefined {
  if (claims.aud !== principal.audience) {
    return new McpOAuthError('MCP_TOKEN_AUDIENCE_INVALID')
  }
  if (principal.principalId.startsWith(WORKOS_USER_SUB_PREFIX)) {
    return undefined
  }
  // Banco local: el seed escribe `dev_*_workos`, no el namespace WorkOS `user_`.
  // Solo con auth de desarrollo y un issuer HTTP de loopback; la nube no entra.
  if (
    isLocalDevAuthEnabled() &&
    isLoopbackHttpIssuer(principal.issuer) &&
    principal.principalId.startsWith(DEV_USER_SUB_PREFIX)
  ) {
    return undefined
  }
  return new McpOAuthError('MCP_TOKEN_CLAIMS_INVALID')
}

/**
 * Sherlock's policy above the generic JWT verifier.
 *
 * WorkOS Agent Registration documents `aud` as the single client/resource
 * selected for the credential. Sherlock accepts only that scalar provider
 * shape, so a multi-resource JWT cannot be replayed across MCP surfaces.
 * `principalId` is already either direct `sub` or delegated `act.sub` here;
 * both paths must resolve to the WorkOS human-user namespace.
 *
 * @see https://workos.com/docs/authkit/agent-auth#access-token-claims
 */
export const assertSherlockMcpAuthPolicyEffect = Effect.fn('McpAuthPolicy.assert')(function* (
  token: McpOAuthVerifiedToken
): Effect.fn.Return<void, McpOAuthError> {
  const error = sherlockMcpAuthPolicyError(token)
  if (error !== undefined) yield* error
})
