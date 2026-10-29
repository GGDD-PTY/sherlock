// ============================================================================
// MCP OAUTH CORE — surface-agnostic resource-server plumbing
// ============================================================================
// Pure transport/crypto machinery shared by every MCP resource server in the
// app: bounded body reads, bearer grammar, JWKS fetch, RS256 verification and
// claim assertion. It knows nothing about tools, scopes-per-method, audiences
// or business surfaces — each surface supplies those.
//
// DEPENDENCY DIRECTION: this module must never import from a concrete MCP
// surface (`src/lib/vdr-mcp`, ...). Surfaces import from here, never the
// reverse. Enforced by `src/__tests__/vdr-mcp/boundary.test.ts`.
// ============================================================================

import {
  Cache,
  Cause,
  Clock,
  Data,
  Duration,
  Effect,
  Exit,
  Predicate,
  Result,
  Schema,
} from 'effect'
import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey as NodeJsonWebKey,
  type KeyObject,
} from 'node:crypto'

import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'

const MCP_MAX_JWKS_BYTES = 64 * 1024
const MCP_MAX_REQUEST_BODY_BYTES = 256 * 1024
const MCP_MAX_BATCH_SIZE = 32
const MCP_JWKS_CACHE_CAPACITY = 128
const MCP_JWKS_CACHE_TTL_MS = 5 * 60 * 1_000
const MCP_JWKS_UNKNOWN_KID_TTL_MS = 30 * 1_000

const MAX_BEARER_BYTES = 8 * 1024
const DEFAULT_JWKS_TIMEOUT_MS = 3_000
const JWT_SEGMENT = '[A-Za-z0-9_-]+'
const JWT_BEARER_PATTERN = new RegExp(
  `^Bearer (${JWT_SEGMENT}\\.${JWT_SEGMENT}\\.${JWT_SEGMENT})$`,
  'i'
)
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const AGENT_REGISTRATION_SUB_PREFIX = 'agent_reg_'
const CLAIM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/
const OAUTH_SCOPE_TOKEN = '[\\x21\\x23-\\x5b\\x5d-\\x7e]+'
const OAUTH_SCOPE_SET_PATTERN = new RegExp(`^${OAUTH_SCOPE_TOKEN}( ${OAUTH_SCOPE_TOKEN})*$`)

export type McpOAuthPrincipal = Readonly<{
  issuer: string
  audience: string
  principalId: string
  tenantId: string
  clientId: string
  scopes: string[]
  expiresAt: number
}>

export type McpOAuthVerifiedToken = Readonly<{
  claims: Readonly<Record<string, unknown>>
  principal: McpOAuthPrincipal
}>

type McpOAuthVerifiedTokenPolicy = (token: McpOAuthVerifiedToken) => void

type McpOAuthVerifiedTokenEffectPolicy = (
  token: McpOAuthVerifiedToken
) => Effect.Effect<void, McpOAuthError>

export type McpOAuthDependencies = Readonly<{
  fetch?: typeof globalThis.fetch
  nowMs?: () => number
}>

export type McpOAuthCoreConfig = Readonly<{
  issuer: string
  audience: string
  /** Exact pathname the audience URL must carry, e.g. `/api/vdr-mcp`. */
  audiencePath: string
  jwksUri: string
  tenantClaim: string
  clientIdClaim: string
  /** Every scope token the surface declares; must be unique and well formed. */
  scopeTokens: readonly string[]
  /** Optional legacy synchronous policy, applied after signature and generic claims verification. */
  verifiedTokenPolicy?: McpOAuthVerifiedTokenPolicy
  /** Effect-native product policy, applied at the same post-verification boundary. */
  verifiedTokenPolicyEffect?: McpOAuthVerifiedTokenEffectPolicy
  /**
   * Scopes the surface grants from the verified claims, on top of whatever
   * `claims.scope` carries. The core never reads a claim it was not told
   * about: the surface decides which claim means what, this module only unions
   * the result and holds it to the same scope grammar as the token.
   */
  grantedScopesFromClaims?: (claims: Readonly<Record<string, unknown>>) => readonly string[]
  jwksTimeoutMs?: number
}>

type RsaJwk = Record<string, unknown> & {
  alg?: string
  d?: string
  dp?: string
  dq?: string
  e?: string
  key_ops?: string[]
  kid?: string
  kty?: string
  n?: string
  p?: string
  q?: string
  qi?: string
  use?: string
}

const McpOAuthStatusSchema = Schema.Literals([400, 401, 403, 413, 502, 503])
export type McpOAuthStatus = typeof McpOAuthStatusSchema.Type

/**
 * Typed OAuth failure. The positional constructor is retained for every
 * existing imperative caller while Effect code carries the same value in its
 * error channel.
 */
export class McpOAuthError extends Schema.TaggedError<McpOAuthError>()('McpOAuthError', {
  code: Schema.String,
  status: McpOAuthStatusSchema,
  message: Schema.String,
}) {
  constructor(code: string, status: McpOAuthStatus = 401) {
    super({ code, status, message: code })
  }
}

export function failMcpOAuth(code: string, status: McpOAuthStatus = 401): never {
  throw new McpOAuthError(code, status)
}

// The explicit annotation is load-bearing: without it TypeScript drops the
// never-returning-call narrowing on every `fail(...)` guard below.
const fail: typeof failMcpOAuth = failMcpOAuth

function normalizeMcpOAuthError(
  cause: unknown,
  fallbackCode: string,
  fallbackStatus: McpOAuthStatus
): McpOAuthError {
  return cause instanceof McpOAuthError ? cause : new McpOAuthError(fallbackCode, fallbackStatus)
}

const mcpOAuthSync = Effect.fn('McpOAuth.sync')(
  <A>(
    evaluate: () => A,
    fallbackCode: string,
    fallbackStatus: McpOAuthStatus
  ): Effect.Effect<A, McpOAuthError> =>
    Effect.try({
      try: evaluate,
      catch: (cause) => normalizeMcpOAuthError(cause, fallbackCode, fallbackStatus),
    })
)

function validateScopeName(value: string): void {
  if (
    value.length === 0 ||
    value.length > 256 ||
    !new RegExp(`^${OAUTH_SCOPE_TOKEN}$`).test(value)
  ) {
    fail('MCP_OAUTH_CONFIG_INVALID', 503)
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}

function isAllowedOAuthUrlProtocol(url: URL): boolean {
  return url.protocol === 'https:' || isLoopbackHttpUrl(url)
}

function validateMcpOAuthConfig(config: McpOAuthCoreConfig): void {
  let issuerUrl: URL
  let audienceUrl: URL
  try {
    issuerUrl = new URL(config.issuer)
    audienceUrl = new URL(config.audience)
  } catch {
    fail('MCP_OAUTH_CONFIG_INVALID', 503)
  }
  if (
    !isAllowedOAuthUrlProtocol(issuerUrl) ||
    issuerUrl.username !== '' ||
    issuerUrl.password !== '' ||
    issuerUrl.search !== '' ||
    issuerUrl.hash !== '' ||
    config.issuer.length > 2_048 ||
    !isAllowedOAuthUrlProtocol(audienceUrl) ||
    audienceUrl.username !== '' ||
    audienceUrl.password !== '' ||
    audienceUrl.pathname !== config.audiencePath ||
    audienceUrl.search !== '' ||
    audienceUrl.hash !== '' ||
    config.audience.length > 2_048 ||
    !CLAIM_NAME_PATTERN.test(config.tenantClaim) ||
    !CLAIM_NAME_PATTERN.test(config.clientIdClaim) ||
    config.tenantClaim === config.clientIdClaim ||
    config.tenantClaim === 'sub' ||
    config.clientIdClaim === 'sub' ||
    (config.verifiedTokenPolicy !== undefined &&
      typeof config.verifiedTokenPolicy !== 'function') ||
    (config.verifiedTokenPolicyEffect !== undefined &&
      typeof config.verifiedTokenPolicyEffect !== 'function') ||
    (config.grantedScopesFromClaims !== undefined &&
      typeof config.grantedScopesFromClaims !== 'function')
  ) {
    fail('MCP_OAUTH_CONFIG_INVALID', 503)
  }

  let jwksUrl: URL
  try {
    jwksUrl = new URL(config.jwksUri)
  } catch {
    fail('MCP_OAUTH_CONFIG_INVALID', 503)
  }
  if (
    !isAllowedOAuthUrlProtocol(jwksUrl) ||
    jwksUrl.username !== '' ||
    jwksUrl.password !== '' ||
    jwksUrl.hash !== '' ||
    jwksUrl.search !== ''
  ) {
    fail('MCP_OAUTH_CONFIG_INVALID', 503)
  }

  config.scopeTokens.forEach(validateScopeName)
  if (new Set(config.scopeTokens).size !== config.scopeTokens.length) {
    fail('MCP_OAUTH_CONFIG_INVALID', 503)
  }

  const timeout = config.jwksTimeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) {
    fail('MCP_OAUTH_CONFIG_INVALID', 503)
  }
}

function parseBearerAuthorization(headers: Headers): string {
  const authorization = headers.get('authorization')
  if (authorization === null) {
    fail('MCP_BEARER_REQUIRED')
  }
  if (authorization.length > MAX_BEARER_BYTES) {
    fail('MCP_BEARER_INVALID')
  }
  const match = JWT_BEARER_PATTERN.exec(authorization)
  if (!match) {
    fail('MCP_BEARER_INVALID')
  }
  return match[1]
}

/** `required` must all be present, unless the bearer carries one of `sufficient`. */
export type McpScopeDemand = Readonly<{
  required: readonly string[]
  sufficient: readonly string[]
}>

function satisfiesScopeDemand(granted: readonly string[], demand: McpScopeDemand): boolean {
  if (demand.required.length === 0) return false
  if (demand.sufficient.some((scope) => granted.includes(scope))) return true
  return demand.required.every((scope) => granted.includes(scope))
}

/**
 * Fan a JSON-RPC body (single message or batch) through a per-message demand
 * mapper. `required` is the deduplicated union across messages; `sufficient` is
 * the intersection, so a batch mixing channels loses the weaker alternative.
 */
export function scopeDemandForMessages(
  body: unknown,
  demandForMessage: (message: unknown) => McpScopeDemand
): McpScopeDemand {
  const messages = Array.isArray(body) ? body : [body]
  if (messages.length === 0 || messages.length > MCP_MAX_BATCH_SIZE) {
    fail('MCP_OPERATION_DENIED', 403)
  }

  const demands = messages.map((message) => demandForMessage(message))
  const required = new Set<string>()
  for (const demand of demands) {
    for (const scope of demand.required) required.add(scope)
  }
  const sufficient = demands
    .slice(1)
    .reduce(
      (carried, demand) => carried.filter((scope) => demand.sufficient.includes(scope)),
      demands[0].sufficient
    )
  return { required: [...required], sufficient }
}

export const scopeDemandForMessagesEffect = Effect.fn('McpOAuth.scopeDemandForMessages')(
  (
    body: unknown,
    demandForMessage: (message: unknown) => McpScopeDemand
  ): Effect.Effect<McpScopeDemand, McpOAuthError> =>
    mcpOAuthSync(() => scopeDemandForMessages(body, demandForMessage), 'MCP_OPERATION_DENIED', 403)
)

async function readBoundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  declaredLength: string | null,
  maxBytes: number,
  tooLargeCode: string,
  emptyCode: string
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    fail('MCP_BOUND_INVALID', 503)
  }

  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      fail(emptyCode, 400)
    }
    const parsedLength = Number(declaredLength)
    if (!Number.isSafeInteger(parsedLength)) {
      fail(tooLargeCode, 413)
    }
    if (parsedLength > maxBytes) {
      fail(tooLargeCode, 413)
    }
  }

  if (stream === null) {
    fail(emptyCode, 400)
  }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        fail(tooLargeCode, 413)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof McpOAuthError) throw error
    fail(emptyCode, 400)
  } finally {
    reader.releaseLock()
  }

  if (total === 0) {
    fail(emptyCode, 400)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function fatalUtf8(bytes: Uint8Array, invalidUtf8Code: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return fail(invalidUtf8Code, 400)
  }
}

async function readBoundedJsonBodyPromise(request: Request, maxBytes: number): Promise<unknown> {
  const bytes = await readBoundedBytes(
    request.body,
    request.headers.get('content-length'),
    maxBytes,
    'MCP_BODY_TOO_LARGE',
    'MCP_BODY_INVALID'
  )
  const text = fatalUtf8(bytes, 'MCP_BODY_INVALID_UTF8')
  try {
    return JSON.parse(text) as unknown
  } catch {
    return fail('MCP_BODY_INVALID_JSON', 400)
  }
}

const readBoundedJsonBodyEffect = Effect.fn('McpOAuth.readBoundedJsonBody')(function* (
  request: Request,
  maxBytes: number = MCP_MAX_REQUEST_BODY_BYTES
): Effect.fn.Return<unknown, McpOAuthError> {
  return yield* Effect.tryPromise({
    try: () => readBoundedJsonBodyPromise(request, maxBytes),
    catch: (cause) => normalizeMcpOAuthError(cause, 'MCP_BODY_INVALID', 400),
  })
})

/** Promise adapter retained for HTTP and every existing caller. */
export async function readBoundedJsonBody(
  request: Request,
  maxBytes = MCP_MAX_REQUEST_BODY_BYTES
): Promise<unknown> {
  return runServerEffect(readBoundedJsonBodyEffect(request, maxBytes))
}

function decodeJwtSegment(segment: string, errorCode: string): Uint8Array {
  let bytes: Buffer
  try {
    bytes = Buffer.from(segment, 'base64url')
  } catch {
    fail(errorCode)
  }
  if (bytes.length === 0 || bytes.toString('base64url') !== segment) {
    fail(errorCode)
  }
  return bytes
}

function decodeJwtObject(segment: string, errorCode: string): Record<string, unknown> {
  const text = fatalUtf8(decodeJwtSegment(segment, errorCode), errorCode)
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    fail(errorCode)
  }
  if (!Predicate.isObject(parsed)) {
    fail(errorCode)
  }
  return parsed
}

function parseJwt(token: string): {
  header: Record<string, unknown>
  claims: Record<string, unknown>
  signingInput: string
  signature: Uint8Array
} {
  const segments = token.split('.')
  if (segments.length !== 3) {
    fail('MCP_TOKEN_INVALID')
  }
  const [encodedHeader, encodedClaims, encodedSignature] = segments
  const header = decodeJwtObject(encodedHeader, 'MCP_TOKEN_INVALID')
  const claims = decodeJwtObject(encodedClaims, 'MCP_TOKEN_INVALID')
  const signature = decodeJwtSegment(encodedSignature, 'MCP_TOKEN_INVALID')

  if (header.alg !== 'RS256') {
    fail('MCP_TOKEN_ALGORITHM_DENIED')
  }
  if (typeof header.kid !== 'string' || !IDENTIFIER_PATTERN.test(header.kid)) {
    fail('MCP_TOKEN_KEY_INVALID')
  }
  if (header.typ !== undefined && header.typ !== 'JWT') {
    fail('MCP_TOKEN_INVALID')
  }
  for (const forbidden of ['crit', 'jku', 'jwk', 'x5u']) {
    if (forbidden in header) {
      fail('MCP_TOKEN_HEADER_DENIED')
    }
  }

  return {
    header,
    claims,
    signingInput: `${encodedHeader}.${encodedClaims}`,
    signature,
  }
}

async function parseBoundedJwks(response: Response): Promise<RsaJwk[]> {
  if (!response.ok) {
    fail('MCP_JWKS_UNAVAILABLE', 502)
  }
  const bytes = await readBoundedBytes(
    response.body,
    response.headers.get('content-length'),
    MCP_MAX_JWKS_BYTES,
    'MCP_JWKS_TOO_LARGE',
    'MCP_JWKS_INVALID'
  )
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json' && mediaType !== 'application/jwk-set+json') {
    fail('MCP_JWKS_INVALID', 502)
  }
  const text = fatalUtf8(bytes, 'MCP_JWKS_INVALID_UTF8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    fail('MCP_JWKS_INVALID', 502)
  }
  if (!Predicate.isObject(parsed) || !Array.isArray(parsed.keys) || parsed.keys.length > 64) {
    fail('MCP_JWKS_INVALID', 502)
  }
  return parsed.keys as RsaJwk[]
}

function selectVerificationKey(keys: RsaJwk[], kid: string): RsaJwk {
  const candidates = keys.filter((key) => Predicate.isObject(key) && key.kid === kid)
  if (candidates.length === 0) {
    fail('MCP_JWKS_KEY_NOT_FOUND')
  }
  if (candidates.length !== 1) {
    fail('MCP_JWKS_KEY_AMBIGUOUS')
  }
  const key = candidates[0]
  if (
    key.kty !== 'RSA' ||
    typeof key.n !== 'string' ||
    typeof key.e !== 'string' ||
    (key.alg !== undefined && key.alg !== 'RS256') ||
    (key.use !== undefined && key.use !== 'sig') ||
    ('d' in key && key.d !== undefined) ||
    ('p' in key && key.p !== undefined) ||
    ('q' in key && key.q !== undefined) ||
    ('dp' in key && key.dp !== undefined) ||
    ('dq' in key && key.dq !== undefined) ||
    ('qi' in key && key.qi !== undefined)
  ) {
    fail('MCP_JWKS_KEY_INVALID')
  }
  if (
    key.key_ops !== undefined &&
    (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify') || key.key_ops.includes('sign'))
  ) {
    fail('MCP_JWKS_KEY_INVALID')
  }
  return key
}

class JwksCacheKey extends Data.Class<{
  readonly fetchImpl: typeof globalThis.fetch
  readonly jwksUri: string
  readonly timeoutMs: number
  readonly kid: string
}> {}

const fetchJwksEffect = Effect.fn('McpOAuth.fetchJwks')(function* (
  cacheKey: JwksCacheKey
): Effect.fn.Return<RsaJwk[], McpOAuthError> {
  return yield* externalCall({
    service: 'McpOAuthJwks',
    operation: 'fetch',
    timeout: Duration.millis(cacheKey.timeoutMs),
    retries: 0,
    run: async (signal) => {
      const response = await cacheKey.fetchImpl(cacheKey.jwksUri, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        redirect: 'error',
        signal,
      })
      return parseBoundedJwks(response)
    },
  }).pipe(
    Effect.mapError((error) => normalizeMcpOAuthError(error.cause, 'MCP_JWKS_UNAVAILABLE', 502))
  )
})

const loadVerificationKeyEffect = Effect.fn('McpOAuth.loadVerificationKey')(function* (
  cacheKey: JwksCacheKey
): Effect.fn.Return<KeyObject, McpOAuthError> {
  const keys = yield* fetchJwksEffect(cacheKey)
  const jwk = yield* mcpOAuthSync(
    () => selectVerificationKey(keys, cacheKey.kid),
    'MCP_JWKS_KEY_INVALID',
    401
  )
  return yield* Effect.try({
    try: () => createPublicKey({ key: jwk as NodeJsonWebKey, format: 'jwk' }),
    catch: () => new McpOAuthError('MCP_JWKS_KEY_INVALID'),
  })
})

// A `kid` the JWKS does not carry is remembered for a short while: the cache
// is keyed by `kid` before any signature check, so every invented `kid` used
// to cost one GET to the authorization server. Any other failure (network,
// timeout, malformed JWKS) is evicted at once so a recovered server is retried
// on the next request.
function jwksFailureTimeToLive(cause: Cause.Cause<McpOAuthError>): Duration.Duration {
  const failure = Cause.findError(cause)
  return Result.isSuccess(failure) && failure.success.code === 'MCP_JWKS_KEY_NOT_FOUND'
    ? Duration.millis(MCP_JWKS_UNKNOWN_KID_TTL_MS)
    : Duration.zero
}

// One warm-process cache. Effect Cache bounds retained keys and shares an
// in-flight lookup for identical JWKS/key requests.
const jwksVerificationKeyCache = Effect.runSync(
  Cache.makeWith(loadVerificationKeyEffect, {
    capacity: MCP_JWKS_CACHE_CAPACITY,
    timeToLive: (result) =>
      Exit.isSuccess(result)
        ? Duration.millis(MCP_JWKS_CACHE_TTL_MS)
        : jwksFailureTimeToLive(result.cause),
  })
)

const verificationKeyEffect = Effect.fn('McpOAuth.verificationKey')(
  (cacheKey: JwksCacheKey): Effect.Effect<KeyObject, McpOAuthError> =>
    Cache.get(jwksVerificationKeyCache, cacheKey)
)

function safeNumericDate(value: unknown, errorCode: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(errorCode)
  }
  return value as number
}

function requiredClaim(claims: Record<string, unknown>, name: string): string {
  const value = claims[name]
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    fail('MCP_TOKEN_CLAIMS_INVALID')
  }
  return value
}

// Un cliente registrado por Client ID Metadata Document (MCP 2025-11-25) no
// trae un `client_id` con forma de identificador: WorkOS Connect emite la URL
// del propio documento, y Claude Code llega con
// `https://claude.ai/oauth/claude-code-client-metadata`. Las barras rompían
// `IDENTIFIER_PATTERN`, así que su `initialize` y su `tools/list` morían en
// `MCP_TOKEN_CLAIMS_INVALID` (401 medido contra prod el 2026-09-12). El claim
// es un identificador opaco —entra al digest del rate limit y a la auditoría,
// nunca a una decisión de acceso—, así que la URL se acepta con las mismas
// restricciones que las demás URLs de este módulo.
// @see https://workos.com/blog/mcp-client-identity-dcr-cimd-auth-md
// @see https://workos.com/docs/authkit/mcp
const MAX_CLIENT_ID_URL_LENGTH = 512

function isCimdClientIdUrl(value: string): boolean {
  if (value.length > MAX_CLIENT_ID_URL_LENGTH || /\s/.test(value) || value.includes('#')) {
    return false
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.username === '' && url.password === ''
}

/**
 * El claim del client id, el único que admite dos formas: el identificador de
 * siempre o una URL CIMD. `sub`, el tenant y el `kid` del header se quedan
 * atados a `IDENTIFIER_PATTERN`.
 */
function clientIdClaim(claims: Record<string, unknown>, name: string, required: true): string
function clientIdClaim(
  claims: Record<string, unknown>,
  name: string,
  required: false
): string | undefined
function clientIdClaim(
  claims: Record<string, unknown>,
  name: string,
  required: boolean
): string | undefined {
  const value = claims[name]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !(IDENTIFIER_PATTERN.test(value) || isCimdClientIdUrl(value))) {
    fail('MCP_TOKEN_CLAIMS_INVALID')
  }
  return value
}

function resolvePrincipalClaims(
  claims: Record<string, unknown>,
  config: McpOAuthCoreConfig
): { principalId: string; clientId: string } {
  const sub = requiredClaim(claims, 'sub')
  if (!sub.startsWith(AGENT_REGISTRATION_SUB_PREFIX)) {
    return {
      principalId: sub,
      clientId: clientIdClaim(claims, config.clientIdClaim, true),
    }
  }

  const act = claims.act
  if (!Predicate.isObject(act)) fail('MCP_TOKEN_CLAIMS_INVALID')
  const principalId = requiredClaim(act, 'sub')
  if (principalId.startsWith(AGENT_REGISTRATION_SUB_PREFIX)) {
    fail('MCP_TOKEN_CLAIMS_INVALID')
  }
  return {
    principalId,
    clientId: clientIdClaim(claims, config.clientIdClaim, false) ?? sub,
  }
}

function parseScopes(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 4_096 || !OAUTH_SCOPE_SET_PATTERN.test(value)) {
    fail('MCP_TOKEN_SCOPE_INVALID')
  }
  const parsed = value.split(' ')
  if (new Set(parsed).size !== parsed.length) {
    fail('MCP_TOKEN_SCOPE_INVALID')
  }
  return parsed
}

/**
 * The scopes the request is judged with: the bearer's own, plus whatever the
 * surface grants from the verified claims. The union keeps the token's order,
 * drops duplicates, and holds every granted name to the token's grammar, so a
 * surface cannot smuggle a malformed scope into the principal.
 */
function grantedScopes(claims: Record<string, unknown>, config: McpOAuthCoreConfig): string[] {
  const scopes = parseScopes(claims.scope)
  const fromClaims = config.grantedScopesFromClaims?.(claims) ?? []
  for (const scope of fromClaims) {
    validateScopeName(scope)
    if (!scopes.includes(scope)) scopes.push(scope)
  }
  return scopes
}

function assertClaims(
  claims: Record<string, unknown>,
  config: McpOAuthCoreConfig,
  nowMs: number,
  demand: McpScopeDemand
): McpOAuthPrincipal {
  if (claims.iss !== config.issuer) {
    fail('MCP_TOKEN_ISSUER_INVALID')
  }
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud
  if (
    !Array.isArray(audiences) ||
    audiences.length === 0 ||
    audiences.some((audience) => typeof audience !== 'string') ||
    !audiences.includes(config.audience)
  ) {
    fail('MCP_TOKEN_AUDIENCE_INVALID')
  }

  const expiresAtSeconds = safeNumericDate(claims.exp, 'MCP_TOKEN_EXPIRED')
  const nowSeconds = Math.floor(nowMs / 1_000)
  if (nowSeconds >= expiresAtSeconds) {
    fail('MCP_TOKEN_EXPIRED')
  }
  if (
    claims.nbf !== undefined &&
    nowSeconds < safeNumericDate(claims.nbf, 'MCP_TOKEN_NOT_ACTIVE')
  ) {
    fail('MCP_TOKEN_NOT_ACTIVE')
  }
  const issuedAtSeconds = safeNumericDate(claims.iat, 'MCP_TOKEN_CLAIMS_INVALID')
  if (issuedAtSeconds > nowSeconds) fail('MCP_TOKEN_CLAIMS_INVALID')

  const { principalId, clientId } = resolvePrincipalClaims(claims, config)
  const tenantId = requiredClaim(claims, config.tenantClaim)
  const scopes = grantedScopes(claims, config)
  if (!satisfiesScopeDemand(scopes, demand)) {
    fail('MCP_SCOPE_INSUFFICIENT', 403)
  }

  return {
    issuer: config.issuer,
    audience: config.audience,
    principalId,
    tenantId,
    clientId,
    scopes,
    expiresAt: expiresAtSeconds * 1_000,
  }
}

/**
 * Effect-native bearer verification. The scope thunk is effectful so a surface
 * can keep denial in the typed error channel while preserving the load-bearing
 * order: config, scope demand, bearer bytes, JWKS, signature, claims, policy.
 */
export const verifyMcpBearerCoreEffect = Effect.fn('McpOAuth.verifyBearer')(function* (
  request: Request,
  config: McpOAuthCoreConfig,
  resolveScopeDemand: () => Effect.Effect<McpScopeDemand, McpOAuthError>,
  dependencies: McpOAuthDependencies = {}
): Effect.fn.Return<McpOAuthPrincipal, McpOAuthError> {
  yield* mcpOAuthSync(() => validateMcpOAuthConfig(config), 'MCP_OAUTH_CONFIG_INVALID', 503)
  const demand = yield* resolveScopeDemand()
  const token = yield* mcpOAuthSync(
    () => parseBearerAuthorization(request.headers),
    'MCP_BEARER_INVALID',
    401
  )
  const parsed = yield* mcpOAuthSync(() => parseJwt(token), 'MCP_TOKEN_INVALID', 401)
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return yield* new McpOAuthError('MCP_JWKS_UNAVAILABLE', 503)
  }

  const key = yield* verificationKeyEffect(
    new JwksCacheKey({
      fetchImpl,
      jwksUri: config.jwksUri,
      timeoutMs: config.jwksTimeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS,
      kid: parsed.header.kid as string,
    })
  )

  const signatureIsValid = yield* Effect.try({
    try: () =>
      verifySignature('RSA-SHA256', Buffer.from(parsed.signingInput), key, parsed.signature),
    catch: () => new McpOAuthError('MCP_JWKS_KEY_INVALID'),
  })
  if (!signatureIsValid) {
    return yield* new McpOAuthError('MCP_TOKEN_SIGNATURE_INVALID')
  }

  const nowMs =
    dependencies.nowMs === undefined
      ? yield* Clock.currentTimeMillis
      : yield* mcpOAuthSync(dependencies.nowMs, 'MCP_OAUTH_CLOCK_INVALID', 503)
  if (!Number.isSafeInteger(nowMs) || nowMs < 1) {
    return yield* new McpOAuthError('MCP_OAUTH_CLOCK_INVALID', 503)
  }
  const principal = yield* mcpOAuthSync(
    () => assertClaims(parsed.claims, config, nowMs, demand),
    'MCP_TOKEN_CLAIMS_INVALID',
    401
  )
  const verifiedToken = { claims: parsed.claims, principal }
  const verifiedTokenPolicy = config.verifiedTokenPolicy
  if (verifiedTokenPolicy !== undefined) {
    yield* mcpOAuthSync(() => verifiedTokenPolicy(verifiedToken), 'MCP_TOKEN_CLAIMS_INVALID', 401)
  }
  const verifiedTokenPolicyEffect = config.verifiedTokenPolicyEffect
  if (verifiedTokenPolicyEffect !== undefined) {
    yield* verifiedTokenPolicyEffect(verifiedToken)
  }
  return principal
})
